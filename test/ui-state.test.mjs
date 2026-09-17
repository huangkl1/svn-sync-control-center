import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canSubmit,
  createDemoUiState,
  selectedChangeCount,
  applyMergeSource,
  validateMergeResult,
  groupChanges,
  selectAllSubmittable,
  isConfigurationRequired,
  mergeForConflict,
  writeMergeResult,
  applyUiUpdate,
  buildOperationPayload,
  createAssociationDraft,
  updateAssociationDraft,
  associationPayload,
  shouldRenderUiUpdate,
  resolveSvnExecutableFromDirectoryFiles,
  shouldRenderOperationBar,
  isWriteOperation,
  shouldRenderOperationResult,
  buildChangeTree,
  getCompactDirectoryChain,
  statusBarCopy,
} from "../src/ui-state.mjs";

test("主界面状态栏显示未提交数量并区分同步、冲突与未关联状态", () => {
  const state = { ...createDemoUiState(), associationStatus: "associated" };
  assert.deepEqual(statusBarCopy(state), {
    label: "当前有 4 个文件未提交",
    title: "当前有 4 个文件未提交，打开 SVN 控制中心",
    tone: "warning",
  });
  assert.deepEqual(statusBarCopy({ ...state, changes: [], status: "synced" }), {
    label: "SVN 已同步",
    title: "打开 SVN 控制中心",
    tone: "synced",
  });
  assert.deepEqual(statusBarCopy({ ...state, status: "conflicts" }), {
    label: "当前有 4 个文件未提交",
    title: "存在冲突，打开 SVN 控制中心查看",
    tone: "danger",
  });
  assert.deepEqual(statusBarCopy({ ...state, associationStatus: "needs-association" }), {
    label: "SVN 未关联",
    title: "打开 SVN 控制中心完成首次关联",
    tone: "muted",
  });
  assert.deepEqual(statusBarCopy({ ...state, client: { ...state.client, configured: false } }), {
    label: "SVN 未配置",
    title: "打开 SVN 设置配置客户端",
    tone: "muted",
  });
});

test("Obsidian 文件变更会安排状态栏状态刷新", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  for (const event of ["modify", "create", "delete", "rename"]) {
    assert.match(main, new RegExp(`this\\.app\\.vault\\.on\\(\\"${event}\\"`));
  }
  assert.match(main, /scheduleStatusRefresh/);
  assert.match(main, /statusRefreshTimer/);
  assert.match(main, /refresh\?\.\(true\)/);
});

test("提交仅在选中文件且没有冲突时可用", () => {
  const state = createDemoUiState();
  assert.equal(canSubmit(state), false);

  const ready = {
    ...state,
    commitMessage: "同步会议纪要",
    conflicts: [],
  };
  assert.equal(canSubmit(ready), true);
});

test("有可提交文件且无冲突时空提交说明也可提交", async () => {
  const state = { ...createDemoUiState(), commitMessage: "", conflicts: [] };
  assert.equal(canSubmit(state), true);
  assert.equal(canSubmit({ ...state, commitMessage: "   " }), true);
  assert.equal(canSubmit({ ...state, changes: state.changes.map((change) => ({ ...change, selected: false })) }), false);
  assert.equal(canSubmit({ ...state, conflicts: [{ ...state.conflicts, resolved: false }] }), false);

  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("（未填写提交说明）"), true);
  assert.equal(main.includes("填写提交说明后可提交。"), false);
});

test("结果卡片覆盖写操作但不覆盖读取操作", () => {
  const writeOperations = ["update", "commit", "cleanup", "restore", "remove-versioned-file", "resolve", "checkout", "import", "ignore", "clear-auth-cache"];
  const readOperations = ["history-detail", "history-compare", "history-compare-file", "file-history", "file-diff"];
  for (const operation of writeOperations) assert.equal(isWriteOperation(operation), true, operation);
  for (const operation of readOperations) assert.equal(isWriteOperation(operation), false, operation);
  assert.equal(shouldRenderOperationResult({ status: "success", name: "commit" }), true);
  assert.equal(shouldRenderOperationResult({ status: "error", name: "update" }), true);
  assert.equal(shouldRenderOperationResult({ status: "running", name: "commit" }), false);
  assert.equal(shouldRenderOperationResult({ status: "success", name: "file-diff" }), false);
});

test("选择文件数量随勾选状态变化", () => {
  const state = createDemoUiState();
  assert.equal(selectedChangeCount(state), 2);
  const deselected = {
    ...state,
    changes: state.changes.map((change, index) => ({ ...change, selected: index === 0 })),
  };
  assert.equal(selectedChangeCount(deselected), 1);
});

test("未版本化文件不属于提交候选", () => {
  const state = {
    ...createDemoUiState(),
    commitMessage: "同步",
    conflicts: [],
    changes: [
      { id: "modified", path: "note.md", kind: "modified", selected: true },
      { id: "added", path: "new.md", kind: "added", selected: false },
      { id: "unversioned", path: ".obsidian/hotkeys.json", kind: "unversioned", selected: true },
    ],
  };
  const selectedOne = applyUiUpdate(state, { type: "set-change-selection", changeId: "unversioned", selected: true });
  assert.equal(selectedOne.changes.find((change) => change.kind === "unversioned").selected, true);
  assert.equal(selectedChangeCount(selectedOne), 2);
  assert.deepEqual(buildOperationPayload(selectedOne, "commit"), { paths: ["note.md"], addPaths: [".obsidian/hotkeys.json"], message: "同步" });
  const selected = selectAllSubmittable(state.changes, true);
  assert.equal(selected.find((change) => change.kind === "unversioned").selected, true);
  assert.equal(selectedChangeCount({ ...state, changes: selected }), 3);
  assert.deepEqual(buildOperationPayload({ ...state, changes: selected }, "commit"), { paths: ["note.md", "new.md"], addPaths: [".obsidian/hotkeys.json"], message: "同步" });
});

test("待提交文件按多级目录生成可展开树", () => {
  const tree = buildChangeTree([
    { id: "a", path: "项目/后端/接口.md", kind: "modified", selected: true },
    { id: "b", path: "项目/前端/首页.md", kind: "added", selected: true },
    { id: "c", path: "根目录.md", kind: "deleted", selected: false },
  ]);
  assert.deepEqual(tree.children.map((node) => [node.kind, node.name]), [["directory", "项目"], ["file", "根目录.md"]]);
  assert.deepEqual(tree.children[0].children.map((node) => node.name), ["后端", "前端"]);
  assert.equal(tree.children[0].children[0].children[0].change.path, "项目/后端/接口.md");
});

test("四级单分支目录生成压缩展示链", () => {
  const tree = buildChangeTree([{ id: "deep", path: "学习/IT/AI/工具/笔记.md", kind: "modified", selected: true }]);
  const chain = getCompactDirectoryChain(tree.children[0]);
  assert.deepEqual(chain.nodes.map((node) => node.name), ["学习", "IT", "AI", "工具"]);
  assert.equal(chain.label, "学习 / IT / AI / 工具");
  assert.equal(chain.leaf.name, "工具");
});

test("浅层目录不压缩，分支外的深链可独立压缩", () => {
  const shallow = buildChangeTree([{ id: "shallow", path: "项目/笔记.md", kind: "modified", selected: true }]);
  assert.equal(getCompactDirectoryChain(shallow.children[0]), undefined);

  const branched = buildChangeTree([
    { id: "deep", path: "项目/学习/IT/AI/笔记.md", kind: "modified", selected: true },
    { id: "sibling", path: "项目/其他.md", kind: "added", selected: true },
  ]);
  assert.equal(getCompactDirectoryChain(branched.children[0]), undefined);
  const branch = getCompactDirectoryChain(branched.children[0].children[0]);
  assert.equal(branch.label, "学习 / IT / AI");
  assert.equal(branch.leaf.name, "AI");
});

test("分支前的共享目录前缀可以压缩", () => {
  const tree = buildChangeTree([
    { id: "inbox", path: ".obsidian/plugins/screenshot-inbox/data.json", kind: "modified", selected: true },
    { id: "center", path: ".obsidian/plugins/svn-sync-control-center/main.js", kind: "modified", selected: true },
  ]);
  const chain = getCompactDirectoryChain(tree.children[0]);
  assert.deepEqual(chain.nodes.map((node) => node.name), [".obsidian", "plugins"]);
  assert.equal(chain.label, ".obsidian / plugins");
  assert.equal(chain.leaf.name, "plugins");
});

test("提交文件树目录按钮使用轻量的 Obsidian 加减图标", async () => {
  const [main, css] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(main, /setIcon\(button, collapsed \? "plus" : "minus"\)/);
  assert.match(main, /getCompactDirectoryChain\(node, 3\)/);
  assert.match(main, /expandedCompactDirectoryChains/);
  assert.match(main, /setIcon\(button, "plus"\)/);
  assert.match(main, /"aria-expanded": String\(!collapsed\)/);
  assert.match(main, /setIcon\(expandAll, "chevrons-down"\)/);
  assert.match(main, /setIcon\(collapseAll, "chevrons-up"\)/);
  assert.match(main, /title: "全部展开"/);
  assert.match(main, /title: "全部收起"/);
  assert.match(main, /buildChangeTree\(this\.state\.changes, filter\.value\)/);
  assert.match(main, /topLevelDirectoryPaths/);
  assert.doesNotMatch(main, /button\.setText\(collapsed \? "▸" : "▾"\)/);
  assert.match(css, /\.svn-tree-toggle[\s\S]*?width: 18px[\s\S]*?height: 18px/);
  assert.match(css, /\.svn-tree-toggle svg[\s\S]*?width: 12px[\s\S]*?height: 12px/);
  assert.match(css, /\.svn-tree-directory-row\.is-compact \.svn-tree-directory-path/);
  assert.match(css, /\.svn-tree-bulk-actions/);
});

test("采用本地或远端会覆盖合并编辑器内容", () => {
  const state = createDemoUiState();
  const merge = mergeForConflict(state, "project-release-plan");
  assert.equal(applyMergeSource(merge, "local"), merge.localText);
  assert.equal(applyMergeSource(merge, "remote"), merge.remoteText);
});

test("未清除冲突标记的合并结果不能写入", () => {
  assert.deepEqual(validateMergeResult("<<<<<<< local\n内容\n=======\n远端\n>>>>>>> remote"), {
    valid: false,
    message: "请先清除所有冲突标记，再写入合并结果。",
  });
  assert.deepEqual(validateMergeResult("# 合并后的笔记\n\n内容已确认。"), { valid: true });
});

test("提交列表按状态分组，全选不会选中冲突文件", () => {
  const state = createDemoUiState();
  state.changes.push({ id: "conflict-change", path: "项目/冲突.md", kind: "conflict", selected: false });
  const groups = groupChanges(state.changes);
  assert.equal(groups.modified.length, 1);
  assert.equal(groups.conflict.length, 1);
  const selected = selectAllSubmittable(state.changes, true);
  assert.equal(selected.find((change) => change.kind === "conflict").selected, false);
  assert.equal(canSubmit({ ...state, commitMessage: "包含冲突", conflicts: [] }), false);
});

test("状态源能表达未配置和按冲突文件读取合并内容", () => {
  const state = createDemoUiState();
  assert.equal(isConfigurationRequired({ ...state, client: { configured: false, status: "missing", message: "未检测到 SVN" } }), true);
  const merge = mergeForConflict(state, "project-release-plan");
  assert.equal(merge.path, "项目/发布计划.md");
  assert.equal(mergeForConflict(state, "missing"), undefined);
});

test("合并结果按冲突 ID 写回，并且在 resolve 成功前不修改解决状态", () => {
  const state = createDemoUiState();
  const updated = writeMergeResult(state, "project-release-plan", "# 发布计划\n\n已人工合并。");
  assert.equal(updated.mergeByConflictId["project-release-plan"].resultText, "# 发布计划\n\n已人工合并。");
  assert.equal(updated.conflicts.find((conflict) => conflict.id === "project-release-plan").resolved, false);
});

test("生产 TypeScript 不得重新引入旧的单一 merge 状态字段", async () => {
  const [main, declarations] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ui-state.d.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(main.includes('SvnUiState["merge"]'), false);
  assert.equal(declarations.includes('SvnUiState["merge"]'), false);
});

test("写操作具备明确且最小的操作载荷", () => {
  const state = { ...createDemoUiState(), commitMessage: "同步发布计划" };
  assert.deepEqual(buildOperationPayload(state, "commit"), {
    paths: state.changes.filter((change) => change.selected).map((change) => change.path),
    addPaths: [],
    message: "同步发布计划",
  });
  assert.deepEqual(buildOperationPayload(state, "restore", { revision: "r184", files: ["项目/发布计划.md"] }), { revision: "r184", files: ["项目/发布计划.md"] });
  assert.deepEqual(buildOperationPayload(state, "remove-versioned-file", { path: ".obsidian/workspace.json" }), { path: ".obsidian/workspace.json" });
});

test("空提交说明会生成空 message 载荷", () => {
  const state = { ...createDemoUiState(), commitMessage: "   ", conflicts: [] };
  assert.deepEqual(buildOperationPayload(state, "commit"), {
    paths: state.changes.filter((change) => change.selected).map((change) => change.path),
    addPaths: [],
    message: "",
  });
});

test("首次关联向导跨步骤保留输入，并按模式产生执行载荷", () => {
  let draft = createAssociationDraft("import");
  draft = updateAssociationDraft(draft, { repositoryUrl: "https://svn.example.com/notes", username: "lin", password: "secret", targetDirectory: "D:\\Notes\\checkout", initialCommitMessage: "导入笔记库" });
  assert.deepEqual(associationPayload(draft), { repositoryUrl: "https://svn.example.com/notes", username: "lin", password: "secret", targetDirectory: "D:\\Notes\\checkout", initialCommitMessage: "导入笔记库" });
});

test("样式使用加在 modalEl 本身的选择器，且不再直接修改注入快照", async () => {
  const [css, main] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(css.includes(".svn-control-center-modal .modal"), false);
  assert.equal(css.includes(".svn-control-center-modal {"), true);
  assert.equal(main.includes("conflict.resolved = true"), false);
});

test("提交说明编辑期间跳过订阅触发的全量渲染", () => {
  assert.equal(shouldRenderUiUpdate({ editingCommitMessage: true }), false);
  assert.equal(shouldRenderUiUpdate({ editingCommitMessage: false }), true);
});

test("提交说明失焦不重渲染，避免吞掉按钮的首次点击", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const commitMessageRenderer = main.match(/private renderCommitMessage\(parent: HTMLElement\): void \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  private renderCommitDiff/)?.[1] ?? "";
  const blurHandler = commitMessageRenderer.match(/message\.addEventListener\("blur", \(\) => \{([\s\S]*?)\}\);/)?.[1] ?? "";
  assert.match(blurHandler, /editingCommitMessage\s*=\s*false/);
  assert.doesNotMatch(blurHandler, /setTimeout|this\.render\(\)/);
});

test("提交确认在点击时读取最新的提交说明草稿", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const commitRenderers = [
    main.match(/private renderCommit\(content: HTMLElement, fixedHost\?: HTMLElement\): void \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  private renderCommitWorkbench/)?.[1] ?? "",
    main.match(/private renderCommitMessage\(parent: HTMLElement\): void \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  private renderCommitDiff/)?.[1] ?? "",
  ];
  for (const renderer of commitRenderers) assert.match(renderer, /this\.confirmCurrentCommit\(\)/);
});

test("控制中心仅在具备取消能力时呈现取消入口，并防止剪贴板假成功", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("this.state.operation.cancellable && this.stateSource.cancelOperation"), true);
  assert.equal(main.includes("if (!navigator.clipboard?.writeText)"), true);
  assert.match(main, /this\.closed \|\| this\.editingCommitMessage/);
});

test("目录选择只接受所选目录根部或 bin 目录中的 svn.exe", () => {
  const files = [
    { relativePath: "TortoiseSVN/bin/svn.exe", absolutePath: "C:\\Program Files\\TortoiseSVN\\bin\\svn.exe" },
    { relativePath: "TortoiseSVN/doc/svn.exe", absolutePath: "C:\\Program Files\\TortoiseSVN\\doc\\svn.exe" },
  ];
  assert.equal(resolveSvnExecutableFromDirectoryFiles(files), "C:\\Program Files\\TortoiseSVN\\bin\\svn.exe");
  assert.equal(resolveSvnExecutableFromDirectoryFiles([{ relativePath: "TortoiseSVN/tools/bin/svn.exe", absolutePath: "C:\\Program Files\\TortoiseSVN\\tools\\bin\\svn.exe" }]), undefined);
});

test("空闲且无界面错误时隐藏操作栏，运行或结果信息时显示", () => {
  assert.equal(shouldRenderOperationBar({ status: "idle", message: "尚未执行操作", output: "等待操作…", progress: 0 }, ""), false);
  assert.equal(shouldRenderOperationBar({ status: "running", message: "正在更新", output: "…", progress: 40 }, ""), true);
  assert.equal(shouldRenderOperationBar({ status: "success", message: "状态已刷新", output: "完成", progress: 100 }, ""), true);
  assert.equal(shouldRenderOperationBar({ status: "idle", message: "尚未执行操作", output: "等待操作…", progress: 0 }, "复制失败"), true);
});

test("运行元数据与窄屏布局遵循重设计约束", async () => {
  const [manifest, css, main] = await Promise.all([
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(JSON.parse(manifest).author, "wc·d");
  assert.equal(css.includes(".svn-center-context-strip"), true);
  assert.equal(css.includes("@media (max-width: 680px)"), true);
  assert.equal(css.includes(".svn-center-content { padding: 24px 16px 28px; }"), true);
  assert.equal(main.includes("renderContextStrip"), true);
});

test("构建会生成 Obsidian 自动加载的 styles.css", async () => {
  const build = await readFile(new URL("../esbuild.config.mjs", import.meta.url), "utf8");
  assert.equal(build.includes('copyFile("main.css", "styles.css")'), true);
});

test("目录选择仅使用常驻可见的真实控件，并保留路径读取回退", async () => {
  const settings = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");
  assert.equal(settings.includes("createFallbackDirectoryPicker"), true);
  assert.equal(settings.includes("fallbackPicker.type = \"file\""), true);
  assert.equal(settings.includes('fallbackPicker.addEventListener("change"'), true);
  assert.equal(settings.includes('fallbackPicker.setAttribute("data-label", "选择 SVN 安装目录")'), true);
  assert.equal(settings.includes("selectSvnDirectory"), false);
  assert.equal(settings.includes("showOpenDialog"), false);
  assert.equal(settings.includes("getNativeDirectoryDialog"), false);
  assert.equal(settings.includes('button.setButtonText("选择目录")'), false);
  assert.equal(settings.includes("picker.showPicker()"), false);
  assert.equal(settings.includes("picker.click()"), false);
  assert.equal(settings.includes("try {"), true);
  assert.equal(settings.includes("catch {"), true);
  assert.equal(settings.includes("(file as File & { path?: string }).path || \"\""), true);
});

test("低高度窄屏允许控制中心收缩，正文保持独立滚动", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.equal(css.includes("@media (max-width: 680px) and (max-height: 620px)"), true);
  assert.equal(css.includes(".svn-control-center { min-height: 0; }"), true);
  assert.equal(css.includes(".svn-center-content { overflow: auto;"), true);
});

test("控制中心和关联向导会控制外层 modal 容器并禁止横向溢出", async () => {
  const [css, main] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(main.includes("svn-control-center-modal-container"), true);
  assert.equal(main.includes("svn-wizard-modal-container"), true);
  assert.equal(css.includes("overflow-x: hidden"), true);
  assert.equal(css.includes("!important"), true);
});

test("SVN 状态不可用时不显示工作副本导航", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes('this.state.associationStatus !== "associated" || this.state.viewStatus.kind !== "ready"'), true);
});

test("控制中心尺寸规则同时覆盖内容识别和外层 modal", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.equal(css.includes('.modal-container:has(.svn-control-center)'), true);
  assert.equal(css.includes('--dialog-width: min(960px'), true);
});

test("控制中心只保留 Obsidian 默认关闭按钮，并对实际 modal 设置尺寸", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes('this.iconButton(actions, "关闭"'), false);
  assert.equal(main.includes('modalEl.style.setProperty("width"'), true);
  assert.equal(main.includes('modalEl.style.setProperty("height"'), true);
});

test("关联方式按钮有明确选中状态和可访问属性", async () => {
  const [css, main] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(css.includes(".svn-association-choice.is-selected"), true);
  assert.equal(main.includes("aria-pressed"), true);
  assert.equal(main.includes("当前已选择"), true);
});

test("控制中心打开时刷新工作副本并使用待提交文案", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("待提交"), true);
  assert.equal(main.includes("associationStatus === \"associated\""), true);
  assert.equal(main.includes("当前没有待提交文件"), true);
});

test("历史差异请求按 revision 去重，并避免打开时与状态刷新并发", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("private historyDiffRequests = new Set<string>();"), true);
  assert.equal(main.includes("this.historyDiffRequests.has(revision)"), true);
  assert.equal(main.includes("this.historyDiffRequests.add(revision);"), true);
  assert.equal(main.includes("this.historyDiffRequests.delete(revision);"), true);
  assert.equal(main.includes("this.refreshingOnOpen"), true);
});

test("历史对比按文件加载差异，不在对比结果中展开全部文件", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes('runOperation("history-compare-file"'), true);
  assert.equal(main.includes("svn-history-compare-list"), true);
  assert.equal(main.includes("svn-history-compare-detail"), true);
  assert.equal(main.includes("for (const file of compare.files)"), true);
  assert.equal(main.includes("renderDiffSide(leftBody, row.left, row.kind)"), true);
});

test("历史对比差异代码避免横向滚动裁切，并为长行换行", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.svn-diff-scroll\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(styles, /\.svn-diff-line\s*\{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.svn-diff-line-text\s*\{[^}]*white-space:\s*pre-wrap/s);
  assert.match(styles, /\.svn-diff-line-text\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(styles, /\.svn-diff-line-text\s*\{[^}]*overflow:\s*hidden/s);
});

test("历史版本卡片收窄并把更多空间留给对比详情", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.svn-history-layout\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*\.58fr\)\s+minmax\(0,\s*2fr\)/s);
  assert.match(styles, /\.svn-history-item\s*\{[^}]*min-height:\s*88px/s);
  assert.match(styles, /\.svn-history-compare-layout\s*\{[^}]*grid-template-columns:\s*minmax\(180px,\s*\.42fr\)\s+minmax\(0,\s*2\.6fr\)/s);
});

test("提交列表为文件提供复制路径和按状态区分的忽略操作", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("this.copyPath(change.path)"), true);
  assert.equal(main.includes("忽略此文件"), true);
  assert.equal(main.includes("停止跟踪并忽略"), true);
  assert.equal(main.includes("removeVersioned"), true);
});

test("查看文件差异时保留待提交文件列表的滚动位置", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("commitFilesScrollTop"), true);
  assert.equal(main.includes("commitFilesScrollAnchor"), true);
  assert.equal(main.includes("private commitDiffPane?: HTMLElement"), true);
  assert.equal(main.includes("renderCommitDiffInPlace"), true);
  assert.equal(main.includes('list.addEventListener("scroll"'), true);
  assert.equal(main.includes("const fileList = this.renderCommitFiles(files)"), true);
  assert.match(main, /applySize\(\);\s*fileList\.scrollTop = this\.commitFilesScrollTop/);
  assert.equal(main.includes("data-svn-path"), true);
  assert.equal(main.includes("restoreCommitFilesScroll"), true);
});

test("每个插件按钮都有独立的悬停说明，且不复用导航容器说明", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("title: tooltip"), true);
  assert.equal(main.includes("SVN 控制中心导航"), false);
});

test("用户界面不再显示英文 Vault 术语", async () => {
  const [main, settings, runtime] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtime-state.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(main.includes("当前 Vault"), false);
  assert.equal(settings.includes("当前 Vault"), false);
  assert.equal(runtime.includes("当前 Vault"), false);
});

test("目录选择只在保存成功后回填路径，并用可访问状态反馈结果", async () => {
  const settings = await readFile(new URL("../src/settings.ts", import.meta.url), "utf8");
  assert.equal(settings.includes("const previousPath = this.plugin.settings.svnExecutablePath"), true);
  assert.equal(settings.indexOf("await this.plugin.saveSettings()") < settings.indexOf("executableInput?.setValue(executablePath)"), true);
  assert.equal(settings.includes("this.plugin.settings.svnExecutablePath = previousPath"), true);
  assert.equal(settings.includes("保存设置失败"), true);
  assert.equal(settings.includes('directoryFeedback.setAttribute("aria-live", "polite")'), true);
  assert.equal(settings.includes('directoryFeedback.setAttribute("role", "status")'), true);
  assert.equal(settings.includes('feedback?.setAttribute("role", "alert")'), true);
  assert.equal(settings.includes("fs.existsSync"), true);
  assert.equal(settings.includes('path.join(directory, "svn.exe")'), true);
  assert.equal(settings.includes("findSvnExecutable(directory)"), true);
});

test("精简配置页占满剩余高度并保留可滚动的引导区", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.equal(css.includes(".svn-configuration-content { flex: 1; min-height: 0;"), true);
  assert.equal(css.includes("justify-content: center"), true);
  assert.equal(css.includes(".svn-directory-fallback-picker::file-selector-button"), true);
  assert.equal(css.includes('content: "选择 SVN 安装目录"'), true);
});

test("未配置控制中心只呈现精简引导，不渲染上下文、导航或操作栏", async () => {
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(main.includes("renderConfigurationShell(root)"), true);
  assert.equal(main.includes('if (isConfigurationRequired(this.state) && this.state.viewStatus.kind !== "unsupported") { this.renderConfigurationShell(root); return; }'), true);
  assert.equal(main.includes("this.renderHeader(root, true)"), true);
  assert.equal(main.includes("if (!compact) {"), true);
});

test("插件默认使用真实运行时状态源，设置检测和清除认证缓存不再使用演示回调", async () => {
  const [main, settings] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/settings.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(main.includes("SvnRuntimeStateSource"), true);
  assert.equal(main.includes("await this.runtimeStateSource.detect()"), true);
  assert.equal(main.includes("private demoState"), false);
  assert.equal(settings.includes("this.plugin.detectSvn()"), true);
  assert.equal(settings.includes("this.plugin.clearAuthCache()"), true);
});

test("操作日志只保留当前运行状态，不持久化到插件 data.json", async () => {
  const [main, runtime, settings] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtime-state.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/settings.ts", import.meta.url), "utf8"),
  ]);
  assert.equal(main.includes("onOperationLog"), false);
  assert.equal(main.includes("persistOperationLog"), false);
  assert.equal(runtime.includes("onOperationLog"), false);
  assert.equal(runtime.includes("retainOperationLogs"), false);
  assert.equal(settings.includes("operationLogs"), false);
  assert.equal(settings.includes("logRetentionDays"), false);
  assert.equal(main.includes("this.state.operation.output"), true);
});
