import { MarkdownView, Plugin, PluginSettingTab, Setting, TFile, setIcon } from "obsidian";

type ZenWriterCenterTrigger = "typing" | "navigation" | "pointer" | "open" | "resize" | "selection" | "wheel";
type EditorCursor = { line: number; ch: number };
type RectLike = { top: number; bottom: number; left: number; right: number };
const NOISE_SCENES = [
  "rain",
  "thunderstorm",
  "campfire",
  "stream",
  "forest-wind",
  "city-street",
  "cafe",
  "library",
  "ocean",
  "morning",
  "night",
  "wind",
] as const;
type NoiseScene = (typeof NOISE_SCENES)[number];
type LegacyNoiseScene = "white" | "pink" | "brown";

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
const TOP_DRAG_STRIP_HEIGHT_PX = 48;
const TOP_EXIT_HINT_BAND_HEIGHT_PX = 96;
const DEFAULT_NOISE_SCENE: NoiseScene = "rain";
const REMOVED_NOISE_SCENE_FALLBACKS: Record<LegacyNoiseScene, NoiseScene> = {
  white: DEFAULT_NOISE_SCENE,
  pink: DEFAULT_NOISE_SCENE,
  brown: DEFAULT_NOISE_SCENE,
};

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
  noiseEnabled: boolean;
  noiseType: NoiseScene;
  noiseVolume: number;
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
  noiseEnabled: false,
  noiseType: DEFAULT_NOISE_SCENE,
  noiseVolume: 0.25,
};


// ─── Archive.org ambient sound URLs (all public domain / CC0) ────────────────
// Base: https://archive.org/download/{identifier}/{filename}
const IA = "https://archive.org/download";
const CB = "CampfireByTheRiverRelaxingFireplace";  // Rich nature sounds collection

const SCENE_URLS: Record<NoiseScene, string[]> = {
  rain: [
    `${IA}/${CB}/GentleRainSoundsOnWindowRainAgainstWindow.mp3`,
    `${IA}/${CB}/SoftRain.mp3`,
  ],
  thunderstorm: [
    `${IA}/${CB}/RelaxingSoundsforSleepThunderstorm.mp3`,
    `${IA}/${CB}/ThunderstormRainOnAWindowSoundThunderRainOnGlassAmbience.mp3`,
    `${IA}/${CB}/LluviaAbundanteYtrueno.mp3`,
  ],
  campfire: [
    `${IA}/${CB}/CampfireByTheRiverRelaxingFireplace.mp3`,
    `${IA}/${CB}/LakesideCampfireWithRelaxing.mp3`,
  ],
  stream: [
    `${IA}/${CB}/ForestCreekSoundsSleepRelaxFocusMeditation.mp3`,
  ],
  "forest-wind": [
    `${IA}/${CB}/WinterStormSoundHeavyBlizzardSnowstorm.mp3`,
  ],
  "city-street": [
    `${IA}/SSE_Library_AMBIENCE/TRAFFIC/AMBTraf_Light%20traffic%20with%20a%20few%20streetcars%3B%20voices_CS_USC.mp3`,
    `${IA}/SSE_Library_AMBIENCE/TRAFFIC/AMBTraf_Light%20traffic%20on%20Sunset%20Blvd_CS_USC.mp3`,
  ],
  cafe: [
    `${IA}/453074-c-rogers-370973-waweee-coffee-shop-ambience-remastered/453074__c_rogers__370973__waweee__coffee-shop-ambience_remastered.mp3`,
    `${IA}/SSE_Library_AMBIENCE/RESTAURANT%20%26%20BAR/AMBRest_Cafe%20ambience%3B%20good%20walla_CS_USC.mp3`,
  ],
  library: [
    `${IA}/aporee_14686_17127/2011062103GrimmZentrum02Lesesaal03LIMEXZERPT.mp3`,
    `${IA}/SSE_Library_AMBIENCE/OFFICE/AMBOffc_Movement%20in%20indoor%20space%3B%20office%20or%20waiting_CS_USC.mp3`,
  ],
  ocean: [
    `${IA}/beachfront-ocean-waves-relaxing-nature-sounds-3-hours/Beachfront%20Ocean%20Waves%20-%20Relaxing%20Nature%20Sounds%203%20Hours.mp3`,
    `${IA}/${CB}/RainSoundsOceanWavesAndDistantThunders.mp3`,
  ],
  morning: [
    `${IA}/EarlyMorningMayBirdsSinging/vogels-mei2008-5uursochtends.mp3`,
    `${IA}/${CB}/TropicalIslandBeachAmbienceSoundOceanandSingingBirds.mp3`,
  ],
  night: [
    `${IA}/${CB}/CampfireByTheSeaCricketsOceanWavesNightForestRelaxing%20Fireplace.mp3`,
    `${IA}/FORESTATNIGHTCricketsOwlsRainWindInTrees/FOREST%20AT%20NIGHT%20-%20Crickets%20Owls%20Rain%20Wind%20in%20Trees.mp3`,
  ],
  wind: [
    `${IA}/FORESTATNIGHTCricketsOwlsRainWindInTrees/FOREST%20AT%20NIGHT%20-%20Crickets%20Owls%20Rain%20Wind%20in%20Trees.mp3`,
    `${IA}/${CB}/WinterStormSoundHeavyBlizzardSnowstorm.mp3`,
  ],
};

function normalizeNoiseScene(value: unknown): NoiseScene {
  if (typeof value !== "string") {
    return DEFAULT_NOISE_SCENE;
  }

  if ((NOISE_SCENES as readonly string[]).includes(value)) {
    return value as NoiseScene;
  }

  return REMOVED_NOISE_SCENE_FALLBACKS[value as LegacyNoiseScene] ?? DEFAULT_NOISE_SCENE;
}

class AmbientSoundEngine {
  private audio: HTMLAudioElement | null = null;
  private fadeFrame: number | null = null;
  private stopTimer: number | null = null;
  private _isRunning = false;

  /** Start streaming a scene. Fades in over `fadeSec` seconds. */
  start(scene: NoiseScene, volume: number, fadeSec = 2, customUrl?: string): void {
    this.destroyInternal();
    const url = customUrl?.trim() || this.pickUrl(scene);
    if (!url) return;

    const audio = new Audio();
    audio.src = url;
    audio.loop = true;
    audio.volume = 0;
    audio.preload = "auto";
    this.audio = audio;
    this._isRunning = true;

    void audio.play().then(() => {
      // Guard: if stop() was called before play() resolved, abort
      if (this.audio !== audio) {
        try { audio.pause(); } catch { /* ignore */ }
        audio.src = "";
        return;
      }
      this.fadeTo(Math.max(0, Math.min(1, volume)), fadeSec);
    }).catch(() => {
      // Guard: if stop() called and pause() interrupted play(), do NOT restart
      if (this.audio !== audio) {
        audio.src = "";
        return;
      }
      // Try fallback URL if primary fails for a real network reason
      const fallbackUrl = this.pickFallbackUrl(scene, url);
      if (fallbackUrl) {
        audio.src = fallbackUrl;
        void audio.play().then(() => {
          if (this.audio !== audio) {
            try { audio.pause(); } catch { /* ignore */ }
            audio.src = "";
            return;
          }
          this.fadeTo(Math.max(0, Math.min(1, volume)), fadeSec);
        }).catch(() => {
          if (this.audio === audio) this.destroyInternal();
          else audio.src = "";
        });
      } else {
        if (this.audio === audio) this.destroyInternal();
      }
    });
  }

  /** Fade out and release the audio element. */
  stop(fadeSec = 2): void {
    this.cancelFade();
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    const audio = this.audio;
    this._isRunning = false;

    if (!audio) return;

    const startVol = audio.volume;
    if (startVol <= 0 || fadeSec <= 0) {
      this.releaseAudio(audio);
      return;
    }

    const startTime = performance.now();
    const durationMs = fadeSec * 1000;
    this.stopTimer = window.setTimeout(() => {
      if (this.audio === audio) {
        this.releaseAudio(audio);
      }
    }, durationMs + 80);

    const tick = (now: number) => {
      if (this.audio !== audio) {
        this.fadeFrame = null;
        return;
      }

      const elapsed = now - startTime;
      const t = Math.min(elapsed / durationMs, 1);
      audio.volume = startVol * (1 - t);
      if (t < 1) {
        this.fadeFrame = requestAnimationFrame(tick);
      } else {
        this.fadeFrame = null;
        this.releaseAudio(audio);
      }
    };

    this.fadeFrame = requestAnimationFrame(tick);
  }

  /** Update volume without restarting. */
  setVolume(volume: number): void {
    if (!this.audio) return;
    this.cancelFade();
    this.audio.volume = Math.max(0, Math.min(1, volume));
  }

  /** Switch scene with a short cross-fade. */
  setType(scene: NoiseScene, volume: number, customUrl?: string): void {
    if (this._isRunning) {
      this.destroyInternal();
      this.start(scene, volume, 0.4, customUrl);
    }
  }

  /** Release all resources immediately. */
  destroy(): void {
    this.destroyInternal();
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private pickUrl(scene: NoiseScene): string {
    const urls = SCENE_URLS[scene];
    return urls?.[0] ?? "";
  }

  private pickFallbackUrl(scene: NoiseScene, failedUrl: string): string | null {
    const urls = SCENE_URLS[scene];
    const next = urls?.find(u => u !== failedUrl);
    return next ?? null;
  }

  private fadeTo(targetVol: number, fadeSec: number): void {
    if (!this.audio) return;
    this.cancelFade();
    const startVol = this.audio.volume;
    const startTime = performance.now();
    const durationMs = Math.max(fadeSec * 1000, 50);
    const audio = this.audio;

    const tick = (now: number) => {
      if (!this.audio || this.audio !== audio) return;
      const elapsed = now - startTime;
      const t = Math.min(elapsed / durationMs, 1);
      audio.volume = startVol + (targetVol - startVol) * t;
      if (t < 1) {
        this.fadeFrame = requestAnimationFrame(tick);
      } else {
        audio.volume = targetVol;
        this.fadeFrame = null;
      }
    };

    this.fadeFrame = requestAnimationFrame(tick);
  }

  private cancelFade(): void {
    if (this.fadeFrame !== null) {
      cancelAnimationFrame(this.fadeFrame);
      this.fadeFrame = null;
    }
  }

  private destroyInternal(): void {
    this.cancelFade();
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.audio) {
      this.releaseAudio(this.audio);
    }
    this._isRunning = false;
  }

  private releaseAudio(audio: HTMLAudioElement): void {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    try { audio.pause(); } catch { /* ignore */ }
    audio.volume = 0;
    audio.src = "";

    if (this.audio === audio) {
      this.audio = null;
    }
  }
}

// Keep alias for internal references
const AmbientNoiseEngine = AmbientSoundEngine;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type AmbientNoiseEngine = AmbientSoundEngine;



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
  private zenRuntimeControlEl: HTMLElement | null = null;
  private zenRuntimeLauncherEl: HTMLButtonElement | null = null;
  private zenRuntimePanelEl: HTMLElement | null = null;
  private zenRuntimeControlOpen = false;
  private zenRuntimeOutsidePointerHandler: ((event: PointerEvent) => void) | null = null;
  private runtimePanelDismissPointerTime = 0;
  private leftSidebarWasVisible = false;
  private rightSidebarWasVisible = false;
  readonly noiseEngine = new AmbientNoiseEngine();

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
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      if (!this.settings.enabled || this.isComposing) {
        return;
      }

      // 快捷退出：按下 Esc 键退出禅意模式
      if (event.key === "Escape") {
        void this.exitZenMode().catch((_e) => {
          console.error("Zen Writer: Failed to exit via Escape", _e);
        });
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

    this.registerDomEvent(window, "mousemove", (event: MouseEvent) => {
      this.syncZenExitButtonVisibility(event.clientY);
    });

    this.registerDomEvent(window, "blur", () => {
      this.rememberActiveCursor();
      this.clearPickerRecovery();
      this.setZenExitButtonVisible(false);
      this.setZenRuntimeControlOpen(false);
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) {
        this.rememberActiveCursor();
        this.clearPickerRecovery();
        this.stopPickerHealthCheck();
        this.setZenRuntimeControlOpen(false);
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
    this.removeZenRuntimeControlCenter();
    this.clearPendingProgrammaticSelection();
    this.clearPendingProgrammaticScroll();
    this.clearPickerViewScope();
    this.noiseEngine.destroy();
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
      noiseEnabled: rawSettings.noiseEnabled ?? DEFAULT_SETTINGS.noiseEnabled,
      noiseType: normalizeNoiseScene(rawSettings.noiseType),
      noiseVolume: rawSettings.noiseVolume ?? DEFAULT_SETTINGS.noiseVolume,
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

    // 启动环境音
    if (this.settings.noiseEnabled) {
      this.noiseEngine.start(this.settings.noiseType, this.settings.noiseVolume);
    }
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

    // 停止环境音
    this.noiseEngine.stop();

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
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file).catch(() => {});
    }
  }

  private createZenExitButton(): void {
    this.removeZenExitButton();

    if (!this.settings.showExitButton) {
      return;
    }

    // 创建触发区域 (靠近顶部的一窄条)
    const trigger = document.createElement("div");
    trigger.className = "zen-writer-exit-trigger";
    const hotspot = document.createElement("div");
    hotspot.className = "zen-writer-exit-hotspot";
    trigger.appendChild(hotspot);
    document.body.appendChild(trigger);
    this.zenExitTriggerEl = trigger;

    // 创建退出按钮 (只有 X 图标)
    const button = document.createElement("div");
    button.className = "zen-writer-exit-button";
    setIcon(button, "x");
    button.addEventListener("click", () => {
      void this.exitZenMode().catch(() => {});
    });

    document.body.appendChild(button);
    this.zenExitButtonEl = button;

    // 中央热点保持可交互，其余顶部区域继续用于窗口拖动
    hotspot.addEventListener("mouseenter", () => {
      button?.classList.add("is-visible");
    });

    hotspot.addEventListener("mouseleave", () => {
      if (button && !button.matches(":hover")) {
        button.classList.remove("is-visible");
      }
    });

    button.addEventListener("mouseenter", () => {
      button.classList.add("is-visible");
    });

    button.addEventListener("mouseleave", () => {
      if (!hotspot.matches(":hover")) {
        button.classList.remove("is-visible");
      }
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

  private setZenExitButtonVisible(visible: boolean): void {
    if (!this.zenExitButtonEl) {
      return;
    }

    this.zenExitButtonEl.classList.toggle("is-visible", visible);
  }

  private syncZenExitButtonVisibility(pointerClientY: number): void {
    if (!this.settings.enabled || !this.settings.showExitButton || !this.zenExitButtonEl) {
      return;
    }

    if (pointerClientY <= TOP_EXIT_HINT_BAND_HEIGHT_PX) {
      this.setZenExitButtonVisible(true);
      return;
    }

    if (this.zenExitButtonEl.matches(":hover") || this.zenExitTriggerEl?.matches(":hover")) {
      return;
    }

    this.setZenExitButtonVisible(false);
  }

  private getThemeOptions(t: typeof I18N.en): Array<{ value: ZenWriterSettings["themeDisplay"]; label: string }> {
    return [
      { value: "default", label: t.themeDefault },
      { value: "sepia", label: t.themeSepia },
      { value: "green", label: t.themeGreen },
      { value: "dark", label: t.themeDark },
    ];
  }

  private getNoiseSceneOptions(t: typeof I18N.en): Array<{ value: NoiseScene; label: string }> {
    return [
      { value: "rain", label: t.noiseRain },
      { value: "thunderstorm", label: t.noiseThunderstorm },
      { value: "campfire", label: t.noiseCampfire },
      { value: "stream", label: t.noiseStream },
      { value: "forest-wind", label: t.noiseForestWind },
      { value: "city-street", label: t.noiseCityStreet },
      { value: "cafe", label: t.noiseCafe },
      { value: "library", label: t.noiseLibrary },
      { value: "ocean", label: t.noiseOcean },
      { value: "morning", label: t.noiseMorning },
      { value: "night", label: t.noiseNight },
      { value: "wind", label: t.noiseWind },
    ];
  }

  private setZenRuntimeControlOpen(open: boolean): void {
    this.zenRuntimeControlOpen = open;
    this.zenRuntimeControlEl?.classList.toggle("is-open", open);
    this.zenRuntimeLauncherEl?.setAttribute("aria-expanded", String(open));
    this.zenRuntimePanelEl?.setAttribute("aria-hidden", String(!open));
  }

  private createZenRuntimeControlCenter(): void {
    if (this.zenRuntimeControlEl) {
      this.renderZenRuntimeControlPanel();
      return;
    }

    const t = I18N[this.settings.language] || I18N.en;
    const container = document.createElement("div");
    container.className = "zen-runtime-controls";

    const hotspot = document.createElement("div");
    hotspot.className = "zen-runtime-hotspot";

    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "zen-runtime-toggle";
    launcher.setAttribute("aria-label", t.runtimeControls);
    launcher.setAttribute("aria-expanded", "false");
    setIcon(launcher, "sliders-horizontal");
    launcher.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setZenRuntimeControlOpen(!this.zenRuntimeControlOpen);
    });

    const panel = document.createElement("div");
    panel.className = "zen-runtime-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t.runtimeControls);
    panel.setAttribute("aria-hidden", "true");

    container.appendChild(hotspot);
    container.appendChild(launcher);
    container.appendChild(panel);
    document.body.appendChild(container);

    this.zenRuntimeControlEl = container;
    this.zenRuntimeLauncherEl = launcher;
    this.zenRuntimePanelEl = panel;

    this.zenRuntimeOutsidePointerHandler = (event: PointerEvent) => {
      if (!this.zenRuntimeControlOpen || !this.zenRuntimeControlEl || !(event.target instanceof Node)) {
        return;
      }

      if (!this.zenRuntimeControlEl.contains(event.target)) {
        this.setZenRuntimeControlOpen(false);
      }
    };
    document.addEventListener("pointerdown", this.zenRuntimeOutsidePointerHandler, true);

    this.renderZenRuntimeControlPanel();
    this.setZenRuntimeControlOpen(this.zenRuntimeControlOpen);
  }

  private removeZenRuntimeControlCenter(): void {
    if (this.zenRuntimeOutsidePointerHandler) {
      document.removeEventListener("pointerdown", this.zenRuntimeOutsidePointerHandler, true);
      this.zenRuntimeOutsidePointerHandler = null;
    }

    if (this.zenRuntimeControlEl) {
      this.zenRuntimeControlEl.remove();
      this.zenRuntimeControlEl = null;
    }

    this.zenRuntimeLauncherEl = null;
    this.zenRuntimePanelEl = null;
    this.zenRuntimeControlOpen = false;
  }

  private isZenRuntimeControlTarget(target: EventTarget | null): boolean {
    return target instanceof Node && !!this.zenRuntimeControlEl?.contains(target);
  }

  private renderZenRuntimeControlPanel(): void {
    if (!this.zenRuntimePanelEl) {
      return;
    }

    const t = I18N[this.settings.language] || I18N.en;
    const panel = this.zenRuntimePanelEl;
    panel.replaceChildren();
    panel.setAttribute("aria-label", t.runtimeControls);
    this.zenRuntimeLauncherEl?.setAttribute("aria-label", t.runtimeControls);

    const header = document.createElement("div");
    header.className = "zen-runtime-header";
    const title = document.createElement("div");
    title.className = "zen-runtime-title";
    title.textContent = t.runtimeControls;
    header.appendChild(title);
    panel.appendChild(header);

    const appearanceSection = document.createElement("section");
    appearanceSection.className = "zen-runtime-section";
    const appearanceHeading = document.createElement("div");
    appearanceHeading.className = "zen-runtime-section-title";
    appearanceHeading.textContent = t.runtimePaper;
    appearanceSection.appendChild(appearanceHeading);

    const themeGrid = document.createElement("div");
    themeGrid.className = "zen-runtime-theme-grid";
    for (const option of this.getThemeOptions(t)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zen-runtime-theme-option";
      if (this.settings.themeDisplay === option.value) {
        button.classList.add("is-active");
      }
      button.dataset.theme = option.value;
      button.setAttribute("aria-pressed", String(this.settings.themeDisplay === option.value));
      button.addEventListener("click", () => {
        if (this.settings.themeDisplay === option.value) {
          return;
        }
        this.settings.themeDisplay = option.value;
        this.renderZenRuntimeControlPanel();
        void this.saveSettings().catch(() => {});
      });

      const swatch = document.createElement("span");
      swatch.className = "zen-runtime-theme-swatch";
      button.appendChild(swatch);

      const label = document.createElement("span");
      label.className = "zen-runtime-theme-label";
      label.textContent = option.label;
      button.appendChild(label);

      themeGrid.appendChild(button);
    }
    appearanceSection.appendChild(themeGrid);
    panel.appendChild(appearanceSection);

    const ambientSection = document.createElement("section");
    ambientSection.className = "zen-runtime-section";
    const ambientTopRow = document.createElement("div");
    ambientTopRow.className = "zen-runtime-row";

    const ambientHeading = document.createElement("div");
    ambientHeading.className = "zen-runtime-section-title";
    ambientHeading.textContent = t.runtimeAmbient;
    ambientTopRow.appendChild(ambientHeading);

    const ambientToggle = document.createElement("button");
    ambientToggle.type = "button";
    ambientToggle.className = "zen-runtime-switch";
    ambientToggle.classList.toggle("is-active", this.settings.noiseEnabled);
    ambientToggle.setAttribute("aria-pressed", String(this.settings.noiseEnabled));
    ambientToggle.textContent = this.settings.noiseEnabled ? t.runtimeOn : t.runtimeOff;
    ambientToggle.addEventListener("click", () => {
      const nextEnabled = !this.settings.noiseEnabled;
      this.settings.noiseEnabled = nextEnabled;

      if (nextEnabled) {
        this.noiseEngine.start(this.settings.noiseType, this.settings.noiseVolume);
      } else {
        this.noiseEngine.stop(0.8);
      }

      this.renderZenRuntimeControlPanel();
      void this.saveSettings().catch(() => {});
    });
    ambientTopRow.appendChild(ambientToggle);
    ambientSection.appendChild(ambientTopRow);

    if (this.settings.noiseEnabled) {
      const sceneRow = document.createElement("label");
      sceneRow.className = "zen-runtime-stack";
      const sceneLabel = document.createElement("span");
      sceneLabel.className = "zen-runtime-label";
      sceneLabel.textContent = t.runtimeScene;
      sceneRow.appendChild(sceneLabel);

      const select = document.createElement("select");
      select.className = "zen-runtime-select";
      for (const option of this.getNoiseSceneOptions(t)) {
        const optionEl = document.createElement("option");
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        optionEl.selected = this.settings.noiseType === option.value;
        select.appendChild(optionEl);
      }
      select.addEventListener("change", () => {
        const nextScene = normalizeNoiseScene(select.value);
        if (nextScene === this.settings.noiseType) {
          return;
        }
        this.settings.noiseType = nextScene;
        this.noiseEngine.setType(nextScene, this.settings.noiseVolume);
        void this.saveSettings().catch(() => {});
      });
      sceneRow.appendChild(select);
      ambientSection.appendChild(sceneRow);

      const volumeRow = document.createElement("div");
      volumeRow.className = "zen-runtime-stack";
      const volumeHeader = document.createElement("div");
      volumeHeader.className = "zen-runtime-row";
      const volumeLabel = document.createElement("span");
      volumeLabel.className = "zen-runtime-label";
      volumeLabel.textContent = t.runtimeVolume;
      const volumeValue = document.createElement("span");
      volumeValue.className = "zen-runtime-value";
      volumeValue.textContent = `${Math.round(this.settings.noiseVolume * 100)}%`;
      volumeHeader.appendChild(volumeLabel);
      volumeHeader.appendChild(volumeValue);
      volumeRow.appendChild(volumeHeader);

      const sliderShell = document.createElement("div");
      sliderShell.className = "zen-runtime-slider";
      const sliderTrack = document.createElement("div");
      sliderTrack.className = "zen-runtime-slider-track";
      const sliderFill = document.createElement("div");
      sliderFill.className = "zen-runtime-slider-fill";
      sliderTrack.appendChild(sliderFill);

      const sliderThumb = document.createElement("div");
      sliderThumb.className = "zen-runtime-slider-thumb";

      const slider = document.createElement("input");
      slider.className = "zen-runtime-slider-input";
      slider.type = "range";
      slider.min = "0.05";
      slider.max = "1";
      slider.step = "0.05";
      slider.value = String(this.settings.noiseVolume);
      slider.setAttribute("aria-label", t.runtimeVolume);

      const updateSliderVisual = (value: number) => {
        const min = Number(slider.min);
        const max = Number(slider.max);
        const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
        sliderShell.style.setProperty("--zen-runtime-slider-percent", `${Math.max(0, Math.min(100, percent))}%`);
        volumeValue.textContent = `${Math.round(value * 100)}%`;
      };

      const snapSliderValue = (value: number) => {
        const min = Number(slider.min);
        const max = Number(slider.max);
        const step = Number(slider.step) || 0.05;
        const snapped = min + Math.round((value - min) / step) * step;
        return Math.max(min, Math.min(max, Number(snapped.toFixed(2))));
      };

      const applyVolume = (value: number, persist: boolean) => {
        const nextVolume = snapSliderValue(value);
        slider.value = String(nextVolume);
        this.settings.noiseVolume = nextVolume;
        this.noiseEngine.setVolume(nextVolume);
        updateSliderVisual(nextVolume);
        if (persist) {
          void this.saveSettings().catch(() => {});
        }
      };

      let activePointerId: number | null = null;
      const updateVolumeFromClientX = (clientX: number, persist: boolean) => {
        const rect = sliderTrack.getBoundingClientRect();
        if (!rect.width) {
          return;
        }
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const min = Number(slider.min);
        const max = Number(slider.max);
        const value = min + ratio * (max - min);
        applyVolume(value, persist);
      };

      updateSliderVisual(this.settings.noiseVolume);
      slider.addEventListener("input", () => {
        applyVolume(Number(slider.value), false);
      });
      slider.addEventListener("change", () => {
        applyVolume(Number(slider.value), true);
      });
      sliderShell.addEventListener("pointerdown", (event: PointerEvent) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        activePointerId = event.pointerId;
        sliderShell.setPointerCapture(event.pointerId);
        updateVolumeFromClientX(event.clientX, false);
      });
      sliderShell.addEventListener("pointermove", (event: PointerEvent) => {
        if (activePointerId !== event.pointerId) {
          return;
        }
        updateVolumeFromClientX(event.clientX, false);
      });
      sliderShell.addEventListener("pointerup", (event: PointerEvent) => {
        if (activePointerId !== event.pointerId) {
          return;
        }
        updateVolumeFromClientX(event.clientX, true);
        sliderShell.releasePointerCapture(event.pointerId);
        activePointerId = null;
      });
      sliderShell.addEventListener("pointercancel", (event: PointerEvent) => {
        if (activePointerId !== event.pointerId) {
          return;
        }
        sliderShell.releasePointerCapture(event.pointerId);
        activePointerId = null;
      });
      sliderShell.appendChild(sliderTrack);
      sliderShell.appendChild(sliderThumb);
      sliderShell.appendChild(slider);
      volumeRow.appendChild(sliderShell);
      ambientSection.appendChild(volumeRow);
    }

    panel.appendChild(ambientSection);
  }

  public applyZenState(): void {
    const t = I18N[this.settings.language] || I18N.en;

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
      this.statusBarItemEl.textContent = this.settings.enabled ? t.statusBarOn : t.statusBarOff;
    }

    if (this.settings.enabled && !this.isComposing) {
      // 立即尝试同步当前文档
      window.requestAnimationFrame(() => {
        this.trySyncPickerImmediate();
        this.schedulePickerRecovery("selection");
        this.startPickerHealthCheck();
      });

      // 同步噪音状态（处理设置面板实时调整）
      this.syncNoiseState();
      this.createZenRuntimeControlCenter();
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
      this.removeZenRuntimeControlCenter();
    }
  }

  /** Sync noise engine state with current settings (called from applyZenState). */
  private syncNoiseState(): void {
    if (!this.settings.enabled) {
      return;
    }

    if (!this.settings.noiseEnabled) {
      // User turned off noise while in Zen mode
      if (this.noiseEngine.isRunning) {
        this.noiseEngine.stop();
      }
      return;
    }

    if (!this.noiseEngine.isRunning) {
      // Noise was off; start it
      this.noiseEngine.start(this.settings.noiseType, this.settings.noiseVolume);
    } else {
      // Engine is running: update volume in real-time, type change handled by setType
      this.noiseEngine.setVolume(this.settings.noiseVolume);
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

    if (event.type === "mousedown" && Date.now() - this.runtimePanelDismissPointerTime < 100) {
      this.runtimePanelDismissPointerTime = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      return;
    }

    if (this.zenRuntimeControlOpen && !this.isZenRuntimeControlTarget(event.target)) {
      if (event.type === "pointerdown") {
        this.runtimePanelDismissPointerTime = Date.now();
      }
      this.setZenRuntimeControlOpen(false);
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      return;
    }

    if (this.isZenRuntimeControlTarget(event.target)) {
      return;
    }

    // Preserve the native top drag zone while Zen mode is active.
    if (event.clientY <= TOP_DRAG_STRIP_HEIGHT_PX) {
      this.setZenExitButtonVisible(this.settings.showExitButton);
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

    this.focusFrameEl.style.setProperty("top", `${top}px`);
    this.focusFrameEl.style.setProperty("left", `${left}px`);
    this.focusFrameEl.style.setProperty("width", `${width}px`);
    this.focusFrameEl.style.setProperty("height", `${height}px`);

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
    this.ribbonIconEl = this.addRibbonIcon("pen-tool", t.ribbonTooltip, () => {
      void this.toggleZenWriter().catch(() => {});
    });
  }

  private registerCommands(): void {
    const t = I18N[this.settings.language] || I18N.en;
    
    // Attempt to remove existing commands to avoid duplicates during language hot-swap
    try {
      const commands = (this.app as unknown as { commands: { removeCommand: (id: string) => void } }).commands;
      if (commands) {
        commands.removeCommand("toggle-zen");
      }
    } catch {
      // Fail silently if command management fails
    }

    this.addCommand({
      id: "toggle-zen",
      name: t.commandToggle,
      callback: () => {
        void this.toggleZenWriter().catch(() => {});
      },
    });
  }
}

const I18N = {
  en: {
    language: "Language",
    languageDesc: "Choose the display language for settings.",
    themeDisplay: "Editor paper theme",
    themeDisplayDesc: "Choose a background color palette for the writing canvas.",
    themeDefault: "System default",
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
    ribbonTooltip: "Enter Zen writing mode",
    commandToggle: "Enter/exit Zen writing mode",
    showExitButton: "Show top exit button",
    showExitButtonDesc: "Display a minimal 'X' button at the top that appears on hover to exit Zen mode.",
    runtimeControls: "Zen controls",
    runtimePaper: "Paper",
    runtimeAmbient: "Ambient",
    runtimeScene: "Scene",
    runtimeVolume: "Volume",
    runtimeOn: "On",
    runtimeOff: "Off",
    noiseEnabled: "Ambient sound",
    noiseEnabledDesc: "Play a gentle background sound to help you stay in flow while writing.",
    noiseType: "Sound scene",
    noiseTypeDesc: "Choose the synthesized ambient scene. All sounds are generated in real-time — no audio files.",
    noiseRain: "🌧️  Rain",
    noiseThunderstorm: "⛈️  Thunderstorm",
    noiseCampfire: "🔥  Campfire",
    noiseStream: "💧  Stream",
    noiseForestWind: "🌲  Forest wind",
    noiseCityStreet: "🏙️  City street",
    noiseCafe: "☕  Coffee shop",
    noiseLibrary: "📚  Library",
    noiseOcean: "🌊  Ocean waves",
    noiseMorning: "🌅  Morning birds",
    noiseNight: "🌙  Night crickets",
    noiseWind: "🌬️  Open wind",
    noiseWhite: "◻️  White noise",
    noisePink: "🟪  Pink noise",
    noiseBrown: "🟫  Brown noise",
    noiseVolume: "Volume",
    noiseVolumeDesc: "Adjust the volume of the ambient sound.",
    statusBarOn: "Zen Writer: picker",
    statusBarOff: "Zen Writer: off",
  },
  zh: {
    language: "语言",
    languageDesc: "选择设置界面的显示语言。",
    themeDisplay: "编辑器纸张背景",
    themeDisplayDesc: "选择令你舒适的沉浸式背景底色调色板。",
    themeDefault: "系统默认",
    themeSepia: "护眼黄",
    themeGreen: "护眼绿",
    themeDark: "深灰夜间",
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
    runtimeControls: "禅意控制",
    runtimePaper: "纸张",
    runtimeAmbient: "环境音",
    runtimeScene: "场景",
    runtimeVolume: "音量",
    runtimeOn: "开启",
    runtimeOff: "关闭",
    noiseEnabled: "环境音",
    noiseEnabledDesc: "进入禅意模式时播放合成的场景音效，帮助你更快进入心流状态。",
    noiseType: "声音场景",
    noiseTypeDesc: "选择要合成的环境音场景，所有声音均实时生成，无需音频文件。",
    noiseRain: "🌧️  雨声",
    noiseThunderstorm: "⛈️  雷暴",
    noiseCampfire: "🔥  篝火",
    noiseStream: "💧  溪流",
    noiseForestWind: "🌲  森林风声",
    noiseCityStreet: "🏙️  城市街道",
    noiseCafe: "☕  咖啡馆",
    noiseLibrary: "📚  图书馆",
    noiseOcean: "🌊  海浪",
    noiseMorning: "🌅  晨间鸟鸣",
    noiseNight: "🌙  夜晚虫鸣",
    noiseWind: "🌬️  旷野风声",
    noiseWhite: "◻️  白噪音",
    noisePink: "🟪  粉噪音",
    noiseBrown: "🟫  棕噪音",
    noiseVolume: "音量",
    noiseVolumeDesc: "调节环境音的播放音量。",
    statusBarOn: "Zen Writer: 聚焦中",
    statusBarOff: "Zen Writer: 已关闭",
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

    new Setting(containerEl).setName(this.plugin.manifest.name).setHeading();

    new Setting(containerEl)
      .setName(t.language)
      .setDesc(t.languageDesc)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("en", "English")
          .addOption("zh", "简体中文")
          .setValue(this.plugin.settings.language)
          .onChange((value: "en" | "zh") => {
            this.plugin.settings.language = value;
            void (async () => {
              await this.plugin.saveSettings();
              this.plugin.applyZenState();
              this.display();
            })().catch(() => {});
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
          .onChange((value: "default" | "sepia" | "green" | "dark") => {
            this.plugin.settings.themeDisplay = value;
            void (async () => {
              await this.plugin.saveSettings();
              this.plugin.applyZenState();
            })().catch(() => {});
          })
      );

    new Setting(containerEl)
      .setName(t.showExitButton)
      .setDesc(t.showExitButtonDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showExitButton).onChange((value) => {
          this.plugin.settings.showExitButton = value;
          void this.plugin.saveSettings().catch(() => {});
        }),
      );

    new Setting(containerEl)
      .setName(t.activeLineGlow)
      .setDesc(t.activeLineGlowDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.activeLineGlow).onChange((value) => {
          this.plugin.settings.activeLineGlow = value;
          void this.plugin.saveSettings().catch(() => {});
        }),
      );

    new Setting(containerEl)
      .setName(t.contentWidth)
      .setDesc(t.contentWidthDesc)
      .addText((text) =>
        text.setPlaceholder("42rem").setValue(this.plugin.settings.maxWidth).onChange((value) => {
          this.plugin.settings.maxWidth = value.trim() || DEFAULT_SETTINGS.maxWidth;
          void this.plugin.saveSettings().catch(() => {});
        }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(() => {
            this.plugin.settings.maxWidth = DEFAULT_SETTINGS.maxWidth;
            void (async () => {
              await this.plugin.saveSettings();
              this.display();
            })().catch(() => {});
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
          .onChange((value) => {
            this.plugin.settings.dimOpacity = value;
            void this.plugin.saveSettings().catch(() => {});
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(() => {
            this.plugin.settings.dimOpacity = DEFAULT_SETTINGS.dimOpacity;
            void (async () => {
              await this.plugin.saveSettings();
              this.display();
            })().catch(() => {});
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
          .onChange((value) => {
            this.plugin.settings.centerDelayMs = value;
            void this.plugin.saveSettings().catch(() => {});
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(() => {
            this.plugin.settings.centerDelayMs = DEFAULT_SETTINGS.centerDelayMs;
            void (async () => {
              await this.plugin.saveSettings();
              this.display();
            })().catch(() => {});
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
          .onChange((value) => {
            this.plugin.settings.pickerFrameHeightPx = value;
            void this.plugin.saveSettings().catch(() => {});
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(() => {
            this.plugin.settings.pickerFrameHeightPx = DEFAULT_SETTINGS.pickerFrameHeightPx;
            void (async () => {
              await this.plugin.saveSettings();
              this.display();
            })().catch(() => {});
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
          .onChange((value) => {
            this.plugin.settings.pickerPaddingX = value;
            void this.plugin.saveSettings().catch(() => {});
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon("reset")
          .setTooltip(t.restoreDefault)
          .onClick(() => {
            this.plugin.settings.pickerPaddingX = DEFAULT_SETTINGS.pickerPaddingX;
            void (async () => {
              await this.plugin.saveSettings();
              this.display();
            })().catch(() => {});
          })
      );

    // ── Ambient Noise Section ──────────────────────────────────────────

    new Setting(containerEl).setName(t.noiseEnabled).setHeading();

    new Setting(containerEl)
      .setName(t.noiseEnabled)
      .setDesc(t.noiseEnabledDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.noiseEnabled).onChange((value) => {
          this.plugin.settings.noiseEnabled = value;
          // Immediately stop engine if user disables ambient sound
          if (!value) {
            this.plugin.noiseEngine.destroy();
          }
          void (async () => {
            await this.plugin.saveSettings();
            this.display(); // re-render to show/hide dependent settings
          })().catch(() => {});
        }),
      );

    if (this.plugin.settings.noiseEnabled) {
      new Setting(containerEl)
        .setName(t.noiseType)
        .setDesc(t.noiseTypeDesc)
        .addDropdown((dropdown) =>
          dropdown
            .addOption("rain",         t.noiseRain)
            .addOption("thunderstorm", t.noiseThunderstorm)
            .addOption("campfire",     t.noiseCampfire)
            .addOption("stream",       t.noiseStream)
            .addOption("forest-wind",  t.noiseForestWind)
            .addOption("city-street",  t.noiseCityStreet)
            .addOption("cafe",         t.noiseCafe)
            .addOption("library",      t.noiseLibrary)
            .addOption("ocean",        t.noiseOcean)
            .addOption("morning",      t.noiseMorning)
            .addOption("night",        t.noiseNight)
            .addOption("wind",         t.noiseWind)
            .setValue(this.plugin.settings.noiseType)
            .onChange((value: NoiseScene) => {
              const changed = this.plugin.settings.noiseType !== value;
              this.plugin.settings.noiseType = value;
              if (changed) {
                this.plugin.noiseEngine.setType(value, this.plugin.settings.noiseVolume);
              }
              void this.plugin.saveSettings().catch(() => {});
            }),
        );

      new Setting(containerEl)
        .setName(t.noiseVolume)
        .setDesc(t.noiseVolumeDesc)
        .addSlider((slider) =>
          slider
            .setLimits(0.05, 1, 0.05)
            .setValue(this.plugin.settings.noiseVolume)
            .setDynamicTooltip()
            .onChange((value) => {
              this.plugin.settings.noiseVolume = value;
              this.plugin.noiseEngine.setVolume(value);
              void this.plugin.saveSettings().catch(() => {});
            }),
        )
        .addExtraButton((button) =>
          button
            .setIcon("reset")
            .setTooltip(t.restoreDefault)
            .onClick(() => {
              this.plugin.settings.noiseVolume = DEFAULT_SETTINGS.noiseVolume;
              this.plugin.noiseEngine.setVolume(DEFAULT_SETTINGS.noiseVolume);
              void (async () => {
                await this.plugin.saveSettings();
                this.display();
              })().catch(() => {});
            })
        );
    }
  }
}
