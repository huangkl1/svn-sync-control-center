import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_IGNORE_PATTERNS, applyUiUpdate } from "./ui-state.mjs";
import type { SvnPluginSettings } from "./settings";
import type { SvnOperationName, SvnOperationPayload, SvnOperationResult, SvnUiState, SvnUiStateSource, SvnUiUpdate } from "./types";
import { SvnClientLocator, SvnCommandRunner, SvnServiceError, SvnWorkingCopyService, decodeSvnOutput, parseUnifiedDiff, sanitizeSvnLog, toSvnUiSnapshot } from "./svn/index";
import type { SvnClientInfo, SvnCommandResult, SvnCommandRunnerLike, SvnFileSystem, SvnWorkingCopyService as SvnService } from "./svn/index";
import { repositoryUrlForVault } from "./vault-config";

type RuntimeService = Pick<SvnService, "inspect" | "history" | "fileHistory" | "diff" | "diffBetweenRevisions" | "diffSummaryBetweenRevisions" | "diffFileBetweenRevisions" | "update" | "add" | "commit" | "cleanup" | "checkout" | "import" | "restore" | "ignore" | "removeVersionedFileKeepLocal" | "resolveTextConflict" | "clearAuthCache" | "cancelCurrent">;
type RuntimeLocator = Pick<SvnClientLocator, "locate">;

export interface SvnRuntimeDependencies {
  platform?: NodeJS.Platform;
  vaultPath: () => string;
  vaultName: () => string;
  getSettings: () => SvnPluginSettings;
  locator?: RuntimeLocator;
  fileSystem?: SvnFileSystem;
  createRunner?: (executable: string, onLog: (line: string) => void) => SvnCommandRunnerLike;
  createService?: (runner: SvnCommandRunnerLike, fileSystem: SvnFileSystem, options: { timeoutMs: number }) => RuntimeService;
  now?: () => Date;
  saveRepositoryUrl?: (repositoryUrl: string) => void | Promise<void>;
}

const defaultFileSystem: SvnFileSystem = {
  readFile: async (file) => decodeSvnOutput(await fs.readFile(file)),
  writeFile: (file, contents) => fs.writeFile(file, contents),
  directoryEntries: (directory) => fs.readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)),
  realpath: (file) => fs.realpath(file),
  ensureDirectory: (directory) => fs.mkdir(directory, { recursive: true }).then(() => undefined),
  removeDirectory: (directory) => fs.rm(directory, { recursive: true, force: true }),
};

function initialState(vaultName: string, patterns: string[], repositoryUrl = ""): SvnUiState {
  return {
    vaultName, repositoryUrl, workingCopyPath: "", associationStatus: "unknown", status: "synced", lastRefreshedAt: "未刷新", activePanel: "overview",
    client: { configured: false, status: "missing", message: "尚未检测 SVN 客户端。" },
    viewStatus: { kind: "empty", message: "请先检测 svn.exe。", actionLabel: "打开设置" },
    commitMessage: "", operation: { status: "idle", message: "尚未执行操作", output: "等待操作…", progress: 0 },
    changes: [], conflicts: [], history: [], fileHistoryByPath: {}, unrestorableHistoryByRevision: {}, diffByRevision: {}, historyDetail: {}, historyCompare: { status: "idle", files: [] }, diffByPath: {}, builtInIgnorePatterns: [...DEFAULT_IGNORE_PATTERNS], customIgnorePatterns: [...patterns], versionedIgnoreCandidates: [], mergeByConflictId: {},
  };
}

function credentials(payload: SvnOperationPayload): { username?: string; password?: string } | undefined {
  return payload.username || payload.password ? { ...(payload.username ? { username: payload.username } : {}), ...(payload.password ? { password: payload.password } : {}) } : undefined;
}

function safeErrorText(error: unknown, secrets: string[] = []): string {
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : String(error);
  return secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "***"), sanitizeSvnLog(message)).replace(/--password\s+\*\*\*/g, "").trim();
}

function errorKind(error: unknown): string {
  if (error instanceof SvnServiceError) return error.kind;
  if (typeof error === "object" && error && "kind" in error) return String((error as { kind: unknown }).kind);
  const text = safeErrorText(error).toLowerCase();
  if (/e155007|not a working copy|不是.*工作副本/.test(text)) return "not-working-copy";
  if (/authenti|authorization|e170001/.test(text)) return "authentication";
  if (/locked|e155004|e155009/.test(text)) return "working-copy-locked";
  if (/damaged|corrupt|e1550(04|10)/.test(text)) return "working-copy-damaged";
  if (/timeout|timed out/.test(text)) return "timeout";
  if (/network|connection|hostname|e170013|e730054/.test(text)) return "network";
  if (/conflict/.test(text)) return "conflict";
  return "unknown";
}

function normalizeIgnorePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function ignorePatternMatches(file: string, pattern: string): boolean {
  const normalizedFile = normalizeIgnorePath(file);
  const normalizedPattern = normalizeIgnorePath(pattern);
  if (!normalizedFile || !normalizedPattern) return false;
  const escapedPattern = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  const expression = normalizedPattern.includes("/") ? `^${escapedPattern}$` : `(?:^|/)${escapedPattern}(?:/|$)`;
  return new RegExp(expression).test(normalizedFile);
}

export class SvnRuntimeStateSource implements SvnUiStateSource {
  private readonly deps: Required<Pick<SvnRuntimeDependencies, "platform" | "now">> & SvnRuntimeDependencies;
  private readonly listeners = new Set<() => void>();
  private readonly fileSystem: SvnFileSystem;
  private readonly locator: RuntimeLocator;
  private state: SvnUiState;
  private service?: RuntimeService;
  private running = false;
  private authRetry?: { operation: SvnOperationName; payload: SvnOperationPayload };
  private commitAddedPaths: string[] = [];

  constructor(dependencies: SvnRuntimeDependencies) {
    this.deps = { ...dependencies, platform: dependencies.platform ?? process.platform, now: dependencies.now ?? (() => new Date()) };
    this.fileSystem = dependencies.fileSystem ?? defaultFileSystem;
    this.locator = dependencies.locator ?? new SvnClientLocator();
    this.state = initialState(dependencies.vaultName(), dependencies.getSettings().ignorePatterns, repositoryUrlForVault(dependencies.getSettings().repositoryUrlByVault, dependencies.vaultPath(), dependencies.platform ?? process.platform));
  }

  getState(): SvnUiState { return this.state; }
  setCustomIgnorePatterns(patterns: string[]): void { this.update({ customIgnorePatterns: [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))] }); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { this.listeners.forEach((listener) => listener()); }
  private update(state: Partial<SvnUiState>): void { this.state = { ...this.state, ...state }; this.emit(); }

  async detect(): Promise<void> {
    this.state = initialState(this.deps.vaultName(), this.deps.getSettings().ignorePatterns, repositoryUrlForVault(this.deps.getSettings().repositoryUrlByVault, this.deps.vaultPath(), this.deps.platform));
    if (this.deps.platform !== "win32") {
      this.update({ client: { configured: false, status: "unsupported", message: "该插件当前只支持 Windows 桌面版 Obsidian。" }, viewStatus: { kind: "unsupported", message: "当前操作系统不受支持。", actionLabel: "查看说明" } });
      return;
    }
    this.update({ viewStatus: { kind: "loading", message: "正在检测 svn.exe…" } });
    let info: SvnClientInfo;
    try { info = await this.locator.locate(this.deps.getSettings().svnExecutablePath); } catch (error) { this.setFailure(error); return; }
    if (!info.found || !info.executable) {
      const configured = Boolean(this.deps.getSettings().svnExecutablePath.trim());
      this.update({ client: { configured, status: "missing", message: info.diagnostics.join(" ") || "未检测到 svn.exe。" }, viewStatus: { kind: "empty", message: configured ? "配置的 svn.exe 无法使用，请检查路径。" : "未检测到 SVN 客户端，请在设置中填写路径。", actionLabel: "打开设置" } });
      return;
    }
    const runner = this.deps.createRunner?.(info.executable, (line) => this.appendLog(line)) ?? new SvnCommandRunner(info.executable, { onLog: (line) => this.appendLog(line) });
    this.service = this.deps.createService?.(runner, this.fileSystem, { timeoutMs: this.deps.getSettings().commandTimeoutMs }) ?? new SvnWorkingCopyService(runner, this.fileSystem, { timeoutMs: this.deps.getSettings().commandTimeoutMs });
    this.update({ client: { configured: true, status: "ready", source: info.source, version: info.version, message: `已检测到 SVN ${info.version ?? ""}`.trim() } });
    await this.refresh();
  }

  async refresh(preserveOperation = false): Promise<void> {
    if (this.running) return;
    if (!this.service) { await this.detect(); return; }
    this.update({ viewStatus: { kind: "loading", message: "正在读取工作副本状态…" }, ...(preserveOperation ? {} : { operation: { status: "running", message: "正在刷新状态", output: "读取 SVN 工作副本…", progress: 30, cancellable: false } }) });
    try {
      const workingCopy = this.deps.vaultPath();
      const scan = await this.service.inspect(workingCopy);
      const normalizedHistory = normalizeHistoryPaths(await this.service.history(scan.workingCopyPath), scan.info?.repositoryRoot, scan.repositoryUrl);
      const history = normalizedHistory.history;
      const snapshot = toSvnUiSnapshot(scan, history);
      const conflictCopies = await this.readConflictCopies(snapshot.conflicts, scan.workingCopyPath);
      snapshot.conflicts = snapshot.conflicts.map((conflict) => conflictCopies.binaryIds.has(conflict.id) ? { ...conflict, type: "binary" } : conflict);
      const status = snapshot.conflicts.length ? "conflicts" : snapshot.changes.length ? "local-changes" : "synced";
      const ignorePatterns = [...this.state.builtInIgnorePatterns, ...this.state.customIgnorePatterns];
      const versionedIgnoreCandidates = snapshot.changes.filter((change) => change.kind !== "unversioned" && change.kind !== "deleted" && ignorePatterns.some((pattern) => ignorePatternMatches(change.path, pattern))).map((change) => change.path);
      this.update({ ...snapshot, associationStatus: "associated", status, lastRefreshedAt: this.deps.now().toLocaleString(), viewStatus: { kind: "ready", message: snapshot.conflicts.length ? "发现冲突，请先处理。" : "工作副本状态已加载。" }, mergeByConflictId: conflictCopies.merges, unrestorableHistoryByRevision: normalizedHistory.unrestorable, versionedIgnoreCandidates, operation: preserveOperation ? this.state.operation : { status: "success", message: "状态已刷新", output: "已读取工作副本、变更和历史记录。", progress: 100 } });
    } catch (error) {
      if (preserveOperation && this.state.operation.name) {
        const refreshError = safeErrorText(error) || "状态刷新失败";
        this.update({ viewStatus: { kind: "error", message: "状态刷新失败，请点击刷新重试。", actionLabel: "重试" }, operation: { ...this.state.operation, summary: `${this.state.operation.summary ?? "操作已完成"}；刷新状态失败，请点击刷新重试`, output: `${this.state.operation.output}\n刷新状态失败：${refreshError}`.trim() } });
      } else this.setFailure(error);
    }
  }

  async updateUi(update: SvnUiUpdate): Promise<void> {
    this.state = applyUiUpdate(this.state, update);
    this.emit();
  }

  cancelOperation(): boolean {
    const cancelled = this.service?.cancelCurrent() ?? false;
    if (cancelled) this.update({ operation: { status: "running", message: "正在取消操作", output: "已向 svn.exe 发送取消请求。", progress: this.state.operation.progress, cancellable: false } });
    return cancelled;
  }
  async retryWithCredentials(username: string, password: string): Promise<SvnOperationResult> {
    if (!this.authRetry) return { ok: false, error: "没有可重试的认证操作。" };
    const retry = this.authRetry; this.authRetry = undefined;
    return this.runOperation(retry.operation, { ...retry.payload, username, password });
  }

  async runOperation(operation: SvnOperationName, payload: SvnOperationPayload = {}): Promise<SvnOperationResult> {
    if (this.running) return { ok: false, error: "当前工作副本已有写操作正在执行，请等待完成或取消。" };
    if (!this.service) return this.rejectOperation(operation, "SVN 客户端尚未准备好，请先检测。");
    if (operation === "history-detail") return this.loadReadOperation(() => this.loadHistoryDetail(payload));
    if (operation === "history-compare") return this.loadReadOperation(() => this.loadHistoryCompare(payload));
    if (operation === "history-compare-file") return this.loadReadOperation(() => this.loadHistoryCompareFile(payload));
    if (operation === "file-history") return this.loadReadOperation(() => this.loadFileHistory(payload));
    if (operation === "file-diff") return this.loadReadOperation(() => this.loadFileDiff(payload));
    if (operation === "resolve" && this.isBinaryConflict(payload.conflictId)) return this.rejectOperation(operation, "二进制冲突不能在插件内合并，请使用外部工具处理后刷新状态。");
    this.running = true;
    this.update({ operation: { status: "running", name: operation, message: `正在${operationLabel(operation)}`, output: "已提交 SVN 命令，等待结果…", progress: 35, cancellable: true } });
    try {
      const result = await this.execute(operation, payload);
      this.commitAddedPaths = [];
      if ((operation === "checkout" || operation === "import") && payload.repositoryUrl?.trim()) {
        this.update({ repositoryUrl: payload.repositoryUrl.trim() });
        await this.deps.saveRepositoryUrl?.(payload.repositoryUrl.trim());
      }
      const associationOperation = operation === "checkout" || operation === "import";
      this.update({
        associationStatus: associationOperation ? "needs-association" : this.state.associationStatus,
        operation: successOperation(operation, payload, result, this.deps.now()),
        viewStatus: associationOperation
          ? { kind: "empty", message: operation === "import" ? "导入并检出已完成，请打开新的笔记仓库。" : "检出已完成，请打开新的笔记仓库。", actionLabel: "开始关联" }
          : { kind: "ready", message: `${operationLabel(operation)}完成。` },
      });
      this.running = false;
      if (operation !== "clear-auth-cache" && operation !== "checkout" && operation !== "import") await this.refresh(true);
      return { ok: true };
    } catch (error) {
      this.running = false;
      const addedPaths = this.commitAddedPaths;
      this.commitAddedPaths = [];
      if (errorKind(error) === "authentication" && ["update", "commit", "checkout", "import"].includes(operation)) this.authRetry = { operation, payload: { ...payload, ...(operation === "commit" && addedPaths.length ? { paths: [...new Set([...(payload.paths ?? []), ...addedPaths])], addPaths: payload.addPaths?.filter((file) => !addedPaths.includes(file)) } : {}), username: undefined, password: undefined } };
      this.setFailure(error, operation, payload.password ? [payload.password] : []);
      if (operation === "commit" && addedPaths.length) {
        await this.refresh(true);
        this.update({ viewStatus: { kind: "error", message: "加入版本控制已完成，但提交失败，可直接重试。", actionLabel: "重试" }, operation: { ...this.state.operation, output: `加入版本控制已完成。\n${this.state.operation.output}`.trim() } });
      }
      return { ok: false, error: this.state.operation.output || safeErrorText(error, payload.password ? [payload.password] : []) };
    }
  }

  private async loadReadOperation(load: () => Promise<SvnOperationResult>): Promise<SvnOperationResult> {
    const previous = this.state.operation;
    if (previous.status !== "idle") this.update({ operation: { ...previous, status: "idle", progress: 0, cancellable: false, name: undefined, summary: undefined, completedAt: undefined } });
    return load();
  }

  private rejectOperation(operation: SvnOperationName, error: string): SvnOperationResult {
    this.setFailure(new Error(error), operation);
    return { ok: false, error };
  }

  private async execute(operation: SvnOperationName, payload: SvnOperationPayload): Promise<SvnCommandResult | void> {
    const service = this.service!; const workingCopy = this.deps.vaultPath(); const auth = credentials(payload);
    switch (operation) {
      case "update": return service.update(workingCopy, auth);
      case "commit": {
        const addPaths = [...new Set(payload.addPaths ?? [])];
        let added: SvnCommandResult | undefined;
        if (addPaths.length) {
          this.update({ operation: { ...this.state.operation, message: "正在加入版本控制", output: `${this.state.operation.output}\n准备加入 ${addPaths.length} 个未版本化文件…`, progress: 50 } });
          added = await service.add(workingCopy, addPaths);
          this.commitAddedPaths = addPaths;
          this.update({ operation: { ...this.state.operation, message: "正在提交", output: `${this.state.operation.output}\n已加入版本控制，正在提交…`, progress: 70 } });
        }
        const paths = [...new Set([...(payload.paths ?? []), ...addPaths])];
        const committed = await service.commit(workingCopy, paths, payload.message ?? "", auth);
        return { ...committed, args: added ? [...added.args, ...committed.args] : committed.args, stdout: [added?.stdout, committed.stdout].filter(Boolean).join("\n"), stderr: [added?.stderr, committed.stderr].filter(Boolean).join("\n") };
      }
      case "cleanup": return service.cleanup(workingCopy);
      case "checkout": return service.checkout(payload.repositoryUrl ?? "", payload.targetDirectory || this.deps.getSettings().defaultCheckoutDirectory, auth);
      case "import": {
        const repositoryUrl = payload.repositoryUrl ?? "";
        const targetDirectory = payload.targetDirectory || this.deps.getSettings().defaultCheckoutDirectory;
        if (!targetDirectory.trim()) throw new Error("导入后必须提供新的空 checkout 目录；当前笔记仓库不会被直接转换。");
        const imported = await service.import(workingCopy, repositoryUrl, payload.initialCommitMessage ?? payload.message ?? "", auth);
        this.update({ operation: { ...this.state.operation, message: "正在 checkout 导入后的笔记仓库", output: `${this.state.operation.output}\n导入已完成，正在 checkout 到 ${targetDirectory}…`, progress: 60 } });
        const checkedOut = await service.checkout(repositoryUrl, targetDirectory, auth);
        return { ...checkedOut, stdout: `${imported.stdout}\n${checkedOut.stdout}`.trim(), stderr: `${imported.stderr}\n${checkedOut.stderr}`.trim() };
      }
      case "restore": for (const file of payload.files ?? []) await service.restore(workingCopy, file, payload.revision ?? ""); return;
      case "ignore": {
        const ignored = await service.ignore(workingCopy, payload.path ?? "", payload.pattern ?? "");
        if (!payload.removeVersioned) return ignored;
        try {
          const removed = await service.removeVersionedFileKeepLocal(workingCopy, payload.path ?? "");
          return { ...removed, stdout: [`忽略规则已写入。`, removed.stdout].filter(Boolean).join("\n") };
        } catch (error) {
          throw new Error(`忽略规则已写入，但停止跟踪失败：${safeErrorText(error)}`);
        }
      }
      case "remove-versioned-file": return service.removeVersionedFileKeepLocal(workingCopy, payload.path ?? "");
      case "resolve": return service.resolveTextConflict(workingCopy, this.conflictPath(payload.conflictId), payload.resultText ?? "");
      case "clear-auth-cache": return service.clearAuthCache();
      default: throw new Error(`不支持的 SVN 操作：${operation}`);
    }
  }

  private async loadHistoryDetail(payload: SvnOperationPayload): Promise<SvnOperationResult> {
    if (!this.service || !payload.revision) return { ok: false, error: "未指定要查看的版本。" };
    const revision = payload.revision.trim();
    const file = payload.path?.trim();
    if (file) this.update({ historyDetail: { revision, selectedPath: file, selectedDiff: { status: "loading" } } });
    try {
      const diff = await this.service.diff(this.deps.vaultPath(), file || ".", revision, "changeset");
      if (!file) this.update({ diffByRevision: { ...this.state.diffByRevision, [revision]: diff } });
      else if (this.state.historyDetail.revision === revision && this.state.historyDetail.selectedPath === file) this.update({ historyDetail: { ...this.state.historyDetail, selectedDiff: { status: "success", diff } } });
      return { ok: true };
    }
    catch (error) {
      const message = safeErrorText(error) || "读取历史版本差异失败。";
      if (file && this.state.historyDetail.revision === revision && this.state.historyDetail.selectedPath === file) this.update({ historyDetail: { ...this.state.historyDetail, selectedDiff: { status: "error", message } } });
      return { ok: false, error: message };
    }
  }
  private async loadHistoryCompare(payload: SvnOperationPayload): Promise<SvnOperationResult> {
    if (!this.service || !payload.fromRevision || !payload.toRevision) return { ok: false, error: "请选择两个历史版本进行对比。" };
    const revisions = [payload.fromRevision.trim(), payload.toRevision.trim()];
    const numbers = revisions.map((revision) => Number(revision.replace(/^r/i, "")));
    if (numbers.some((revision) => !Number.isInteger(revision) || revision < 0) || numbers[0] === numbers[1]) return { ok: false, error: "对比版本号无效或两个版本相同。" };
    const order = numbers[0] < numbers[1] ? [0, 1] : [1, 0];
    const fromRevision = revisions[order[0]];
    const toRevision = revisions[order[1]];
    this.update({ historyCompare: { status: "loading", fromRevision, toRevision, files: [] } });
    try {
      const files = await this.service.diffSummaryBetweenRevisions(this.deps.vaultPath(), fromRevision, toRevision);
      this.update({ historyCompare: { status: "success", fromRevision, toRevision, files, ...(files[0] ? { selectedPath: files[0].path } : {}) } });
      return { ok: true };
    } catch (error) {
      const message = safeErrorText(error) || "读取历史版本对比失败。";
      this.update({ historyCompare: { status: "error", fromRevision, toRevision, files: [], message } });
      return { ok: false, error: message };
    }
  }
  private async loadHistoryCompareFile(payload: SvnOperationPayload): Promise<SvnOperationResult> {
    const compare = this.state.historyCompare;
    const file = payload.path?.trim();
    if (!this.service || !compare.fromRevision || !compare.toRevision || !file) return { ok: false, error: "未指定要查看的对比文件。" };
    const summary = compare.files.find((candidate) => candidate.path === file);
    if (!summary) return { ok: false, error: "该文件不在当前版本对比结果中。" };
    this.update({ historyCompare: { ...compare, selectedPath: file, selectedDiff: { status: "loading" }, message: undefined } });
    try {
      const raw = await this.service.diffFileBetweenRevisions(this.deps.vaultPath(), compare.fromRevision, compare.toRevision, file);
      const diff = parseUnifiedDiff(raw, summary.kind);
      this.update({ historyCompare: { ...this.state.historyCompare, selectedPath: file, selectedDiff: { status: "success", diff } } });
      return { ok: true };
    } catch (error) {
      const message = safeErrorText(error) || "读取单文件版本差异失败。";
      this.update({ historyCompare: { ...this.state.historyCompare, selectedPath: file, selectedDiff: { status: "error", message } } });
      return { ok: false, error: message };
    }
  }
  private async loadFileHistory(payload: SvnOperationPayload): Promise<SvnOperationResult> {
    if (!this.service || !payload.path) return { ok: false, error: "未指定文件路径。" };
    try { const history = await this.service.fileHistory(this.deps.vaultPath(), payload.path); this.update({ fileHistoryByPath: { ...this.state.fileHistoryByPath, [payload.path]: history } }); return { ok: true }; }
    catch (error) { this.setFailure(error); return { ok: false, error: safeErrorText(error) }; }
  }
  private async loadFileDiff(payload: SvnOperationPayload): Promise<SvnOperationResult> {
    const file = payload.path;
    if (!this.service || !file) return { ok: false, error: "未指定文件路径。" };
    const change = this.state.changes.find((candidate) => candidate.path === file);
    if (!change) return { ok: false, error: "未找到该待提交文件。" };
    if (change.kind === "unversioned") {
      this.update({ diffByPath: { ...this.state.diffByPath, [file]: { status: "success", diff: { status: "empty", rows: [], message: "未版本化文件不会提交，也没有 SVN BASE 可供对比。" } } } });
      return { ok: true };
    }
    this.update({ diffByPath: { ...this.state.diffByPath, [file]: { status: "loading" } } });
    try {
      const raw = await this.service.diff(this.deps.vaultPath(), file);
      const diff = parseUnifiedDiff(raw, change.kind);
      this.update({ diffByPath: { ...this.state.diffByPath, [file]: { status: "success", diff } } });
      return { ok: true };
    } catch (error) {
      const message = safeErrorText(error) || "读取文件差异失败。";
      this.update({ diffByPath: { ...this.state.diffByPath, [file]: { status: "error", message } } });
      return { ok: false, error: message };
    }
  }

  private appendLog(line: string): void {
    if (this.state.operation.status !== "running") return;
    this.update({ operation: { ...this.state.operation, output: `${this.state.operation.output}\n${sanitizeSvnLog(line)}`.trim() } });
  }

  private setFailure(error: unknown, operation?: SvnOperationName, secrets: string[] = []): void {
    const kind = errorKind(error); const output = safeErrorText(error, secrets) || "SVN 操作失败。";
    const metadataPresent = error instanceof SvnServiceError ? error.workingCopyMetadataPresent : typeof error === "object" && error !== null && "workingCopyMetadataPresent" in error && (error as { workingCopyMetadataPresent?: unknown }).workingCopyMetadataPresent === true;
    const mapping: Record<string, Pick<SvnUiState["viewStatus"], "kind" | "message" | "actionLabel">> = {
      authentication: { kind: "auth-failed", message: "认证失败，请确认用户名、密码或本机认证缓存。", actionLabel: "重新认证" },
      "working-copy-locked": { kind: "locked", message: "工作副本被锁定，请先执行清理。", actionLabel: "清理工作副本" },
      "working-copy-damaged": { kind: "damaged", message: "工作副本已损坏，请使用 SVN 客户端修复。", actionLabel: "查看诊断" },
      network: { kind: "network-error", message: "无法连接 SVN 仓库，请检查网络与仓库地址。", actionLabel: "重试" },
      timeout: { kind: "network-error", message: "SVN 命令超时，请检查网络或提高超时设置。", actionLabel: "重试" },
      conflict: { kind: "ready", message: "操作产生冲突，请处理冲突后继续。", actionLabel: "查看冲突" },
      "not-working-copy": { kind: "empty", message: "当前笔记仓库不是 SVN 工作副本。", actionLabel: "开始关联" },
      "metadata-error": { kind: "metadata-error", message: "检测到 .svn 元数据，但无法读取当前工作副本。请重试或重新关联。", actionLabel: "重新关联" },
    };
    const metadataError = metadataPresent && (kind === "not-working-copy" || kind === "unknown");
    const needsAssociation = !metadataPresent && (kind === "not-working-copy" || (!operation && kind === "unknown"));
    const viewStatus = metadataError ? mapping["metadata-error"] : needsAssociation ? mapping["not-working-copy"] : mapping[kind] ?? { kind: "error" as const, message: "无法读取 SVN 工作副本，请检查诊断日志。", actionLabel: "重试" };
    this.update({ associationStatus: metadataError ? "metadata-error" : needsAssociation ? "needs-association" : this.state.associationStatus, status: kind === "working-copy-locked" || kind === "working-copy-damaged" ? "needs-cleanup" : this.state.status, viewStatus, operation: { status: "error", name: operation, message: `${operation ? operationLabel(operation) : "读取状态"}失败`, summary: operation ? operationFailureSummary(operation, output) : undefined, completedAt: operation ? this.deps.now().toLocaleString() : undefined, output, progress: 100 } });
  }

  private async readConflictCopies(conflicts: SvnUiState["conflicts"], workingCopy: string): Promise<{ merges: SvnUiState["mergeByConflictId"]; binaryIds: Set<string> }> {
    const merges: SvnUiState["mergeByConflictId"] = {};
    const binaryIds = new Set<string>();
    for (const conflict of conflicts) {
      if (conflict.type === "binary") continue;
      try {
        const absolute = path.join(workingCopy, conflict.path); const directory = path.dirname(absolute); const base = path.basename(absolute); const entries = await this.fileSystem.directoryEntries(directory);
        const mine = entries.find((entry) => entry === `${base}.mine`); const remote = entries.filter((entry) => new RegExp(`^${escapeRegExp(base)}\\.r\\d+$`).test(entry)).sort((left, right) => revisionNumber(right) - revisionNumber(left))[0];
        if (!mine || !remote) continue;
        const [localText, remoteText] = await Promise.all([this.fileSystem.readFile(path.join(directory, mine)), this.fileSystem.readFile(path.join(directory, remote))]);
        if (looksBinary(localText) || looksBinary(remoteText)) { binaryIds.add(conflict.id); continue; }
        merges[conflict.id] = { path: conflict.path, localText, remoteText, resultText: localText };
      } catch { /* Missing temporary copies are safely represented as an external-tool-only conflict. */ }
    }
    return { merges, binaryIds };
  }

  private isBinaryConflict(id?: string): boolean { return Boolean(this.state.conflicts.find((conflict) => conflict.id === id)?.type === "binary"); }
  private conflictPath(id?: string): string { const path = this.state.conflicts.find((conflict) => conflict.id === id)?.path; if (!path) throw new Error("未找到待解决的冲突文件。"); return path; }
}

function revisionNumber(entry: string): number { return Number(entry.match(/\.r(\d+)$/)?.[1] ?? -1); }
function looksBinary(value: string): boolean { if (value.includes("\0")) return true; const sample = value.slice(0, 8192); if (!sample) return false; const nonText = Array.from(sample).filter((character) => { const code = character.codePointAt(0) ?? 0; return code < 9 || (code > 13 && code < 32); }).length; return nonText / sample.length > 0.03; }
function normalizeHistoryPaths(history: SvnUiState["history"], repositoryRoot: string | undefined, repositoryUrl: string): { history: SvnUiState["history"]; unrestorable: Record<string, string[]> } {
  const root = urlPath(repositoryRoot); const repository = urlPath(repositoryUrl); const relativeRepository = root && repository && repository.startsWith(root) ? repository.slice(root.length).replace(/^\/+/, "") : undefined;
  const unrestorable: Record<string, string[]> = {};
  const repo = repository ?? "";
  return { history: history.map((entry) => ({ ...entry, files: entry.files.map((file) => { if (!file.startsWith("/")) return file; const candidate = repo ? (file.startsWith(`${repo}/`) ? file.slice(repo.length + 1) : relativeRepository && file.startsWith(`/${relativeRepository}/`) ? file.slice(relativeRepository.length + 2) : undefined) : undefined; if (!candidate) { (unrestorable[entry.revision] ??= []).push(file); return file; } return candidate; }) })), unrestorable };
}
function urlPath(value?: string): string | undefined { try { return value ? decodeURIComponent(new URL(value).pathname).replace(/\/$/, "") : undefined; } catch { return undefined; } }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function operationLabel(operation: SvnOperationName): string { return ({ update: "更新", commit: "提交", cleanup: "清理", restore: "恢复", "remove-versioned-file": "从 SVN 移除文件", resolve: "解决冲突", checkout: "检出", import: "导入", ignore: "应用忽略规则", "clear-auth-cache": "清除认证缓存", "history-detail": "读取差异", "history-compare": "读取历史对比", "history-compare-file": "读取文件差异", "file-history": "读取文件历史", "file-diff": "读取文件差异" } as Record<SvnOperationName, string>)[operation]; }
function operationFailureSummary(operation: SvnOperationName, output: string): string { const detail = output.replace(/\s+/g, " ").trim(); const clipped = detail.length > 180 ? `${detail.slice(0, 177)}…` : detail; return `${operationLabel(operation)}失败：${clipped || "详细原因请查看诊断日志"}`; }
function successOperation(operation: SvnOperationName, payload: SvnOperationPayload, result: SvnCommandResult | void, completedAt: Date): SvnUiState["operation"] { return { status: "success", name: operation, message: `${operationLabel(operation)}成功`, summary: operationSummary(operation, payload), completedAt: completedAt.toLocaleString(), output: result ? sanitizeSvnLog(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`).trim() || "SVN 命令已成功完成。" : "操作已成功完成。", progress: 100 }; }
function operationSummary(operation: SvnOperationName, payload: SvnOperationPayload): string { if (operation === "commit") { const count = new Set([...(payload.paths ?? []), ...(payload.addPaths ?? [])]).size; return count ? `${count} 个文件已提交` : "提交已完成"; } return ({ update: "工作副本已更新", cleanup: "工作副本已清理", restore: "历史版本已恢复", resolve: "冲突已解决", "remove-versioned-file": "文件已停止跟踪并保留在本地", ignore: "忽略规则已应用", checkout: "工作副本已检出", import: "工作副本已导入", "clear-auth-cache": "认证缓存已清除" } as Partial<Record<SvnOperationName, string>>)[operation] ?? `${operationLabel(operation)}已完成`; }
