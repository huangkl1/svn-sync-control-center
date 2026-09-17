import test from "node:test";
import assert from "node:assert/strict";
import esbuild from "esbuild";

let runtime;

test.before(async () => {
  const result = await esbuild.build({ entryPoints: ["src/runtime-state.ts"], bundle: true, platform: "node", format: "esm", write: false, target: "es2021" });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
});

const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [".cache"], commandTimeoutMs: 4000, logRetentionDays: 30 };
const scan = { workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [{ path: "note.md", kind: "modified" }], conflicts: [] };

function service(overrides = {}) {
  return {
    inspect: async () => scan,
    history: async () => [{ revision: "42", author: "lin", time: "2026-01-01", message: "note", files: ["note.md"] }],
    diff: async () => "- old\n+ new",
    update: async () => ({ args: ["update"], stdout: "updated", stderr: "", exitCode: 0 }),
    add: async () => ({ args: ["add"], stdout: "added", stderr: "", exitCode: 0 }),
    commit: async () => ({ args: ["commit"], stdout: "committed", stderr: "", exitCode: 0 }),
    cleanup: async () => ({ args: ["cleanup"], stdout: "cleaned", stderr: "", exitCode: 0 }),
    checkout: async () => ({ args: ["checkout"], stdout: "checked out", stderr: "", exitCode: 0 }),
    import: async () => ({ args: ["import"], stdout: "imported", stderr: "", exitCode: 0 }),
    restore: async () => {}, ignore: async () => {}, removeVersionedFileKeepLocal: async () => ({ args: ["delete"], stdout: "removed", stderr: "", exitCode: 0 }),
    resolveTextConflict: async () => ({ args: ["resolve"], stdout: "resolved", stderr: "", exitCode: 0 }),
    clearAuthCache: async () => {}, cancelCurrent: () => true,
    ...overrides,
  };
}

function source(options = {}) {
  const received = [];
  const svc = options.service ?? service();
  const saveRepositoryUrl = options.saveRepositoryUrl ?? (() => {});
  return {
    received,
    svc,
    instance: new runtime.SvnRuntimeStateSource({
      platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
      locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
      createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => true }),
      createService: (...args) => { received.push(args); return svc; },
      saveRepositoryUrl,
      fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
      ...options,
    }),
  };
}

test("检测客户端后扫描工作副本，并映射历史与可提交改动", async () => {
  const { instance } = source();
  await instance.detect();
  const state = instance.getState();
  assert.equal(state.client.status, "ready");
  assert.equal(state.repositoryUrl, "https://svn.example/vault");
  assert.equal(state.changes[0].path, "note.md");
  assert.equal(state.history[0].revision, "42");
});

test("SVN 日志的仓库根路径会转换为可安全恢复的工作副本相对路径", async () => {
  const { instance } = source({ service: service({ inspect: async () => ({ ...scan, repositoryUrl: "https://svn.example/repos/trunk", info: { repositoryRoot: "https://svn.example/repos" } }), history: async () => [{ revision: "42", author: "lin", time: "", message: "note", files: ["/trunk/folder/note.md"] }] }) });
  await instance.detect();
  assert.deepEqual(instance.getState().history[0].files, ["folder/note.md"]);
});

test("编码中文仓库 URL 会映射历史路径并允许读取单文件差异", async () => {
  const calls = [];
  const repositoryUrl = "https://svn.example/repos/%E8%B5%84%E6%96%99/%E8%AE%B0%E5%BD%95/%E9%BB%91%E6%9B%9C%E7%9F%B3%E7%AC%94%E8%AE%B0%E4%BB%93%E5%BA%93/wcd";
  const repositoryPath = "/资料/记录/黑曜石笔记仓库/wcd/工作/任务.md";
  const { instance } = source({ service: service({
    inspect: async () => ({ ...scan, repositoryUrl, info: { repositoryRoot: "https://svn.example/repos" } }),
    history: async () => [{ revision: "42", author: "lin", time: "", message: "note", files: [repositoryPath] }],
    diff: async (...args) => { calls.push(args); return "Index: 工作/任务.md\n@@ -1 +1 @@\n-old\n+new"; },
  }) });
  await instance.detect();
  assert.deepEqual(instance.getState().history[0].files, ["工作/任务.md"]);
  const result = await instance.runOperation("history-detail", { revision: "42", path: "工作/任务.md" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["C:\\Vault", "工作/任务.md", "42", "changeset"]);
  assert.equal(instance.getState().historyDetail.selectedDiff.status, "success");
});

test("非法编码的仓库 URL 不会抛出异常或放宽历史路径安全限制", async () => {
  const repositoryPath = "/broken/outside.md";
  const { instance } = source({ service: service({
    inspect: async () => ({ ...scan, repositoryUrl: "https://svn.example/repos/%E0%A4%A", info: { repositoryRoot: "https://svn.example/repos" } }),
    history: async () => [{ revision: "42", author: "lin", time: "", message: "note", files: [repositoryPath] }],
  }) });
  await assert.doesNotReject(() => instance.detect());
  assert.deepEqual(instance.getState().history[0].files, [repositoryPath]);
  assert.deepEqual(instance.getState().unrestorableHistoryByRevision["42"], [repositoryPath]);
});

test("未配置或非 Windows 以可行动状态呈现", async () => {
  const unconfigured = source({ getSettings: () => ({ ...settings, svnExecutablePath: "" }), locator: { locate: async () => ({ found: false, diagnostics: ["not found"] }) } }).instance;
  await unconfigured.detect();
  assert.equal(unconfigured.getState().viewStatus.kind, "empty");
  assert.equal(unconfigured.getState().viewStatus.actionLabel, "打开设置");
  const otherPlatform = source({ platform: "darwin" }).instance;
  await otherPlatform.detect();
  assert.equal(otherPlatform.getState().viewStatus.kind, "unsupported");
});

test("更新传递临时认证且认证失败不会泄漏密码", async () => {
  const { instance } = source({ service: service({ update: async (_cwd, credentials) => { assert.deepEqual(credentials, { username: "lin", password: "secret" }); throw { kind: "authentication", message: "Authentication failed secret" }; } }) });
  await instance.detect();
  const result = await instance.runOperation("update", { username: "lin", password: "secret" });
  assert.equal(result.ok, false);
  const stateText = JSON.stringify(instance.getState());
  assert.equal(stateText.includes("secret"), false);
  assert.equal(instance.getState().viewStatus.kind, "auth-failed");
});

test("提交、checkout 与 import 使用规范载荷，恢复会逐文件执行", async () => {
  const calls = [];
  const { instance } = source({ service: service({ commit: async (...args) => { calls.push(["commit", ...args]); return { args: ["commit"], stdout: "", stderr: "", exitCode: 0 }; }, checkout: async (...args) => { calls.push(["checkout", ...args]); return { args: ["checkout"], stdout: "", stderr: "", exitCode: 0 }; }, import: async (...args) => { calls.push(["import", ...args]); return { args: ["import"], stdout: "", stderr: "", exitCode: 0 }; }, restore: async (...args) => calls.push(["restore", ...args]) }) });
  await instance.detect();
  await instance.runOperation("commit", { paths: ["note.md"], message: "同步", username: "lin", password: "secret" });
  await instance.runOperation("checkout", { repositoryUrl: "https://svn.example/new", targetDirectory: "D:\\Checkouts\\new", username: "lin", password: "secret" });
  await instance.runOperation("import", { repositoryUrl: "https://svn.example/new", initialCommitMessage: "导入", username: "lin", password: "secret" });
  await instance.runOperation("restore", { revision: "41", files: ["note.md", "other.md"] });
  assert.deepEqual(calls[0], ["commit", "C:\\Vault", ["note.md"], "同步", { username: "lin", password: "secret" }]);
  assert.deepEqual(calls[1], ["checkout", "https://svn.example/new", "D:\\Checkouts\\new", { username: "lin", password: "secret" }]);
  assert.deepEqual(calls[2], ["import", "C:\\Vault", "https://svn.example/new", "导入", { username: "lin", password: "secret" }]);
  assert.deepEqual(calls[3], ["checkout", "https://svn.example/new", "D:\\Checkouts", { username: "lin", password: "secret" }]);
  assert.deepEqual(calls.slice(4), [["restore", "C:\\Vault", "note.md", "41"], ["restore", "C:\\Vault", "other.md", "41"]]);
});

test("运行时允许空提交说明并将其传递给 SVN 服务", async () => {
  const calls = [];
  const { instance } = source({ service: service({ commit: async (...args) => { calls.push(args); return { args: ["commit"], stdout: "committed", stderr: "", exitCode: 0 }; } }) });
  await instance.detect();
  const result = await instance.runOperation("commit", { paths: ["note.md"], message: "" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["C:\\Vault", ["note.md"], "", undefined]]);
});

test("提交未版本化文件时先加入版本控制再提交", async () => {
  const calls = [];
  const { instance } = source({ service: service({
    add: async (...args) => { calls.push(["add", ...args]); return { args: ["add"], stdout: "added", stderr: "", exitCode: 0 }; },
    commit: async (...args) => { calls.push(["commit", ...args]); return { args: ["commit"], stdout: "committed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const result = await instance.runOperation("commit", { paths: ["note.md"], addPaths: ["new.md"], message: "同步" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["add", "C:\\Vault", ["new.md"]],
    ["commit", "C:\\Vault", ["note.md", "new.md"], "同步", undefined],
  ]);
});

test("加入版本控制失败时不会执行提交", async () => {
  let commits = 0;
  const { instance } = source({ service: service({
    add: async () => { throw new Error("svn add failed"); },
    commit: async () => { commits += 1; return { args: ["commit"], stdout: "committed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const result = await instance.runOperation("commit", { paths: [], addPaths: ["new.md"], message: "同步" });
  assert.equal(result.ok, false);
  assert.equal(commits, 0);
});

test("加入成功但提交失败后保留新增状态并可直接重试", async () => {
  let inspectCount = 0;
  let commits = 0;
  const { instance } = source({ service: service({
    inspect: async () => {
      inspectCount += 1;
      return inspectCount === 1 ? { ...scan, changes: [{ path: "new.md", kind: "unversioned" }] } : { ...scan, changes: [{ path: "new.md", kind: "added" }] };
    },
    add: async () => ({ args: ["add"], stdout: "added", stderr: "", exitCode: 0 }),
    commit: async () => { commits += 1; if (commits === 1) throw new Error("commit failed"); return { args: ["commit"], stdout: "committed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const first = await instance.runOperation("commit", { paths: [], addPaths: ["new.md"], message: "同步" });
  assert.equal(first.ok, false);
  assert.equal(instance.getState().changes[0].kind, "added");
  assert.match(instance.getState().viewStatus.message, /加入版本控制已完成/);
  const second = await instance.runOperation("commit", { paths: ["new.md"], message: "同步" });
  assert.equal(second.ok, true);
  assert.equal(commits, 2);
});

test("认证重试不会重复加入已成功加入的文件", async () => {
  let adds = 0;
  let commits = 0;
  const commitPaths = [];
  const { instance } = source({ service: service({
    add: async () => { adds += 1; return { args: ["add"], stdout: "added", stderr: "", exitCode: 0 }; },
    commit: async (_cwd, paths) => { commits += 1; commitPaths.push(paths); if (commits === 1) throw { kind: "authentication", message: "Authentication failed" }; return { args: ["commit"], stdout: "committed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const first = await instance.runOperation("commit", { paths: [], addPaths: ["new.md"], message: "同步", username: "lin", password: "secret" });
  assert.equal(first.ok, false);
  const retry = await instance.retryWithCredentials("lin", "secret");
  assert.equal(retry.ok, true);
  assert.equal(adds, 1);
  assert.equal(commits, 2);
  assert.deepEqual(commitPaths, [["new.md"], ["new.md"]]);
});

test("非工作副本、锁和网络错误有可行动的视图状态", async () => {
  const empty = source({ service: service({ inspect: async () => { throw { kind: "not-working-copy", message: "E155007" }; } }) }).instance;
  await empty.detect();
  assert.deepEqual(empty.getState().viewStatus, { kind: "empty", message: "当前笔记仓库不是 SVN 工作副本。", actionLabel: "开始关联" });
});

test("普通目录的 SVN XML 读取异常仍进入待关联流程", async () => {
  const empty = source({ service: service({ inspect: async () => { throw { kind: "unknown", message: "SVN XML 标签嵌套不完整" }; } }) }).instance;
  await empty.detect();
  assert.equal(empty.getState().associationStatus, "needs-association");
  assert.equal(empty.getState().viewStatus.kind, "empty");
});

test("非工作副本使用当前 Vault 地址，并标记为待关联", async () => {
  const configured = { ...settings, repositoryUrlByVault: { "c:\\vault": "https://svn.example/team" } };
  const empty = source({ getSettings: () => configured, service: service({ inspect: async () => { throw { kind: "not-working-copy", message: "E155007" }; } }) }).instance;
  await empty.detect();
  assert.equal(empty.getState().repositoryUrl, "https://svn.example/team");
  assert.equal(empty.getState().associationStatus, "needs-association");
});

test("按 Vault 保存的 SVN 地址不会串到其他 Vault", async () => {
  const configured = { ...settings, repositoryUrlByVault: { "c:\\vault": "https://svn.example/team" } };
  const otherVault = source({ vaultPath: () => "C:\\OtherVault", getSettings: () => configured, service: service({ inspect: async () => { throw { kind: "not-working-copy", message: "E155007" }; } }) }).instance;
  await otherVault.detect();
  assert.equal(otherVault.getState().repositoryUrl, "");
});

test("检测到 .svn 但读取失败时标记为元数据错误", async () => {
  const damaged = source({ service: service({ inspect: async () => { throw { kind: "not-working-copy", message: "E155007", workingCopyMetadataPresent: true }; } }) }).instance;
  await damaged.detect();
  assert.equal(damaged.getState().associationStatus, "metadata-error");
  assert.equal(damaged.getState().viewStatus.kind, "metadata-error");
});

test("checkout 或 import 成功后保存当前 Vault 的仓库地址", async () => {
  const saved = [];
  const { instance } = source({ saveRepositoryUrl: (url) => saved.push(url) });
  await instance.detect();
  await instance.runOperation("checkout", { repositoryUrl: "https://svn.example/new", targetDirectory: "D:\\Checkouts\\new" });
  assert.deepEqual(saved, ["https://svn.example/new"]);
});

test("安全导入报告导入与 checkout 阶段，并以完成状态结束", async () => {
  const snapshots = [];
  const { instance } = source({ service: service({
    inspect: async () => { throw { kind: "not-working-copy", message: "E155007" }; },
    import: async () => ({ args: ["import"], stdout: "imported", stderr: "", exitCode: 0 }),
    checkout: async () => ({ args: ["checkout"], stdout: "checked out", stderr: "", exitCode: 0 }),
  }) });
  instance.subscribe(() => snapshots.push({ operation: { ...instance.getState().operation }, viewStatus: instance.getState().viewStatus, associationStatus: instance.getState().associationStatus }));
  await instance.detect();
  const result = await instance.runOperation("import", { repositoryUrl: "https://svn.example/new", initialCommitMessage: "导入" });
  assert.equal(result.ok, true);
  assert.equal(snapshots.some((snapshot) => snapshot.operation.progress === 60 && snapshot.operation.message.includes("checkout")), true);
  assert.equal(instance.getState().operation.status, "success");
  assert.equal(instance.getState().associationStatus, "needs-association");
  assert.equal(instance.getState().viewStatus.kind, "empty");
});

test("刷新不会覆盖进行中的写操作", async () => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const { instance } = source({ service: service({ update: async () => pending }) });
  await instance.detect(); const updating = instance.runOperation("update");
  await instance.refresh();
  assert.equal(instance.getState().operation.status, "running");
  assert.equal(instance.getState().operation.cancellable, true);
  release({ args: ["update"], stdout: "", stderr: "", exitCode: 0 }); await updating;
});

test("内置忽略候选不包含未版本化文件", async () => {
  const { instance } = source({ service: service({ inspect: async () => ({ ...scan, changes: [{ path: ".obsidian/workspace.json", kind: "unversioned" }], conflicts: [] }) }) });
  await instance.detect(); assert.deepEqual(instance.getState().versionedIgnoreCandidates, []);
});

test("Windows 路径和自定义忽略规则能够识别已受控文件", async () => {
  const { instance } = source({ service: service({ inspect: async () => ({ ...scan, changes: [
    { path: ".obsidian\\workspace.json", kind: "modified" },
    { path: "folder\\.cache", kind: "modified" },
    { path: "note.md", kind: "modified" },
  ], conflicts: [] }) }) });
  await instance.detect();
  assert.deepEqual(instance.getState().versionedIgnoreCandidates, [".obsidian\\workspace.json", "folder\\.cache"]);
});

test("已计划从 SVN 删除的文件不再显示为已受控忽略候选", async () => {
  const { instance } = source({ service: service({ inspect: async () => ({ ...scan, changes: [
    { path: ".obsidian\\workspace.json", kind: "deleted" },
  ], conflicts: [] }) }) });
  await instance.detect();
  assert.deepEqual(instance.getState().versionedIgnoreCandidates, []);
});

test("锁定和取消映射为明确状态，运行中的写操作不会并发", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { instance, svc } = source({ service: service({ update: async () => pending }) });
  await instance.detect();
  const first = instance.runOperation("update");
  const second = await instance.runOperation("cleanup");
  assert.equal(second.ok, false);
  assert.equal(instance.cancelOperation(), true);
  release({ args: ["update"], stdout: "", stderr: "", exitCode: 0 });
  await first;
  assert.equal(instance.getState().operation.status, "success");
  assert.equal(svc.cancelCurrent(), true);
});

test("写操作刷新后保留结果元数据和实际命令输出", async () => {
  const { instance } = source({ now: () => new Date("2026-09-15T08:30:00.000Z") });
  await instance.detect();
  await instance.runOperation("update");
  const operation = instance.getState().operation;
  assert.match(operation.output, /updated/);
  assert.equal(operation.name, "update");
  assert.equal(operation.summary, "工作副本已更新");
  assert.equal(operation.completedAt, "2026/9/15 16:30:00");
});

test("提交成功但刷新失败时仍保留提交成功结果", async () => {
  let inspectCount = 0;
  const { instance } = source({
    service: service({
      inspect: async () => {
        inspectCount += 1;
        if (inspectCount > 1) throw new Error("svn status refresh failed");
        return scan;
      },
    }),
  });
  await instance.detect();
  const result = await instance.runOperation("commit", { paths: ["note.md"], message: "同步" });
  assert.equal(result.ok, true);
  assert.equal(instance.getState().operation.name, "commit");
  assert.equal(instance.getState().operation.status, "success");
  assert.match(instance.getState().operation.summary, /刷新状态失败/);
  assert.match(instance.getState().operation.output, /刷新状态失败/);
});

test("提交结果摘要记录提交文件数量并在刷新后保留", async () => {
  const { instance } = source({ now: () => new Date("2026-09-15T08:30:00.000Z") });
  await instance.detect();
  await instance.runOperation("commit", { paths: ["note.md", "other.md"], addPaths: ["new.md"], message: "同步" });
  const operation = instance.getState().operation;
  assert.equal(operation.name, "commit");
  assert.equal(operation.summary, "3 个文件已提交");
  assert.equal(operation.completedAt, "2026/9/15 16:30:00");
});

test("提交失败不会把已关联工作副本误判为待关联", async () => {
  const { instance } = source({ now: () => new Date("2026-09-15T08:30:00.000Z"), service: service({ commit: async () => { throw new Error("svn: E200009: Commit failed: hotkeys.json is not under version control"); } }) });
  await instance.detect();
  assert.equal(instance.getState().associationStatus, "associated");
  const result = await instance.runOperation("commit", { paths: ["note.md"], message: "同步" });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().viewStatus.kind, "error");
  assert.equal(instance.getState().operation.status, "error");
  assert.equal(instance.getState().operation.name, "commit");
  assert.match(instance.getState().operation.summary, /提交失败：.*Commit failed/);
  assert.equal(instance.getState().operation.completedAt, "2026/9/15 16:30:00");
});

test("写操作前置失败也记录可展示的结果原因", async () => {
  const { instance } = source({ service: service({ inspect: async () => ({ ...scan, changes: [{ path: "image.png", kind: "conflict", binary: true }], conflicts: [{ path: "image.png", kind: "conflict", binary: true }] }) }) });
  await instance.detect();
  const result = await instance.runOperation("resolve", { conflictId: "image.png", resultText: "" });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().operation.name, "resolve");
  assert.match(instance.getState().operation.summary, /二进制冲突不能在插件内合并/);
});

test("按文件读取差异只更新差异状态，不改变关联状态", async () => {
  const { instance } = source({ service: service({ diff: async () => "--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-old\n+new\n" }) });
  await instance.detect();
  const result = await instance.runOperation("file-diff", { path: "note.md" });
  assert.equal(result.ok, true);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().diffByPath["note.md"].diff.rows[0].kind, "modified");
});

test("文件差异读取失败不会进入待关联或覆盖主操作状态", async () => {
  const { instance } = source({ service: service({ diff: async () => { throw new Error("svn diff failed"); } }) });
  await instance.detect();
  const before = instance.getState().operation;
  const result = await instance.runOperation("file-diff", { path: "note.md" });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().operation.message, before.message);
  assert.equal(instance.getState().operation.status, "idle");
  assert.equal(instance.getState().operation.name, undefined);
  assert.equal(instance.getState().diffByPath["note.md"].status, "error");
});

test("历史差异读取超时不会把工作副本标记为无法连接", async () => {
  const { instance } = source({ service: service({ diff: async () => { throw new Error("Command timed out"); } }) });
  await instance.detect();
  const before = instance.getState().operation;
  const result = await instance.runOperation("history-detail", { revision: "42" });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().viewStatus.kind, "ready");
  assert.equal(instance.getState().operation.message, before.message);
  assert.equal(instance.getState().operation.output, before.output);
  assert.equal(instance.getState().operation.status, "idle");
  assert.equal(instance.getState().operation.name, undefined);
});

test("忽略规则合并内置规则，受控文件只能经显式移除操作", async () => {
  const calls = [];
  const { instance } = source({ service: service({ ignore: async (...args) => calls.push(["ignore", ...args]), removeVersionedFileKeepLocal: async (...args) => { calls.push(["remove", ...args]); return { args: ["delete"], stdout: "", stderr: "", exitCode: 0 }; } }) });
  await instance.detect();
  await instance.updateUi({ type: "add-custom-ignore", pattern: ".tmp" });
  await instance.runOperation("ignore", { path: "folder/file.tmp", pattern: ".tmp" });
  await instance.runOperation("remove-versioned-file", { path: ".obsidian/workspace.json" });
  assert.deepEqual(instance.getState().builtInIgnorePatterns, [".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".trash"]);
  assert.equal(instance.getState().customIgnorePatterns.includes(".tmp"), true);
  assert.deepEqual(calls[0], ["ignore", "C:\\Vault", "folder/file.tmp", ".tmp"]);
  assert.deepEqual(calls[1], ["remove", "C:\\Vault", ".obsidian/workspace.json"]);
});

test("未版本化文件快速忽略时只写入忽略规则", async () => {
  const calls = [];
  const { instance } = source({ service: service({
    ignore: async (...args) => { calls.push(["ignore", ...args]); return { args: ["propset"], stdout: "ignored", stderr: "", exitCode: 0 }; },
    removeVersionedFileKeepLocal: async (...args) => { calls.push(["remove", ...args]); return { args: ["delete"], stdout: "removed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const result = await instance.runOperation("ignore", { path: "folder/new.tmp", pattern: "new.tmp" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["ignore", "C:\\Vault", "folder/new.tmp", "new.tmp"]]);
});

test("已版本化文件快速忽略时先写入规则再停止跟踪", async () => {
  const calls = [];
  const { instance } = source({ service: service({
    ignore: async (...args) => { calls.push(["ignore", ...args]); return { args: ["propset"], stdout: "ignored", stderr: "", exitCode: 0 }; },
    removeVersionedFileKeepLocal: async (...args) => { calls.push(["remove", ...args]); return { args: ["delete"], stdout: "removed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const result = await instance.runOperation("ignore", { path: "folder/tracked.md", pattern: "tracked.md", removeVersioned: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["ignore", "C:\\Vault", "folder/tracked.md", "tracked.md"],
    ["remove", "C:\\Vault", "folder/tracked.md"],
  ]);
});

test("已删除文件加入忽略时不会重复停止跟踪", async () => {
  const calls = [];
  const { instance } = source({ service: service({
    ignore: async (...args) => { calls.push(["ignore", ...args]); return { args: ["propset"], stdout: "ignored", stderr: "", exitCode: 0 }; },
    removeVersionedFileKeepLocal: async (...args) => { calls.push(["remove", ...args]); return { args: ["delete"], stdout: "removed", stderr: "", exitCode: 0 }; },
  }) });
  await instance.detect();
  const result = await instance.runOperation("ignore", { path: "folder/deleted.md", pattern: "deleted.md", removeVersioned: false });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["ignore", "C:\\Vault", "folder/deleted.md", "deleted.md"]]);
});

test("停止跟踪失败时返回明确错误并保留已关联状态", async () => {
  const { instance } = source({ service: service({
    ignore: async () => ({ args: ["propset"], stdout: "ignored", stderr: "", exitCode: 0 }),
    removeVersionedFileKeepLocal: async () => { throw new Error("svn delete failed"); },
  }) });
  await instance.detect();
  const result = await instance.runOperation("ignore", { path: "folder/tracked.md", pattern: "tracked.md", removeVersioned: true });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().viewStatus.kind, "error");
  assert.match(instance.getState().operation.output, /忽略规则已写入/);
});

test("二进制冲突拒绝写入合并，文本冲突读取 .mine 与最新 r 副本", async () => {
  const fileSystem = { readFile: async (file) => file.endsWith(".mine") ? "local" : "remote", writeFile: async () => {}, directoryEntries: async () => ["note.md.mine", "note.md.r4", "note.md.r7"], realpath: async (value) => value, removeDirectory: async () => {} };
  const text = source({ fileSystem, service: service({ inspect: async () => ({ ...scan, conflicts: [{ path: "note.md", kind: "conflict", binary: false }], changes: [{ path: "note.md", kind: "conflict" }] }) }) }).instance;
  await text.detect();
  assert.equal(text.getState().mergeByConflictId["note.md"].localText, "local");
  assert.equal(text.getState().mergeByConflictId["note.md"].remoteText, "remote");
  const binary = source({ service: service({ inspect: async () => ({ ...scan, conflicts: [{ path: "image.png", kind: "conflict", binary: true }], changes: [{ path: "image.png", kind: "conflict" }] }) }) }).instance;
  await binary.detect();
  const result = await binary.runOperation("resolve", { conflictId: "image.png", resultText: "nope" });
  assert.equal(result.ok, false);
  assert.match(result.error, /二进制/);
});

test("未设置 mime-type 的冲突副本含 NUL 时仍视为二进制", async () => {
  const fileSystem = { readFile: async (file) => file.endsWith(".mine") ? "\0png" : "remote", writeFile: async () => {}, directoryEntries: async () => ["image.bin.mine", "image.bin.r7"], realpath: async (value) => value, removeDirectory: async () => {} };
  const { instance } = source({ fileSystem, service: service({ inspect: async () => ({ ...scan, conflicts: [{ path: "image.bin", kind: "conflict", binary: false }], changes: [{ path: "image.bin", kind: "conflict" }] }) }) });
  await instance.detect();
  assert.equal(instance.getState().conflicts[0].type, "binary");
  assert.equal((await instance.runOperation("resolve", { conflictId: "image.bin", resultText: "x" })).ok, false);
});
