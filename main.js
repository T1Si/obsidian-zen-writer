var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => ZenWriterPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var WHEEL_BROWSE_DAMPING = 0.35;
var WHEEL_BROWSE_STOP_EPSILON_PX = 0.75;
var WHEEL_BROWSE_MAX_MOMENTUM_PX = 320;
var WHEEL_BROWSE_MAX_FRAME_LINES = 1.6;
var FOCUS_FRAME_RESYNC_DELAY_MS = 48;
var FOCUS_FRAME_RESYNC_MAX_ATTEMPTS = 8;
var PICKER_RECOVERY_DELAY_MS = 50;
var PICKER_RECOVERY_MAX_ATTEMPTS = 20;
var PICKER_SETTLE_FRAMES = 10;
var DEFAULT_SETTINGS = {
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
  showExitButton: true
};
var ZenWriterPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.rememberedCursors = /* @__PURE__ */ new Map();
    this.pickerViewRoot = null;
    this.centerTimer = null;
    this.centerFrame = null;
    this.statusBarItemEl = null;
    this.isComposing = false;
    this.pendingCenterTrigger = null;
    this.viewportRefreshFrame = null;
    this.pendingViewportTrigger = null;
    this.focusFrameHost = null;
    this.focusFrameEl = null;
    this.focusFrameResyncTimer = null;
    this.focusFrameResyncAttempts = 0;
    this.lastPointerDownTime = 0;
    this.pendingProgrammaticSelectionOffset = null;
    this.pendingProgrammaticScrollEl = null;
    this.pendingProgrammaticScrollTop = null;
    this.wheelBrowseFrame = null;
    this.pendingWheelDeltaPx = 0;
    this.wheelBrowseCarryPx = 0;
    this.lastWheelDirection = 0;
    this.pickerSettleFrame = null;
    this.pickerSettleFramesRemaining = 0;
    this.pickerRecoveryTimer = null;
    this.pickerRecoveryAttempts = 0;
    this.pickerHealthCheckInterval = null;
    this.zenExitButtonEl = null;
    this.zenExitTriggerEl = null;
    this.leftSidebarWasVisible = false;
    this.rightSidebarWasVisible = false;
    this.ribbonIconEl = null;
  }
  async onload() {
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
        this.rememberCursorForView(view);
        this.scheduleViewportRefresh("typing");
      })
    );
    this.registerDomEvent(document, "keydown", (event) => {
      if (!this.settings.enabled || this.isComposing) {
        return;
      }
      if (event.key === "Escape") {
        void this.exitZenMode().catch((_e) => {
          console.error("Zen Writer: Failed to exit via Escape", _e);
        });
        return;
      }
      const isNavigationKey = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "PageUp",
        "PageDown",
        "Home",
        "End"
      ].includes(event.key);
      if (isNavigationKey) {
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
        if (this.settings.enabled && this.settings.zenLockedFile) {
          const view = this.getActiveMarkdownView();
          const currentFile = view ? this.getViewFilePath(view) : null;
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
        this.clearFocusFrame();
        this.clearPickerViewScope();
        window.requestAnimationFrame(() => {
          this.trySyncPickerImmediate();
          window.requestAnimationFrame(() => {
            this.trySyncPickerImmediate();
            this.schedulePickerRecovery("selection");
          });
        });
      })
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
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (!this.settings.enabled) {
          return;
        }
        this.clearPickerRecovery();
        this.clearFocusFrame();
        this.clearPickerViewScope();
        window.requestAnimationFrame(() => {
          this.trySyncPickerImmediate();
          window.requestAnimationFrame(() => {
            this.trySyncPickerImmediate();
            this.schedulePickerRecovery("open");
          });
        });
      })
    );
    this.registerDomEvent(document, "compositionstart", () => {
      this.isComposing = true;
      this.clearCenterTimer();
    });
    this.registerDomEvent(document, "compositionend", () => {
      this.isComposing = false;
      this.scheduleViewportRefresh("typing");
    });
    this.registerDomEvent(window, "mouseup", (event) => {
      this.handlePointerBrowse(event);
    });
    this.registerDomEvent(
      document,
      "scroll",
      (event) => {
        this.handlePickerScroll(event);
      },
      true
    );
    this.registerDomEvent(
      document,
      "pointerdown",
      (event) => {
        this.handleMouseDown(event);
      },
      { capture: true }
    );
    this.registerDomEvent(
      document,
      "mousedown",
      (event) => {
        this.handleMouseDown(event);
      },
      { capture: true }
    );
    this.registerDomEvent(
      window,
      "wheel",
      (event) => {
        this.handleWheelBrowse(event);
      },
      { passive: false }
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
  onunload() {
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
  async loadSettings() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m;
    const rawSettings = await this.loadData() || {};
    this.settings = {
      language: (_a = rawSettings.language) != null ? _a : DEFAULT_SETTINGS.language,
      enabled: (_b = rawSettings.enabled) != null ? _b : DEFAULT_SETTINGS.enabled,
      maxWidth: (_c = rawSettings.maxWidth) != null ? _c : DEFAULT_SETTINGS.maxWidth,
      dimOpacity: (_d = rawSettings.dimOpacity) != null ? _d : DEFAULT_SETTINGS.dimOpacity,
      centerDelayMs: (_e = rawSettings.centerDelayMs) != null ? _e : DEFAULT_SETTINGS.centerDelayMs,
      pickerFrameHeightPx: (_g = (_f = rawSettings.pickerFrameHeightPx) != null ? _f : rawSettings.focusFrameHeightPx) != null ? _g : DEFAULT_SETTINGS.pickerFrameHeightPx,
      pickerPaddingX: (_i = (_h = rawSettings.pickerPaddingX) != null ? _h : rawSettings.focusFramePaddingX) != null ? _i : DEFAULT_SETTINGS.pickerPaddingX,
      zenLockedFile: (_j = rawSettings.zenLockedFile) != null ? _j : DEFAULT_SETTINGS.zenLockedFile,
      activeLineGlow: (_k = rawSettings.activeLineGlow) != null ? _k : DEFAULT_SETTINGS.activeLineGlow,
      themeDisplay: (_l = rawSettings.themeDisplay) != null ? _l : DEFAULT_SETTINGS.themeDisplay,
      showExitButton: (_m = rawSettings.showExitButton) != null ? _m : DEFAULT_SETTINGS.showExitButton
    };
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.applyZenState();
  }
  async toggleZenWriter() {
    if (this.settings.enabled) {
      await this.exitZenMode();
    } else {
      await this.enterZenMode();
    }
  }
  async enterZenMode() {
    const view = this.getActiveMarkdownView();
    if (!view) {
      return;
    }
    const filePath = this.getViewFilePath(view);
    if (!filePath) {
      return;
    }
    this.leftSidebarWasVisible = !this.app.workspace.leftSplit.collapsed;
    this.rightSidebarWasVisible = !this.app.workspace.rightSplit.collapsed;
    if (this.leftSidebarWasVisible) {
      this.app.workspace.leftSplit.collapse();
    }
    if (this.rightSidebarWasVisible) {
      this.app.workspace.rightSplit.collapse();
    }
    this.settings.enabled = true;
    this.settings.zenLockedFile = filePath;
    await this.saveSettings();
    this.applyZenState();
    this.createZenExitButton();
  }
  async exitZenMode() {
    this.settings.enabled = false;
    this.settings.zenLockedFile = null;
    if (this.leftSidebarWasVisible) {
      this.app.workspace.leftSplit.expand();
    }
    if (this.rightSidebarWasVisible) {
      this.app.workspace.rightSplit.expand();
    }
    this.removeZenExitButton();
    await this.saveSettings();
    this.applyZenState();
  }
  restoreLockedFile() {
    if (!this.settings.zenLockedFile) {
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(this.settings.zenLockedFile);
    if (!file) {
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof import_obsidian.MarkdownView && this.getViewFilePath(view) === this.settings.zenLockedFile) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    this.app.workspace.getLeaf(false).openFile(file);
  }
  createZenExitButton() {
    this.removeZenExitButton();
    if (!this.settings.showExitButton) {
      return;
    }
    const trigger = document.createElement("div");
    trigger.className = "zen-writer-exit-trigger";
    document.body.appendChild(trigger);
    this.zenExitTriggerEl = trigger;
    const button = document.createElement("div");
    button.className = "zen-writer-exit-button";
    (0, import_obsidian.setIcon)(button, "x");
    button.addEventListener("click", () => {
      void this.exitZenMode().catch(() => {
      });
    });
    document.body.appendChild(button);
    this.zenExitButtonEl = button;
    trigger.addEventListener("mouseenter", () => {
      button == null ? void 0 : button.classList.add("is-visible");
    });
    trigger.addEventListener("mouseleave", () => {
      if (button && !button.matches(":hover")) {
        button.classList.remove("is-visible");
      }
    });
    button.addEventListener("mouseenter", () => {
      button.classList.add("is-visible");
    });
    button.addEventListener("mouseleave", () => {
      button.classList.remove("is-visible");
    });
  }
  removeZenExitButton() {
    if (this.zenExitButtonEl) {
      this.zenExitButtonEl.remove();
      this.zenExitButtonEl = null;
    }
    if (this.zenExitTriggerEl) {
      this.zenExitTriggerEl.remove();
      this.zenExitTriggerEl = null;
    }
  }
  applyZenState() {
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
  scheduleViewportRefresh(trigger) {
    if (!this.settings.enabled) {
      return;
    }
    if (this.pendingViewportTrigger === null || this.getCenterPriority(trigger) >= this.getCenterPriority(this.pendingViewportTrigger)) {
      this.pendingViewportTrigger = trigger;
    }
    if (this.viewportRefreshFrame !== null) {
      return;
    }
    this.viewportRefreshFrame = window.requestAnimationFrame(() => {
      var _a;
      const nextTrigger = (_a = this.pendingViewportTrigger) != null ? _a : "selection";
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
  scheduleCentering(trigger) {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }
    if ((this.centerTimer !== null || this.centerFrame !== null) && this.pendingCenterTrigger !== null && this.getCenterPriority(trigger) < this.getCenterPriority(this.pendingCenterTrigger)) {
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
  clearCenterTimer() {
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
  clearViewportRefreshFrame() {
    if (this.viewportRefreshFrame !== null) {
      window.cancelAnimationFrame(this.viewportRefreshFrame);
      this.viewportRefreshFrame = null;
    }
    this.pendingViewportTrigger = null;
  }
  schedulePickerSettle(trigger) {
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
  flushPickerSettle() {
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
  clearPickerSettleFrame() {
    if (this.pickerSettleFrame !== null) {
      window.cancelAnimationFrame(this.pickerSettleFrame);
      this.pickerSettleFrame = null;
    }
    this.pickerSettleFramesRemaining = 0;
  }
  clearPendingProgrammaticScroll() {
    this.pendingProgrammaticScrollEl = null;
    this.pendingProgrammaticScrollTop = null;
  }
  clearPendingProgrammaticSelection() {
    this.pendingProgrammaticSelectionOffset = null;
  }
  rememberActiveCursor() {
    const view = this.getActiveMarkdownView();
    if (view) {
      this.rememberCursorForView(view);
    }
  }
  markProgrammaticSelection(view, cursor) {
    this.pendingProgrammaticSelectionOffset = view.editor.posToOffset(cursor);
    this.rememberCursorForView(view, cursor);
  }
  getViewFilePath(view) {
    var _a;
    const file = view.file;
    return (_a = file == null ? void 0 : file.path) != null ? _a : null;
  }
  rememberCursorForView(view, cursor = view.editor.getCursor()) {
    const path = this.getViewFilePath(view);
    if (!path) {
      return;
    }
    this.rememberedCursors.set(path, { line: cursor.line, ch: cursor.ch });
  }
  restoreRememberedCursorForView(view) {
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
      ch: this.clamp(rememberedCursor.ch, 0, lineText.length)
    };
    const currentCursor = view.editor.getCursor();
    if (currentCursor.line === nextCursor.line && currentCursor.ch === nextCursor.ch) {
      return false;
    }
    this.markProgrammaticSelection(view, nextCursor);
    view.editor.setCursor(nextCursor);
    return true;
  }
  schedulePickerRecovery(trigger) {
    if (!this.settings.enabled) {
      this.clearPickerRecovery();
      return;
    }
    const synced = this.trySyncPickerImmediate();
    this.scheduleViewportRefresh(trigger);
    if (!synced && this.pickerRecoveryTimer === null) {
      this.pickerRecoveryAttempts = 0;
      this.attemptPickerRecovery(trigger);
    }
  }
  trySyncPickerImmediate() {
    if (!this.settings.enabled) {
      return false;
    }
    const view = this.getActiveMarkdownView();
    if (!view) {
      return false;
    }
    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
    const host = this.getActiveEditorHost(view);
    if (!(sourceView instanceof HTMLElement) || !(scroller instanceof HTMLElement) || !(host instanceof HTMLElement)) {
      return false;
    }
    if (this.focusFrameHost && this.focusFrameHost !== host) {
      this.clearFocusFrame();
    }
    if (this.pickerViewRoot && this.pickerViewRoot !== sourceView) {
      this.clearPickerViewScope();
    }
    const syncedView = this.syncPickerViewScope();
    this.syncFocusFrame();
    const viewSynced = syncedView === sourceView && sourceView.classList.contains("zen-writer-picker-view");
    const frameSynced = this.focusFrameHost === host && host.classList.contains("zen-writer-focus-frame-host") && this.focusFrameEl !== null;
    return viewSynced && frameSynced && scroller.clientHeight > 0;
  }
  attemptPickerRecovery(trigger) {
    if (!this.settings.enabled) {
      this.clearPickerRecovery();
      return;
    }
    const synced = this.trySyncPickerImmediate();
    if (synced) {
      this.clearPickerRecovery();
      this.scheduleViewportRefresh(trigger);
      return;
    }
    if (this.pickerRecoveryAttempts < PICKER_RECOVERY_MAX_ATTEMPTS) {
      this.pickerRecoveryAttempts += 1;
      const delay = this.pickerRecoveryAttempts <= 5 ? 16 : PICKER_RECOVERY_DELAY_MS;
      this.pickerRecoveryTimer = window.setTimeout(() => {
        this.pickerRecoveryTimer = null;
        this.attemptPickerRecovery(trigger);
      }, delay);
    } else {
      this.clearPickerRecovery();
      this.syncPickerViewScope();
      this.syncFocusFrame();
      this.scheduleViewportRefresh(trigger);
    }
  }
  clearPickerRecovery() {
    if (this.pickerRecoveryTimer !== null) {
      window.clearTimeout(this.pickerRecoveryTimer);
      this.pickerRecoveryTimer = null;
    }
    this.pickerRecoveryAttempts = 0;
  }
  startPickerHealthCheck() {
    this.stopPickerHealthCheck();
    if (!this.settings.enabled) {
      return;
    }
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
      if (this.pickerViewRoot !== sourceView) {
        needsSync = true;
      }
      if (this.focusFrameHost !== host) {
        needsSync = true;
      }
      if (!sourceView.classList.contains("zen-writer-picker-view")) {
        needsSync = true;
      }
      if (!host.classList.contains("zen-writer-focus-frame-host")) {
        needsSync = true;
      }
      if (!this.focusFrameEl || !host.contains(this.focusFrameEl)) {
        needsSync = true;
      }
      if (needsSync) {
        this.trySyncPickerImmediate();
      }
    }, 300);
  }
  stopPickerHealthCheck() {
    if (this.pickerHealthCheckInterval !== null) {
      window.clearInterval(this.pickerHealthCheckInterval);
      this.pickerHealthCheckInterval = null;
    }
  }
  scheduleFocusFrameResync() {
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
  clearFocusFrameResync() {
    if (this.focusFrameResyncTimer !== null) {
      window.clearTimeout(this.focusFrameResyncTimer);
      this.focusFrameResyncTimer = null;
    }
    this.focusFrameResyncAttempts = 0;
  }
  getCenterPriority(trigger) {
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
  centerActiveCursor() {
    if (!this.settings.enabled) {
      return;
    }
    const view = this.getActiveMarkdownView();
    if (!view) {
      this.schedulePickerRecovery("selection");
      return;
    }
    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement) || scroller.clientHeight === 0) {
      this.schedulePickerRecovery("selection");
      return;
    }
    if (!this.trySyncPickerImmediate()) {
      this.schedulePickerRecovery("selection");
      return;
    }
    this.syncFocusFrame();
    if (this.scrollActiveLineToAnchor(view)) {
      this.syncFocusFrame();
      return;
    }
    const cursor = view.editor.getCursor();
    view.editor.scrollIntoView({ from: cursor, to: cursor }, true);
  }
  getCenterDelay(trigger) {
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
  getActiveMarkdownView() {
    const view = this.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
    if (!view) {
      return null;
    }
    if (typeof view.getMode === "function" && view.getMode() !== "source") {
      return null;
    }
    return view;
  }
  getActiveEditorHost(view) {
    const host = view.containerEl.querySelector(".markdown-source-view.mod-cm6 .cm-editor");
    return host instanceof HTMLElement ? host : null;
  }
  getActiveSourceViewRoot(view) {
    const sourceView = view.containerEl.querySelector(".markdown-source-view.mod-cm6");
    return sourceView instanceof HTMLElement ? sourceView : null;
  }
  syncPickerViewScope() {
    const view = this.getActiveMarkdownView();
    const sourceView = view ? this.getActiveSourceViewRoot(view) : null;
    if (!this.settings.enabled || !(sourceView instanceof HTMLElement)) {
      this.clearPickerViewScope();
      return null;
    }
    if (this.pickerViewRoot === sourceView) {
      if (!sourceView.classList.contains("zen-writer-picker-view")) {
        sourceView.classList.add("zen-writer-picker-view");
      }
      return sourceView;
    }
    if (this.pickerViewRoot && this.pickerViewRoot !== sourceView) {
      this.pickerViewRoot.classList.remove("zen-writer-picker-view");
      this.pickerViewRoot = null;
    }
    sourceView.classList.add("zen-writer-picker-view");
    this.pickerViewRoot = sourceView;
    return sourceView;
  }
  clearPickerViewScope() {
    var _a;
    (_a = this.pickerViewRoot) == null ? void 0 : _a.classList.remove("zen-writer-picker-view");
    this.pickerViewRoot = null;
  }
  handlePointerBrowse(event) {
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
  handlePickerScroll(event) {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }
    const view = this.getActiveMarkdownView();
    if (!view) {
      return;
    }
    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement) || event.target !== scroller) {
      return;
    }
    if (this.pendingProgrammaticScrollEl === scroller && this.pendingProgrammaticScrollTop !== null && Math.abs(scroller.scrollTop - this.pendingProgrammaticScrollTop) < 1) {
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
  getCodeMirrorView(view) {
    var _a, _b, _c;
    const editorWithCodeMirror = view.editor;
    if (editorWithCodeMirror.cm && typeof editorWithCodeMirror.cm.posAtCoords === "function" && typeof editorWithCodeMirror.cm.coordsAtPos === "function") {
      return editorWithCodeMirror.cm;
    }
    const hostWithCodeMirror = this.getActiveEditorHost(view);
    const hostView = (_a = hostWithCodeMirror == null ? void 0 : hostWithCodeMirror.cmView) == null ? void 0 : _a.view;
    if (hostView && typeof hostView.posAtCoords === "function" && typeof hostView.coordsAtPos === "function") {
      return hostView;
    }
    const contentWithCodeMirror = (_b = this.getActiveSourceViewRoot(view)) == null ? void 0 : _b.querySelector(".cm-content");
    const contentView = (_c = contentWithCodeMirror == null ? void 0 : contentWithCodeMirror.cmView) == null ? void 0 : _c.view;
    if (contentView && typeof contentView.posAtCoords === "function" && typeof contentView.coordsAtPos === "function") {
      return contentView;
    }
    return null;
  }
  getCursorRect(view) {
    const editorView = this.getCodeMirrorView(view);
    if (!editorView) {
      return null;
    }
    const cursorOffset = view.editor.posToOffset(view.editor.getCursor());
    return editorView.coordsAtPos(cursorOffset);
  }
  getEstimatedLineHeight(view) {
    const cursorRect = this.getCursorRect(view);
    if (cursorRect) {
      const cursorHeight = cursorRect.bottom - cursorRect.top;
      if (cursorHeight > 0) {
        return cursorHeight;
      }
    }
    const sourceView = this.getActiveSourceViewRoot(view);
    const activeLine = sourceView == null ? void 0 : sourceView.querySelector(".cm-activeLine");
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
  normalizeWheelDelta(deltaY, deltaMode, scroller, lineHeight) {
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
  getAnchorPoint(view, scroller, deltaPx = 0) {
    const sourceView = this.getActiveSourceViewRoot(view);
    const scrollerRect = scroller.getBoundingClientRect();
    if (scrollerRect.width === 0 || scrollerRect.height === 0) {
      return null;
    }
    const content = sourceView == null ? void 0 : sourceView.querySelector(".cm-content");
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
      y: this.clamp(baseY + deltaPx, scrollerRect.top + 1, scrollerRect.bottom - 1)
    };
  }
  getCursorAtAnchorOffset(view, scroller, deltaPx) {
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
  moveCursorByLineDelta(view, lineDelta) {
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
  moveCursorWithWheelDelta(view, scroller, deltaPx) {
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
    if (nextCursor && (nextCursor.line !== currentCursor.line || nextCursor.ch !== currentCursor.ch)) {
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
  scheduleWheelBrowse(deltaPx) {
    this.pendingWheelDeltaPx = this.clamp(
      this.pendingWheelDeltaPx + deltaPx,
      -WHEEL_BROWSE_MAX_MOMENTUM_PX,
      WHEEL_BROWSE_MAX_MOMENTUM_PX
    );
    if (this.wheelBrowseFrame !== null) {
      return;
    }
    this.wheelBrowseFrame = window.requestAnimationFrame(() => {
      this.flushWheelBrowse();
    });
  }
  flushWheelBrowse() {
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
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
    if (!(scroller instanceof HTMLElement)) {
      this.pendingWheelDeltaPx = 0;
      return;
    }
    const lineHeight = this.getEstimatedLineHeight(view);
    const frameDelta = this.clamp(
      this.pendingWheelDeltaPx * WHEEL_BROWSE_DAMPING,
      -lineHeight * WHEEL_BROWSE_MAX_FRAME_LINES,
      lineHeight * WHEEL_BROWSE_MAX_FRAME_LINES
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
  handleWheelBrowse(event) {
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
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
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
  handleMouseDown(event) {
    if (!this.settings.enabled || this.isComposing) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (event.type === "mousedown" && Date.now() - this.lastPointerDownTime < 100) {
      const physicalAnchor2 = window.innerHeight * 0.5;
      const clickY2 = event.clientY;
      const safeZoneHalfHeight2 = window.innerHeight * 0.35;
      const sourceView2 = this.getActiveSourceViewRoot(this.getActiveMarkdownView());
      const content2 = sourceView2 == null ? void 0 : sourceView2.querySelector(".cm-content");
      const contentRect2 = content2 instanceof HTMLElement ? content2.getBoundingClientRect() : null;
      let isOutside2 = true;
      if (contentRect2) {
        const isInsideHorizontally = event.clientX >= contentRect2.left && event.clientX <= contentRect2.right;
        const isInsideVertically = Math.abs(clickY2 - physicalAnchor2) <= safeZoneHalfHeight2;
        isOutside2 = !(isInsideHorizontally && isInsideVertically);
      } else {
        isOutside2 = Math.abs(clickY2 - physicalAnchor2) > safeZoneHalfHeight2;
      }
      if (isOutside2) {
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
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
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
  clearWheelBrowseFrame() {
    if (this.wheelBrowseFrame !== null) {
      window.cancelAnimationFrame(this.wheelBrowseFrame);
      this.wheelBrowseFrame = null;
    }
    this.pendingWheelDeltaPx = 0;
  }
  resetWheelBrowseCarry() {
    this.wheelBrowseCarryPx = 0;
    this.lastWheelDirection = 0;
  }
  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  scrollActiveLineToAnchor(view) {
    var _a;
    const sourceView = this.getActiveSourceViewRoot(view);
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
    const activeLine = (_a = sourceView == null ? void 0 : sourceView.querySelector(".cm-activeLine")) != null ? _a : sourceView == null ? void 0 : sourceView.querySelector(".zen-writer-persistent-active");
    const cursorRect = this.getCursorRect(view);
    const lineRect = activeLine instanceof HTMLElement ? activeLine.getBoundingClientRect() : null;
    if (!(scroller instanceof HTMLElement)) {
      return false;
    }
    if (scroller.clientHeight === 0) {
      return false;
    }
    const anchorRect = cursorRect != null ? cursorRect : lineRect;
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
  getAnchorRatio() {
    return 0.5;
  }
  syncFocusFrame() {
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
    const scroller = sourceView == null ? void 0 : sourceView.querySelector(".cm-scroller");
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
    if (!this.pickerViewRoot || this.pickerViewRoot !== sourceView || !sourceView.classList.contains("zen-writer-picker-view")) {
      this.syncPickerViewScope();
    }
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
  updateFocusFrameGeometry(view, host, scroller) {
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
    this.focusFrameEl.style.setProperty("top", `${top}px`);
    this.focusFrameEl.style.setProperty("left", `${left}px`);
    this.focusFrameEl.style.setProperty("width", `${width}px`);
    this.focusFrameEl.style.setProperty("height", `${height}px`);
    this.updateFocusFrameEdgeSpacing(view, scroller);
    return true;
  }
  updateFocusFrameEdgeSpacing(view, scroller) {
    const lineHeight = this.getEstimatedLineHeight(view);
    const scrollerRect = scroller.getBoundingClientRect();
    const physicalAnchor = window.innerHeight * 0.5;
    const topSpace = Math.max(0, physicalAnchor - scrollerRect.top - lineHeight / 2);
    const bottomSpace = Math.max(0, scrollerRect.bottom - physicalAnchor - lineHeight / 2);
    document.body.style.setProperty("--zen-writer-focus-frame-edge-top", `${Math.round(topSpace)}px`);
    document.body.style.setProperty("--zen-writer-focus-frame-edge-bottom", `${Math.round(bottomSpace)}px`);
  }
  clearFocusFrameEdgeSpacing() {
    document.body.style.removeProperty("--zen-writer-focus-frame-edge-top");
    document.body.style.removeProperty("--zen-writer-focus-frame-edge-bottom");
  }
  clearFocusFrame() {
    if (this.focusFrameEl) {
      this.focusFrameEl.remove();
      this.focusFrameEl = null;
    }
    if (this.focusFrameHost) {
      this.focusFrameHost.classList.remove("zen-writer-focus-frame-host");
      this.focusFrameHost = null;
    }
  }
  registerRibbonIcon() {
    const t = I18N[this.settings.language] || I18N.en;
    if (this.ribbonIconEl) {
      this.ribbonIconEl.setAttribute("aria-label", t.ribbonTooltip);
      return;
    }
    this.ribbonIconEl = this.addRibbonIcon("pen-tool", t.ribbonTooltip, async () => {
      await this.toggleZenWriter();
    });
  }
  registerCommands() {
    const t = I18N[this.settings.language] || I18N.en;
    try {
      const commands = this.app.commands;
      if (commands) {
        commands.removeCommand("toggle-zen-writer");
        commands.removeCommand("exit-zen-writer");
      }
    } catch (_e) {
    }
    this.addCommand({
      id: "toggle-zen-writer",
      name: t.commandToggle,
      callback: () => {
        void this.toggleZenWriter().catch(() => {
        });
      }
    });
  }
};
var I18N = {
  en: {
    language: "Language",
    languageDesc: "Choose the display language for settings.",
    themeDisplay: "Editor paper theme",
    themeDisplayDesc: "Choose a background color palette for the writing canvas.",
    themeDefault: "System Default",
    themeSepia: "Sepia / warm",
    themeGreen: "Mint green",
    themeDark: "Dark night",
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
    ribbonTooltip: "Enter zen writing mode",
    commandToggle: "Enter/exit zen writing mode",
    showExitButton: "Show top exit button",
    showExitButtonDesc: "Display a minimal 'X' button at the top that appears on hover to exit zen mode."
  },
  zh: {
    language: "\u8BED\u8A00",
    languageDesc: "\u9009\u62E9\u8BBE\u7F6E\u754C\u9762\u7684\u663E\u793A\u8BED\u8A00\u3002",
    themeDisplay: "\u7F16\u8F91\u5668\u7EB8\u5F20\u80CC\u666F",
    themeDisplayDesc: "\u9009\u62E9\u4EE4\u4F60\u8212\u9002\u7684\u6C89\u6D78\u5F0F\u80CC\u666F\u5E95\u8272\u8C03\u8272\u677F\u3002",
    themeDefault: "\u7CFB\u7EDF\u9ED8\u8BA4",
    themeSepia: "\u62A4\u773C\u9EC4 (Sepia)",
    themeGreen: "\u62A4\u773C\u7EFF (Green)",
    themeDark: "\u6DF1\u7070\u591C\u95F4 (Dark)",
    activeLineGlow: "\u542F\u7528\u5F53\u524D\u884C\u80CC\u666F",
    activeLineGlowDesc: "\u4F7F\u7528\u5FAE\u5F31\u7684\u80CC\u666F\u6765\u663E\u793A\u5F53\u524D\u5149\u6807\u6240\u5728\u884C\u3002",
    contentWidth: "\u6B63\u6587\u5185\u5BB9\u6700\u5927\u5BBD\u5EA6",
    contentWidthDesc: "\u53EF\u4EE5\u4F7F\u7528\u4EFB\u4F55\u5408\u6CD5\u7684 CSS \u5BBD\u5EA6\u503C\uFF0C\u4F8B\u5982 42rem \u6216 720px\u3002",
    dimOpacity: "\u80CC\u666F\u884C\u892A\u8272\u900F\u660E\u5EA6",
    dimOpacityDesc: "\u6570\u503C\u8D8A\u5C0F\uFF0C\u975E\u4E2D\u5FC3\u533A\u57DF\u7684\u6587\u5B57\u5C31\u4F1A\u8D8A\u6697\u6DE1\u3002",
    centerDelay: "\u5C45\u4E2D\u5EF6\u8FDF\u9632\u6296",
    centerDelayDesc: "\u7A0D\u5FAE\u589E\u52A0\u4E00\u70B9\u5EF6\u8FDF\u53EF\u4EE5\u8BA9\u6253\u5B57\u65F6\u7684\u5C45\u4E2D\u8FC7\u6E21\u66F4\u52A0\u5E73\u6ED1\u987A\u7545\u3002",
    pickerHeight: "\u4E2D\u5FC3\u805A\u7126\u9AD8\u5EA6",
    pickerHeightDesc: "\u8BBE\u7F6E\u5C45\u4E2D\u533A\u57DF\u672A\u88AB\u8FC7\u5EA6\u865A\u5316\u906E\u6321\u7684\u7A97\u53E3\u9AD8\u5EA6\u3002",
    pickerPadding: "\u805A\u7126\u5E26\u5DE6\u53F3\u5185\u8FB9\u8DDD",
    pickerPaddingDesc: "\u589E\u52A0\u6C34\u5E73\u8FB9\u8DDD\uFF0C\u907F\u514D\u5C45\u4E2D\u805A\u7126\u5E26\u7684\u9AD8\u4EAE\u8FB9\u7F18\u76F4\u63A5\u8D34\u4F4F\u7F16\u8F91\u5668\u4E24\u4FA7\u3002",
    restoreDefault: "\u6062\u590D\u9ED8\u8BA4\u503C",
    ribbonTooltip: "\u8FDB\u5165\u7985\u610F\u5199\u4F5C\u6A21\u5F0F",
    commandToggle: "\u8FDB\u5165/\u9000\u51FA\u7985\u610F\u5199\u4F5C\u6A21\u5F0F",
    showExitButton: "\u663E\u793A\u9876\u90E8\u9000\u51FA\u6309\u94AE",
    showExitButtonDesc: "\u5728\u9875\u9762\u9876\u90E8\u663E\u793A\u4E00\u4E2A\u6781\u6D45\u7684 'X' \u56FE\u6807\uFF0C\u4EC5\u5728\u9F20\u6807\u60AC\u505C\u5728\u9876\u90E8\u65F6\u53EF\u89C1\uFF0C\u70B9\u51FB\u53EF\u9000\u51FA\u7985\u610F\u6A21\u5F0F\u3002"
  }
};
var ZenWriterSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const t = I18N[this.plugin.settings.language] || I18N.en;
    containerEl.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Zen Writer";
    containerEl.appendChild(heading);
    new import_obsidian.Setting(containerEl).setName(t.language).setDesc(t.languageDesc).addDropdown(
      (dropdown) => dropdown.addOption("en", "English").addOption("zh", "\u7B80\u4F53\u4E2D\u6587").setValue(this.plugin.settings.language).onChange((value) => {
        this.plugin.settings.language = value;
        void (async () => {
          await this.plugin.saveSettings();
          this.plugin.applyZenState();
          this.display();
        })().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.themeDisplay).setDesc(t.themeDisplayDesc).addDropdown(
      (dropdown) => dropdown.addOption("default", t.themeDefault).addOption("sepia", t.themeSepia).addOption("green", t.themeGreen).addOption("dark", t.themeDark).setValue(this.plugin.settings.themeDisplay).onChange((value) => {
        this.plugin.settings.themeDisplay = value;
        void (async () => {
          await this.plugin.saveSettings();
          this.plugin.applyZenState();
        })().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.showExitButton).setDesc(t.showExitButtonDesc).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.showExitButton).onChange((value) => {
        this.plugin.settings.showExitButton = value;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.activeLineGlow).setDesc(t.activeLineGlowDesc).addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.activeLineGlow).onChange((value) => {
        this.plugin.settings.activeLineGlow = value;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.contentWidth).setDesc(t.contentWidthDesc).addText(
      (text) => text.setPlaceholder("42rem").setValue(this.plugin.settings.maxWidth).onChange((value) => {
        this.plugin.settings.maxWidth = value.trim() || DEFAULT_SETTINGS.maxWidth;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    ).addExtraButton(
      (button) => button.setIcon("reset").setTooltip(t.restoreDefault).onClick(() => {
        this.plugin.settings.maxWidth = DEFAULT_SETTINGS.maxWidth;
        void (async () => {
          await this.plugin.saveSettings();
          this.display();
        })().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.dimOpacity).setDesc(t.dimOpacityDesc).addSlider(
      (slider) => slider.setLimits(0.1, 0.55, 0.05).setValue(this.plugin.settings.dimOpacity).setDynamicTooltip().onChange((value) => {
        this.plugin.settings.dimOpacity = value;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    ).addExtraButton(
      (button) => button.setIcon("reset").setTooltip(t.restoreDefault).onClick(() => {
        this.plugin.settings.dimOpacity = DEFAULT_SETTINGS.dimOpacity;
        void (async () => {
          await this.plugin.saveSettings();
          this.display();
        })().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.centerDelay).setDesc(t.centerDelayDesc).addSlider(
      (slider) => slider.setLimits(0, 200, 4).setValue(this.plugin.settings.centerDelayMs).setDynamicTooltip().onChange((value) => {
        this.plugin.settings.centerDelayMs = value;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    ).addExtraButton(
      (button) => button.setIcon("reset").setTooltip(t.restoreDefault).onClick(() => {
        this.plugin.settings.centerDelayMs = DEFAULT_SETTINGS.centerDelayMs;
        void (async () => {
          await this.plugin.saveSettings();
          this.display();
        })().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.pickerHeight).setDesc(t.pickerHeightDesc).addSlider(
      (slider) => slider.setLimits(40, 120, 2).setValue(this.plugin.settings.pickerFrameHeightPx).setDynamicTooltip().onChange((value) => {
        this.plugin.settings.pickerFrameHeightPx = value;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    ).addExtraButton(
      (button) => button.setIcon("reset").setTooltip(t.restoreDefault).onClick(() => {
        this.plugin.settings.pickerFrameHeightPx = DEFAULT_SETTINGS.pickerFrameHeightPx;
        void (async () => {
          await this.plugin.saveSettings();
          this.display();
        })().catch(() => {
        });
      })
    );
    new import_obsidian.Setting(containerEl).setName(t.pickerPadding).setDesc(t.pickerPaddingDesc).addSlider(
      (slider) => slider.setLimits(0, 48, 2).setValue(this.plugin.settings.pickerPaddingX).setDynamicTooltip().onChange((value) => {
        this.plugin.settings.pickerPaddingX = value;
        void this.plugin.saveSettings().catch(() => {
        });
      })
    ).addExtraButton(
      (button) => button.setIcon("reset").setTooltip(t.restoreDefault).onClick(() => {
        this.plugin.settings.pickerPaddingX = DEFAULT_SETTINGS.pickerPaddingX;
        void (async () => {
          await this.plugin.saveSettings();
          this.display();
        })().catch(() => {
        });
      })
    );
  }
};
