import { highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";

interface ZenWriterSettings {
  enabled: boolean;
  maxWidth: string;
  dimOpacity: number;
  centerDelayMs: number;
}

const DEFAULT_SETTINGS: ZenWriterSettings = {
  enabled: false,
  maxWidth: "42rem",
  dimOpacity: 0.32,
  centerDelayMs: 24,
};

export default class ZenWriterPlugin extends Plugin {
  settings: ZenWriterSettings = DEFAULT_SETTINGS;
  private centerTimer: number | null = null;
  private statusBarItemEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerEditorExtension([highlightActiveLine(), highlightActiveLineGutter()]);

    this.statusBarItemEl = this.addStatusBarItem();

    this.addRibbonIcon("pen-tool", "Toggle Zen Writer", async () => {
      await this.toggleZenWriter();
    });

    this.addCommand({
      id: "toggle-zen-writer",
      name: "Toggle zen mode",
      callback: async () => {
        await this.toggleZenWriter();
      },
    });

    this.addSettingTab(new ZenWriterSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.scheduleCentering();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.applyZenState();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.applyZenState();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.scheduleCentering();
      }),
    );

    this.registerDomEvent(document, "selectionchange", () => {
      this.scheduleCentering();
    });

    this.registerDomEvent(window, "mouseup", () => {
      this.scheduleCentering();
    });

    this.registerDomEvent(window, "keyup", () => {
      this.scheduleCentering();
    });

    this.registerDomEvent(window, "resize", () => {
      this.scheduleCentering();
    });

    this.applyZenState();
  }

  onunload(): void {
    this.clearCenterTimer();
    document.body.classList.remove("zen-writer-enabled");
    document.body.style.removeProperty("--zen-writer-max-width");
    document.body.style.removeProperty("--zen-writer-dim-opacity");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyZenState();
  }

  private async toggleZenWriter(): Promise<void> {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
  }

  private applyZenState(): void {
    document.body.style.setProperty("--zen-writer-max-width", this.settings.maxWidth);
    document.body.style.setProperty("--zen-writer-dim-opacity", `${this.settings.dimOpacity}`);
    document.body.classList.toggle("zen-writer-enabled", this.settings.enabled);

    if (this.statusBarItemEl) {
      this.statusBarItemEl.textContent = this.settings.enabled ? "Zen Writer: On" : "Zen Writer: Off";
    }

    if (this.settings.enabled) {
      this.scheduleCentering();
    } else {
      this.clearCenterTimer();
    }
  }

  private scheduleCentering(): void {
    if (!this.settings.enabled) {
      return;
    }

    this.clearCenterTimer();
    this.centerTimer = window.setTimeout(() => {
      this.centerTimer = null;
      this.centerActiveCursor();
    }, this.settings.centerDelayMs);
  }

  private clearCenterTimer(): void {
    if (this.centerTimer !== null) {
      window.clearTimeout(this.centerTimer);
      this.centerTimer = null;
    }
  }

  private centerActiveCursor(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }

    if (typeof view.getMode === "function" && view.getMode() !== "source") {
      return;
    }

    const cursor = view.editor.getCursor();
    view.editor.scrollIntoView({ from: cursor, to: cursor }, true);
  }
}

class ZenWriterSettingTab extends PluginSettingTab {
  plugin: ZenWriterPlugin;

  constructor(app: ZenWriterPlugin["app"], plugin: ZenWriterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();

    const heading = document.createElement("h2");
    heading.textContent = "Zen Writer";
    containerEl.appendChild(heading);

    new Setting(containerEl)
      .setName("Enable plugin mode")
      .setDesc("Turn Zen Writer on or off for this vault.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Content width")
      .setDesc("Any valid CSS width value, such as 42rem or 720px.")
      .addText((text) =>
        text.setPlaceholder("42rem").setValue(this.plugin.settings.maxWidth).onChange(async (value) => {
          this.plugin.settings.maxWidth = value.trim() || DEFAULT_SETTINGS.maxWidth;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Background line opacity")
      .setDesc("Lower values make non-active lines dimmer.")
      .addSlider((slider) =>
        slider
          .setLimits(0.1, 1, 0.05)
          .setValue(this.plugin.settings.dimOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.dimOpacity = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Centering delay")
      .setDesc("A small delay can make cursor centering feel smoother while typing.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 120, 4)
          .setValue(this.plugin.settings.centerDelayMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.centerDelayMs = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
