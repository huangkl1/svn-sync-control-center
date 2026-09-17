export const DEFAULT_IGNORE_PATTERNS = [
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".trash",
];

const WRITE_OPERATIONS = new Set([
  "update",
  "commit",
  "cleanup",
  "restore",
  "remove-versioned-file",
  "resolve",
  "checkout",
  "import",
  "ignore",
  "clear-auth-cache",
]);

export function formatHistoryTime(value) {
  const source = String(value ?? "").trim();
  if (!source) return "未知时间";
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return source;
  const pad = (part, length = 2) => String(part).padStart(length, "0");
  return `${pad(date.getFullYear(), 4)}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatHistoryRelativeTime(value, now = new Date()) {
  const date = new Date(String(value ?? "").trim());
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return "";
  const elapsed = Math.max(0, current.getTime() - date.getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "刚刚";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}分钟前`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时前`;
  if (elapsed < 2 * day) return "昨天";
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}天前`;
  return "";
}

export function toggleHistorySelection(selection, revision, multiSelect) {
  if (!multiSelect) return [revision];
  if (selection.includes(revision)) return selection.filter((item) => item !== revision);
  return selection.length >= 2 ? selection : [...selection, revision];
}

export function createDemoUiState() {
  return {
    vaultName: "团队知识库",
    repositoryUrl: "https://svn.example.com/notes/team-vault",
    workingCopyPath: "D:\\Notes\\团队知识库",
    status: "local-changes",
    lastRefreshedAt: "刚刚",
    activePanel: "overview",
    client: { configured: true, status: "ready", source: "演示状态源", version: "1.14.5", message: "已检测到 SVN 客户端" },
    viewStatus: { kind: "ready", message: "工作副本状态已加载" },
    commitMessage: "",
    operation: { status: "idle", message: "尚未执行操作", output: "等待操作…", progress: 0 },
    changes: [
      { id: "meeting-notes", path: "项目/周会纪要.md", kind: "modified", selected: true },
      { id: "requirements", path: "项目/需求清单.md", kind: "added", selected: true },
      { id: "workspace", path: ".obsidian/workspace.json", kind: "unversioned", selected: false },
      { id: "archive", path: "归档/旧计划.md", kind: "deleted", selected: false },
    ],
    fileHistoryByPath: {},
    unrestorableHistoryByRevision: {},
    conflicts: [
      { id: "project-release-plan", path: "项目/发布计划.md", type: "text", occurredAt: "今天 10:42", resolved: false },
      { id: "architecture-diagram", path: "附件/架构图.drawio", type: "binary", occurredAt: "今天 10:42", resolved: false },
    ],
    history: [
      { revision: "r184", author: "lin", time: "今天 09:20", message: "补充发布检查项", files: ["项目/发布计划.md", "项目/需求清单.md"] },
      { revision: "r183", author: "wei", time: "昨天 17:48", message: "更新架构图", files: ["附件/架构图.drawio"] },
      { revision: "r182", author: "lin", time: "昨天 11:02", message: "整理周会纪要", files: ["项目/周会纪要.md"] },
    ],
    diffByRevision: {
      r184: "- 旧版内容\n+ 新版内容",
    },
    historyDetail: {},
    historyCompare: { status: "idle", files: [] },
    diffByPath: {},
    builtInIgnorePatterns: [...DEFAULT_IGNORE_PATTERNS],
    customIgnorePatterns: [".cache"],
    versionedIgnoreCandidates: [".obsidian/workspace.json"],
    mergeByConflictId: {
      "project-release-plan": {
        path: "项目/发布计划.md",
        localText: "# 发布计划\n\n- 本地：周四 16:00 发布\n- 负责人：Lin\n",
        remoteText: "# 发布计划\n\n- 远端：周五 10:00 发布\n- 负责人：Wei\n",
        resultText: "# 发布计划\n\n<<<<<<< local\n- 周四 16:00 发布\n=======\n- 周五 10:00 发布\n>>>>>>> remote\n",
      },
    },
  };
}

export function selectedChangeCount(state) {
  return state.changes.filter((change) => change.selected && isSubmittableChange(change)).length;
}

export function statusBarCopy(state) {
  if (!state?.client?.configured) return { label: "SVN 未配置", title: "打开 SVN 设置配置客户端", tone: "muted" };
  if (state.associationStatus && state.associationStatus !== "associated") return { label: "SVN 未关联", title: "打开 SVN 控制中心完成首次关联", tone: "muted" };
  const count = state.changes?.length ?? 0;
  if (state.status === "conflicts" && count > 0) return { label: `当前有 ${count} 个文件未提交`, title: "存在冲突，打开 SVN 控制中心查看", tone: "danger" };
  if (count > 0) return { label: `当前有 ${count} 个文件未提交`, title: `当前有 ${count} 个文件未提交，打开 SVN 控制中心`, tone: "warning" };
  return { label: "SVN 已同步", title: "打开 SVN 控制中心", tone: "synced" };
}

export function canSubmit(state) {
  return selectedChangeCount(state) > 0 && state.conflicts.every((conflict) => conflict.resolved) && !state.changes.some((change) => change.kind === "conflict");
}

export function groupChanges(changes) {
  return ["added", "modified", "deleted", "unversioned", "conflict"].reduce((groups, kind) => {
    groups[kind] = changes.filter((change) => change.kind === kind);
    return groups;
  }, {});
}

export function buildChangeTree(changes, filter = "") {
  const root = { name: "", path: "", kind: "directory", children: [] };
  const query = filter.trim().toLowerCase();
  for (const change of changes) {
    if (query && !change.path.toLowerCase().includes(query)) continue;
    const parts = change.path.replaceAll("\\", "/").split("/").filter(Boolean);
    let parent = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const nodePath = parts.slice(0, index + 1).join("/");
      let node = parent.children.find((candidate) => candidate.path === nodePath);
      if (!node) {
        node = isFile ? { name: part, path: nodePath, kind: "file", change } : { name: part, path: nodePath, kind: "directory", children: [] };
        parent.children.push(node);
      }
      if (!isFile) parent = node;
    });
  }
  const sort = (node) => {
    node.children.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name, "zh-Hans-CN") : left.kind === "directory" ? -1 : 1);
    node.children.filter((child) => child.kind === "directory").forEach(sort);
  };
  sort(root);
  return root;
}

export function getCompactDirectoryChain(node, minimumDepth = 3) {
  if (!node || node.kind !== "directory" || !Array.isArray(node.children)) return undefined;
  const nodes = [node];
  let leaf = node;
  while (leaf.children.length === 1 && leaf.children[0].kind === "directory") {
    leaf = leaf.children[0];
    nodes.push(leaf);
  }
  const directoryChildren = leaf.children.filter((child) => child.kind === "directory");
  const isSharedBranchPrefix = directoryChildren.length > 1 && nodes.length === minimumDepth - 1;
  if (nodes.length < minimumDepth && !isSharedBranchPrefix) return undefined;
  return { nodes, label: nodes.map((directory) => directory.name).join(" / "), leaf };
}

export function selectAllSubmittable(changes, selected) {
  return changes.map((change) => ({ ...change, selected: isSubmittableChange(change) ? selected : false }));
}

function isSubmittableChange(change) {
  return change.kind !== "conflict";
}

export function isConfigurationRequired(state) {
  return !state.client?.configured;
}

export function mergeForConflict(state, conflictId) {
  return state.mergeByConflictId?.[conflictId];
}

export function writeMergeResult(state, conflictId, resultText) {
  const existing = mergeForConflict(state, conflictId);
  if (!existing) return state;
  return {
    ...state,
    mergeByConflictId: {
      ...state.mergeByConflictId,
      [conflictId]: { ...existing, resultText },
    },
  };
}

export function buildOperationPayload(state, operation, detail = {}) {
  if (operation === "commit") {
    const selected = state.changes.filter((change) => change.selected && isSubmittableChange(change));
    return {
      paths: selected.filter((change) => change.kind !== "unversioned").map((change) => change.path),
      addPaths: selected.filter((change) => change.kind === "unversioned").map((change) => change.path),
      message: state.commitMessage.trim(),
    };
  }
  if (operation === "restore") return { revision: detail.revision, files: detail.files ?? [] };
  if (operation === "remove-versioned-file") return { path: detail.path };
  if (operation === "resolve") return { conflictId: detail.conflictId, resultText: detail.resultText };
  return {};
}

export function createAssociationDraft(mode = "checkout") {
  return { mode, repositoryUrl: "", username: "", password: "", targetDirectory: "", initialCommitMessage: "" };
}

export function updateAssociationDraft(draft, update) {
  return { ...draft, ...update };
}

export function associationPayload(draft) {
  return { repositoryUrl: draft.repositoryUrl, username: draft.username, password: draft.password, targetDirectory: draft.targetDirectory, ...(draft.mode === "import" ? { initialCommitMessage: draft.initialCommitMessage } : {}) };
}

export function applyUiUpdate(state, update) {
  if (update.type === "select-panel") return { ...state, activePanel: update.panel };
  if (update.type === "set-commit-message") return { ...state, commitMessage: update.message };
  if (update.type === "set-change-selection") return { ...state, changes: state.changes.map((change) => change.id === update.changeId ? { ...change, selected: isSubmittableChange(change) ? update.selected : false } : change) };
  if (update.type === "set-all-submittable") return { ...state, changes: selectAllSubmittable(state.changes, update.selected) };
  if (update.type === "set-merge-result") return writeMergeResult(state, update.conflictId, update.resultText);
  if (update.type === "clear-history-detail") return { ...state, historyDetail: {} };
  if (update.type === "add-custom-ignore") return { ...state, customIgnorePatterns: [...state.customIgnorePatterns, update.pattern] };
  if (update.type === "remove-custom-ignore") return { ...state, customIgnorePatterns: state.customIgnorePatterns.filter((pattern) => pattern !== update.pattern) };
  return state;
}

export function shouldRenderUiUpdate({ editingCommitMessage }) {
  return !editingCommitMessage;
}

export function resolveSvnExecutableFromDirectoryFiles(files) {
  for (const file of files) {
    const relativePath = (file.relativePath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!/^[^/]+\/(?:svn\.exe|bin\/svn\.exe)$/i.test(relativePath)) continue;
    if (file.absolutePath) return file.absolutePath;
  }
  return undefined;
}

export function shouldRenderOperationBar(operation, uiError = "") {
  return operation.status !== "idle" || Boolean(uiError.trim());
}

export function isWriteOperation(operation) {
  return WRITE_OPERATIONS.has(operation);
}

export function shouldRenderOperationResult(operation) {
  return isWriteOperation(operation?.name) && (operation.status === "success" || operation.status === "error");
}

export function applyMergeSource(merge, source) {
  return source === "local" ? merge.localText : merge.remoteText;
}

export function validateMergeResult(result) {
  if (/<<<<<<<|=======|>>>>>>>/.test(result)) {
    return { valid: false, message: "请先清除所有冲突标记，再写入合并结果。" };
  }
  return { valid: true };
}
