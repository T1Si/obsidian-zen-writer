import { MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";

type ZenWriterCenterTrigger = "typing" | "navigation" | "pointer" | "open" | "resize" | "selection" | "wheel";
type EditorCursor = { line: number; ch: number };
type RectLike = { top: number; bottom: number; left: number; right: number };

interface CodeMirrorViewLike {
  posAtCoords(coords: { x: number; y: number }): number | null;
  coordsAtPos(pos: number): RectLike | null;
}

const WHEEL_BROWSE_DAMPING = 0.35;
const WHEEL_BROWSE_STOP_EPSILON_PX = 0.75;
const WHEEL_BROWSE_MAX_MOMENTUM_PX = 320;
const WHEEL_BROWSE_MAX_FRAME_LINES = 1.6;
const FOCUS_FRAME_RESYNC_DELAY_MS = 48;
const FOCUS_FRAME_RESYNC_MAX_ATTEMPTS = 8;
const PICKER_RECOVERY_DELAY_MS = 50;
const PICKER_RECOVERY_MAX_ATTEMPTS = 20;
const PICKER_SETTLE_FRAMES = 10;

interface ZenWriterSettings {
  language: "en" | "zh";
  enabled: boolean;
  maxWidth: string;
  dimOpacity: number;
  centerDelayMs: number;
  pickerFrameHeightPx: number;
  pickerPaddingX: number;
  zenLockedFile: string | null;
  activeLineGlow: boolean;
  themeDisplay: "default" | "sepia" | "green" | "dark";
  showExitButton: boolean;
}

const DEFAULT_SETTINGS: ZenWriterSettings = {
  language: "en",
  enabled: false,
  maxWidth: "42rem",
  dimOpacity: 0.32,
  centerDelayMs: 150,
  pickerFrameHeightPx: 56,
  pickerPaddingX: 16,
  zenLockedFile: null,
  activeLineGlow: true,
  themeDisplay: "default",
  showExitButton: true,
};

export default class ZenWriterPlugin extends Plugin {
  settings: ZenWriterSettings = DEFAULT_SETTINGS;
  private readonly rememberedCursors = new Map<string, EditorCursor>();
  private pickerViewRoot: HTMLElement | null = null;
  private centerTimer: number | null = null;
  private centerFrame: number | null = null;
  private statusBarItemEl: HTMLElement | null = null;
  private isComposing = false;
  private pendingCenterTrigger: ZenWriterCenterTrigger | null = null;
  private viewportRefreshFrame: number | null = null;
  private pendingViewportTrigger: ZenWriterCenterTrigger | null = null;
  private focusFrameHost: HTMLElement | null = null;
  private focusFrameEl: HTMLElement | null = null;
  private focusFrameResyncTimer: number | null = null;
  private focusFrameResyncAttempts = 0;
  private lastPointerDownTime = 0;
  private pendingProgrammaticSelectionOffset: number | null = null;
  private pendingProgrammaticScrollEl: HTMLElement | null = null;
  private pendingProgrammaticScrollTop: number | null = null;
  private wheelBrowseFrame: number | null = null;
  private pendingWheelDeltaPx = 0;
  private wheelBrowseCarryPx = 0;
  private lastWheelDirection = 0;
  private pickerSettleFrame: number | null = null;
  private pickerSettleFramesRemaining = 0;
  private pickerRecoveryTimer: number | null = null;
  private pickerRecoveryAttempts = 0;
  private pickerHealthCheckInterval: number | null = null;
  private zenExitButtonEl: HTMLElement | null = null;
  private zenExitTriggerEl: HTMLElement | null = null;
  private leftSidebarWasVisible = false;
  private rightSidebarWasVisible = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarItemEl = this.addStatusBarItem();
    this.registerCommands();
    this.registerRibbonIcon();

    this.addSettingTab(new ZenWriterSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor) => {
        if (!this.settings.enabled || this.isComposing) {
          return;
        }

        const view = this.getActiveMarkdownView();
        if (!view) {
          return;
        }

        // 只记住光标位置，不要干扰输入
        this.rememberCursorForView(view);

        // 使用更长的延迟，避免干扰输入
        this.scheduleViewportRefresh("typing");
      }),
    );

    // 监听键盘导航事件
    this.registerDomEvent(document, "keydown", async (event: KeyboardEvent) => {
      if (!this.settings.enabled || this.isComposing) {
        return;
      }

      // 快捷退出：按下 Esc 键退出禅意模式
      if (event.key === "Escape") {
        await this.exitZenMode();
        return;
      }

      // 检测方向键、PageUp/PageDown、Home/End
      const isNavigationKey = [
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "PageUp", "PageDown", "Home", "End"
      ].includes(event.key);

      if (isNavigationKey) {
        // 延迟一帧，让光标先移动
        window.requestAnimationFrame(() => {
          const view = this.getActiveMarkdownView();
          if (view) {
            this.rememberCursorForView(view);
            this.scheduleViewportRefresh("navigation");
          }
        });
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        // 如果在 Zen 模式下，检查是否切换到了其他文件
        if (this.settings.enabled && this.settings.zenLockedFile) {
          const view = this.getActiveMarkdownView();
          const currentFile = view ? this.getViewFilePath(view) : null;

          // 如果切换到了其他文件，阻止并恢复到锁定的文件
          if (currentFile && currentFile !== this.settings.zenLockedFile) {
            this.restoreLockedFile();
            return;
          }
        }

        if (!this.settings.enabled) {
          return;
        }
        this.rememberActiveCursor();
        this.clearPickerRecovery();

        // 强制清理旧状态
        this.clearFocusFrame();
        this.clearPickerViewScope();

        // 多次尝试恢复，确保成功
        window.requestAnimationFrame(() => {
          this.trySyncPickerImmediate();
          window.requestAnimationFrame(() => {
            this.trySyncPickerImmediate();
            this.schedulePickerRecovery("selection");
          });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.settings.enabled) {
          return;
        }
        this.clearPickerRecovery();
        window.requestAnimationFrame(() => {
          this.trySyncPickerImmediate();
          this.schedulePickerRecovery("resize");
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (!this.settings.enabled) {
          return;
        }
        this.clearPickerRecovery();

        // 强制清理旧状态
        this.clearFocusFrame();
        this.clearPickerViewScope();

        // 多次尝试恢复，确保成功
        window.requestAnimationFrame(() => {
          this.trySyncPickerImmediate();
          window.requestAnimationFrame(() => {
            this.trySyncPickerImmediate();
            this.schedulePickerRecovery("open");
          });
        });
      }),
    );

    this.registerDomEvent(document, "compositionstart", () => {
      this.isComposing = true;
      this.clearCenterTimer();
    });

    this.registerDomEvent(document, "compositionend", () => {
      this.isComposing = false;
      this.scheduleViewportRefresh("typing");
    });

    this.registerDomEvent(window, "mouseup", (event: MouseEvent) => {
      this.handlePointerBrowse(event);
    });

    this.registerDomEvent(
      document,
      "scroll",
      (event: Event) => {
        this.handlePickerScroll(event);
      },
      true,
    );

    this.registerDomEvent(
      document,
      "pointerdown",
      (event: PointerEvent) => {
        this.handleMouseDown(event);
      },
      { capture: true },
    );

    this.registerDomEvent(
      document,
      "mousedown",
      (event: MouseEvent) => {
        this.handleMouseDown(event);
      },
      { capture: true },
    );

    this.registerDomEvent(
      window,
      "wheel",
      (event: WheelEvent) => {
        this.handleWheelBrowse(event);
      },
      { passive: false },
    );

    this.registerDomEvent(window, "resize", () => {
      this.scheduleViewportRefresh("resize");
    });

    this.registerDomEvent(window, "focus", () => {
      this.schedulePickerRecovery("selection");
    });

    this.registerDomEvent(window, "blur", () => {
      this.rememberActiveCursor();
      this.clearPickerRecovery();
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) {
        this.rememberActiveCursor();
        this.clearPickerRecovery();
        this.stopPickerHealthCheck();
      } else {
        this.schedulePickerRecovery("selection");
        this.startPickerHealthCheck();
      }
    });

    this.applyZenState();
  }

  onunload(): void {
    this.clearCenterTimer();
    this.clearViewportRefreshFrame();
    this.clearFocusFrame();
    this.clearFocusFrameResync();
    this.clearWheelBrowseFrame();
    this.clearPickerSettleFrame();
    this.clearPickerRecovery();
    this.stopPickerHealthCheck();
    this.removeZenExitButton();
    this.clearPendingProgrammaticSelection();
    this.clearPendingProgrammaticScroll();
    this.clearPickerViewScope();
    document.body.classList.remove("zen-writer-enabled");
    delete document.body.dataset.zenWriterMode;
    document.body.style.removeProperty("--zen-writer-max-width");
    document.body.style.removeProperty("--zen-writer-dim-opacity");
    document.body.style.removeProperty("--zen-writer-focus-frame-height");
    document.body.style.removeProperty("--zen-writer-focus-frame-padding-x");
    document.body.style.removeProperty("--zen-writer-picker-anchor");
    document.body.style.removeProperty("--zen-writer-focus-frame-edge-top");
    document.body.style.removeProperty("--zen-writer-focus-frame-edge-bottom");
  }

  async loadSettings(): Promise<void> {
    const rawSettings = await this.loadData() || {};

    this.settings = {
      language: rawSettings.language ?? DEFAULT_SETTINGS.language,
      enabled: rawSettings.enabled ?? DEFAULT_SETTINGS.enabled,
      maxWidth: rawSettings.maxWidth ?? DEFAULT_SETTINGS.maxWidth,
      dimOpacity: rawSettings.dimOpacity ?? DEFAULT_SETTINGS.dimOpacity,
      centerDelayMs: rawSettings.centerDelayMs ?? DEFAULT_SETTINGS.centerDelayMs,
      pickerFrameHeightPx:
        rawSettings.pickerFrameHeightPx ?? rawSettings.focusFrameHeightPx ?? DEFAULT_SETTINGS.pickerFrameHeightPx,
      pickerPaddingX:
        rawSettings.pickerPaddingX ?? rawSettings.focusFramePaddingX ?? DEFAULT_SETTINGS.pickerPaddingX,
      zenLockedFile: rawSettings.zenLockedFile ?? DEFAULT_SETTINGS.zenLockedFile,
      activeLineGlow: rawSettings.activeLineGlow ?? DEFAULT_SETTINGS.activeLineGlow,
      themeDisplay: rawSettings.themeDisplay ?? DEFAULT_SETTINGS.themeDisplay,
      showExitButton: rawSettings.showExitButton ?? DEFAULT_SETTINGS.showExitButton,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyZenState();
  }

  private async toggleZenWriter(): Promise<void> {
    if (this.settings.enabled) {
      await this.exitZenMode();
    } else {
      await this.enterZenMode();
    }
  }

  private async enterZenMode(): Promise<void> {
    const view = this.getActiveMarkdownView();
    if (!view) {
      return;
    }

    const filePath = this.getViewFilePath(view);
    if (!filePath) {
      return;
    }

    // 记住当前侧边栏状态
    this.leftSidebarWasVisible = !this.app.workspace.leftSplit.collapsed;
    this.rightSidebarWasVisible = !this.app.workspace.rightSplit.collapsed;

    // 收起侧边栏
    if (this.leftSidebarWasVisible) {
      this.app.workspace.leftSplit.collapse();
    }
    if (this.rightSidebarWasVisible) {
      this.app.workspace.rightSplit.collapse();
    }

    // 锁定当前文件
    this.settings.enabled = true;
    this.settings.zenLockedFile = filePath;
    await this.saveSettings();

    // 应用 Zen 状态（这会触发 picker 效果）
    this.applyZenState();

    // 创建退出按钮
    this.createZenExitButton();
  }

  private async exitZenMode(): Promise<void> {
    this.settings.enabled = false;
    this.settings.zenLockedFile = null;

    // 恢复侧边栏状态
    if (this.leftSidebarWasVisible) {
      this.app.workspace.leftSplit.expand();
    }
    if (this.rightSidebarWasVisible) {
      this.app.workspace.rightSplit.expand();
    }

    // 移除退出按钮
    this.removeZenExitButton();

    await this.saveSettings();

    // 应用状态（这会清理 picker 效果）
    this.applyZenState();
  }

  private restoreLockedFile(): void {
    if (!this.settings.zenLockedFile) {
      return;
    }

    // 尝试找到锁定的文件并切换回去
    const file = this.app.vault.getAbstractFileByPath(this.settings.zenLockedFile);
    if (!file) {
      return;
    }

    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && this.getViewFilePath(view) === this.settings.zenLockedFile) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }

    // 如果没有找到已打开的 leaf，尝试打开文件
    this.app.workspace.getLeaf(false).openFile(file as any);
  }

  private createZenExitButton(): void {
    this.removeZenExitButton();

    if (!this.settings.showExitButton) {
      return;
    }

    // 创建触发区域 (靠近顶部的一窄条)
    const trigger = document.createElement("div");
    trigger.className = "zen-writer-exit-trigger";
    document.body.appendChild(trigger);
    this.zenExitTriggerEl = trigger;

    // 创建退出按钮 (只有 X 图标)
    const button = document.createElement("div");
    button.className = "zen-writer-exit-button";
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    button.addEventListener("click", async () => {
      await this.exitZenMode();
    });

    document.body.appendChild(button);
    this.zenExitButtonEl = button;

    // 鼠标移到顶部时显示按钮
    trigger.addEventListener("mouseenter", () => {
      if (button) {
        button.style.transform = "translateX(-50%) translateY(0)";
        button.style.opacity = "1";
      }
    });

    trigger.addEventListener("mouseleave", () => {
      if (button && !button.matches(":hover")) {
        button.style.transform = "translateX(-50%) translateY(-100%)";
        button.style.opacity = "0";
      }
    });

    button.addEventListener("mouseenter", () => {
      button.style.transform = "translateX(-50%) translateY(0)";
      button.style.opacity = "1";
    });

    button.addEventListener("mouseleave", () => {
      button.style.transform = "translateX(-50%) translateY(-100%)";
      button.style.opacity = "0";
    });
  }

  private removeZenExitButton(): void {
    if (this.zenExitButtonEl) {
      this.zenExitButtonEl.remove();
      this.zenExitButtonEl = null;
    }
    if (this.zenExitTriggerEl) {
      this.zenExitTriggerEl.remove();
      this.zenExitTriggerEl = null;
    }
  }

  public applyZenState(): void {
    document.body.style.setProperty("--zen-writer-max-width", this.settings.maxWidth);
    document.body.style.setProperty("--zen-writer-dim-opacity", `${this.settings.dimOpacity}`);
    document.body.style.setProperty("--zen-writer-focus-frame-height", `${this.settings.pickerFrameHeightPx}px`);
    document.body.style.setProperty("--zen-writer-focus-frame-padding-x", `${this.settings.pickerPaddingX}px`);
    document.body.dataset.zenWriterMode = "picker";
    document.body.classList.toggle("zen-writer-enabled", this.settings.enabled);
    document.body.classList.toggle("zen-writer-glow-enabled", this.settings.activeLineGlow);
    
    this.registerRibbonIcon();
    this.registerCommands();

    document.body.classList.remove("zen-theme-sepia", "zen-theme-green", "zen-theme-dark");
    if (this.settings.enabled && this.settings.themeDisplay && this.settings.themeDisplay !== "default") {
      document.body.classList.add(`zen-theme-${this.settings.themeDisplay}`);
    }

    if (this.statusBarItemEl) {
      this.statusBarItemEl.textContent = this.settings.enabled ? "Zen Writer: Picker" : "Zen Writer: Off";
    }

    if (this.settings.enabled && !this.isComposing) {
      // 立即尝试同步当前文档
      window.requestAnimationFrame(() => {
        this.trySyncPickerImmediate();
        this.schedulePickerRecovery("selection");
        this.startPickerHealthCheck();
      });
    } else {
      this.clearCenterTimer();
      this.clearViewportRefreshFrame();
      this.clearFocusFrame();
      this.clearWheelBrowseFrame();
      this.resetWheelBrowseCarry();
      this.clearPickerSettleFrame();
      this.clearPickerRecovery();
      this.stopPickerHealthCheck();
      this.clearPendingProgrammaticSelection();
      this.clearPendingProgrammaticScroll();
      this.clearPickerViewScope();
      this.clearFocusFrameEdgeSpacing();
      this.clearFocusFrameResync();
    }
  }

  private scheduleViewportRefresh(trigger: ZenWriterCenterTrigger): void {
    if (!this.settings.enabled) {
      return;
    }

    if (
      this.pendingViewportTrigger === null ||
      this.getCenterPriority(trigger) >= this.getCenterPriority(this.pendingViewportTrigger)
    ) {
      this.pendingViewportTrigger = trigger;
    }

    if (this.viewportRefreshFrame !== null) {
      return;
    }

    this.viewportRefreshFrame = window.requestAnimationFrame(() => {
      const nextTrigger = this.pendingViewportTrigger ?? "selection";
      this.viewportRefreshFrame = null;
      this.pendingViewportTrigger = null;

      if (!this.settings.enabled) {
        return;
      }

      const view = this.getActiveMarkdownView();
      if (!view) {
        this.schedulePickerRecovery(nextTrigger);
        return;
      }

      if (nextTrigger !== "wheel") {
        this.resetWheelBrowseCarry();
      }

      this.syncFocusFrame();
      this.scheduleCentering(nextTrigger);
      this.schedulePickerSettle(nextTrigger);
    });
  }

  private scheduleCentering(trigger: ZenWriterCenterTrigger): void {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }

    if (
      (this.centerTimer !== null || this.centerFrame !== null) &&
      this.pendingCenterTrigger !== null &&
      this.getCenterPriority(trigger) < this.getCenterPriority(this.pendingCenterTrigger)
    ) {
      return;
    }

    this.clearCenterTimer();
    this.pendingCenterTrigger = trigger;

    const runCentering = () => {
      this.centerFrame = null;
      this.pendingCenterTrigger = null;
      this.centerActiveCursor();
    };

    const delay = this.getCenterDelay(trigger);
    if (delay === 0) {
      this.centerFrame = window.requestAnimationFrame(runCentering);
      return;
    }

    this.centerTimer = window.setTimeout(() => {
      this.centerTimer = null;
      this.centerFrame = window.requestAnimationFrame(runCentering);
    }, delay);
  }

  private clearCenterTimer(): void {
    if (this.centerTimer !== null) {
      window.clearTimeout(this.centerTimer);
      this.centerTimer = null;
    }

    if (this.centerFrame !== null) {
      window.cancelAnimationFrame(this.centerFrame);
      this.centerFrame = null;
    }

    this.pendingCenterTrigger = null;
  }

  private clearViewportRefreshFrame(): void {
    if (this.viewportRefreshFrame !== null) {
      window.cancelAnimationFrame(this.viewportRefreshFrame);
      this.viewportRefreshFrame = null;
    }

    this.pendingViewportTrigger = null;
  }

  private schedulePickerSettle(trigger: ZenWriterCenterTrigger): void {
    if (!this.settings.enabled || this.isComposing || trigger === "typing") {
      return;
    }

    this.pickerSettleFramesRemaining = Math.max(this.pickerSettleFramesRemaining, PICKER_SETTLE_FRAMES);
    if (this.pickerSettleFrame !== null) {
      return;
    }

    this.pickerSettleFrame = window.requestAnimationFrame(() => {
      this.flushPickerSettle();
    });
  }

  private flushPickerSettle(): void {
    this.pickerSettleFrame = null;

    if (!this.settings.enabled || this.isComposing || this.pickerSettleFramesRemaining <= 0) {
      this.pickerSettleFramesRemaining = 0;
      return;
    }

    this.pickerSettleFramesRemaining -= 1;
    this.syncFocusFrame();
    this.centerActiveCursor();

    if (this.pickerSettleFramesRemaining > 0) {
      this.pickerSettleFrame = window.requestAnimationFrame(() => {
        this.flushPickerSettle();
      });
    }
  }

  private clearPickerSettleFrame(): void {
    if (this.pickerSettleFrame !== null) {
      window.cancelAnimationFrame(this.pickerSettleFrame);
      this.pickerSettleFrame = null;
    }

    this.pickerSettleFramesRemaining = 0;
  }

  private clearPendingProgrammaticScroll(): void {
    this.pendingProgrammaticScrollEl = null;
    this.pendingProgrammaticScrollTop = null;
  }

  private clearPendingProgrammaticSelection(): void {
    this.pendingProgrammaticSelectionOffset = null;
  }

  private rememberActiveCursor(): void {
    const view = this.getActiveMarkdownView();
    if (view) {
      this.rememberCursorForView(view);
    }
  }

  private markProgrammaticSelection(view: MarkdownView, cursor: EditorCursor): void {
    this.pendingProgrammaticSelectionOffset = view.editor.posToOffset(cursor);
    this.rememberCursorForView(view, cursor);
  }

  private getViewFilePath(view: MarkdownView): string | null {
    const file = view.file;
    return file?.path ?? null;
  }

  private rememberCursorForView(view: MarkdownView, cursor = view.editor.getCursor()): void {
    const path = this.getViewFilePath(view);
    if (!path) {
      return;
    }

    this.rememberedCursors.set(path, { line: cursor.line, ch: cursor.ch });
  }

  private restoreRememberedCursorForView(view: MarkdownView): boolean {
    const path = this.getViewFilePath(view);
    if (!path) {
      return false;
    }

    const rememberedCursor = this.rememberedCursors.get(path);
    if (!rememberedCursor) {
      return false;
    }

    const lineCount = view.editor.lineCount();
    if (lineCount === 0) {
      return false;
    }

    const maxLine = Math.max(0, lineCount - 1);
    const line = this.clamp(rememberedCursor.line, 0, maxLine);
    const lineText = view.editor.getLine(line);
    const nextCursor = {
      line,
      ch: this.clamp(rememberedCursor.ch, 0, lineText.length),
    };
    const currentCursor = view.editor.getCursor();
    if (currentCursor.line === nextCursor.line && currentCursor.ch === nextCursor.ch) {
      return false;
    }

    this.markProgrammaticSelection(view, nextCursor);
    view.editor.setCursor(nextCursor);
    return true;
  }

  private schedulePickerRecovery(trigger: ZenWriterCenterTrigger): void {
    if (!this.settings.enabled) {
      this.clearPickerRecovery();
      return;
    }

    // 先尝试立即恢复
    const synced = this.trySyncPickerImmediate();

    // 无论是否成功，都调度 viewport refresh
    this.scheduleViewportRefresh(trigger);

    // 如果同步失败，启动重试机制
    if (!synced && this.pickerRecoveryTimer === null) {
      this.pickerRecoveryAttempts = 0;
      this.attemptPickerRecovery(trigger);
    }
  }

  private trySyncPickerImmediate(): boolean {
    if (!this.settings.enabled) {
      return false;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      return false;
    }

    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");
    const host = this.getActiveEditorHost(view);

    if (!(sourceView instanceof HTMLElement) || !(scroller instanceof HTMLElement) ||
      !(host instanceof HTMLElement)) {
      return false;
    }

    // 清理不匹配的旧状态
    if (this.focusFrameHost && this.focusFrameHost !== host) {
      this.clearFocusFrame();
    }
    if (this.pickerViewRoot && this.pickerViewRoot !== sourceView) {
      this.clearPickerViewScope();
    }

    // 强制同步 pickerViewScope
    const syncedView = this.syncPickerViewScope();

    // 强制同步 focusFrame
    this.syncFocusFrame();

    // 验证同步是否成功
    const viewSynced = syncedView === sourceView &&
      sourceView.classList.contains("zen-writer-picker-view");
    const frameSynced = this.focusFrameHost === host &&
      host.classList.contains("zen-writer-focus-frame-host") &&
      this.focusFrameEl !== null;

    return viewSynced && frameSynced && scroller.clientHeight > 0;
  }

  private attemptPickerRecovery(trigger: ZenWriterCenterTrigger): void {
    if (!this.settings.enabled) {
      this.clearPickerRecovery();
      return;
    }

    // 尝试同步
    const synced = this.trySyncPickerImmediate();

    if (synced) {
      // 同步成功
      this.clearPickerRecovery();
      this.scheduleViewportRefresh(trigger);
      return;
    }

    // 未成功，继续重试
    if (this.pickerRecoveryAttempts < PICKER_RECOVERY_MAX_ATTEMPTS) {
      this.pickerRecoveryAttempts += 1;
      const delay = this.pickerRecoveryAttempts <= 5 ? 16 : PICKER_RECOVERY_DELAY_MS;
      this.pickerRecoveryTimer = window.setTimeout(() => {
        this.pickerRecoveryTimer = null;
        this.attemptPickerRecovery(trigger);
      }, delay);
    } else {
      // 达到最大重试次数，强制同步一次
      this.clearPickerRecovery();
      this.syncPickerViewScope();
      this.syncFocusFrame();
      this.scheduleViewportRefresh(trigger);
    }
  }

  private clearPickerRecovery(): void {
    if (this.pickerRecoveryTimer !== null) {
      window.clearTimeout(this.pickerRecoveryTimer);
      this.pickerRecoveryTimer = null;
    }
    this.pickerRecoveryAttempts = 0;
  }

  private startPickerHealthCheck(): void {
    this.stopPickerHealthCheck();
    if (!this.settings.enabled) {
      return;
    }
    // 每 300ms 检查一次 picker 状态（更频繁）
    this.pickerHealthCheckInterval = window.setInterval(() => {
      if (!this.settings.enabled || this.isComposing) {
        return;
      }
      const view = this.getActiveMarkdownView();
      if (!view) {
        return;
      }
      const sourceView = this.getActiveSourceViewRoot(view);
      const host = this.getActiveEditorHost(view);

      if (!(sourceView instanceof HTMLElement) || !(host instanceof HTMLElement)) {
        return;
      }

      let needsSync = false;

      // 检查 pickerViewRoot 是否正确
      if (this.pickerViewRoot !== sourceView) {
        needsSync = true;
      }
      // 检查 focusFrameHost 是否正确
      if (this.focusFrameHost !== host) {
        needsSync = true;
      }
      // 检查类是否存在
      if (!sourceView.classList.contains("zen-writer-picker-view")) {
        needsSync = true;
      }
      if (!host.classList.contains("zen-writer-focus-frame-host")) {
        needsSync = true;
      }
      // 检查 frame 元素是否存在
      if (!this.focusFrameEl || !host.contains(this.focusFrameEl)) {
        needsSync = true;
      }

      if (needsSync) {
        this.trySyncPickerImmediate();
      }
    }, 300);
  }

  private stopPickerHealthCheck(): void {
    if (this.pickerHealthCheckInterval !== null) {
      window.clearInterval(this.pickerHealthCheckInterval);
      this.pickerHealthCheckInterval = null;
    }
  }

  private scheduleFocusFrameResync(): void {
    if (!this.settings.enabled) {
      return;
    }

    if (this.focusFrameResyncTimer !== null || this.focusFrameResyncAttempts >= FOCUS_FRAME_RESYNC_MAX_ATTEMPTS) {
      return;
    }

    this.focusFrameResyncAttempts += 1;
    this.focusFrameResyncTimer = window.setTimeout(() => {
      this.focusFrameResyncTimer = null;
      this.scheduleViewportRefresh("selection");
    }, FOCUS_FRAME_RESYNC_DELAY_MS);
  }

  private clearFocusFrameResync(): void {
    if (this.focusFrameResyncTimer !== null) {
      window.clearTimeout(this.focusFrameResyncTimer);
      this.focusFrameResyncTimer = null;
    }

    this.focusFrameResyncAttempts = 0;
  }

  private getCenterPriority(trigger: ZenWriterCenterTrigger): number {
    switch (trigger) {
      case "typing":
        return 2;
      case "selection":
      case "open":
        return 3;
      case "pointer":
      case "navigation":
      case "resize":
      case "wheel":
      default:
        return 1;
    }
  }

  private centerActiveCursor(): void {
    if (!this.settings.enabled) {
      return;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      this.schedulePickerRecovery("selection");
      return;
    }

    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement) || scroller.clientHeight === 0) {
      this.schedulePickerRecovery("selection");
      return;
    }

    // 确保 picker 状态正确
    if (!this.trySyncPickerImmediate()) {
      this.schedulePickerRecovery("selection");
      return;
    }

    // 不要在这里恢复光标，让用户的输入保持自然

    // 必须先同步焦点框（这会恢复被 Obsidian 刷掉的 DOM Padding），然后再计算滚动！
    this.syncFocusFrame();

    if (this.scrollActiveLineToAnchor(view)) {
      this.syncFocusFrame();
      return;
    }

    const cursor = view.editor.getCursor();
    view.editor.scrollIntoView({ from: cursor, to: cursor }, true);
  }

  private getCenterDelay(trigger: ZenWriterCenterTrigger): number {
    switch (trigger) {
      case "typing":
        return this.settings.centerDelayMs;
      case "navigation":
        return 0;
      case "pointer":
        return 0;
      case "wheel":
        return 0;
      case "open":
        return 0;
      case "resize":
        return 8;
      case "selection":
      default:
        return 0;
    }
  }

  private getActiveMarkdownView(): MarkdownView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return null;
    }

    if (typeof view.getMode === "function" && view.getMode() !== "source") {
      return null;
    }

    return view;
  }

  private getActiveEditorHost(view: MarkdownView): HTMLElement | null {
    const host = view.containerEl.querySelector(".markdown-source-view.mod-cm6 .cm-editor");
    return host instanceof HTMLElement ? host : null;
  }

  private getActiveSourceViewRoot(view: MarkdownView): HTMLElement | null {
    const sourceView = view.containerEl.querySelector(".markdown-source-view.mod-cm6");
    return sourceView instanceof HTMLElement ? sourceView : null;
  }

  private syncPickerViewScope(): HTMLElement | null {
    const view = this.getActiveMarkdownView();
    const sourceView = view ? this.getActiveSourceViewRoot(view) : null;

    if (!this.settings.enabled || !(sourceView instanceof HTMLElement)) {
      this.clearPickerViewScope();
      return null;
    }

    // 如果已经是正确的 view，确保类存在
    if (this.pickerViewRoot === sourceView) {
      if (!sourceView.classList.contains("zen-writer-picker-view")) {
        sourceView.classList.add("zen-writer-picker-view");
      }
      return sourceView;
    }

    // 清理旧的 view
    if (this.pickerViewRoot && this.pickerViewRoot !== sourceView) {
      this.pickerViewRoot.classList.remove("zen-writer-picker-view");
      this.pickerViewRoot = null;
    }

    // 设置新的 view
    sourceView.classList.add("zen-writer-picker-view");
    this.pickerViewRoot = sourceView;
    return sourceView;
  }

  private clearPickerViewScope(): void {
    this.pickerViewRoot?.classList.remove("zen-writer-picker-view");
    this.pickerViewRoot = null;
  }

  private handlePointerBrowse(event: MouseEvent): void {
    if (!this.settings.enabled || this.isComposing || event.button !== 0) {
      return;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      return;
    }

    this.rememberCursorForView(view);

    const sourceView = this.getActiveSourceViewRoot(view);
    const target = event.target;
    if (!(sourceView instanceof HTMLElement) || !(target instanceof Node)) {
      return;
    }

    if (!sourceView.contains(target)) {
      window.requestAnimationFrame(() => {
        this.schedulePickerRecovery("selection");
      });
      return;
    }

    window.requestAnimationFrame(() => {
      const editorView = this.getCodeMirrorView(view);
      if (!editorView) {
        return;
      }

      const offset = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
      if (typeof offset === "number") {
        const nextCursor = view.editor.offsetToPos(offset);
        const currentCursor = view.editor.getCursor();
        if (nextCursor.line !== currentCursor.line || nextCursor.ch !== currentCursor.ch) {
          this.markProgrammaticSelection(view, nextCursor);
          view.editor.setCursor(nextCursor);
        }
      }

      this.scheduleViewportRefresh("pointer");
    });
  }

  private handlePickerScroll(event: Event): void {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      return;
    }

    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement) || event.target !== scroller) {
      return;
    }

    if (
      this.pendingProgrammaticScrollEl === scroller &&
      this.pendingProgrammaticScrollTop !== null &&
      Math.abs(scroller.scrollTop - this.pendingProgrammaticScrollTop) < 1
    ) {
      this.clearPendingProgrammaticScroll();
      return;
    }

    if (this.pendingProgrammaticScrollEl === scroller) {
      this.clearPendingProgrammaticScroll();
    }

    window.requestAnimationFrame(() => {
      const nextCursor = this.getCursorAtAnchorOffset(view, scroller, 0);
      if (!nextCursor) {
        return;
      }

      const currentCursor = view.editor.getCursor();
      if (nextCursor.line !== currentCursor.line || nextCursor.ch !== currentCursor.ch) {
        this.markProgrammaticSelection(view, nextCursor);
        view.editor.setCursor(nextCursor);
      }

      this.scheduleViewportRefresh("wheel");
    });
  }

  private getCodeMirrorView(view: MarkdownView): CodeMirrorViewLike | null {
    const editorWithCodeMirror = view.editor as typeof view.editor & { cm?: CodeMirrorViewLike };
    if (
      editorWithCodeMirror.cm &&
      typeof editorWithCodeMirror.cm.posAtCoords === "function" &&
      typeof editorWithCodeMirror.cm.coordsAtPos === "function"
    ) {
      return editorWithCodeMirror.cm;
    }

    const hostWithCodeMirror = this.getActiveEditorHost(view) as
      | (HTMLElement & { cmView?: { view?: CodeMirrorViewLike } })
      | null;
    const hostView = hostWithCodeMirror?.cmView?.view;
    if (hostView && typeof hostView.posAtCoords === "function" && typeof hostView.coordsAtPos === "function") {
      return hostView;
    }

    const contentWithCodeMirror = this.getActiveSourceViewRoot(view)?.querySelector(".cm-content") as
      | (HTMLElement & { cmView?: { view?: CodeMirrorViewLike } })
      | null;
    const contentView = contentWithCodeMirror?.cmView?.view;
    if (
      contentView &&
      typeof contentView.posAtCoords === "function" &&
      typeof contentView.coordsAtPos === "function"
    ) {
      return contentView;
    }

    return null;
  }

  private getCursorRect(view: MarkdownView): RectLike | null {
    const editorView = this.getCodeMirrorView(view);
    if (!editorView) {
      return null;
    }

    const cursorOffset = view.editor.posToOffset(view.editor.getCursor());
    return editorView.coordsAtPos(cursorOffset);
  }

  private getEstimatedLineHeight(view: MarkdownView): number {
    const cursorRect = this.getCursorRect(view);
    if (cursorRect) {
      const cursorHeight = cursorRect.bottom - cursorRect.top;
      if (cursorHeight > 0) {
        return cursorHeight;
      }
    }

    const sourceView = this.getActiveSourceViewRoot(view);
    const activeLine = sourceView?.querySelector(".cm-activeLine");

    if (activeLine instanceof HTMLElement) {
      const computedLineHeight = Number.parseFloat(window.getComputedStyle(activeLine).lineHeight);
      if (Number.isFinite(computedLineHeight) && computedLineHeight > 0) {
        return computedLineHeight;
      }

      const rect = activeLine.getBoundingClientRect();
      if (rect.height > 0) {
        return rect.height;
      }
    }

    return 24;
  }

  private normalizeWheelDelta(deltaY: number, deltaMode: number, scroller: HTMLElement, lineHeight: number): number {
    switch (deltaMode) {
      case WheelEvent.DOM_DELTA_LINE:
        return deltaY * lineHeight;
      case WheelEvent.DOM_DELTA_PAGE:
        return deltaY * scroller.clientHeight;
      case WheelEvent.DOM_DELTA_PIXEL:
      default:
        return deltaY;
    }
  }

  private getAnchorPoint(view: MarkdownView, scroller: HTMLElement, deltaPx = 0): { x: number; y: number } | null {
    const sourceView = this.getActiveSourceViewRoot(view);
    const scrollerRect = scroller.getBoundingClientRect();
    if (scrollerRect.width === 0 || scrollerRect.height === 0) {
      return null;
    }

    const content = sourceView?.querySelector(".cm-content");
    const contentRect = content instanceof HTMLElement ? content.getBoundingClientRect() : null;
    const cursorRect = this.getCursorRect(view);
    const inset = 12;

    const minX = contentRect ? contentRect.left + inset : scrollerRect.left + inset;
    const maxX = contentRect ? Math.max(minX, contentRect.right - inset) : scrollerRect.right - inset;
    const fallbackX = contentRect ? minX : scrollerRect.left + Math.min(scrollerRect.width * 0.35, 72);
    const preferredX = cursorRect ? cursorRect.left + Math.max(1, (cursorRect.right - cursorRect.left) / 2) : fallbackX;
    const baseY = window.innerHeight * this.getAnchorRatio();

    return {
      x: this.clamp(preferredX, minX, maxX),
      y: this.clamp(baseY + deltaPx, scrollerRect.top + 1, scrollerRect.bottom - 1),
    };
  }

  private getCursorAtAnchorOffset(view: MarkdownView, scroller: HTMLElement, deltaPx: number): EditorCursor | null {
    const editorView = this.getCodeMirrorView(view);
    const anchorPoint = this.getAnchorPoint(view, scroller, deltaPx);
    if (!editorView || !anchorPoint) {
      return null;
    }

    const offset = editorView.posAtCoords(anchorPoint);
    if (typeof offset !== "number") {
      return null;
    }

    return view.editor.offsetToPos(offset);
  }

  private moveCursorByLineDelta(view: MarkdownView, lineDelta: number): boolean {
    if (lineDelta === 0) {
      return false;
    }

    const currentCursor = view.editor.getCursor();
    const maxLine = Math.max(0, view.editor.lineCount() - 1);
    const nextLine = this.clamp(Math.round(currentCursor.line + lineDelta), 0, maxLine);
    if (nextLine === currentCursor.line) {
      return false;
    }

    const nextLineText = view.editor.getLine(nextLine);
    const nextCh = Math.min(currentCursor.ch, nextLineText.length);
    const nextCursor = { line: nextLine, ch: nextCh };
    this.markProgrammaticSelection(view, nextCursor);
    view.editor.setCursor(nextCursor);
    return true;
  }

  private moveCursorWithWheelDelta(view: MarkdownView, scroller: HTMLElement, deltaPx: number): boolean {
    const lineHeight = this.getEstimatedLineHeight(view);
    if (deltaPx === 0) {
      return false;
    }

    const direction = Math.sign(deltaPx);
    if (direction !== 0 && direction !== this.lastWheelDirection) {
      this.wheelBrowseCarryPx = 0;
    }

    this.lastWheelDirection = direction;

    const currentCursor = view.editor.getCursor();
    const accumulatedDelta = this.wheelBrowseCarryPx + deltaPx;
    const nextCursor = this.getCursorAtAnchorOffset(view, scroller, accumulatedDelta);

    if (
      nextCursor &&
      (nextCursor.line !== currentCursor.line || nextCursor.ch !== currentCursor.ch)
    ) {
      this.markProgrammaticSelection(view, nextCursor);
      view.editor.setCursor(nextCursor);
      this.resetWheelBrowseCarry();
      return true;
    }

    this.wheelBrowseCarryPx = this.clamp(accumulatedDelta, -scroller.clientHeight, scroller.clientHeight);
    const lineDelta = Math.trunc(this.wheelBrowseCarryPx / Math.max(1, lineHeight));
    if (!this.moveCursorByLineDelta(view, lineDelta)) {
      return false;
    }

    this.wheelBrowseCarryPx -= lineDelta * Math.max(1, lineHeight);
    return true;
  }

  private scheduleWheelBrowse(deltaPx: number): void {
    this.pendingWheelDeltaPx = this.clamp(
      this.pendingWheelDeltaPx + deltaPx,
      -WHEEL_BROWSE_MAX_MOMENTUM_PX,
      WHEEL_BROWSE_MAX_MOMENTUM_PX,
    );
    if (this.wheelBrowseFrame !== null) {
      return;
    }

    this.wheelBrowseFrame = window.requestAnimationFrame(() => {
      this.flushWheelBrowse();
    });
  }

  private flushWheelBrowse(): void {
    this.wheelBrowseFrame = null;

    if (Math.abs(this.pendingWheelDeltaPx) < WHEEL_BROWSE_STOP_EPSILON_PX) {
      this.pendingWheelDeltaPx = 0;
      return;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      this.pendingWheelDeltaPx = 0;
      return;
    }

    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement)) {
      this.pendingWheelDeltaPx = 0;
      return;
    }

    const lineHeight = this.getEstimatedLineHeight(view);
    const frameDelta = this.clamp(
      this.pendingWheelDeltaPx * WHEEL_BROWSE_DAMPING,
      -lineHeight * WHEEL_BROWSE_MAX_FRAME_LINES,
      lineHeight * WHEEL_BROWSE_MAX_FRAME_LINES,
    );

    this.pendingWheelDeltaPx -= frameDelta;
    if (Math.abs(this.pendingWheelDeltaPx) < WHEEL_BROWSE_STOP_EPSILON_PX) {
      this.pendingWheelDeltaPx = 0;
    }

    if (frameDelta !== 0 && this.moveCursorWithWheelDelta(view, scroller, frameDelta)) {
      this.scheduleViewportRefresh("wheel");
    }

    if (this.pendingWheelDeltaPx !== 0) {
      this.wheelBrowseFrame = window.requestAnimationFrame(() => {
        this.flushWheelBrowse();
      });
    }
  }

  private handleWheelBrowse(event: WheelEvent): void {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }

    if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      return;
    }

    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");
    const target = event.target;

    if (!(sourceView instanceof HTMLElement) || !(scroller instanceof HTMLElement) || !(target instanceof Node)) {
      return;
    }

    if (!sourceView.contains(target)) {
      return;
    }

    event.preventDefault();
    const deltaPx = this.normalizeWheelDelta(event.deltaY, event.deltaMode, scroller, this.getEstimatedLineHeight(view));
    this.scheduleWheelBrowse(deltaPx);
  }

  private handleMouseDown(event: MouseEvent | PointerEvent): void {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    // Prevent double execution for mousedown that follows pointerdown
    if (event.type === "mousedown" && Date.now() - this.lastPointerDownTime < 100) {
      const physicalAnchor = window.innerHeight * 0.5;
      const clickY = event.clientY;
      const safeZoneHalfHeight = window.innerHeight * 0.35;

      const sourceView = this.getActiveSourceViewRoot(this.getActiveMarkdownView()!);
      const content = sourceView?.querySelector(".cm-content");
      const contentRect = content instanceof HTMLElement ? content.getBoundingClientRect() : null;

      let isOutside = true;
      if (contentRect) {
        const isInsideHorizontally = event.clientX >= contentRect.left && event.clientX <= contentRect.right;
        const isInsideVertically = Math.abs(clickY - physicalAnchor) <= safeZoneHalfHeight;
        isOutside = !(isInsideHorizontally && isInsideVertically);
      } else {
        isOutside = Math.abs(clickY - physicalAnchor) > safeZoneHalfHeight;
      }

      if (isOutside) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
      }
      return;
    }

    if (event.type === "pointerdown") {
      this.lastPointerDownTime = Date.now();
    }

    const view = this.getActiveMarkdownView();
    if (!view) return;

    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");

    if (!(sourceView instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Node) || !sourceView.contains(target)) {
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    if (event.clientX >= scrollerRect.right - 20) {
      return;
    }

    const content = sourceView.querySelector(".cm-content");
    const contentRect = content instanceof HTMLElement ? content.getBoundingClientRect() : null;

    const physicalAnchor = window.innerHeight * 0.5;
    const clickY = event.clientY;
    const clickX = event.clientX;

    const safeZoneHalfHeight = window.innerHeight * 0.35;

    let isOutside = true;
    if (contentRect) {
      const isInsideHorizontally = clickX >= contentRect.left && clickX <= contentRect.right;
      const isInsideVertically = Math.abs(clickY - physicalAnchor) <= safeZoneHalfHeight;
      isOutside = !(isInsideHorizontally && isInsideVertically);
    } else {
      isOutside = Math.abs(clickY - physicalAnchor) > safeZoneHalfHeight;
    }

    if (isOutside) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();

      const lineDelta = clickY < physicalAnchor ? -1 : 1;
      this.moveCursorByLineDelta(view, lineDelta);
      view.editor.focus();
      this.scheduleViewportRefresh("pointer");
    }
  }

  private clearWheelBrowseFrame(): void {
    if (this.wheelBrowseFrame !== null) {
      window.cancelAnimationFrame(this.wheelBrowseFrame);
      this.wheelBrowseFrame = null;
    }

    this.pendingWheelDeltaPx = 0;
  }

  private resetWheelBrowseCarry(): void {
    this.wheelBrowseCarryPx = 0;
    this.lastWheelDirection = 0;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private scrollActiveLineToAnchor(view: MarkdownView): boolean {
    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");
    const activeLine = sourceView?.querySelector(".cm-activeLine") ?? sourceView?.querySelector(".zen-writer-persistent-active");
    const cursorRect = this.getCursorRect(view);
    const lineRect = activeLine instanceof HTMLElement ? activeLine.getBoundingClientRect() : null;

    if (!(scroller instanceof HTMLElement)) {
      return false;
    }

    if (scroller.clientHeight === 0) {
      return false;
    }

    const anchorRect = cursorRect ?? lineRect;
    if (!anchorRect) {
      return false;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const currentAnchor = anchorRect.top - scrollerRect.top + (anchorRect.bottom - anchorRect.top) / 2;
    const targetAnchor = window.innerHeight * this.getAnchorRatio() - scrollerRect.top;
    const delta = currentAnchor - targetAnchor;

    if (Math.abs(delta) < 2) {
      return true;
    }

    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextScrollTop = Math.min(maxScrollTop, Math.max(0, scroller.scrollTop + delta));
    if (Math.abs(nextScrollTop - scroller.scrollTop) >= 0.5) {
      this.pendingProgrammaticScrollEl = scroller;
      this.pendingProgrammaticScrollTop = nextScrollTop;
      scroller.scrollTop = nextScrollTop;
    }

    return true;
  }

  private getAnchorRatio(): number {
    return 0.5;
  }

  private syncFocusFrame(): void {
    if (!this.settings.enabled) {
      this.clearFocusFrameResync();
      this.clearFocusFrameEdgeSpacing();
      this.clearPickerViewScope();
      this.clearFocusFrame();
      return;
    }

    const view = this.getActiveMarkdownView();
    if (!view) {
      this.clearFocusFrame();
      this.scheduleFocusFrameResync();
      return;
    }

    const host = this.getActiveEditorHost(view);
    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView?.querySelector(".cm-scroller");

    if (!(host instanceof HTMLElement) || !(sourceView instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      this.clearFocusFrame();
      this.scheduleFocusFrameResync();
      return;
    }

    const activeLine = sourceView.querySelector(".cm-activeLine");
    if (activeLine instanceof HTMLElement) {
      sourceView.querySelectorAll(".zen-writer-persistent-active").forEach((el) => {
        if (el !== activeLine) el.classList.remove("zen-writer-persistent-active");
      });
      activeLine.classList.add("zen-writer-persistent-active");
    }

    // 确保 pickerViewScope 已设置
    if (!this.pickerViewRoot || this.pickerViewRoot !== sourceView || !sourceView.classList.contains("zen-writer-picker-view")) {
      this.syncPickerViewScope();
    }

    // 如果 host 改变，或者 Obsidian 重建了 DOM 脱落了 class，清理旧的并创建新的
    if (this.focusFrameHost !== host || !host.classList.contains("zen-writer-focus-frame-host") || !host.querySelector(".zen-writer-focus-frame")) {
      this.clearFocusFrame();
      host.classList.add("zen-writer-focus-frame-host");
      const frame = document.createElement("div");
      frame.className = "zen-writer-focus-frame";
      frame.setAttribute("aria-hidden", "true");
      host.appendChild(frame);
      this.focusFrameHost = host;
      this.focusFrameEl = frame;
    }

    if (!this.updateFocusFrameGeometry(view, host, scroller)) {
      this.scheduleFocusFrameResync();
      return;
    }

    this.clearFocusFrameResync();
  }

  private updateFocusFrameGeometry(view: MarkdownView, host: HTMLElement, scroller: HTMLElement): boolean {
    if (!this.focusFrameEl) {
      return false;
    }

    const hostRect = host.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    if (hostRect.width === 0 || scrollerRect.width === 0 || scroller.clientHeight === 0) {
      return false;
    }

    const height = this.settings.pickerFrameHeightPx;
    const physicalAnchor = window.innerHeight * 0.5;

    const hostRelativeAnchor = physicalAnchor - hostRect.top;
    const scrollerRelativeAnchor = physicalAnchor - scrollerRect.top;

    document.body.style.setProperty("--zen-writer-editor-anchor", `${Math.round(hostRelativeAnchor)}px`);
    document.body.style.setProperty("--zen-writer-scroller-anchor", `${Math.round(scrollerRelativeAnchor)}px`);

    const top = Math.max(0, hostRelativeAnchor - height / 2);
    const left = Math.max(0, scrollerRect.left - hostRect.left + this.settings.pickerPaddingX);
    const width = Math.max(0, scrollerRect.width - this.settings.pickerPaddingX * 2);

    this.focusFrameEl.style.top = `${top}px`;
    this.focusFrameEl.style.left = `${left}px`;
    this.focusFrameEl.style.width = `${width}px`;
    this.focusFrameEl.style.height = `${height}px`;

    this.updateFocusFrameEdgeSpacing(view, scroller);
    return true;
  }

  private updateFocusFrameEdgeSpacing(view: MarkdownView, scroller: HTMLElement): void {
    const lineHeight = this.getEstimatedLineHeight(view);
    const scrollerRect = scroller.getBoundingClientRect();
    const physicalAnchor = window.innerHeight * 0.5;
    const topSpace = Math.max(0, physicalAnchor - scrollerRect.top - lineHeight / 2);
    const bottomSpace = Math.max(0, scrollerRect.bottom - physicalAnchor - lineHeight / 2);

    document.body.style.setProperty("--zen-writer-focus-frame-edge-top", `${Math.round(topSpace)}px`);
    document.body.style.setProperty("--zen-writer-focus-frame-edge-bottom", `${Math.round(bottomSpace)}px`);
  }

  private clearFocusFrameEdgeSpacing(): void {
    document.body.style.removeProperty("--zen-writer-focus-frame-edge-top");
    document.body.style.removeProperty("--zen-writer-focus-frame-edge-bottom");
  }

  private clearFocusFrame(): void {
    if (this.focusFrameEl) {
      this.focusFrameEl.remove();
      this.focusFrameEl = null;
    }
    if (this.focusFrameHost) {
      this.focusFrameHost.classList.remove("zen-writer-focus-frame-host");
      this.focusFrameHost = null;
    }
  }

  private ribbonIconEl: HTMLElement | null = null;

  private registerRibbonIcon(): void {
    const t = I18N[this.settings.language] || I18N.en;
    if (this.ribbonIconEl) {
      this.ribbonIconEl.setAttribute("aria-label", t.ribbonTooltip);
      return;
    }
    this.ribbonIconEl = this.addRibbonIcon("pen-tool", t.ribbonTooltip, async () => {
      await this.toggleZenWriter();
    });
  }

  private registerCommands(): void {
    const t = I18N[this.settings.language] || I18N.en;
    
    // Attempt to remove existing commands to avoid duplicates during language hot-swap
    try {
      const commands = (this.app as any).commands;
      if (commands) {
        commands.removeCommand(`${this.manifest.id}:toggle-zen-writer`);
        commands.removeCommand(`${this.manifest.id}:exit-zen-writer`);
      }
    } catch (e) {
      // Fail silently if command management fails
    }

    this.addCommand({
      id: "toggle-zen-writer",
      name: t.commandToggle,
      callback: async () => {
        await this.toggleZenWriter();
      },
    });
  }
}

const I18N = {
  en: {
    language: "Language",
    languageDesc: "Choose the display language for settings.",
    themeDisplay: "Editor Paper Theme",
    themeDisplayDesc: "Choose a background color palette for the writing canvas.",
    themeDefault: "System Default",
    themeSepia: "Sepia / Warm",
    themeGreen: "Mint Green",
    themeDark: "Dark Night",
    activeLineGlow: "Active line background",
    activeLineGlowDesc: "Highlight the current line with a subtle background.",
    contentWidth: "Content width",
    contentWidthDesc: "Any valid CSS width value, such as 42rem or 720px.",
    dimOpacity: "Background line opacity",
    dimOpacityDesc: "Lower values make lines outside the picker center fade more.",
    centerDelay: "Centering delay",
    centerDelayDesc: "A small delay can make text entry feel smoother while the picker recenters.",
    pickerHeight: "Picker window height",
    pickerHeightDesc: "Sets the height of the centered picker window.",
    pickerPadding: "Picker side padding",
    pickerPaddingDesc: "Adds horizontal inset so the picker window does not touch the editor edges.",
    restoreDefault: "Restore default",
    ribbonTooltip: "Enter Zen Writing Mode",
    commandToggle: "Enter/Exit Zen Writing Mode",
    showExitButton: "Show top exit button",
    showExitButtonDesc: "Display a minimal 'X' button at the top that appears on hover to exit Zen mode.",
  },
  zh: {
    language: "语言",
    languageDesc: "选择设置界面的显示语言。",
    themeDisplay: "编辑器纸张背景",
    themeDisplayDesc: "选择令你舒适的沉浸式背景底色调色板。",
    themeDefault: "系统默认",
    themeSepia: "护眼黄 (Sepia)",
    themeGreen: "护眼绿 (Green)",
    themeDark: "深灰夜间 (Dark)",
    activeLineGlow: "启用当前行背景",
    activeLineGlowDesc: "使用微弱的背景来显示当前光标所在行。",
    contentWidth: "正文内容最大宽度",
    contentWidthDesc: "可以使用任何合法的 CSS 宽度值，例如 42rem 或 720px。",
    dimOpacity: "背景行褪色透明度",
    dimOpacityDesc: "数值越小，非中心区域的文字就会越暗淡。",
    centerDelay: "居中延迟防抖",
    centerDelayDesc: "稍微增加一点延迟可以让打字时的居中过渡更加平滑顺畅。",
    pickerHeight: "中心聚焦高度",
    pickerHeightDesc: "设置居中区域未被过度虚化遮挡的窗口高度。",
    pickerPadding: "聚焦带左右内边距",
    pickerPaddingDesc: "增加水平边距，避免居中聚焦带的高亮边缘直接贴住编辑器两侧。",
    restoreDefault: "恢复默认值",
    ribbonTooltip: "进入禅意写作模式",
    commandToggle: "进入/退出禅意写作模式",
    showExitButton: "显示顶部退出按钮",
    showExitButtonDesc: "在页面顶部显示一个极浅的 'X' 图标，仅在鼠标悬停在顶部时可见，点击可退出禅意模式。",
  }
};

class ZenWriterSettingTab extends PluginSettingTab {
  plugin: ZenWriterPlugin;

  constructor(app: ZenWriterPlugin["app"], plugin: ZenWriterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const t = I18N[this.plugin.settings.language] || I18N.en;

    containerEl.replaceChildren();

    const heading = document.createElement("h2");
    heading.textContent = "Zen Writer";
    containerEl.appendChild(heading);

    new Setting(containerEl)
      .setName(t.language)
      .setDesc(t.languageDesc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("en", "English")
          .addOption("zh", "简体中文")
          .setValue(this.plugin.settings.language)
          .onChange(async (value: "en" | "zh") => {
            this.plugin.settings.language = value;
            await this.plugin.saveSettings();
            this.plugin.applyZenState();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t.themeDisplay)
      .setDesc(t.themeDisplayDesc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("default", t.themeDefault)
          .addOption("sepia", t.themeSepia)
          .addOption("green", t.themeGreen)
          .addOption("dark", t.themeDark)
          .setValue(this.plugin.settings.themeDisplay)
          .onChange(async (value: "default" | "sepia" | "green" | "dark") => {
            this.plugin.settings.themeDisplay = value;
            await this.plugin.saveSettings();
            this.plugin.applyZenState();
          })
      );

    new Setting(containerEl)
      .setName(t.showExitButton)
      .setDesc(t.showExitButtonDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showExitButton).onChange(async (value) => {
          this.plugin.settings.showExitButton = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.activeLineGlow)
      .setDesc(t.activeLineGlowDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.activeLineGlow).onChange(async (value) => {
          this.plugin.settings.activeLineGlow = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(t.contentWidth)
      .setDesc(t.contentWidthDesc)
      .addText((text) =>
        text.setPlaceholder("42rem").setValue(this.plugin.settings.maxWidth).onChange(async (value) => {
          this.plugin.settings.maxWidth = value.trim() || DEFAULT_SETTINGS.maxWidth;
          await this.plugin.saveSettings();
        }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(async () => {
            this.plugin.settings.maxWidth = DEFAULT_SETTINGS.maxWidth;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t.dimOpacity)
      .setDesc(t.dimOpacityDesc)
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 0.55, 0.05)
          .setValue(this.plugin.settings.dimOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.dimOpacity = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(async () => {
            this.plugin.settings.dimOpacity = DEFAULT_SETTINGS.dimOpacity;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t.centerDelay)
      .setDesc(t.centerDelayDesc)
      .addSlider((slider) =>
        slider
          .setLimits(0, 200, 4)
          .setValue(this.plugin.settings.centerDelayMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.centerDelayMs = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(async () => {
            this.plugin.settings.centerDelayMs = DEFAULT_SETTINGS.centerDelayMs;
            await this.plugin.saveSettings();
            this.display();
          })
      );


    new Setting(containerEl)
      .setName(t.pickerHeight)
      .setDesc(t.pickerHeightDesc)
      .addSlider((slider) =>
        slider
          .setLimits(40, 120, 2)
          .setValue(this.plugin.settings.pickerFrameHeightPx)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pickerFrameHeightPx = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(async () => {
            this.plugin.settings.pickerFrameHeightPx = DEFAULT_SETTINGS.pickerFrameHeightPx;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t.pickerPadding)
      .setDesc(t.pickerPaddingDesc)
      .addSlider((slider) =>
        slider
          .setLimits(0, 48, 2)
          .setValue(this.plugin.settings.pickerPaddingX)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pickerPaddingX = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(async () => {
            this.plugin.settings.pickerPaddingX = DEFAULT_SETTINGS.pickerPaddingX;
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
