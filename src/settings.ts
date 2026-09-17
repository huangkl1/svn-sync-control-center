import { App, PluginSettingTab, Setting } from "obsidian";
import type SvnSyncPlugin from "./main";
import { resolveSvnExecutableFromDirectoryFiles } from "./ui-state.mjs";

type RuntimeRequire = (moduleName: string) => unknown;

export interface CommitLayout { filesRatio: number; messageRatio: number; diffRatio: number; }
export type ResizableModalKind = "control-center" | "wizard" | "merge";
export interface ModalSize { width: number; height: number; }

export interface SvnPluginSettings {
  svnExecutablePath: string;
  defaultCheckoutDirectory: string;
  repositoryUrlByVault: Record<string, string>;
  ignorePatterns: string[];
  commandTimeoutMs: number;
  commitLayoutByVault: Record<string, CommitLayout>;
  modalSizeByVault: Record<string, Partial<Record<ResizableModalKind, ModalSize>>>;
}

export const DEFAULT_SETTINGS: SvnPluginSettings = {
  svnExecutablePath: "",
  defaultCheckoutDirectory: "",
  repositoryUrlByVault: {},
  ignorePatterns: [],
  commandTimeoutMs: 120000,
  commitLayoutByVault: {},
  modalSizeByVault: {},
};

export class SvnSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SvnSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "SVN 同步" });

    containerEl.createEl("h3", { text: "SVN 客户端" });
    const detection = this.plugin.svnDetection;
    new Setting(containerEl).setName("检测状态").setDesc(`${detection.message} 来源：${detection.source}${detection.version ? `；版本：${detection.version}` : ""}`);
    let executableInput: { setValue(value: string): unknown } | undefined;
    const executablePathSetting = new Setting(containerEl)
      .setName("svn.exe 路径")
      .setDesc(this.plugin.settings.svnExecutablePath ? `当前配置：${this.plugin.settings.svnExecutablePath}` : "未检测到路径。可填写 svn.exe 或其安装目录。")
      .addText((text) => {
        executableInput = text;
        return text.setPlaceholder("C:\\Program Files\\TortoiseSVN\\bin\\svn.exe").setValue(this.plugin.settings.svnExecutablePath).onChange(async (value) => {
        this.plugin.settings.svnExecutablePath = value.trim();
        await this.plugin.saveSettings();
        await this.plugin.detectSvn();
        });
      });
    const directoryFeedback = executablePathSetting.descEl.createDiv({ cls: "svn-setting-inline-feedback", text: "" });
    directoryFeedback.setAttribute("aria-live", "polite");
    directoryFeedback.setAttribute("role", "status");
    this.createFallbackDirectoryPicker(executablePathSetting.controlEl, executableInput, directoryFeedback);
    new Setting(containerEl).setName("重新检测").setDesc("检测来源、版本和错误结果由本机 svn.exe 检测服务更新。").addButton((button) => button.setButtonText("检测 SVN").setTooltip("重新检测本机 SVN 客户端").onClick(async () => { button.setButtonText("正在检测"); try { await this.plugin.detectSvn(); } finally { button.setButtonText("检测 SVN"); this.display(); } }));

    containerEl.createEl("h3", { text: "Checkout 与忽略规则" });
    new Setting(containerEl)
      .setName("当前笔记仓库的 SVN 仓库地址")
      .setDesc("按当前笔记仓库保存，仅作为关联向导的默认地址；不会单独判定当前目录已经关联 SVN。")
      .addText((text) => text
        .setPlaceholder("https://svn.example.com/repos/notes")
        .setValue(this.plugin.getRepositoryUrlForCurrentVault())
        .onChange(async (value) => { await this.plugin.saveRepositoryUrlForCurrentVault(value); }));
    new Setting(containerEl)
      .setName("清空当前笔记仓库的仓库地址")
      .setDesc("清空后，关联向导不会再自动预填仓库地址。")
      .addButton((button) => button.setButtonText("清空地址").setTooltip("清空当前笔记仓库的 SVN 地址").onClick(async () => { await this.plugin.saveRepositoryUrlForCurrentVault(""); this.display(); }));
    new Setting(containerEl).setName("默认 checkout 目录").setDesc("首次关联向导建议使用的空目录。").addText((text) => text.setPlaceholder("D:\\Notes").setValue(this.plugin.settings.defaultCheckoutDirectory).onChange(async (value) => {
      this.plugin.settings.defaultCheckoutDirectory = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("自定义忽略规则").setDesc("每行一条规则；内置规则可以在控制中心中查看。").addTextArea((text) => text.setValue(this.plugin.settings.ignorePatterns.join("\n")).onChange(async (value) => {
      this.plugin.settings.ignorePatterns = value.split("\n").map((line) => line.trim()).filter(Boolean);
      await this.plugin.saveSettings();
      this.plugin.syncCustomIgnorePatterns(this.plugin.settings.ignorePatterns);
    }));

    containerEl.createEl("h3", { text: "运行选项" });
    new Setting(containerEl).setName("命令超时（毫秒）").addText((text) => text.setValue(String(this.plugin.settings.commandTimeoutMs)).onChange(async (value) => {
      const timeout = Number(value);
      if (Number.isFinite(timeout) && timeout > 0) {
        this.plugin.settings.commandTimeoutMs = timeout;
        await this.plugin.saveSettings();
      }
    }));
    containerEl.createEl("h3", { text: "认证缓存" });
    new Setting(containerEl).setName("清除并重新认证").setDesc("SVN 本机认证缓存会被清除；插件不会保存密码。").addButton((button) => {
      button.setWarning().setButtonText("清除认证缓存");
      if (detection.status !== "ready") { button.setDisabled(true); button.setTooltip("请先成功检测 svn.exe，再清除认证缓存。"); }
      return button.onClick(() => this.plugin.openDangerConfirmation("清除 SVN 认证缓存", "将清除本机 SVN 保存的认证信息。下次访问仓库时需要重新认证。", "清除认证缓存", () => void this.plugin.clearAuthCache()));
    });
  }

  private showDirectorySelectionFeedback(feedback: HTMLElement | null, message: string): void {
    feedback?.setText(message);
    feedback?.addClass("is-error");
    feedback?.setAttribute("role", "alert");
  }

  private createFallbackDirectoryPicker(parent: HTMLElement, executableInput: { setValue(value: string): unknown } | undefined, feedback: HTMLElement): HTMLInputElement {
    const fallbackPicker = parent.createEl("input", { cls: "svn-directory-fallback-picker" });
    fallbackPicker.type = "file";
    fallbackPicker.multiple = true;
    fallbackPicker.setAttribute("aria-label", "选择 SVN 安装目录");
    fallbackPicker.setAttribute("data-label", "选择 SVN 安装目录");
    fallbackPicker.setAttribute("webkitdirectory", "");
    fallbackPicker.setAttribute("directory", "");
    fallbackPicker.addEventListener("change", () => {
      void this.handleFallbackDirectorySelection(fallbackPicker.files, executableInput, feedback).finally(() => { fallbackPicker.value = ""; });
    });
    fallbackPicker.addEventListener("cancel", () => { fallbackPicker.value = ""; feedback.setText(""); feedback.setAttribute("role", "status"); });
    return fallbackPicker;
  }

  private async handleFallbackDirectorySelection(fileList: FileList | null, executableInput: { setValue(value: string): unknown } | undefined, feedback: HTMLElement): Promise<void> {
    try {
      if (!fileList?.length) {
        feedback.setText("");
        feedback.setAttribute("role", "status");
        return;
      }
      const files = Array.from(fileList ?? []).map((file) => ({ relativePath: file.webkitRelativePath, absolutePath: this.getElectronFilePath(file) }));
      const selectedExecutable = resolveSvnExecutableFromDirectoryFiles(files);
      const directory = selectedExecutable ? this.directoryFromExecutablePath(selectedExecutable) : undefined;
      if (!directory) {
        this.showDirectorySelectionFeedback(feedback, "所选目录中未找到可读取的 svn.exe。请检查安装目录。");
        return;
      }
      await this.saveSvnExecutableFromDirectory(directory, executableInput, feedback);
    } catch {
      this.showDirectorySelectionFeedback(feedback, "读取所选目录失败。请重试或手动填写 svn.exe 路径。");
    }
  }

  private async saveSvnExecutableFromDirectory(directory: string, executableInput: { setValue(value: string): unknown } | undefined, feedback: HTMLElement | null): Promise<void> {
    const executablePath = this.findSvnExecutable(directory);
    if (!executablePath) {
      this.showDirectorySelectionFeedback(feedback, "所选目录中未找到 svn.exe 或 bin\\svn.exe。手动填写的路径未被修改。");
      return;
    }
    const previousPath = this.plugin.settings.svnExecutablePath;
    this.plugin.settings.svnExecutablePath = executablePath;
    try {
      await this.plugin.saveSettings();
      await this.plugin.detectSvn();
      executableInput?.setValue(executablePath);
      feedback?.setText("已选择并保存 svn.exe 路径。");
      feedback?.removeClass("is-error");
      feedback?.setAttribute("role", "status");
    } catch {
      this.plugin.settings.svnExecutablePath = previousPath;
      executableInput?.setValue(previousPath);
      this.showDirectorySelectionFeedback(feedback, "保存设置失败。已保留原 svn.exe 路径。");
    }
  }

  private findSvnExecutable(directory: string): string | undefined {
    const runtimeRequire = this.getRuntimeRequire();
    if (!runtimeRequire) return undefined;
    try {
      const fs = runtimeRequire("fs") as { existsSync?: (path: string) => boolean };
      const path = runtimeRequire("path") as { join?: (...segments: string[]) => string };
      if (!fs.existsSync || !path.join) return undefined;
      return [path.join(directory, "svn.exe"), path.join(directory, "bin", "svn.exe")].find((candidate) => fs.existsSync?.(candidate));
    } catch {
      return undefined;
    }
  }

  private directoryFromExecutablePath(executablePath: string): string | undefined {
    const runtimeRequire = this.getRuntimeRequire();
    if (!runtimeRequire) return undefined;
    try {
      const path = runtimeRequire("path") as { basename?: (value: string) => string; dirname?: (value: string) => string };
      if (!path.basename || !path.dirname || path.basename(executablePath).toLowerCase() !== "svn.exe") return undefined;
      const parent = path.dirname(executablePath);
      return path.basename(parent).toLowerCase() === "bin" ? path.dirname(parent) : parent;
    } catch {
      return undefined;
    }
  }

  private getRuntimeRequire(): RuntimeRequire | undefined {
    const candidate = (globalThis as typeof globalThis & { require?: RuntimeRequire }).require;
    return typeof candidate === "function" ? candidate : undefined;
  }

  private getElectronFilePath(file: File): string {
    const runtimeRequire = this.getRuntimeRequire();
    if (!runtimeRequire) return (file as File & { path?: string }).path || "";
    try {
      const electron = runtimeRequire("electron") as { webUtils?: { getPathForFile?: (selectedFile: File) => string } };
      return electron.webUtils?.getPathForFile?.(file) || (file as File & { path?: string }).path || "";
    } catch {
      return (file as File & { path?: string }).path || "";
    }
  }
}
