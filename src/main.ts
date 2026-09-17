import { App, Modal, Notice, Plugin, setIcon } from "obsidian";
import { applyMergeSource, associationPayload, buildChangeTree, buildOperationPayload, canSubmit, createAssociationDraft, formatHistoryRelativeTime, formatHistoryTime, getCompactDirectoryChain, groupChanges, isConfigurationRequired, mergeForConflict, selectedChangeCount, shouldRenderOperationBar, shouldRenderOperationResult, shouldRenderUiUpdate, statusBarCopy, toggleHistorySelection, validateMergeResult, updateAssociationDraft } from "./ui-state.mjs";
import { CommitLayout, DEFAULT_SETTINGS, ModalSize, ResizableModalKind, SvnPluginSettings, SvnSettingTab } from "./settings";
import type { SvnOperationName, SvnOperationPayload, SvnPanel, SvnUiState, SvnUiStateSource, SvnUiUpdate } from "./types";
import { SvnRuntimeStateSource } from "./runtime-state";
import { normalizeVaultPath, repositoryUrlForVault, setRepositoryUrlForVault } from "./vault-config";
import "./styles.css";

const PANEL_LABELS: Array<{ id: SvnPanel; label: string; icon: string }> = [
  { id: "overview", label: "概览与同步", icon: "refresh-cw" },
  { id: "commit", label: "提交", icon: "upload" },
  { id: "conflicts", label: "冲突", icon: "git-merge" },
  { id: "history", label: "历史", icon: "history" },
  { id: "ignore", label: "忽略规则", icon: "ban" },
];

type ModalLayoutKind = ResizableModalKind;

const DEFAULT_COMMIT_LAYOUT: CommitLayout = { filesRatio: 0.32, messageRatio: 0.2, diffRatio: 0.48 };
const MODAL_DEFAULTS: Record<ModalLayoutKind, ModalSize> = {
  "control-center": { width: 960, height: 780 },
  wizard: { width: 820, height: 640 },
  merge: { width: 1320, height: 760 },
};

function allocateCommitHeights(total: number, layout: Partial<CommitLayout>): [number, number, number] {
  const minimums: [number, number, number] = [150, 130, 260];
  const available = Math.max(minimums.reduce((sum, value) => sum + value, 0), total || 0);
  const ratio = normalizeCommitLayout(layout); const heights: [number, number, number] = [available * ratio.filesRatio, available * ratio.messageRatio, available * ratio.diffRatio];
  for (let index = 0; index < minimums.length; index += 1) {
    if (heights[index] >= minimums[index]) continue;
    const deficit = minimums[index] - heights[index]; heights[index] = minimums[index];
    const donors = heights.map((value, donor) => donor !== index ? Math.max(0, value - minimums[donor]) : 0); const donorTotal = donors.reduce((sum, value) => sum + value, 0);
    for (let donor = 0; donor < heights.length; donor += 1) heights[donor] -= donorTotal ? deficit * donors[donor] / donorTotal : 0;
  }
  return heights;
}

function normalizeCommitLayout(layout?: Partial<CommitLayout>): CommitLayout {
  const values = [Number(layout?.filesRatio), Number(layout?.messageRatio), Number(layout?.diffRatio)];
  const valid = values.every((value) => Number.isFinite(value) && value > 0);
  if (!valid) return { ...DEFAULT_COMMIT_LAYOUT };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { filesRatio: values[0] / total, messageRatio: values[1] / total, diffRatio: values[2] / total };
}

function compareRevisionNumbers(left: string, right: string): number {
  const leftNumber = Number(left.replace(/^r/i, ""));
  const rightNumber = Number(right.replace(/^r/i, ""));
  return leftNumber - rightNumber;
}

function historyCompareKindLabel(kind: "added" | "modified" | "deleted"): string {
  return kind === "added" ? "新增" : kind === "deleted" ? "删除" : "修改";
}

function clampModalSize(kind: ModalLayoutKind, size: ModalSize): ModalSize {
  const defaults = MODAL_DEFAULTS[kind];
  const narrow = window.innerWidth <= 680;
  const maxWidth = Math.max(320, window.innerWidth - (narrow ? 16 : 48));
  const maxHeight = Math.max(320, window.innerHeight - (narrow ? 16 : 48));
  const minWidth = Math.min(maxWidth, narrow ? 320 : kind === "merge" ? 720 : kind === "control-center" ? 640 : 520);
  const minHeight = Math.min(maxHeight, narrow ? 320 : kind === "control-center" ? 700 : 480);
  return { width: Math.min(maxWidth, Math.max(minWidth, Number(size?.width) || defaults.width)), height: Math.min(maxHeight, Math.max(minHeight, Number(size?.height) || defaults.height)) };
}

function applyModalLayout(modalEl: HTMLElement, kind: ModalLayoutKind, savedSize?: ModalSize): void {
  const narrow = window.innerWidth <= 680;
  const size = clampModalSize(kind, savedSize ?? MODAL_DEFAULTS[kind]);
  modalEl.style.setProperty("width", narrow ? "calc(100vw - 16px)" : `${size.width}px`, "important");
  modalEl.style.setProperty("max-width", narrow ? "calc(100vw - 16px)" : "calc(100vw - 48px)", "important");
  modalEl.style.setProperty("max-height", narrow ? "calc(100vh - 16px)" : "calc(100vh - 48px)", "important");
  modalEl.style.setProperty("height", narrow ? "calc(100vh - 16px)" : `${size.height}px`, "important");
  modalEl.style.setProperty("box-sizing", "border-box");
  modalEl.style.setProperty("overflow", "hidden", "important");
}

function applyMaximizedModalLayout(modalEl: HTMLElement): void {
  modalEl.style.setProperty("width", "calc(100vw - 16px)", "important");
  modalEl.style.setProperty("height", "calc(100vh - 16px)", "important");
  modalEl.style.setProperty("max-width", "calc(100vw - 16px)", "important");
  modalEl.style.setProperty("max-height", "calc(100vh - 16px)", "important");
  modalEl.style.setProperty("box-sizing", "border-box");
  modalEl.style.setProperty("overflow", "hidden", "important");
}

function clearModalLayout(modalEl: HTMLElement): void {
  ["width", "max-width", "max-height", "height", "box-sizing", "overflow"].forEach((property) => modalEl.style.removeProperty(property));
}

function installModalResizer(modalEl: HTMLElement, kind: ModalLayoutKind, onSave: (size: ModalSize) => void, isDisabled: () => boolean = () => false): () => void {
  const handle = modalEl.createDiv({ cls: "svn-modal-resize-handle", attr: { role: "presentation", "aria-hidden": "true" } });
  if (window.innerWidth <= 680) handle.addClass("is-disabled");
  let start: { x: number; y: number; size: ModalSize } | undefined;
  const move = (event: PointerEvent) => {
    if (!start) return;
    const size = clampModalSize(kind, { width: start.size.width + event.clientX - start.x, height: start.size.height + event.clientY - start.y });
    modalEl.style.setProperty("width", `${size.width}px`, "important"); modalEl.style.setProperty("height", `${size.height}px`, "important");
  };
  const end = (event: PointerEvent) => {
    if (!start) return;
    const size = clampModalSize(kind, { width: modalEl.getBoundingClientRect().width, height: modalEl.getBoundingClientRect().height });
    start = undefined; handle.releasePointerCapture?.(event.pointerId); onSave(size);
  };
  const down = (event: PointerEvent) => { if (window.innerWidth <= 680 || isDisabled()) return; event.preventDefault(); const rect = modalEl.getBoundingClientRect(); start = { x: event.clientX, y: event.clientY, size: clampModalSize(kind, { width: rect.width, height: rect.height }) }; handle.setPointerCapture?.(event.pointerId); };
  handle.addEventListener("pointerdown", down); handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end); handle.addEventListener("pointercancel", end);
  return () => { handle.removeEventListener("pointerdown", down); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); handle.remove(); };
}

interface ModalPersistence { get(kind: ResizableModalKind): ModalSize | undefined; save(kind: ResizableModalKind, size: ModalSize): void; }
interface CommitPersistence { get(): CommitLayout; save(layout: CommitLayout): void; }

export default class SvnSyncPlugin extends Plugin {
  settings: SvnPluginSettings = DEFAULT_SETTINGS;
  svnDetection: { status: "ready" | "missing" | "error"; source: string; version?: string; message: string } = { status: "missing", source: "尚未检测", version: "", message: "尚未检测 SVN 客户端" };
  private runtimeStateSource!: SvnRuntimeStateSource;
  private hasInjectedStateSource = false;
  private uiStateSource!: SvnUiStateSource;
  private statusBarItem?: HTMLElement;
  private statusBarUnsubscribe?: () => void;
  private statusRefreshTimer?: number;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.runtimeStateSource = new SvnRuntimeStateSource({
      vaultPath: () => (this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? "",
      vaultName: () => this.app.vault.getName(),
      getSettings: () => this.settings,
      saveRepositoryUrl: (repositoryUrl) => this.saveRepositoryUrlForCurrentVault(repositoryUrl),
    });
    this.uiStateSource = this.runtimeStateSource;
    this.register(this.runtimeStateSource.subscribe(() => { const patterns = this.runtimeStateSource.getState().customIgnorePatterns; if (patterns.join("\n") !== this.settings.ignorePatterns.join("\n")) { this.settings.ignorePatterns = [...patterns]; void this.saveSettings(); } }));
    await this.runtimeStateSource.detect();
    this.syncDetectionFromRuntime();
    this.createStatusBarItem();
    this.registerVaultChangeListeners();
    this.addSettingTab(new SvnSettingTab(this.app, this));
    this.addRibbonIcon("folder-sync", "打开 SVN 控制中心", () => this.openControlCenter());
    this.addCommand({ id: "open-svn-control-center", name: "打开 SVN 控制中心", callback: () => this.openControlCenter() });
    this.addCommand({ id: "open-svn-association-wizard", name: "打开 SVN 首次关联向导", callback: () => this.openAssociationWizard() });
  }

  async loadSettings(): Promise<void> {
    const storedData = (await this.loadData() ?? {}) as Record<string, unknown>;
    const { operationLogs: _operationLogs, logRetentionDays: _logRetentionDays, ...settingsData } = storedData;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    this.settings.repositoryUrlByVault = this.settings.repositoryUrlByVault ?? {};
    this.settings.commitLayoutByVault = this.settings.commitLayoutByVault ?? {};
    this.settings.modalSizeByVault = this.settings.modalSizeByVault ?? {};
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getRepositoryUrlForCurrentVault(): string {
    const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? "";
    return repositoryUrlForVault(this.settings.repositoryUrlByVault, vaultPath);
  }

  async saveRepositoryUrlForCurrentVault(repositoryUrl: string): Promise<void> {
    const vaultPath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? "";
    this.settings.repositoryUrlByVault ??= {};
    setRepositoryUrlForVault(this.settings.repositoryUrlByVault, vaultPath, repositoryUrl);
    await this.saveSettings();
  }

  syncCustomIgnorePatterns(patterns: string[]): void { if (!this.hasInjectedStateSource) this.runtimeStateSource.setCustomIgnorePatterns(patterns); }

  /** Future command services can provide live state without coupling UI to svn.exe. */
  setUiStateSource(source: SvnUiStateSource): void {
    this.uiStateSource = source;
    this.hasInjectedStateSource = true;
    this.bindStatusBarStateSource();
    this.renderStatusBarItem();
  }

  setSvnDetection(detection: { status: "ready" | "missing" | "error"; source: string; version?: string; message: string }): void {
    this.svnDetection = detection;
    this.openPluginSettings();
  }

  async detectSvn(): Promise<void> {
    if (this.hasInjectedStateSource) { await this.uiStateSource.refresh?.(); return; }
    await this.runtimeStateSource.detect();
    this.syncDetectionFromRuntime();
  }

  async clearAuthCache(): Promise<void> {
    const result = await this.uiStateSource.runOperation("clear-auth-cache");
    new Notice(result.ok ? "SVN 认证缓存已清除。" : `无法清除认证缓存：${result.error ?? "未知错误"}`);
  }

  private syncDetectionFromRuntime(): void {
    const client = this.runtimeStateSource.getState().client;
    this.svnDetection = { status: client.status === "ready" ? "ready" : client.status === "missing" ? "missing" : "error", source: client.source ?? "本机检测", version: client.version, message: client.message };
  }

  private createStatusBarItem(): void {
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("svn-status-bar-item");
    this.statusBarItem.addEventListener("click", () => this.openControlCenter());
    this.statusBarItem.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.openControlCenter();
    });
    this.bindStatusBarStateSource();
    this.renderStatusBarItem();
    this.register(() => { this.statusBarUnsubscribe?.(); this.statusBarUnsubscribe = undefined; });
  }

  private bindStatusBarStateSource(): void {
    if (!this.statusBarItem) return;
    this.statusBarUnsubscribe?.();
    this.statusBarUnsubscribe = this.uiStateSource.subscribe?.(() => this.renderStatusBarItem());
  }

  private renderStatusBarItem(): void {
    if (!this.statusBarItem) return;
    const copy = statusBarCopy(this.uiStateSource.getState());
    this.statusBarItem.removeClass("is-muted");
    this.statusBarItem.removeClass("is-warning");
    this.statusBarItem.removeClass("is-danger");
    this.statusBarItem.removeClass("is-synced");
    this.statusBarItem.addClass(`is-${copy.tone}`);
    this.statusBarItem.setAttribute("role", "button");
    this.statusBarItem.setAttribute("tabindex", "0");
    this.statusBarItem.setAttribute("title", copy.title);
    this.statusBarItem.setAttribute("aria-label", copy.title);
    this.statusBarItem.empty();
    this.statusBarItem.createSpan({ text: copy.label });
  }

  private registerVaultChangeListeners(): void {
    const scheduleRefresh = () => this.scheduleStatusRefresh();
    this.registerEvent(this.app.vault.on("modify", scheduleRefresh));
    this.registerEvent(this.app.vault.on("create", scheduleRefresh));
    this.registerEvent(this.app.vault.on("delete", scheduleRefresh));
    this.registerEvent(this.app.vault.on("rename", scheduleRefresh));
    this.register(() => {
      if (this.statusRefreshTimer === undefined) return;
      window.clearTimeout(this.statusRefreshTimer);
      this.statusRefreshTimer = undefined;
    });
  }

  private scheduleStatusRefresh(): void {
    const state = this.uiStateSource.getState();
    if (!this.uiStateSource.refresh || !state.client.configured || state.associationStatus !== "associated" || state.viewStatus.kind !== "ready") return;
    if (this.statusRefreshTimer !== undefined) window.clearTimeout(this.statusRefreshTimer);
    this.statusRefreshTimer = window.setTimeout(() => {
      this.statusRefreshTimer = undefined;
      if (this.uiStateSource.getState().operation.status === "running") return;
      void this.uiStateSource.refresh?.(true);
    }, 300);
  }

  openControlCenter(): void {
    const source = this.uiStateSource;
    const state = source.getState();
    new SvnControlCenterModal(this.app, state, source, () => this.openPluginSettings(), this.settings.defaultCheckoutDirectory, { get: () => this.getCommitLayoutForCurrentVault(), save: (layout) => void this.saveCommitLayoutForCurrentVault(layout) }, this.modalPersistence()).open();
  }

  openAssociationWizard(defaultCheckoutDirectory = this.settings.defaultCheckoutDirectory, defaultRepositoryUrl = this.getRepositoryUrlForCurrentVault()): void {
    new FirstAssociationModal(this.app, this.uiStateSource, defaultCheckoutDirectory, defaultRepositoryUrl, this.modalPersistence()).open();
  }

  getCommitLayoutForCurrentVault(): CommitLayout {
    const key = this.currentVaultKey();
    return normalizeCommitLayout(this.settings.commitLayoutByVault?.[key]);
  }

  async saveCommitLayoutForCurrentVault(layout: CommitLayout): Promise<void> {
    this.settings.commitLayoutByVault ??= {};
    this.settings.commitLayoutByVault[this.currentVaultKey()] = normalizeCommitLayout(layout);
    await this.saveSettings();
  }

  modalPersistence(): ModalPersistence {
    return {
      get: (kind) => this.settings.modalSizeByVault?.[this.currentVaultKey()]?.[kind],
      save: (kind, size) => void this.saveModalSizeForCurrentVault(kind, size),
    };
  }

  private async saveModalSizeForCurrentVault(kind: ResizableModalKind, size: ModalSize): Promise<void> {
    this.settings.modalSizeByVault ??= {};
    const key = this.currentVaultKey();
    this.settings.modalSizeByVault[key] = { ...(this.settings.modalSizeByVault[key] ?? {}), [kind]: clampModalSize(kind, size) };
    await this.saveSettings();
  }

  private currentVaultKey(): string {
    return normalizeVaultPath((this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? "", process.platform);
  }

  private openPluginSettings(): void {
    const settings = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  openDangerConfirmation(title: string, description: string, confirmText: string, onConfirm: () => void): void {
    new DangerConfirmationModal(this.app, title, description, confirmText, onConfirm).open();
  }
}

class SvnControlCenterModal extends Modal {
  private state: SvnUiState;
  private mergeError = "";
  private unsubscribe?: () => void;
  private closed = false;
  private uiError = "";
  private commitMessageDraft: string;
  private editingCommitMessage = false;
  private associationRepositoryUrl: string;
  private removeResizeHandle?: () => void;
  private selectedCommitPath = "";
  private selectedHistoryRevision = "";
  private selectedHistoryRevisions: string[] = [];
  private commitFilesScrollTop = 0;
  private commitFilesScrollAnchor?: { path: string; offsetTop: number };
  private commitDiffPane?: HTMLElement;
  private diffRequestedPath = "";
  private commitHeights?: [number, number, number];
  private collapsedCommitDirectories = new Set<string>();
  private expandedCompactDirectoryChains = new Set<string>();
  private removeCommitObserver?: () => void;
  private commitDragActive = false;
  private maximized = false;
  private restoreSize?: ModalSize;
  private readonly onWindowResize = () => { if (this.maximized) applyMaximizedModalLayout(this.modalEl); };
  private historyDiffRequests = new Set<string>();
  private historyCompareFileRequests = new Set<string>();
  private refreshingOnOpen = false;

  constructor(app: App, state: SvnUiState, private readonly stateSource: SvnUiStateSource, private readonly openSettings: () => void, private readonly defaultCheckoutDirectory = "", private readonly commitPersistence: CommitPersistence = { get: () => ({ ...DEFAULT_COMMIT_LAYOUT }), save: () => {} }, private readonly modalPersistence: ModalPersistence = { get: () => undefined, save: () => {} }) {
    super(app);
    this.state = state;
    this.commitMessageDraft = state.commitMessage;
    this.associationRepositoryUrl = state.repositoryUrl;
  }

  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("svn-control-center-modal");
    this.modalEl.parentElement?.classList.add("svn-control-center-modal-container");
    applyModalLayout(this.modalEl, "control-center", this.modalPersistence.get("control-center"));
    this.removeResizeHandle = installModalResizer(this.modalEl, "control-center", (size) => this.modalPersistence.save("control-center", size), () => this.maximized);
    window.addEventListener("resize", this.onWindowResize);
    this.unsubscribe = this.stateSource.subscribe?.(() => {
      if (this.closed || this.editingCommitMessage) return;
      const previous = this.state;
      this.state = this.stateSource.getState();
      const diffOnly = Boolean(this.commitDiffPane)
        && previous.activePanel === "commit" && this.state.activePanel === "commit"
        && previous.changes === this.state.changes
        && previous.conflicts === this.state.conflicts
        && previous.history === this.state.history
        && previous.operation === this.state.operation
        && previous.diffByPath !== this.state.diffByPath;
      if (diffOnly) { this.renderCommitDiffInPlace(); return; }
      this.render();
    });
    this.refreshingOnOpen = this.state.associationStatus === "associated" && this.state.viewStatus.kind === "ready" && this.state.operation.status !== "running" && Boolean(this.stateSource.refresh);
    this.render();
    if (this.refreshingOnOpen) void this.refreshFromSource();
  }

  onClose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.removeResizeHandle?.(); this.removeResizeHandle = undefined;
    this.historyDiffRequests.clear();
    window.removeEventListener("resize", this.onWindowResize);
    this.maximized = false; this.modalEl.removeClass("is-maximized");
    this.modalEl.parentElement?.classList.remove("svn-control-center-modal-container");
    clearModalLayout(this.modalEl);
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    this.commitDiffPane = undefined;
    root.empty();
    root.addClass("svn-control-center");
    if (isConfigurationRequired(this.state) && this.state.viewStatus.kind !== "unsupported") { this.renderConfigurationShell(root); return; }
    this.renderHeader(root);
    if (this.state.associationStatus !== "associated" || this.state.viewStatus.kind !== "ready") {
      this.renderOperationResult(root);
      const content = root.createDiv({ cls: "svn-center-content svn-association-content" });
      this.renderPanel(content);
      this.renderOperationBar(root);
      return;
    }
    this.renderContextStrip(root);
    this.renderOperationResult(root);
    const shell = root.createDiv({ cls: "svn-center-shell" });
    this.renderNavigation(shell);
    const main = shell.createDiv({ cls: "svn-center-main" });
    if (this.state.activePanel === "commit") this.renderCommitWorkbench(main);
    else { const content = main.createDiv({ cls: "svn-center-content" }); this.renderPanel(content); }
    this.renderOperationBar(root);
  }

  private renderConfigurationShell(root: HTMLElement): void {
    this.renderHeader(root, true);
    const content = root.createDiv({ cls: "svn-center-content svn-configuration-content" });
    this.renderConfigurationRequired(content);
  }

  private renderHeader(root: HTMLElement, compact = false): void {
    const header = root.createDiv({ cls: "svn-center-header" });
    const identity = header.createDiv({ cls: "svn-vault-identity" });
    identity.createEl("h2", { text: this.state.vaultName });
    if (!compact) {
      const actions = header.createDiv({ cls: "svn-header-actions" });
      this.iconButton(actions, "刷新状态", "refresh-cw", () => this.refreshFromSource(), this.state.operation.status === "running");
      this.iconButton(actions, this.maximized ? "恢复窗口" : "最大化窗口", this.maximized ? "minimize-2" : "maximize-2", () => this.toggleMaximized(), false, this.maximized);
    }
  }

  private renderContextStrip(root: HTMLElement): void {
    const context = root.createDiv({ cls: "svn-center-context-strip" });
    context.createEl("div", { text: this.state.repositoryUrl, cls: "svn-repository-url" });
    const stateLabel = this.state.status === "conflicts" ? "存在冲突" : this.state.status === "local-changes" ? "有本地修改" : this.state.status === "needs-cleanup" ? "需要清理" : "已同步";
    this.createStatus(context, this.state.status, stateLabel);
    context.createEl("span", { text: `未提交 ${this.state.changes.length}`, cls: "svn-context-metric" });
    context.createEl("span", { text: `最后刷新：${this.state.lastRefreshedAt}`, cls: "svn-refreshed-at" });
  }

  private renderNavigation(shell: HTMLElement): void {
    const nav = shell.createEl("nav", { cls: "svn-center-nav", attr: { "aria-label": "控制中心功能导航" } });
    const navigationTooltips: Record<SvnPanel, string> = {
      overview: "查看并刷新当前笔记仓库状态",
      commit: "查看待提交文件",
      conflicts: "查看并处理冲突文件",
      history: "查看 SVN 仓库历史",
      ignore: "管理 SVN 忽略规则",
    };
    for (const item of PANEL_LABELS) {
      const label = item.id === "commit" ? `待提交 ${this.state.changes.length}` : item.label;
      const button = nav.createEl("button", { cls: `svn-nav-item ${this.state.activePanel === item.id ? "is-active" : ""}`, attr: { type: "button", title: navigationTooltips[item.id], "aria-label": navigationTooltips[item.id] } });
      const icon = button.createSpan({ cls: "svn-nav-icon" });
      setIcon(icon, item.icon);
      button.createSpan({ text: label });
      if (item.id === "conflicts") {
        const count = this.state.conflicts.filter((conflict) => !conflict.resolved).length;
        button.createSpan({ text: String(count), cls: "svn-nav-count" });
      }
      button.addEventListener("click", () => {
        void this.updateUi({ type: "select-panel", panel: item.id });
      });
    }
  }

  private renderPanel(content: HTMLElement, fixedHost?: HTMLElement): void {
    if (this.state.viewStatus.kind !== "ready") { this.renderViewStatus(content); return; }
    if (this.state.activePanel === "overview") this.renderOverview(content);
    if (this.state.activePanel === "commit") this.renderCommit(content, fixedHost);
    if (this.state.activePanel === "conflicts") this.renderConflicts(content);
    if (this.state.activePanel === "history") this.renderHistory(content);
    if (this.state.activePanel === "ignore") this.renderIgnoreRules(content);
  }

  private renderConfigurationRequired(content: HTMLElement): void {
    const guide = content.createDiv({ cls: "svn-configuration-guide" });
    this.sectionTitle(guide, "需要配置 SVN 客户端", "尚未检测到 svn.exe。配置完成后，插件才会读取或关联 SVN 工作副本。", "needs-cleanup", "尚未配置");
    guide.createEl("p", { text: "当前笔记仓库不会被误显示为已关联仓库。可手动填写路径，或在设置中选择 SVN 安装目录。" });
    this.button(guide, "配置 SVN 客户端", "primary", this.openSettings);
  }

  private renderViewStatus(content: HTMLElement): void {
    const status = this.state.viewStatus;
    const heading = ({ empty: "暂无工作副本数据", "metadata-error": "检测到 SVN 元数据但无法读取", loading: "正在读取工作副本", error: "无法读取工作副本", locked: "工作副本已锁定", damaged: "工作副本已损坏", "auth-failed": "SVN 认证失败", "network-error": "无法连接 SVN 仓库", unsupported: "当前系统不受支持", ready: "工作副本状态已就绪" } as Record<string, string>)[status.kind] ?? "SVN 状态异常";
    const action = status.actionLabel ?? ({ empty: "打开首次关联向导", "metadata-error": "重新关联", loading: "刷新状态", error: "重试读取", locked: "清理工作副本", damaged: "查看诊断", "auth-failed": "重新认证", "network-error": "重试", unsupported: "查看说明", ready: "刷新状态" } as Record<string, string>)[status.kind] ?? "重试";
    if (status.kind === "empty" || status.kind === "metadata-error") { this.renderAssociationRequired(content); return; }
    this.sectionTitle(content, heading, status.message, status.kind === "error" || status.kind === "auth-failed" ? "conflicts" : status.kind === "locked" ? "needs-cleanup" : "synced", action);
    const run = status.kind === "auth-failed"
        ? () => new CredentialRetryModal(this.app, this.stateSource).open()
        : status.kind === "locked"
          ? () => this.confirm("清理工作副本", `影响范围：${this.state.workingCopyPath}。将尝试清除由中断 SVN 操作遗留的锁定。`, "执行清理", () => this.requestOperation("cleanup"))
          : () => this.refreshFromSource();
    this.button(content, action, status.kind === "locked" || status.kind === "damaged" ? "warning" : "primary", run, status.kind === "loading" || status.kind === "unsupported");
    if (status.kind === "locked") content.createEl("p", { text: "清理将修复中断操作遗留的锁定。执行前会显示影响说明。", cls: "svn-form-guidance" });
  }

  private renderAssociationRequired(content: HTMLElement): void {
    const metadataError = this.state.viewStatus.kind === "metadata-error";
    const guide = content.createDiv({ cls: "svn-association-required" });
    this.sectionTitle(guide, metadataError ? "需要重新关联 SVN" : "当前笔记仓库尚未关联 SVN", this.state.viewStatus.message, metadataError ? "conflicts" : "needs-cleanup", metadataError ? "需要处理" : "待关联");
    if (metadataError) guide.createEl("p", { text: "目录中仍有 .svn 元数据，但 svn info 无法读取它。请确认目录没有被移动或损坏；必要时重新检出到新目录。", cls: "svn-danger-note" });
    const label = guide.createEl("label", { text: "SVN 仓库地址", attr: { for: "svn-association-repository-url" } });
    const input = guide.createEl("input", { cls: "svn-association-repository-url", attr: { id: "svn-association-repository-url", type: "url", placeholder: "https://svn.example.com/repos/notes" } });
    input.value = this.associationRepositoryUrl;
    input.addEventListener("input", () => { this.associationRepositoryUrl = input.value; });
    label.insertAdjacentElement("afterend", input);
    guide.createEl("p", { text: "地址只会作为关联向导的默认值；执行 checkout 或 import 前仍会校验不能为空。", cls: "svn-form-guidance" });
    const actions = guide.createDiv({ cls: "svn-inline-actions" });
    this.button(actions, "输入地址并开始关联", "primary", () => new FirstAssociationModal(this.app, this.stateSource, this.defaultCheckoutDirectory, this.associationRepositoryUrl, this.modalPersistence).open());
    this.button(actions, "打开设置", "secondary", this.openSettings);
    this.button(actions, "重新检测", "secondary", () => this.refreshFromSource());
    if (this.state.operation.status === "error") guide.createEl("pre", { text: this.state.operation.output, cls: "svn-diagnostic-output" });
  }

  private renderOverview(content: HTMLElement): void {
    const overview = this.overviewCopy();
    this.sectionTitle(content, overview.title, overview.description, this.state.status, overview.label);
    if (overview.impact) {
      const impact = content.createDiv({ cls: "svn-impact-note" });
      this.iconText(impact, "triangle-alert", overview.impact);
    }
    const details = content.createDiv({ cls: "svn-detail-list" });
    this.detailRow(details, "仓库地址", this.state.repositoryUrl);
    this.detailRow(details, "工作副本", this.state.workingCopyPath);
    this.detailRow(details, "未提交改动", `${this.state.changes.length} 个文件`);
    this.detailRow(details, "最近操作", this.state.operation.message);
    const actions = content.createDiv({ cls: "svn-inline-actions" });
    this.button(actions, "更新", "primary", () => this.confirmUpdate(this.state, () => this.requestOperation("update")));
    this.button(actions, "转到提交", "secondary", () => void this.updateUi({ type: "select-panel", panel: "commit" }));
    this.button(actions, "清理工作副本", "secondary", () => this.confirm("清理工作副本", "影响范围：当前工作副本。仅用于中断更新或工作副本锁定。", "执行清理", () => this.requestOperation("cleanup")));
  }

  private renderCommit(content: HTMLElement, fixedHost?: HTMLElement): void {
    const hasConflict = this.state.conflicts.some((conflict) => !conflict.resolved) || this.state.changes.some((change) => change.kind === "conflict");
    this.sectionTitle(content, "准备提交", hasConflict ? "先解决冲突，才能提交所选文件。" : "选择需要提交的文件；勾选未版本化文件后，提交时会先加入版本控制。", hasConflict ? "conflicts" : "local-changes", hasConflict ? "存在未解决冲突" : this.commitSelectionText(this.state));
    const toolbar = content.createDiv({ cls: "svn-list-toolbar" });
    const toggleAll = toolbar.createEl("label", { cls: "svn-check-label" });
    const all = toggleAll.createEl("input", { attr: { type: "checkbox" } });
    const submittable = this.state.changes.filter((change) => change.kind !== "conflict");
    all.checked = submittable.length > 0 && submittable.every((change) => change.selected);
    toggleAll.createSpan({ text: "全选可提交文件（含未版本化）" });
    all.addEventListener("change", () => void this.updateUi({ type: "set-all-submittable", selected: all.checked }));
    const filter = toolbar.createEl("input", { cls: "svn-filter", attr: { type: "search", placeholder: "筛选路径" } });
    const list = content.createDiv({ cls: "svn-change-list" });
    const drawChanges = () => {
      list.empty();
      const groups = groupChanges(this.state.changes.filter((item) => item.path.toLowerCase().includes(filter.value.toLowerCase()))) as Record<string, SvnUiState["changes"]>;
      for (const kind of ["added", "modified", "deleted", "unversioned", "conflict"] as const) {
        if (!groups[kind].length) continue;
        list.createEl("h3", { text: `${this.changeLabel(kind)} (${groups[kind].length})`, cls: "svn-change-group-title" });
        for (const change of groups[kind]) {
          const row = list.createDiv({ cls: "svn-change-row" });
          const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `选择 ${change.path}` } });
          checkbox.checked = change.selected; checkbox.disabled = change.kind === "conflict";
          checkbox.addEventListener("change", () => void this.updateUi({ type: "set-change-selection", changeId: change.id, selected: checkbox.checked }));
          row.createSpan({ text: this.changeLabel(change.kind), cls: `svn-change-kind is-${change.kind}` });
          row.createSpan({ text: change.path, cls: "svn-file-path" });
          this.renderChangeActions(row, change);
        }
      }
    };
    filter.addEventListener("input", drawChanges);
    drawChanges();
    const composer = (fixedHost ?? content).createDiv({ cls: "svn-commit-composer" });
    composer.createEl("label", { text: "提交说明", attr: { for: "svn-commit-message" } });
    const message = composer.createEl("textarea", { attr: { id: "svn-commit-message", placeholder: "说明本次变更的目的" } });
    message.value = this.commitMessageDraft;
    message.addEventListener("focus", () => { this.editingCommitMessage = true; });
    message.addEventListener("input", () => { this.commitMessageDraft = message.value; void this.updateUi({ type: "set-commit-message", message: message.value }, false); });
    message.addEventListener("blur", () => { this.editingCommitMessage = false; });
    const guidance = composer.createDiv({ cls: "svn-form-guidance" });
    const commitState = { ...this.state, commitMessage: this.commitMessageDraft };
    guidance.setText(hasConflict ? "提交已禁用：请先解决全部冲突。" : !this.state.changes.length ? "当前没有待提交文件。" : selectedChangeCount(this.state) === 0 ? "至少选择一个文件。" : this.commitSelectionText(commitState));
    this.button(composer, `提交 ${selectedChangeCount(this.state)} 个文件`, "primary", () => this.confirmCurrentCommit(), !canSubmit(commitState));
  }

  private renderCommitWorkbench(main: HTMLElement): void {
    this.removeCommitObserver?.();
    const workbench = main.createDiv({ cls: "svn-commit-workbench" });
    const files = workbench.createDiv({ cls: "svn-commit-section svn-commit-files-pane", attr: { "aria-label": "待提交文件" } });
    const fileList = this.renderCommitFiles(files);
    const firstSplitter = workbench.createDiv({ cls: "svn-commit-splitter", attr: { role: "separator", tabindex: "0", "aria-orientation": "horizontal", "aria-label": "调整文件区与提交信息区高度" } });
    const message = workbench.createDiv({ cls: "svn-commit-section svn-commit-message-pane", attr: { "aria-label": "提交信息" } });
    this.renderCommitMessage(message);
    const secondSplitter = workbench.createDiv({ cls: "svn-commit-splitter", attr: { role: "separator", tabindex: "0", "aria-orientation": "horizontal", "aria-label": "调整提交信息区与差异区高度" } });
    const diff = workbench.createDiv({ cls: "svn-commit-section svn-commit-diff-pane", attr: { "aria-label": "文件差异" } });
    this.commitDiffPane = diff;
    this.renderCommitDiff(diff);
    const applySize = () => {
      const total = Math.max(0, workbench.getBoundingClientRect().height - 16);
      this.commitHeights = allocateCommitHeights(total, this.commitPersistence.get());
      this.setCommitHeights(workbench, this.commitHeights);
      this.updateSplitterAria(firstSplitter, 0, this.commitHeights, total);
      this.updateSplitterAria(secondSplitter, 1, this.commitHeights, total);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => { if (!this.commitDragActive) applySize(); });
    observer?.observe(workbench); this.removeCommitObserver = () => observer?.disconnect();
    applySize();
    fileList.scrollTop = this.commitFilesScrollTop;
    this.restoreCommitFilesScroll(fileList);
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => this.restoreCommitFilesScroll(fileList));
    this.installCommitSplitter(workbench, firstSplitter, 0);
    this.installCommitSplitter(workbench, secondSplitter, 1);
    const selected = this.state.changes.find((change) => change.path === this.selectedCommitPath);
    if (selected && !this.state.diffByPath[selected.path] && this.diffRequestedPath !== selected.path) { this.diffRequestedPath = selected.path; void this.loadFileDiff(selected.path); }
  }

  private renderCommitFiles(parent: HTMLElement): HTMLElement {
    const heading = parent.createDiv({ cls: "svn-workbench-heading" }); heading.createEl("h2", { text: "待提交文件" }); heading.createEl("p", { text: "按目录查看变更；未版本化文件勾选后会先加入版本控制再提交，未勾选仅作提醒。" });
    const toolbar = parent.createDiv({ cls: "svn-list-toolbar" });
    const selectionTools = toolbar.createDiv({ cls: "svn-commit-tree-tools" });
    const toggle = selectionTools.createEl("label", { cls: "svn-check-label" }); const all = toggle.createEl("input", { attr: { type: "checkbox" } });
    const submittable = this.state.changes.filter((change) => change.kind !== "conflict");
    all.checked = submittable.length > 0 && submittable.every((change) => change.selected); toggle.createSpan({ text: `全选可提交文件（${submittable.length}）` });
    all.addEventListener("change", () => void this.updateUi({ type: "set-all-submittable", selected: all.checked }));
    const treeActions = selectionTools.createDiv({ cls: "svn-tree-bulk-actions" });
    const expandAll = treeActions.createEl("button", { cls: "clickable-icon svn-tree-bulk-action", attr: { type: "button", title: "全部展开", "aria-label": "全部展开" } });
    setIcon(expandAll, "chevrons-down");
    const collapseAll = treeActions.createEl("button", { cls: "clickable-icon svn-tree-bulk-action", attr: { type: "button", title: "全部收起", "aria-label": "全部收起" } });
    setIcon(collapseAll, "chevrons-up");
    const filter = toolbar.createEl("input", { cls: "svn-filter", attr: { type: "search", placeholder: "筛选路径", "aria-label": "筛选待提交路径" } });
    const list = parent.createDiv({ cls: "svn-commit-files-scroll" });
    list.addEventListener("scroll", () => { this.commitFilesScrollTop = list.scrollTop; }, { passive: true });
    let visibleTreeState = { directoryPaths: new Set<string>(), topLevelDirectoryPaths: new Set<string>(), compactChainRoots: new Set<string>() };
    const collectTreeState = (node: any, depth: number, state: typeof visibleTreeState): void => {
      if (node.kind !== "directory") return;
      if (node.path) state.directoryPaths.add(node.path);
      if (depth === 0 && node.path) state.topLevelDirectoryPaths.add(node.path);
      if (getCompactDirectoryChain(node, 3)) state.compactChainRoots.add(node.path);
      node.children.forEach((child: any) => collectTreeState(child, depth + 1, state));
    };
    const applyBulkExpansion = (expand: boolean): void => {
      visibleTreeState.directoryPaths.forEach((path) => {
        this.collapsedCommitDirectories.delete(path);
        if (!expand) this.expandedCompactDirectoryChains.delete(path);
      });
      if (expand) visibleTreeState.compactChainRoots.forEach((path) => this.expandedCompactDirectoryChains.add(path));
      else visibleTreeState.topLevelDirectoryPaths.forEach((path) => this.collapsedCommitDirectories.add(path));
      this.commitFilesScrollTop = list.scrollTop;
      draw();
    };
    expandAll.addEventListener("click", () => applyBulkExpansion(true));
    collapseAll.addEventListener("click", () => applyBulkExpansion(false));
    const draw = () => {
      const previousScrollTop = list.scrollTop;
      list.empty(); const tree = buildChangeTree(this.state.changes, filter.value);
      visibleTreeState = { directoryPaths: new Set<string>(), topLevelDirectoryPaths: new Set<string>(), compactChainRoots: new Set<string>() };
      tree.children.forEach((child: any) => collectTreeState(child, 0, visibleTreeState));
      expandAll.disabled = visibleTreeState.directoryPaths.size === 0;
      collapseAll.disabled = visibleTreeState.directoryPaths.size === 0;
      const clearChainCollapseState = (chain: any): void => chain.nodes.forEach((directory: any) => this.collapsedCommitDirectories.delete(directory.path));
      const renderExpandedChain = (chain: any, target: HTMLElement, depth: number, index: number): void => {
        const node = chain.nodes[index];
        const collapsed = this.collapsedCommitDirectories.has(node.path);
        const row = target.createDiv({ cls: "svn-tree-directory-row", attr: { style: `--svn-tree-depth:${depth}` } });
        const button = row.createEl("button", { cls: "svn-tree-toggle", attr: { type: "button", "aria-label": `${index === 0 ? "收起" : collapsed ? "展开" : "收起"}${index === 0 ? chain.label : node.path}`, "aria-expanded": String(!collapsed) } });
        setIcon(button, collapsed ? "plus" : "minus"); row.createSpan({ text: node.name, cls: "svn-tree-directory-name" });
        button.addEventListener("click", () => {
          if (index === 0) { this.expandedCompactDirectoryChains.delete(chain.nodes[0].path); clearChainCollapseState(chain); draw(); return; }
          if (this.collapsedCommitDirectories.has(node.path)) this.collapsedCommitDirectories.delete(node.path); else this.collapsedCommitDirectories.add(node.path);
          draw();
        });
        if (node.path && collapsed) return;
        if (index + 1 < chain.nodes.length) renderExpandedChain(chain, target, depth + 1, index + 1);
        else chain.leaf.children.forEach((child: any) => renderNode(child, target, depth + 1));
      };
      const renderNode = (node: any, target: HTMLElement, depth: number) => {
        if (node.kind === "directory") {
          const chain = getCompactDirectoryChain(node, 3);
          if (chain && !this.expandedCompactDirectoryChains.has(node.path)) {
            const row = target.createDiv({ cls: "svn-tree-directory-row is-compact", attr: { style: `--svn-tree-depth:${depth}` } });
            const button = row.createEl("button", { cls: "svn-tree-toggle", attr: { type: "button", "aria-label": `展开${chain.label}`, "aria-expanded": "false" } });
            setIcon(button, "plus"); row.createSpan({ text: chain.label, cls: "svn-tree-directory-name svn-tree-directory-path" });
            button.addEventListener("click", () => { clearChainCollapseState(chain); this.expandedCompactDirectoryChains.add(node.path); draw(); });
            if (this.collapsedCommitDirectories.has(node.path)) return;
            chain.leaf.children.forEach((child: any) => renderNode(child, target, depth + 1)); return;
          }
          if (chain && this.expandedCompactDirectoryChains.has(node.path)) { renderExpandedChain(chain, target, depth, 0); return; }
          const row = target.createDiv({ cls: "svn-tree-directory-row", attr: { style: `--svn-tree-depth:${depth}` } });
          const collapsed = this.collapsedCommitDirectories.has(node.path);
          const button = row.createEl("button", { cls: "svn-tree-toggle", attr: { type: "button", "aria-label": `${collapsed ? "展开" : "收起"}${node.path}`, "aria-expanded": String(!collapsed) } });
          setIcon(button, collapsed ? "plus" : "minus"); row.createSpan({ text: node.name || "工作副本", cls: "svn-tree-directory-name" });
          button.addEventListener("click", () => { if (this.collapsedCommitDirectories.has(node.path)) this.collapsedCommitDirectories.delete(node.path); else this.collapsedCommitDirectories.add(node.path); draw(); });
          if (node.path && collapsed) return;
          node.children.forEach((child: any) => renderNode(child, target, depth + 1)); return;
        }
        const change = node.change; const row = target.createDiv({ cls: `svn-change-row svn-tree-file-row ${change.path === this.selectedCommitPath ? "is-selected" : ""}`, attr: { style: `--svn-tree-depth:${depth}`, "data-svn-path": change.path } });
        const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `选择 ${change.path}` } }); checkbox.checked = change.selected; checkbox.disabled = change.kind === "conflict";
        checkbox.addEventListener("click", (event) => event.stopPropagation()); checkbox.addEventListener("change", () => void this.updateUi({ type: "set-change-selection", changeId: change.id, selected: checkbox.checked }));
        row.createSpan({ text: this.changeLabel(change.kind), cls: `svn-change-kind is-${change.kind}` }); row.createSpan({ text: change.name ?? node.name, cls: "svn-file-name" }); row.createSpan({ text: change.path, cls: "svn-file-path" });
        this.renderChangeActions(row, change);
        row.addEventListener("click", () => {
          this.commitFilesScrollTop = list.scrollTop;
          const listRect = list.getBoundingClientRect(); const rowRect = row.getBoundingClientRect();
          this.commitFilesScrollAnchor = { path: change.path, offsetTop: rowRect.top - listRect.top };
          list.querySelectorAll<HTMLElement>(".svn-tree-file-row.is-selected").forEach((selectedRow) => selectedRow.removeClass("is-selected"));
          row.addClass("is-selected");
          this.selectedCommitPath = change.path; this.diffRequestedPath = ""; this.renderCommitDiffInPlace();
          if (!this.state.diffByPath[change.path]) void this.loadFileDiff(change.path);
        });
      };
      if (!this.selectedCommitPath) this.selectedCommitPath = submittable[0]?.path ?? this.state.changes[0]?.path ?? "";
      tree.children.forEach((child: any) => renderNode(child, list, 0));
      list.scrollTop = previousScrollTop;
    };
    filter.addEventListener("input", draw); draw(); return list;
  }

  private restoreCommitFilesScroll(list: HTMLElement): void {
    const anchor = this.commitFilesScrollAnchor;
    if (anchor) {
      const row = Array.from(list.querySelectorAll<HTMLElement>("[data-svn-path]")).find((candidate) => candidate.getAttribute("data-svn-path") === anchor.path);
      if (row) {
        const listRect = list.getBoundingClientRect(); const rowRect = row.getBoundingClientRect();
        list.scrollTop += rowRect.top - listRect.top - anchor.offsetTop;
        return;
      }
    }
    list.scrollTop = this.commitFilesScrollTop;
  }

  private renderCommitDiffInPlace(): void {
    if (!this.commitDiffPane) return;
    this.commitDiffPane.empty();
    this.renderCommitDiff(this.commitDiffPane);
  }

  private renderCommitMessage(parent: HTMLElement): void {
    const hasConflict = this.state.conflicts.some((conflict) => !conflict.resolved) || this.state.changes.some((change) => change.kind === "conflict");
    const heading = parent.createDiv({ cls: "svn-workbench-heading" }); heading.createEl("h2", { text: "提交信息" }); heading.createEl("p", { text: hasConflict ? "存在未解决冲突，提交按钮已禁用。" : this.commitSelectionText(this.state) });
    const message = parent.createEl("textarea", { cls: "svn-commit-message-input", attr: { id: "svn-commit-message", placeholder: "说明本次变更的目的" } }); message.value = this.commitMessageDraft;
    message.addEventListener("focus", () => { this.editingCommitMessage = true; }); message.addEventListener("input", () => { this.commitMessageDraft = message.value; void this.updateUi({ type: "set-commit-message", message: message.value }, false); }); message.addEventListener("blur", () => { this.editingCommitMessage = false; });
    const actions = parent.createDiv({ cls: "svn-commit-message-actions" }); const guidance = actions.createDiv({ cls: "svn-form-guidance" }); const commitState = { ...this.state, commitMessage: this.commitMessageDraft };
    guidance.setText(hasConflict ? "提交已禁用：请先解决全部冲突。" : !this.state.changes.length ? "当前没有待提交文件。" : selectedChangeCount(this.state) === 0 ? "至少选择一个文件。" : this.commitSelectionText(commitState));
    this.button(actions, `提交 ${selectedChangeCount(this.state)} 个文件`, "primary", () => this.confirmCurrentCommit(), !canSubmit(commitState));
  }

  private renderCommitDiff(parent: HTMLElement): void {
    const change = this.state.changes.find((candidate) => candidate.path === this.selectedCommitPath);
    const heading = parent.createDiv({ cls: "svn-workbench-heading svn-diff-heading" }); heading.createEl("h2", { text: "差异" }); heading.createEl("p", { text: change ? `${change.path} · 左侧 SVN BASE，右侧当前工作区` : "选择文件查看 SVN BASE 与当前工作区的差异。" });
    if (!change) { parent.createEl("p", { text: "当前没有可查看的文件。", cls: "svn-diff-empty" }); return; }
    const state = this.state.diffByPath[change.path];
    if (state?.status === "loading") { parent.createEl("p", { text: "正在读取文件差异…", cls: "svn-diff-empty" }); return; }
    if (state?.status === "error") { parent.createEl("p", { text: `差异读取失败：${state.message ?? "未知错误"}`, cls: "svn-inline-error" }); return; }
    if (!state?.diff || !state.diff.rows.length) { parent.createEl("p", { text: state?.diff?.message ?? (change.kind === "unversioned" ? "未版本化文件没有 SVN BASE；勾选后提交时会作为新增文件加入版本控制。" : "当前文件没有可显示的差异。"), cls: "svn-diff-empty" }); return; }
    const columns = parent.createDiv({ cls: "svn-diff-columns" }); const left = columns.createDiv({ cls: "svn-diff-column" }); const right = columns.createDiv({ cls: "svn-diff-column" });
    left.createEl("h3", { text: "上个版本（BASE）" }); right.createEl("h3", { text: "当前版本" });
    const leftBody = left.createDiv({ cls: "svn-diff-scroll" }); const rightBody = right.createDiv({ cls: "svn-diff-scroll" });
    for (const row of state.diff.rows) { this.renderDiffSide(leftBody, row.left, row.kind); this.renderDiffSide(rightBody, row.right, row.kind); }
  }

  private renderDiffSide(parent: HTMLElement, side: { lineNumber?: number; text: string; kind: string } | undefined, rowKind: string): void {
    const row = parent.createDiv({ cls: `svn-diff-line is-${side?.kind ?? rowKind}` }); row.createSpan({ text: side?.lineNumber == null ? "" : String(side.lineNumber), cls: "svn-diff-line-number" }); row.createSpan({ text: side?.text ?? "", cls: "svn-diff-line-text" });
  }

  private installCommitSplitter(workbench: HTMLElement, splitter: HTMLElement, index: 0 | 1): void {
    const change = (delta: number) => {
      const total = Math.max(0, workbench.getBoundingClientRect().height - 16); const current = this.commitHeights ?? allocateCommitHeights(total, this.commitPersistence.get()); const next: [number, number, number] = [...current] as [number, number, number];
      const min = [150, 130, 260]; const left = index; const right = index + 1; const amount = Math.max(-next[left] + min[left], Math.min(next[right] - min[right], delta)); next[left] += amount; next[right] -= amount; this.commitHeights = next; this.setCommitHeights(workbench, next); this.updateSplitterAria(splitter, index, next, total);
    };
    const finish = () => { this.commitDragActive = false; const total = this.commitHeights?.reduce((sum, value) => sum + value, 0) ?? 1; const heights = this.commitHeights ?? allocateCommitHeights(total, this.commitPersistence.get()); this.commitPersistence.save(normalizeCommitLayout({ filesRatio: heights[0] / total, messageRatio: heights[1] / total, diffRatio: heights[2] / total })); };
    let start = 0;
    splitter.addEventListener("pointerdown", (event) => { event.preventDefault(); this.commitDragActive = true; start = event.clientY; splitter.setPointerCapture?.(event.pointerId); });
    splitter.addEventListener("pointermove", (event) => { if (this.commitDragActive) { const delta = event.clientY - start; start = event.clientY; change(delta); } });
    splitter.addEventListener("pointerup", finish); splitter.addEventListener("pointercancel", finish);
    splitter.addEventListener("keydown", (event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); change(event.key === "ArrowUp" ? -12 : 12); finish(); } });
  }

  private setCommitHeights(workbench: HTMLElement, heights: [number, number, number]): void { workbench.style.gridTemplateRows = `${heights[0]}px 8px ${heights[1]}px 8px ${heights[2]}px`; }
  private updateSplitterAria(splitter: HTMLElement, index: 0 | 1, heights: [number, number, number], total: number): void { const min = [150, 130, 260]; splitter.setAttribute("aria-valuemin", String(min[index])); splitter.setAttribute("aria-valuemax", String(Math.max(min[index], total - min[(index + 1) as 1 | 2]))); splitter.setAttribute("aria-valuenow", String(Math.round(heights[index]))); }

  private renderConflicts(content: HTMLElement): void {
    this.sectionTitle(content, "冲突处理", "文本冲突可在三栏合并器中处理；二进制文件需使用外部工具。", "conflicts", `${this.state.conflicts.filter((conflict) => !conflict.resolved).length} 个待处理`);
    const list = content.createDiv({ cls: "svn-conflict-list" });
    for (const conflict of this.state.conflicts) {
      const row = list.createDiv({ cls: "svn-conflict-row" });
      const icon = row.createSpan({ cls: "svn-row-icon" }); setIcon(icon, conflict.type === "text" ? "file-warning" : "file-question");
      const meta = row.createDiv(); meta.createEl("strong", { text: conflict.path }); meta.createEl("small", { text: `${conflict.type === "text" ? "文本冲突" : "二进制冲突"} · ${conflict.occurredAt}` });
      if (conflict.resolved) this.createStatus(row, "synced", "已解决");
      else if (conflict.type === "text") {
        const merge = mergeForConflict(this.state, conflict.id);
        if (merge) this.button(row, "打开合并器", "secondary", () => new MergeModal(this.app, conflict.id, merge, this.stateSource, () => void this.refreshFromSource(), this.modalPersistence).open());
        else row.createEl("span", { text: "无法读取该冲突的合并副本，请使用外部工具处理", cls: "svn-inline-hint" });
      }
      else row.createEl("span", { text: "请使用外部工具处理后刷新状态", cls: "svn-inline-hint" });
    }
  }

  private renderHistory(content: HTMLElement): void {
    content.addClass("svn-history-content");
    this.sectionTitle(content, "版本历史", "点击记录查看提交内容；按住 Ctrl 或 Shift 点击可选择两条记录进行版本对比。", "synced", `${this.state.history.length} 条记录`);
    const actions = content.createDiv({ cls: "svn-history-actions" });
    actions.createSpan({ text: this.selectedHistoryRevisions.length ? `已选择 ${this.selectedHistoryRevisions.length}/2 条记录` : "尚未选择对比记录", cls: "svn-inline-hint" });
    this.button(actions, "对比", "primary", () => void this.compareHistory(), this.selectedHistoryRevisions.length !== 2, "对比选中的两个版本");
    if (this.selectedHistoryRevisions.length === 2) actions.createSpan({ text: "将按版本号自动确定旧版本和新版本。", cls: "svn-inline-hint" });
    if (!this.state.history.length) {
      const empty = content.createDiv({ cls: "svn-history-empty" });
      empty.createEl("h3", { text: "暂无版本历史" });
      empty.createEl("p", { text: "刷新工作副本后，SVN 提交记录会显示在这里。" });
      return;
    }
    const layout = content.createDiv({ cls: "svn-history-layout" });
    const timeline = layout.createDiv({ cls: "svn-history-timeline" });
    const detail = layout.createDiv({ cls: "svn-history-detail" });
    const selectedEntry = this.state.history.find((entry) => entry.revision === this.selectedHistoryRevision) ?? this.state.history[0];
    const selectedCompare = this.state.historyCompare;
    const compareRevisions = [...this.selectedHistoryRevisions].sort(compareRevisionNumbers);
    const compareMatchesSelection = compareRevisions.length === 2 && selectedCompare.fromRevision === compareRevisions[0] && selectedCompare.toRevision === compareRevisions[1];
    const showDetail = (entry: SvnUiState["history"][number]) => {
      detail.empty();
      const header = detail.createDiv({ cls: "svn-history-detail-header" });
      header.createSpan({ text: entry.revision, cls: "svn-history-detail-revision" });
      header.createEl("h3", { text: entry.message || "无提交说明" });
      const metadata = header.createDiv({ cls: "svn-history-detail-meta" });
      metadata.createSpan({ text: entry.author || "未知作者" });
      const formattedTime = metadata.createSpan({ text: formatHistoryTime(entry.time), cls: "svn-history-detail-time" });
      const relativeTime = formatHistoryRelativeTime(entry.time);
      if (relativeTime) formattedTime.createSpan({ text: ` · ${relativeTime}`, cls: "svn-history-relative-time" });

      const messageSection = detail.createDiv({ cls: "svn-history-detail-section" });
      messageSection.createEl("h4", { text: "提交说明" });
      messageSection.createEl("p", { text: entry.message || "无提交说明" });

      const filesSection = detail.createDiv({ cls: "svn-history-detail-section" });
      const filesHeading = filesSection.createDiv({ cls: "svn-history-detail-section-heading" });
      filesHeading.createEl("h4", { text: "受影响文件" });
      filesHeading.createSpan({ text: `${entry.files.length} 个文件`, cls: "svn-history-file-count" });
      const historyDetail = this.state.historyDetail.revision === entry.revision ? this.state.historyDetail : {};
      entry.files.forEach((file) => {
        const selected = historyDetail.selectedPath === file;
        const row = filesSection.createDiv({ cls: `svn-history-file-row${selected ? " is-selected" : ""}`, attr: { role: "button", tabindex: "0", "aria-pressed": String(selected), title: `查看 ${file} 的差异` } });
        row.createSpan({ text: file, cls: "svn-file-path" });
        row.createSpan({ text: selected ? "当前预览" : "点击查看差异", cls: "svn-history-file-preview-hint" });
        row.addEventListener("click", () => void this.loadHistoryFileDiff(entry.revision, file));
        row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void this.loadHistoryFileDiff(entry.revision, file); } });
        const history = this.button(row, "按文件历史", "link", () => this.renderFileHistory(content, file));
        history.addEventListener("click", (event) => event.stopPropagation());
        history.addEventListener("keydown", (event) => event.stopPropagation());
      });

      const diffSection = detail.createDiv({ cls: "svn-history-detail-section" });
      diffSection.createEl("h4", { text: "差异预览" });
      if (!historyDetail.selectedPath) diffSection.createEl("p", { text: "请选择一个受影响文件查看差异。", cls: "svn-diff-empty" });
      else if (!historyDetail.selectedDiff || historyDetail.selectedDiff.status === "loading") diffSection.createEl("p", { text: "正在读取该文件的差异…", cls: "svn-diff-empty" });
      else if (historyDetail.selectedDiff.status === "error") diffSection.createEl("p", { text: `文件差异读取失败：${historyDetail.selectedDiff.message ?? "未知错误"}`, cls: "svn-inline-error" });
      else diffSection.createEl("pre", { text: historyDetail.selectedDiff.diff?.trim() || "当前文件没有可显示的文本差异。", cls: "svn-diff-preview" });
      const unrestorable = this.state.unrestorableHistoryByRevision[entry.revision] ?? [];
      if (unrestorable.length) detail.createEl("p", { text: `无法可靠映射仓库路径：${unrestorable.join("、")}；为安全起见已禁用恢复。`, cls: "svn-inline-error" });
      const restoreActions = detail.createDiv({ cls: "svn-history-detail-actions" });
      this.button(restoreActions, "预览并恢复此版本", "secondary", () => this.confirm(`恢复 ${entry.revision}`, `将把 ${entry.files.join("、")} 恢复为该版本内容，写入后会成为新的本地修改。`, "写入工作区", () => this.requestOperation("restore", buildOperationPayload(this.state, "restore", { revision: entry.revision, files: entry.files }))), unrestorable.length > 0);
    };
    for (const entry of this.state.history) {
      const selected = this.selectedHistoryRevisions.includes(entry.revision);
      const item = timeline.createEl("button", { cls: `svn-history-item${selected ? " is-selected" : ""}`, attr: { type: "button", title: `查看版本 ${entry.revision} 的变更详情`, "aria-label": `查看版本 ${entry.revision} 的变更详情`, "aria-pressed": String(selected) } });
      const itemHeader = item.createDiv({ cls: "svn-history-item-header" });
      itemHeader.createSpan({ text: entry.revision, cls: "svn-history-item-revision" });
      itemHeader.createSpan({ text: `${entry.files.length} 个文件`, cls: "svn-history-item-count" });
      item.createDiv({ text: entry.message || "无提交说明", cls: "svn-history-item-message" });
      const itemMeta = item.createDiv({ cls: "svn-history-item-meta" });
      itemMeta.createSpan({ text: entry.author || "未知作者" });
      const itemTime = itemMeta.createSpan({ text: formatHistoryTime(entry.time), cls: "svn-history-item-time" });
      const itemRelativeTime = formatHistoryRelativeTime(entry.time);
      if (itemRelativeTime) itemTime.createSpan({ text: ` · ${itemRelativeTime}`, cls: "svn-history-relative-time" });
      item.addEventListener("click", (event) => {
        const multiSelect = event.ctrlKey || event.shiftKey;
        const next = toggleHistorySelection(this.selectedHistoryRevisions, entry.revision, multiSelect);
        if (multiSelect && next.length === this.selectedHistoryRevisions.length && !this.selectedHistoryRevisions.includes(entry.revision)) { this.uiError = "最多选择两条历史记录。"; this.render(); return; }
        this.selectedHistoryRevisions = next;
        this.selectedHistoryRevision = entry.revision;
        void this.updateUi({ type: "clear-history-detail" }, false);
        this.render();
      });
    }
    if (compareMatchesSelection && selectedCompare.status !== "idle") this.renderHistoryCompare(detail, selectedCompare);
    else if (selectedEntry) showDetail(selectedEntry);
  }

  private renderHistoryCompare(parent: HTMLElement, compare: SvnUiState["historyCompare"]): void {
    parent.empty();
    parent.createEl("h3", { text: `${compare.fromRevision} → ${compare.toRevision} · 版本对比` });
    if (compare.status === "loading") { parent.createEl("p", { text: "正在读取变更文件列表…", cls: "svn-diff-empty" }); return; }
    if (compare.status === "error") { parent.createEl("p", { text: `历史对比失败：${compare.message ?? "未知错误"}`, cls: "svn-inline-error" }); return; }
    if (!compare.files.length) { parent.createEl("p", { text: "两个版本之间没有文件变更。", cls: "svn-diff-empty" }); return; }
    const layout = parent.createDiv({ cls: "svn-history-compare-layout" });
    const listPane = layout.createDiv({ cls: "svn-history-compare-list-pane" });
    const listHeading = listPane.createDiv({ cls: "svn-history-compare-list-heading" });
    listHeading.createEl("h4", { text: "变更文件" });
    listHeading.createSpan({ text: `${compare.files.length} 个文件`, cls: "svn-history-file-count" });
    const list = listPane.createDiv({ cls: "svn-history-compare-list", attr: { role: "listbox", "aria-label": "版本对比变更文件" } });
    for (const file of compare.files) {
      const selected = compare.selectedPath === file.path;
      const item = list.createEl("button", { cls: `svn-history-compare-file-item${selected ? " is-selected" : ""}`, attr: { type: "button", role: "option", "aria-selected": String(selected), title: file.path } });
      item.createSpan({ text: file.path, cls: "svn-history-compare-file-path" });
      item.createSpan({ text: historyCompareKindLabel(file.kind), cls: `svn-history-compare-file-kind is-${file.kind}` });
      item.addEventListener("click", () => void this.loadHistoryCompareFile(file.path));
    }
    const detail = layout.createDiv({ cls: "svn-history-compare-detail" });
    const selectedFile = compare.files.find((file) => file.path === compare.selectedPath) ?? compare.files[0];
    if (!selectedFile) { detail.createEl("p", { text: "请选择一个文件查看差异。", cls: "svn-diff-empty" }); return; }
    detail.createDiv({ cls: "svn-history-compare-detail-heading" }).createEl("h4", { text: selectedFile.path });
    detail.createSpan({ text: historyCompareKindLabel(selectedFile.kind), cls: `svn-history-compare-file-kind is-${selectedFile.kind}` });
    const selectedDiff = compare.selectedPath === selectedFile.path ? compare.selectedDiff : undefined;
    if (!selectedDiff || selectedDiff.status === "loading") { detail.createEl("p", { text: "正在读取该文件的差异…", cls: "svn-diff-empty" }); return; }
    if (selectedDiff.status === "error") { detail.createEl("p", { text: `文件差异读取失败：${selectedDiff.message ?? "未知错误"}`, cls: "svn-inline-error" }); return; }
    if (!selectedDiff.diff || selectedDiff.diff.status === "binary" || !selectedDiff.diff.rows.length) { detail.createEl("p", { text: selectedDiff.diff?.message ?? "该文件没有可显示的文本差异。", cls: "svn-diff-empty" }); return; }
    const columns = detail.createDiv({ cls: "svn-diff-columns" });
    const left = columns.createDiv({ cls: "svn-diff-column" }); const right = columns.createDiv({ cls: "svn-diff-column" });
    left.createEl("h3", { text: `${compare.fromRevision}（旧版本）` }); right.createEl("h3", { text: `${compare.toRevision}（新版本）` });
    const leftBody = left.createDiv({ cls: "svn-diff-scroll" }); const rightBody = right.createDiv({ cls: "svn-diff-scroll" });
    for (const row of selectedDiff.diff.rows) { this.renderDiffSide(leftBody, row.left, row.kind); this.renderDiffSide(rightBody, row.right, row.kind); }
  }

  private renderFileHistory(content: HTMLElement, path: string): void {
    content.removeClass("svn-history-content");
    content.empty();
    const fileHistory = this.state.fileHistoryByPath[path] ?? [];
    this.sectionTitle(content, "按文件历史", path, "synced", `${fileHistory.length} 条记录`);
    if (!fileHistory.length) content.createEl("p", { text: "未找到该文件的历史记录。", cls: "svn-form-guidance" });
    for (const entry of fileHistory) { const row = content.createDiv({ cls: "svn-history-file-row" }); row.createSpan({ text: `${entry.revision} · ${entry.message || "无提交说明"}` }); const meta = row.createSpan({ text: `${entry.author || "未知作者"} · ${formatHistoryTime(entry.time)}`, cls: "svn-inline-hint" }); const relativeTime = formatHistoryRelativeTime(entry.time); if (relativeTime) meta.createSpan({ text: ` · ${relativeTime}`, cls: "svn-history-relative-time" }); }
    this.button(content, "返回完整历史", "secondary", () => this.renderHistory(content));
  }

  private renderIgnoreRules(content: HTMLElement): void {
    this.sectionTitle(content, "忽略规则", "内置规则减少本机工作区冲突；已受版本控制文件需要单独确认。", "synced", `${this.state.builtInIgnorePatterns.length + this.state.customIgnorePatterns.length} 条规则`);
    content.createEl("h3", { text: "内置规则" });
    const list = content.createDiv({ cls: "svn-rule-list" });
    this.state.builtInIgnorePatterns.forEach((pattern) => {
      const row = list.createDiv({ cls: "svn-rule-row" }); row.createEl("code", { text: pattern });
    });
    content.createEl("h3", { text: "自定义规则" });
    const customList = content.createDiv({ cls: "svn-rule-list" });
    this.state.customIgnorePatterns.forEach((pattern) => { const row = customList.createDiv({ cls: "svn-rule-row" }); row.createEl("code", { text: pattern }); this.button(row, "移除", "link", () => void this.updateUi({ type: "remove-custom-ignore", pattern })); });
    const addRow = content.createDiv({ cls: "svn-add-rule" });
    const input = addRow.createEl("input", { attr: { type: "text", placeholder: "新增忽略规则，例如 .cache" } });
    this.button(addRow, "添加规则", "secondary", () => { if (input.value.trim()) void this.updateUi({ type: "add-custom-ignore", pattern: input.value.trim() }); });
    const unversioned = this.state.changes.filter((change) => change.kind === "unversioned");
    if (unversioned.length) {
      content.createEl("h3", { text: "应用忽略规则" });
      content.createEl("p", { text: "只对未版本化文件应用 SVN 属性；添加规则本身不会修改工作副本。", cls: "svn-form-guidance" });
      for (const change of unversioned) {
        const row = content.createDiv({ cls: "svn-rule-row" }); row.createSpan({ text: change.path, cls: "svn-file-path" });
        const pattern = row.createEl("select", { attr: { "aria-label": `为 ${change.path} 选择忽略规则` } });
        for (const rule of [...this.state.builtInIgnorePatterns, ...this.state.customIgnorePatterns]) pattern.createEl("option", { text: rule, value: rule });
        this.button(row, "应用", "secondary", () => this.requestOperation("ignore", { path: change.path, pattern: this.ignorePatternFor(change.path, pattern.value) }));
      }
    }
    content.createEl("h3", { text: "已受版本控制的文件" });
    for (const path of this.state.versionedIgnoreCandidates) {
      const warning = content.createDiv({ cls: "svn-danger-note" });
      this.iconText(warning, "triangle-alert", `${path} 已受版本控制。普通忽略不会生效。`);
      this.button(warning, "保留本地并从 SVN 移除", "warning", () => this.confirm("从 SVN 移除已受控文件", `目标：${path}。该文件会保留在本地，但下次提交将从 SVN 仓库中移除它。`, "保留本地并移除", () => this.requestOperation("remove-versioned-file", buildOperationPayload(this.state, "remove-versioned-file", { path }))));
    }
  }

  private renderOperationBar(root: HTMLElement): void {
    if (!shouldRenderOperationBar(this.state.operation, this.uiError)) return;
    const bar = root.createDiv({ cls: `svn-operation-bar is-${this.state.operation.status}`, attr: { tabindex: "-1", "aria-label": "最近操作和诊断日志" } });
    const status = bar.createDiv(); status.createEl("strong", { text: this.state.operation.message }); status.createEl("small", { text: this.state.operation.output });
    const progress = bar.createDiv({ cls: "svn-progress" }); progress.createDiv({ cls: "svn-progress-value", attr: { style: `width: ${this.state.operation.progress}%` } });
    if (this.uiError) bar.createEl("small", { text: this.uiError, cls: "svn-inline-error" });
    this.button(bar, "刷新日志", "link", () => void this.refreshFromSource());
    this.button(bar, "复制诊断日志", "link", () => void this.copyLog());
    if (this.state.operation.status === "running" && this.state.operation.cancellable && this.stateSource.cancelOperation) this.button(bar, "取消", "secondary", () => void this.cancelOperation());
  }

  private renderOperationResult(root: HTMLElement): void {
    const operation = this.state.operation;
    if (!shouldRenderOperationResult(operation)) return;
    const status = operation.status;
    const result = root.createDiv({ cls: `svn-operation-result is-${status}`, attr: { role: status === "error" ? "alert" : "status", "aria-live": status === "error" ? "assertive" : "polite" } });
    const icon = result.createDiv({ cls: "svn-operation-result__icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, status === "error" ? "circle-alert" : "circle-check");
    const content = result.createDiv({ cls: "svn-operation-result__content" });
    content.createEl("strong", { text: operation.message });
    content.createEl("span", { text: operation.summary ?? operation.output });
    if (operation.completedAt) content.createEl("small", { text: `完成时间：${operation.completedAt}` });
    const actions = result.createDiv({ cls: "svn-operation-result__actions" });
    this.button(actions, "查看诊断日志", "link", () => this.focusOperationLog(), false, "查看底部诊断日志");
  }

  private focusOperationLog(): void {
    const log = this.contentEl.querySelector<HTMLElement>(".svn-operation-bar");
    log?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    log?.focus({ preventScroll: true });
  }

  private async refreshFromSource(): Promise<void> {
    try {
      await this.stateSource.refresh?.();
      this.refreshingOnOpen = false;
      if (!this.closed) { this.state = this.stateSource.getState(); this.uiError = ""; this.render(); }
    } catch (error) {
      this.refreshingOnOpen = false;
      this.showUiError(`刷新失败：${this.errorMessage(error)}。请重试。`);
    }
  }

  private async requestOperation(operation: SvnOperationName, payload: SvnOperationPayload = {}): Promise<void> {
    this.uiError = "";
    try {
      const result = await this.stateSource.runOperation(operation, payload);
      if (!this.closed) { this.state = this.stateSource.getState(); this.uiError = result.ok ? "" : `操作失败：${result.error ?? "命令服务未提供失败原因"}。请检查状态后重试。`; if (result.ok && operation === "ignore") new Notice(payload.removeVersioned ? "已停止跟踪并加入忽略规则；请提交删除和忽略属性变更。" : "已加入忽略规则。" ); this.render(); }
    } catch (error) { this.showUiError(`操作失败：${this.errorMessage(error)}。请检查状态后重试。`); }
  }

  private async updateUi(update: SvnUiUpdate, rerender = true): Promise<void> { try { await this.stateSource.updateUi(update); if (!this.closed) { this.state = this.stateSource.getState(); if (rerender && shouldRenderUiUpdate({ editingCommitMessage: this.editingCommitMessage })) this.render(); } } catch (error) { this.showUiError(`界面更新失败：${this.errorMessage(error)}。请重试。`); } }
  private async cancelOperation(): Promise<void> { if (!this.stateSource.cancelOperation) { this.showUiError("当前操作不支持取消。请等待完成或刷新状态。"); return; } try { await this.stateSource.cancelOperation(); await this.refreshFromSource(); } catch (error) { this.showUiError(`取消失败：${this.errorMessage(error)}。请重试。`); } }
  private async copyLog(): Promise<void> { if (!navigator.clipboard?.writeText) { this.showUiError("当前环境不支持复制诊断日志，请手动选择并复制。" ); return; } try { await navigator.clipboard.writeText(this.state.operation.output); if (!this.closed) new Notice("诊断日志已复制"); } catch (error) { this.showUiError(`复制日志失败：${this.errorMessage(error)}。请重试。`); } }
  private async copyPath(path: string): Promise<void> { if (!navigator.clipboard?.writeText) { this.showUiError("当前环境不支持复制路径，请手动选择路径文本。" ); return; } try { await navigator.clipboard.writeText(path); if (!this.closed) new Notice("文件相对路径已复制"); } catch (error) { this.showUiError(`复制路径失败：${this.errorMessage(error)}。请重试。`); } }
  private showUiError(message: string): void { if (!this.closed) { this.uiError = message; this.render(); } }
  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : "未知错误"; }
  private async openFileHistory(path: string): Promise<void> { await this.updateUi({ type: "select-panel", panel: "history" }); const result = await this.stateSource.runOperation("file-history", { path }); if (!result.ok) { this.showUiError(`读取文件历史失败：${result.error ?? "未知错误"}`); return; } if (!this.closed) { this.state = this.stateSource.getState(); this.renderFileHistory(this.contentEl.querySelector(".svn-center-content") as HTMLElement, path); } }
  private async loadHistoryDiff(revision: string): Promise<void> {
    if (this.historyDiffRequests.has(revision)) return;
    if (this.state.diffByRevision[revision]) return;
    this.historyDiffRequests.add(revision);
    try {
      const result = await this.stateSource.runOperation("history-detail", { revision });
      if (this.closed) return;
      if (result.ok) { this.state = this.stateSource.getState(); this.uiError = ""; this.render(); }
      else this.showUiError(`读取差异失败：${result.error ?? "未知错误"}。`);
    } catch (error) {
      this.showUiError(`读取差异失败：${this.errorMessage(error)}。`);
    } finally {
      this.historyDiffRequests.delete(revision);
    }
  }
  private async loadHistoryFileDiff(revision: string, path: string): Promise<void> {
    const key = `${revision}:${path}`;
    if (this.historyDiffRequests.has(key)) return;
    this.historyDiffRequests.add(key);
    try {
      const result = await this.stateSource.runOperation("history-detail", { revision, path });
      if (!this.closed) { this.state = this.stateSource.getState(); if (!result.ok) this.uiError = `读取文件差异失败：${result.error ?? "未知错误"}`; else this.uiError = ""; this.render(); }
    } catch (error) {
      this.showUiError(`读取文件差异失败：${this.errorMessage(error)}。`);
    } finally {
      this.historyDiffRequests.delete(key);
    }
  }
  private async compareHistory(): Promise<void> { if (this.selectedHistoryRevisions.length !== 2) return; const [first, second] = this.selectedHistoryRevisions; const result = await this.stateSource.runOperation("history-compare", { fromRevision: first, toRevision: second }); if (!this.closed) { this.state = this.stateSource.getState(); if (!result.ok) this.uiError = `历史对比失败：${result.error ?? "未知错误"}`; else { this.uiError = ""; this.render(); const firstFile = this.state.historyCompare.selectedPath; if (firstFile) void this.loadHistoryCompareFile(firstFile); } } }
  private async loadHistoryCompareFile(path: string): Promise<void> {
    const compare = this.state.historyCompare;
    if (!compare.fromRevision || !compare.toRevision || !compare.files.some((file) => file.path === path)) return;
    const key = `${compare.fromRevision}:${compare.toRevision}:${path}`;
    if (this.historyCompareFileRequests.has(key)) return;
    this.historyCompareFileRequests.add(key);
    try {
      const result = await this.stateSource.runOperation("history-compare-file", { path });
      if (!this.closed) { this.state = this.stateSource.getState(); if (!result.ok) this.uiError = `文件差异读取失败：${result.error ?? "未知错误"}`; else this.uiError = ""; this.render(); }
    } catch (error) {
      this.showUiError(`文件差异读取失败：${this.errorMessage(error)}。`);
    } finally {
      this.historyCompareFileRequests.delete(key);
    }
  }
  private async loadFileDiff(path: string): Promise<void> { try { const result = await this.stateSource.runOperation("file-diff", { path }); if (!this.closed && !this.editingCommitMessage) { this.state = this.stateSource.getState(); if (!result.ok && !this.state.diffByPath[path]) this.uiError = `读取差异失败：${result.error ?? "未知错误"}`; this.render(); } } catch (error) { this.showUiError(`读取文件差异失败：${this.errorMessage(error)}。`); } }
  private toggleMaximized(): void {
    if (this.maximized) {
      this.maximized = false; this.modalEl.removeClass("is-maximized");
      applyModalLayout(this.modalEl, "control-center", this.restoreSize ?? this.modalPersistence.get("control-center")); this.render(); return;
    }
    const rect = this.modalEl.getBoundingClientRect(); this.restoreSize = clampModalSize("control-center", { width: rect.width, height: rect.height });
    this.maximized = true; this.modalEl.addClass("is-maximized"); applyMaximizedModalLayout(this.modalEl); this.render();
  }
  private renderChangeActions(parent: HTMLElement, change: SvnUiState["changes"][number]): void {
    const actions = parent.createDiv({ cls: "svn-change-actions" });
    const history = this.button(actions, "文件历史", "link", () => void this.openFileHistory(change.path), false, "查看文件历史");
    history.addEventListener("click", (event) => event.stopPropagation());
    const copy = this.button(actions, "复制路径", "link", () => void this.copyPath(change.path), false, "复制相对路径");
    copy.addEventListener("click", (event) => event.stopPropagation());
    if (change.kind === "conflict") return;
    const label = change.kind === "unversioned" ? "忽略此文件" : change.kind === "deleted" ? "加入忽略规则" : "停止跟踪并忽略";
    const ignore = this.button(actions, label, change.kind === "unversioned" || change.kind === "deleted" ? "link" : "warning", () => void this.ignoreChange(change), false, label);
    ignore.addEventListener("click", (event) => event.stopPropagation());
  }
  private ignorePayload(change: SvnUiState["changes"][number]): SvnOperationPayload { const fileName = change.path.split(/[\\/]/).pop() ?? change.path; return { path: change.path, pattern: fileName, removeVersioned: change.kind === "added" || change.kind === "modified" }; }
  private ignoreChange(change: SvnUiState["changes"][number]): void { const payload = this.ignorePayload(change); if (payload.removeVersioned) { this.confirm("停止跟踪并忽略文件", `本地文件 ${change.path} 会保留；SVN 将产生删除变更，并写入所在目录的忽略规则。操作完成后仍需提交删除和忽略属性变更。`, "停止跟踪并忽略", () => void this.requestOperation("ignore", payload)); return; } void this.requestOperation("ignore", payload); }
  private ignorePatternFor(file: string, rule: string): string { return rule.includes("/") || rule.includes("\\") ? file.split(/[\\/]/).pop() ?? rule : rule; }

  private overviewCopy(): { title: string; label: string; description: string; impact?: string } {
    if (this.state.status === "synced") return { title: "工作副本已同步", label: "已同步", description: "当前工作副本与最近一次读取的仓库状态一致。" };
    if (this.state.status === "conflicts") return { title: "工作副本存在冲突", label: "存在冲突", description: "请先处理冲突，再继续提交或更新。", impact: "检测到冲突文件。提交已被禁用，直到所有冲突都标记为已解决。" };
    if (this.state.status === "needs-cleanup") return { title: "工作副本需要清理", label: "需要清理", description: "检测到可能由中断操作导致的工作副本问题。", impact: "执行清理前请确认没有其他 SVN 操作正在运行。" };
    return { title: "工作副本有本地修改", label: "有本地修改", description: "更新前会保留本地修改；检测到冲突时将转到冲突处理。", impact: "检测到未提交改动。更新可能产生冲突，请在更新后检查冲突列表。" };
  }

  private confirm(title: string, description: string, button: string, onConfirm: () => void): void { new DangerConfirmationModal(this.app, title, description, button, onConfirm).open(); }
  private confirmUpdate(state: SvnUiState, onConfirm: () => void): void { new UpdateConfirmationModal(this.app, { workingCopyPath: state.workingCopyPath, repositoryUrl: state.repositoryUrl, changeCount: state.changes.length }, onConfirm).open(); }
  private confirmCurrentCommit(): void {
    const state = { ...this.state, commitMessage: this.commitMessageDraft };
    this.confirmCommit(state, () => this.requestOperation("commit", buildOperationPayload(state, "commit")));
  }
  private confirmCommit(state: SvnUiState, onConfirm: () => void): void {
    const selected = state.changes.filter((change) => change.selected && change.kind !== "conflict");
    const added = selected.filter((change) => change.kind === "unversioned").length;
    new CommitConfirmationModal(this.app, { repositoryUrl: state.repositoryUrl, selectedCount: selected.length, addedCount: added, message: state.commitMessage.trim() }, onConfirm).open();
  }
  private sectionTitle(parent: HTMLElement, title: string, description: string, status: string, label: string): void { const header = parent.createDiv({ cls: "svn-section-heading" }); const text = header.createDiv(); text.createEl("h2", { text: title }); text.createEl("p", { text: description }); this.createStatus(header, status, label); }
  private detailRow(parent: HTMLElement, label: string, value: string): void { const row = parent.createDiv({ cls: "svn-detail-row" }); row.createSpan({ text: label }); row.createSpan({ text: value }); }
  private createStatus(parent: HTMLElement, status: string, text: string): void { const badge = parent.createSpan({ cls: `svn-status-badge is-${status}` }); const icon = badge.createSpan(); setIcon(icon, status === "conflicts" ? "circle-alert" : status === "needs-cleanup" ? "triangle-alert" : status === "local-changes" ? "circle-dot" : "circle-check"); badge.createSpan({ text }); }
  private iconText(parent: HTMLElement, iconName: string, text: string): void { const icon = parent.createSpan(); setIcon(icon, iconName); parent.createSpan({ text }); }
  private iconButton(parent: HTMLElement, label: string, iconName: string, onClick: () => void, disabled = false, pressed = false): void { const button = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": String(pressed) } }); button.disabled = disabled; setIcon(button, iconName); button.addEventListener("click", onClick); }
  private button(parent: HTMLElement, label: string, style: "primary" | "secondary" | "warning" | "link", onClick: () => void, disabled = false, tooltip = label): HTMLButtonElement { const button = parent.createEl("button", { text: label, cls: `svn-button is-${style}`, attr: { type: "button", title: tooltip, "aria-label": tooltip } }); button.disabled = disabled; button.addEventListener("click", onClick); return button; }
  private commitSelectionText(state: SvnUiState): string { const selected = state.changes.filter((change) => change.selected && change.kind !== "conflict"); const addCount = selected.filter((change) => change.kind === "unversioned").length; return addCount ? `${selected.length} 个文件已选中，其中 ${addCount} 个未版本化文件将在提交前加入版本控制。` : `${selected.length} 个文件已选中。`; }
  private changeLabel(kind: string): string { return ({ added: "新增", modified: "修改", deleted: "删除", unversioned: "未版本化", conflict: "冲突" } as Record<string, string>)[kind] ?? kind; }
}

class FirstAssociationModal extends Modal {
  private step = 1;
  private draft: { mode: "checkout" | "import"; repositoryUrl: string; username: string; password: string; targetDirectory: string; initialCommitMessage: string } = createAssociationDraft("checkout") as { mode: "checkout" | "import"; repositoryUrl: string; username: string; password: string; targetDirectory: string; initialCommitMessage: string };
  private error = "";
  private closed = false;
  private removeResizeHandle?: () => void;
  private maximized = false;
  private restoreSize?: ModalSize;
  private readonly onWindowResize = () => { if (this.maximized) applyMaximizedModalLayout(this.modalEl); };

  constructor(app: App, private readonly stateSource: SvnUiStateSource, defaultCheckoutDirectory = "", defaultRepositoryUrl = "", private readonly modalPersistence: ModalPersistence = { get: () => undefined, save: () => {} }) { super(app); if (defaultCheckoutDirectory) this.draft.targetDirectory = defaultCheckoutDirectory; if (defaultRepositoryUrl) this.draft.repositoryUrl = defaultRepositoryUrl; }
  onOpen(): void { this.closed = false; this.modalEl.addClass("svn-wizard-modal"); this.modalEl.parentElement?.classList.add("svn-wizard-modal-container"); applyModalLayout(this.modalEl, "wizard", this.modalPersistence.get("wizard")); this.removeResizeHandle = installModalResizer(this.modalEl, "wizard", (size) => this.modalPersistence.save("wizard", size), () => this.maximized); window.addEventListener("resize", this.onWindowResize); this.render(); }
  onClose(): void { this.closed = true; this.removeResizeHandle?.(); this.removeResizeHandle = undefined; window.removeEventListener("resize", this.onWindowResize); this.maximized = false; this.modalEl.removeClass("is-maximized"); this.modalEl.parentElement?.classList.remove("svn-wizard-modal-container"); clearModalLayout(this.modalEl); this.contentEl.empty(); }
  private render(): void {
    const root = this.contentEl; root.empty(); root.addClass("svn-wizard");
    const title = root.createDiv({ cls: "svn-modal-title" }); title.createEl("h2", { text: "关联 SVN 笔记库" }); this.iconButton(title, this.maximized ? "恢复窗口" : "最大化窗口", this.maximized ? "minimize-2" : "maximize-2", () => this.toggleMaximized(), this.maximized);
    root.createEl("p", { text: "此向导不会覆盖当前笔记仓库。成功后请在 Obsidian 中打开新的工作副本。" });
    const steps = root.createDiv({ cls: "svn-wizard-steps" }); ["选择方式", "仓库与认证", "目标目录", "确认执行"].forEach((label, index) => steps.createSpan({ text: `${index + 1} ${label}`, cls: index + 1 === this.step ? "is-current" : "" }));
    const body = root.createDiv({ cls: "svn-wizard-body" });
    if (this.step === 1) this.renderChoice(body); else this.renderFields(body);
    const footer = root.createDiv({ cls: "svn-wizard-footer" });
    if (this.step > 1) this.button(footer, "上一步", () => { this.step--; this.render(); });
    if (this.error) root.createEl("div", { text: this.error, cls: "svn-inline-error" });
    if (this.step < 4) this.button(footer, "下一步", () => { this.step++; this.render(); }, true);
    else this.button(footer, this.draft.mode === "checkout" ? "确认 checkout" : "确认 import", () => void this.execute(), true);
  }
  private renderChoice(body: HTMLElement): void {
    body.createEl("h3", { text: "选择关联方式" });
    const choices = body.createDiv({ cls: "svn-association-choices" });
    this.choice(choices, "checkout", "检出已有笔记库", "从已有 SVN 仓库检出到新建或空目录。", true);
    this.choice(choices, "import", "导入当前笔记库", "先导入空仓库，再检出新的工作副本。", false);
  }
  private renderFields(body: HTMLElement): void {
    const copy = this.step === 2 ? "输入仓库地址；密码仅在执行期间存于内存。" : this.step === 3 ? "选择新建或空的目标目录，当前笔记仓库不会被替换。" : "请确认执行范围。插件将只调用对应的 SVN 命令。";
    body.createEl("p", { text: copy });
    if (this.step === 2) { this.field(body, "SVN 仓库地址", "repositoryUrl", "url"); this.field(body, "用户名", "username"); this.field(body, "密码", "password", "password"); if (this.draft.mode === "import") this.field(body, "首次提交说明", "initialCommitMessage"); }
    if (this.step === 3) this.field(body, "目标目录", "targetDirectory", "text", "D:\\Notes\\新笔记库");
    if (this.step === 4) body.createDiv({ cls: "svn-impact-note", text: this.draft.mode === "checkout" ? "将检出到新目录，不修改当前笔记仓库。" : "将导入当前内容，随后需要检出到新目录打开。" });
  }
  private field(parent: HTMLElement, label: string, key: "repositoryUrl" | "username" | "password" | "targetDirectory" | "initialCommitMessage", type = "text", placeholder = ""): void { const id = `svn-wizard-${key}`; parent.createEl("label", { text: label, attr: { for: id } }); const input = parent.createEl("input", { attr: { id, type, placeholder } }); input.value = this.draft[key]; input.addEventListener("input", () => { this.draft = updateAssociationDraft(this.draft, { [key]: input.value }); this.error = ""; }); }
  private choice(parent: HTMLElement, mode: "checkout" | "import", title: string, description: string, featured: boolean): void { const selected = this.draft.mode === mode; const button = parent.createEl("button", { cls: `svn-association-choice ${selected ? "is-selected" : ""} ${featured ? "is-featured" : ""}`, attr: { type: "button", title: `选择${title}`, "aria-label": `选择${title}`, "aria-pressed": String(selected) } }); button.createEl("strong", { text: title }); button.createEl("span", { text: description }); button.createEl("span", { text: selected ? "当前已选择" : "点击选择", cls: "svn-choice-state" }); button.addEventListener("click", () => { this.draft = updateAssociationDraft(this.draft, { mode }); this.render(); }); }
  private button(parent: HTMLElement, text: string, click: () => void, primary = false): void { const button = parent.createEl("button", { text, cls: `svn-button is-${primary ? "primary" : "secondary"}`, attr: { type: "button", title: text, "aria-label": text } }); button.addEventListener("click", click); }
  private iconButton(parent: HTMLElement, label: string, iconName: string, onClick: () => void, pressed = false): void { const button = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": String(pressed) } }); setIcon(button, iconName); button.addEventListener("click", onClick); }
  private toggleMaximized(): void { if (this.maximized) { this.maximized = false; this.modalEl.removeClass("is-maximized"); applyModalLayout(this.modalEl, "wizard", this.restoreSize ?? this.modalPersistence.get("wizard")); } else { const rect = this.modalEl.getBoundingClientRect(); this.restoreSize = clampModalSize("wizard", { width: rect.width, height: rect.height }); this.maximized = true; this.modalEl.addClass("is-maximized"); applyMaximizedModalLayout(this.modalEl); } this.render(); }
  private async execute(): Promise<void> { try { const result = await this.stateSource.runOperation(this.draft.mode, associationPayload(this.draft)); if (!result.ok) { if (!this.closed) { this.error = `关联失败：${result.error ?? "命令未完成"}。请检查输入后重试。`; this.render(); } return; } if (!this.closed) { new Notice(this.draft.mode === "checkout" ? `检出完成，请在 Obsidian 中安全打开新的笔记仓库：${this.draft.targetDirectory}` : `导入完成，请在 Obsidian 中打开新的笔记仓库：${this.draft.targetDirectory}`); this.close(); } } catch (error) { if (!this.closed) { this.error = `关联失败：${error instanceof Error ? error.message : "未知错误"}。请检查输入后重试。`; this.render(); } } }
}

class MergeModal extends Modal {
  private result: string;
  private error = "";
  private closed = false;
  private removeResizeHandle?: () => void;
  private maximized = false;
  private restoreSize?: ModalSize;
  private readonly onWindowResize = () => { if (this.maximized) applyMaximizedModalLayout(this.modalEl); };
  constructor(app: App, private readonly conflictId: string, private readonly merge: SvnUiState["mergeByConflictId"][string], private readonly stateSource: SvnUiStateSource, private readonly onResolved: () => void, private readonly modalPersistence: ModalPersistence = { get: () => undefined, save: () => {} }) { super(app); this.result = merge.resultText; }
  onOpen(): void { this.closed = false; this.modalEl.addClass("svn-merge-modal"); this.modalEl.parentElement?.classList.add("svn-merge-modal-container"); applyModalLayout(this.modalEl, "merge", this.modalPersistence.get("merge")); this.removeResizeHandle = installModalResizer(this.modalEl, "merge", (size) => this.modalPersistence.save("merge", size), () => this.maximized); window.addEventListener("resize", this.onWindowResize); this.render(); }
  onClose(): void { this.closed = true; this.removeResizeHandle?.(); this.removeResizeHandle = undefined; window.removeEventListener("resize", this.onWindowResize); this.maximized = false; this.modalEl.removeClass("is-maximized"); this.modalEl.parentElement?.classList.remove("svn-merge-modal-container"); clearModalLayout(this.modalEl); this.contentEl.empty(); }
  private render(): void {
    const root = this.contentEl; root.empty(); root.addClass("svn-merge");
    const title = root.createDiv({ cls: "svn-modal-title" }); title.createEl("h2", { text: `合并冲突：${this.merge.path}` }); this.iconButton(title, this.maximized ? "恢复窗口" : "最大化窗口", this.maximized ? "minimize-2" : "maximize-2", () => this.toggleMaximized(), this.maximized); root.createEl("p", { text: "保留需要的内容，清除冲突标记后再写入。" });
    const columns = root.createDiv({ cls: "svn-merge-columns" });
    this.column(columns, "本地版本", this.merge.localText, false); this.column(columns, "远端版本", this.merge.remoteText, false); this.column(columns, "合并结果", this.result, true);
    if (this.error) root.createEl("div", { text: this.error, cls: "svn-inline-error" });
    const actions = root.createDiv({ cls: "svn-merge-actions" });
    this.button(actions, "采用本地", () => { this.result = applyMergeSource(this.merge, "local"); this.render(); });
    this.button(actions, "采用远端", () => { this.result = applyMergeSource(this.merge, "remote"); this.render(); });
    this.button(actions, "写入并标记已解决", () => void this.writeAndResolve(), true);
  }
  private async writeAndResolve(): Promise<void> {
    const validation = validateMergeResult(this.result);
    if (!validation.valid) { if (!this.closed) { this.error = validation.message ?? "合并结果无效"; this.render(); } return; }
    try {
      await this.stateSource.updateUi({ type: "set-merge-result", conflictId: this.conflictId, resultText: this.result });
      const result = await this.stateSource.runOperation("resolve", { conflictId: this.conflictId, resultText: this.result });
      if (!result.ok) { if (!this.closed) { this.error = `未能标记为已解决：${result.error ?? "SVN resolve 未成功"}。请检查 SVN 状态后重试。`; this.render(); } return; }
      if (this.closed) return;
      this.onResolved();
      new Notice("合并结果已写入并标记为已解决");
      this.close();
    } catch (error) {
      if (!this.closed) { this.error = `写入或解决冲突失败：${error instanceof Error ? error.message : "未知错误"}。请检查工作副本后重试。`; this.render(); }
    }
  }
  private column(parent: HTMLElement, title: string, value: string, editable: boolean): void { const col = parent.createDiv({ cls: "svn-merge-column" }); col.createEl("h3", { text: title }); const area = col.createEl("textarea", { attr: editable ? { "aria-label": title } : { readonly: "true", "aria-label": title } }); area.value = value; if (editable) area.addEventListener("input", () => { this.result = area.value; this.error = ""; }); }
  private button(parent: HTMLElement, text: string, click: () => void, primary = false): void { const button = parent.createEl("button", { text, cls: `svn-button is-${primary ? "primary" : "secondary"}`, attr: { type: "button", title: text, "aria-label": text } }); button.addEventListener("click", click); }
  private iconButton(parent: HTMLElement, label: string, iconName: string, onClick: () => void, pressed = false): void { const button = parent.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": String(pressed) } }); setIcon(button, iconName); button.addEventListener("click", onClick); }
  private toggleMaximized(): void { if (this.maximized) { this.maximized = false; this.modalEl.removeClass("is-maximized"); applyModalLayout(this.modalEl, "merge", this.restoreSize ?? this.modalPersistence.get("merge")); } else { const rect = this.modalEl.getBoundingClientRect(); this.restoreSize = clampModalSize("merge", { width: rect.width, height: rect.height }); this.maximized = true; this.modalEl.addClass("is-maximized"); applyMaximizedModalLayout(this.modalEl); } this.render(); }
}

class DangerConfirmationModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly description: string, private readonly confirmText: string, private readonly onConfirm: () => void) { super(app); }
  onOpen(): void { const root = this.contentEl; root.addClass("svn-confirmation"); root.createEl("h2", { text: this.title }); root.createEl("p", { text: this.description }); const actions = root.createDiv({ cls: "svn-inline-actions" }); const cancel = actions.createEl("button", { text: "取消", cls: "svn-button is-secondary", attr: { type: "button", title: "取消当前操作", "aria-label": "取消当前操作" } }); cancel.addEventListener("click", () => this.close()); const confirm = actions.createEl("button", { text: this.confirmText, cls: "svn-button is-warning", attr: { type: "button", title: this.confirmText, "aria-label": this.confirmText } }); confirm.addEventListener("click", () => { this.onConfirm(); this.close(); }); }
  onClose(): void { this.contentEl.empty(); }
}

interface CommitConfirmationData { repositoryUrl: string; selectedCount: number; addedCount: number; message: string; }

class CommitConfirmationModal extends Modal {
  constructor(app: App, private readonly data: CommitConfirmationData, private readonly onConfirm: () => void) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("svn-commit-confirmation-modal");
    const root = this.contentEl; root.empty(); root.addClass("svn-confirmation"); root.addClass("svn-commit-confirmation");
    const header = root.createDiv({ cls: "svn-confirmation-header" });
    const icon = header.createDiv({ cls: "svn-confirmation-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, "upload");
    const copy = header.createDiv(); copy.createEl("h2", { text: "确认提交" }); copy.createEl("p", { text: "请确认本次提交的范围和说明，确认后将写入 SVN。" });
    const summary = root.createDiv({ cls: "svn-confirmation-summary", attr: { "aria-label": "提交摘要" } });
    this.summaryItem(summary, "提交范围", `${this.data.selectedCount} 个文件`);
    this.summaryItem(summary, "新增文件", this.data.addedCount ? `${this.data.addedCount} 个未版本化文件` : "无");
    const repository = root.createDiv({ cls: "svn-confirmation-detail" });
    repository.createSpan({ text: "仓库地址", cls: "svn-confirmation-detail-label" });
    repository.createEl("code", { text: this.data.repositoryUrl, cls: "svn-confirmation-repository", attr: { title: this.data.repositoryUrl, "aria-label": `完整仓库地址：${this.data.repositoryUrl}` } });
    const message = root.createDiv({ cls: "svn-confirmation-message" }); message.createEl("span", { text: "提交说明", cls: "svn-confirmation-detail-label" }); message.createEl("blockquote", { text: this.data.message || "（未填写提交说明）" });
    const notice = root.createDiv({ cls: "svn-confirmation-notice" }); const noticeIcon = notice.createSpan({ attr: { "aria-hidden": "true" } }); setIcon(noticeIcon, "info"); notice.createSpan({ text: "提交完成后，SVN 仓库会生成新的版本记录。" });
    const actions = root.createDiv({ cls: "svn-confirmation-actions" });
    const cancel = actions.createEl("button", { text: "取消", cls: "svn-button is-secondary", attr: { type: "button", title: "取消当前提交", "aria-label": "取消当前提交" } }); cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "确认提交", cls: "svn-button is-warning", attr: { type: "button", title: "确认提交", "aria-label": "确认提交" } }); confirm.addEventListener("click", () => { this.onConfirm(); this.close(); });
  }
  onClose(): void { this.modalEl.removeClass("svn-commit-confirmation-modal"); this.contentEl.empty(); }
  private summaryItem(parent: HTMLElement, label: string, value: string): void { const item = parent.createDiv({ cls: "svn-confirmation-summary-item" }); item.createEl("span", { text: label }); item.createEl("strong", { text: value }); }
}

interface UpdateConfirmationData { workingCopyPath: string; repositoryUrl: string; changeCount: number; }

class UpdateConfirmationModal extends Modal {
  constructor(app: App, private readonly data: UpdateConfirmationData, private readonly onConfirm: () => void) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("svn-update-confirmation-modal");
    const root = this.contentEl; root.empty(); root.addClass("svn-confirmation"); root.addClass("svn-update-confirmation");
    const header = root.createDiv({ cls: "svn-confirmation-header" });
    const icon = header.createDiv({ cls: "svn-confirmation-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, "refresh-cw");
    const copy = header.createDiv(); copy.createEl("h2", { text: "确认更新" }); copy.createEl("p", { text: "更新会从远端同步最新内容，请确认工作副本和仓库地址。" });
    const summary = root.createDiv({ cls: "svn-confirmation-summary", attr: { "aria-label": "更新摘要" } });
    this.summaryItem(summary, "更新范围", "当前工作副本");
    this.summaryItem(summary, "本地改动", this.data.changeCount ? `${this.data.changeCount} 个文件` : "无");
    const workingCopy = root.createDiv({ cls: "svn-confirmation-detail" });
    workingCopy.createSpan({ text: "工作副本", cls: "svn-confirmation-detail-label" });
    workingCopy.createEl("code", { text: this.data.workingCopyPath, cls: "svn-confirmation-working-copy", attr: { title: this.data.workingCopyPath, "aria-label": `完整工作副本路径：${this.data.workingCopyPath}` } });
    const repository = root.createDiv({ cls: "svn-confirmation-detail" });
    repository.createSpan({ text: "仓库地址", cls: "svn-confirmation-detail-label" });
    repository.createEl("code", { text: this.data.repositoryUrl, cls: "svn-confirmation-repository", attr: { title: this.data.repositoryUrl, "aria-label": `完整仓库地址：${this.data.repositoryUrl}` } });
    const notice = root.createDiv({ cls: "svn-confirmation-notice is-warning" }); const noticeIcon = notice.createSpan({ attr: { "aria-hidden": "true" } }); setIcon(noticeIcon, "triangle-alert"); notice.createSpan({ text: "本地未提交修改可能产生冲突，更新完成后请检查冲突列表。" });
    const actions = root.createDiv({ cls: "svn-confirmation-actions" });
    const cancel = actions.createEl("button", { text: "取消", cls: "svn-button is-secondary", attr: { type: "button", title: "取消当前更新", "aria-label": "取消当前更新" } }); cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "确认更新", cls: "svn-button is-warning", attr: { type: "button", title: "确认更新", "aria-label": "确认更新" } }); confirm.addEventListener("click", () => { this.onConfirm(); this.close(); });
  }
  onClose(): void { this.modalEl.removeClass("svn-update-confirmation-modal"); this.contentEl.empty(); }
  private summaryItem(parent: HTMLElement, label: string, value: string): void { const item = parent.createDiv({ cls: "svn-confirmation-summary-item" }); item.createEl("span", { text: label }); item.createEl("strong", { text: value }); }
}

class CredentialRetryModal extends Modal {
  constructor(app: App, private readonly stateSource: SvnUiStateSource) { super(app); }
  onOpen(): void {
    const root = this.contentEl; root.addClass("svn-confirmation"); root.createEl("h2", { text: "重新认证" }); root.createEl("p", { text: "用户名和密码仅用于本次重试，不会保存到设置、状态或诊断日志。" });
    const username = root.createEl("input", { attr: { type: "text", placeholder: "用户名", "aria-label": "用户名" } });
    const password = root.createEl("input", { attr: { type: "password", placeholder: "密码", "aria-label": "密码" } });
    const actions = root.createDiv({ cls: "svn-inline-actions" }); const cancel = actions.createEl("button", { text: "取消", cls: "svn-button is-secondary", attr: { type: "button", title: "取消认证重试", "aria-label": "取消认证重试" } }); cancel.addEventListener("click", () => this.close());
    const retry = actions.createEl("button", { text: "重试", cls: "svn-button is-primary", attr: { type: "button", title: "使用当前账号密码重试", "aria-label": "使用当前账号密码重试" } }); retry.addEventListener("click", async () => { const result = await this.stateSource.retryWithCredentials?.(username.value, password.value); password.value = ""; if (result?.ok) { new Notice("认证重试已完成"); this.close(); } else new Notice(`认证重试失败：${result?.error ?? "没有可重试操作"}`); });
  }
  onClose(): void { this.contentEl.empty(); }
}
