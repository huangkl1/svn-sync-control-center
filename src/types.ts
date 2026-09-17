export type SvnPanel = "overview" | "commit" | "conflicts" | "history" | "ignore";
export type ChangeKind = "added" | "modified" | "deleted" | "unversioned" | "conflict";
export type OperationStatus = "idle" | "running" | "success" | "error";
export type SvnAssociationStatus = "unknown" | "associated" | "needs-association" | "metadata-error";

export interface SvnDiffSide { lineNumber?: number; text: string; kind: "context" | "added" | "deleted"; }
export interface SvnDiffRow { kind: "context" | "added" | "deleted" | "modified"; left?: SvnDiffSide; right?: SvnDiffSide; }
export interface SvnFileDiff { status: "modified" | "added" | "deleted" | "binary" | "empty"; rows: SvnDiffRow[]; message?: string; }
export interface SvnFileDiffState { status: "idle" | "loading" | "success" | "error"; diff?: SvnFileDiff; message?: string; }
export interface SvnHistoryDiffFile { path: string; diff: SvnFileDiff; }
export interface SvnHistoryDetailDiffState { status: "loading" | "success" | "error"; diff?: string; message?: string; }
export interface SvnHistoryDetailState { revision?: string; selectedPath?: string; selectedDiff?: SvnHistoryDetailDiffState; }
export interface SvnHistoryCompareFile { path: string; kind: "added" | "modified" | "deleted"; }
export interface SvnHistoryCompareState { status: "idle" | "loading" | "success" | "error"; fromRevision?: string; toRevision?: string; files: SvnHistoryCompareFile[]; selectedPath?: string; selectedDiff?: SvnFileDiffState; message?: string; }

export interface SvnOperation {
  status: OperationStatus;
  message: string;
  output: string;
  progress: number;
  cancellable?: boolean;
  name?: SvnOperationName;
  summary?: string;
  completedAt?: string;
}

export interface SvnUiState {
  vaultName: string;
  repositoryUrl: string;
  workingCopyPath: string;
  associationStatus: SvnAssociationStatus;
  status: "synced" | "local-changes" | "conflicts" | "needs-cleanup";
  lastRefreshedAt: string;
  activePanel: SvnPanel;
  client: { configured: boolean; status: "ready" | "missing" | "error" | "unsupported"; source?: string; version?: string; message: string };
  viewStatus: { kind: "ready" | "empty" | "loading" | "error" | "locked" | "auth-failed" | "unsupported" | "network-error" | "damaged" | "metadata-error"; message: string; actionLabel?: string };
  commitMessage: string;
  operation: SvnOperation;
  changes: Array<{ id: string; path: string; kind: ChangeKind; selected: boolean }>;
  conflicts: Array<{ id: string; path: string; type: "text" | "binary"; occurredAt: string; resolved: boolean }>;
  history: Array<{ revision: string; author: string; time: string; message: string; files: string[] }>;
  fileHistoryByPath: Record<string, Array<{ revision: string; author: string; time: string; message: string; files: string[] }>>;
  unrestorableHistoryByRevision: Record<string, string[]>;
  diffByRevision: Record<string, string>;
  historyDetail: SvnHistoryDetailState;
  historyCompare: SvnHistoryCompareState;
  diffByPath: Record<string, SvnFileDiffState>;
  builtInIgnorePatterns: string[];
  customIgnorePatterns: string[];
  versionedIgnoreCandidates: string[];
  mergeByConflictId: Record<string, { path: string; localText: string; remoteText: string; resultText: string }>;
}

export interface SvnUiStateSource {
  getState(): SvnUiState;
  updateUi(update: SvnUiUpdate): void | Promise<void>;
  refresh?(preserveOperation?: boolean): void | Promise<void>;
  cancelOperation?(): void | boolean | Promise<void | boolean>;
  retryWithCredentials?(username: string, password: string): SvnOperationResult | Promise<SvnOperationResult>;
  runOperation(operation: SvnOperationName, payload?: SvnOperationPayload): SvnOperationResult | Promise<SvnOperationResult>;
  subscribe?(listener: () => void): () => void;
}

export type SvnOperationName = "update" | "commit" | "cleanup" | "restore" | "remove-versioned-file" | "resolve" | "checkout" | "import" | "ignore" | "clear-auth-cache" | "history-detail" | "history-compare" | "history-compare-file" | "file-history" | "file-diff";
export interface SvnOperationPayload { conflictId?: string; resultText?: string; paths?: string[]; addPaths?: string[]; message?: string; revision?: string; fromRevision?: string; toRevision?: string; files?: string[]; path?: string; pattern?: string; removeVersioned?: boolean; repositoryUrl?: string; username?: string; password?: string; targetDirectory?: string; initialCommitMessage?: string; }
export interface SvnOperationResult { ok: boolean; error?: string; }
export type SvnUiUpdate =
  | { type: "select-panel"; panel: SvnPanel }
  | { type: "set-commit-message"; message: string }
  | { type: "set-change-selection"; changeId: string; selected: boolean }
  | { type: "set-all-submittable"; selected: boolean }
  | { type: "set-merge-result"; conflictId: string; resultText: string }
  | { type: "clear-history-detail" }
  | { type: "add-custom-ignore"; pattern: string }
  | { type: "remove-custom-ignore"; pattern: string };
