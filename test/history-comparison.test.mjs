import assert from "node:assert/strict";
import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatHistoryRelativeTime, formatHistoryTime, toggleHistorySelection } from "../src/ui-state.mjs";

let svn;
let runtime;

test.before(async () => {
  const [svnBuild, runtimeBuild] = await Promise.all([
    esbuild.build({ entryPoints: ["src/svn/index.ts"], bundle: true, platform: "node", format: "esm", write: false, target: "es2021" }),
    esbuild.build({ entryPoints: ["src/runtime-state.ts"], bundle: true, platform: "node", format: "esm", write: false, target: "es2021" }),
  ]);
  svn = await import(`data:text/javascript;base64,${Buffer.from(svnBuild.outputFiles[0].text).toString("base64")}`);
  runtime = await import(`data:text/javascript;base64,${Buffer.from(runtimeBuild.outputFiles[0].text).toString("base64")}`);
});

function localTimeParts(value) {
  const date = new Date(value);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part, index) => index === 0 ? String(part).padStart(4, "0") : String(part).padStart(2, "0"));
}

test("历史时间转换为本机中文年月日和时分", () => {
  const [year, month, day, hour, minute] = localTimeParts("2026-09-15T06:11:25.123Z");
  const expected = `${year}年${Number(month)}月${Number(day)}日 ${hour}:${minute}`;
  assert.equal(formatHistoryTime("2026-09-15T06:11:25.123Z"), expected);
  assert.equal(formatHistoryTime(""), "未知时间");
  assert.equal(formatHistoryTime("not-a-date"), "not-a-date");
});

test("历史时间提供稳定的相对时间文案", () => {
  const now = new Date("2026-09-15T08:00:00+08:00");
  assert.equal(formatHistoryRelativeTime("2026-09-15T07:59:35+08:00", now), "刚刚");
  assert.equal(formatHistoryRelativeTime("2026-09-15T07:42:00+08:00", now), "18分钟前");
  assert.equal(formatHistoryRelativeTime("2026-09-15T05:00:00+08:00", now), "3小时前");
  assert.equal(formatHistoryRelativeTime("2026-09-14T08:00:00+08:00", now), "昨天");
  assert.equal(formatHistoryRelativeTime("2026-09-10T08:00:00+08:00", now), "5天前");
  assert.equal(formatHistoryRelativeTime("2020-01-01T00:00:00Z", now), "");
  assert.equal(formatHistoryRelativeTime("not-a-date", now), "");
});

test("历史选择支持普通点击、Ctrl/Shift 追加和两条上限", () => {
  assert.deepEqual(toggleHistorySelection([], "184", false), ["184"]);
  assert.deepEqual(toggleHistorySelection(["184"], "183", true), ["184", "183"]);
  assert.deepEqual(toggleHistorySelection(["184", "183"], "183", true), ["184"]);
  assert.deepEqual(toggleHistorySelection(["184", "183"], "182", true), ["184", "183"]);
});

test("多文件历史差异解析为左右代码视图数据", () => {
  const parsed = svn.parseUnifiedDiffFiles([
    "Index: docs/a.md",
    "===================================================================",
    "--- docs/a.md\t(revision 183)",
    "+++ docs/a.md\t(revision 184)",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "Index: docs/new.md",
    "===================================================================",
    "--- docs/new.md\t(revision 183)",
    "+++ docs/new.md\t(revision 184)",
    "@@ -0,0 +1 @@",
    "+created",
    "Index: docs/removed.md",
    "===================================================================",
    "--- docs/removed.md\t(revision 183)",
    "+++ docs/removed.md\t(revision 184)",
    "@@ -1 +0,0 @@",
    "-removed",
  ].join("\n"));
  assert.deepEqual(parsed.files.map((file) => file.path), ["docs/a.md", "docs/new.md", "docs/removed.md"]);
  assert.equal(parsed.files[0].diff.rows[0].kind, "modified");
  assert.equal(parsed.files[1].diff.rows[0].kind, "added");
  assert.equal(parsed.files[2].diff.rows[0].kind, "deleted");
  const single = svn.parseUnifiedDiffFiles("--- docs/single.md\t(revision 183)\n+++ docs/single.md\t(revision 184)\n@@ -1 +1 @@\n-old\n+new");
  assert.equal(single.files[0].path, "docs/single.md");
});

test("版本区间差异使用旧版本到新版本的安全 SVN 参数", async () => {
  const calls = [];
  const runner = { cancelCurrent: () => false, run: async (args, options) => { calls.push({ args, options }); return { args, cwd: options.cwd, stdout: "diff", stderr: "", exitCode: 0 }; } };
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value });
  await service.diffBetweenRevisions("C:\\Notes", "183", "184");
  assert.deepEqual(calls[0].args, ["diff", "-r", "183:184", "--", "."]);
  assert.equal(calls[0].options.cwd, "C:\\Notes");
});

test("普通历史详情按 revision 和路径读取单文件差异", async () => {
  const calls = [];
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [{ revision: "42", author: "lin", time: "2026-01-01", message: "note", files: ["docs/note.md"] }],
    diff: async (...args) => { calls.push(args); return "Index: docs/note.md\\n@@ -1 +1 @@\\n-old\\n+new"; },
    update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => ({}), removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => ({}), clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  const result = await instance.runOperation("history-detail", { revision: "42", path: "docs/note.md" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["C:\\Vault", "docs/note.md", "42", "changeset"]);
  assert.equal(instance.getState().historyDetail.revision, "42");
  assert.equal(instance.getState().historyDetail.selectedPath, "docs/note.md");
  assert.equal(instance.getState().historyDetail.selectedDiff.status, "success");
  assert.match(instance.getState().historyDetail.selectedDiff.diff, /-old[\s\S]*\+new/);
});

test("普通历史详情快速切换文件时旧差异不能覆盖当前选择", async () => {
  const pending = new Map();
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [],
    diff: async (_cwd, path) => new Promise((resolve) => pending.set(path, resolve)),
    update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => ({}), removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => ({}), clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  const first = instance.runOperation("history-detail", { revision: "42", path: "first.md" });
  const second = instance.runOperation("history-detail", { revision: "42", path: "second.md" });
  pending.get("second.md")( "Index: second.md\\n@@ -1 +1 @@\\n-old-second\\n+new-second" );
  await second;
  pending.get("first.md")( "Index: first.md\\n@@ -1 +1 @@\\n-old-first\\n+new-first" );
  await first;
  assert.equal(instance.getState().historyDetail.selectedPath, "second.md");
  assert.match(instance.getState().historyDetail.selectedDiff.diff, /new-second/);
});

test("普通历史详情单文件差异失败时保留选中路径和错误状态", async () => {
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [], diff: async () => { throw new Error("history file diff failed"); },
    update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => ({}), removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => ({}), clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  const result = await instance.runOperation("history-detail", { revision: "42", path: "docs/note.md" });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().historyDetail.revision, "42");
  assert.equal(instance.getState().historyDetail.selectedPath, "docs/note.md");
  assert.equal(instance.getState().historyDetail.selectedDiff.status, "error");
  assert.match(instance.getState().historyDetail.selectedDiff.message, /history file diff failed/);
  assert.equal(instance.getState().associationStatus, "associated");
});

test("历史对比摘要默认选择第一个文件，并按需读取单文件差异", async () => {
  let fileDiffCalls = 0;
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000, logRetentionDays: 30 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [],
    diffSummaryBetweenRevisions: async (_cwd, fromRevision, toRevision) => { assert.deepEqual([fromRevision, toRevision], ["183", "184"]); return [{ path: "docs/note.md", kind: "modified" }, { path: "assets/logo.png", kind: "modified" }]; },
    diffFileBetweenRevisions: async (_cwd, fromRevision, toRevision, path) => { fileDiffCalls += 1; assert.deepEqual([fromRevision, toRevision, path], ["183", "184", "docs/note.md"]); return "Index: docs/note.md\n@@ -1 +1 @@\n-old\n+new"; },
    diff: async () => "", update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => ({}), removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => ({}), clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  assert.equal((await instance.runOperation("history-compare", { fromRevision: "184", toRevision: "183" })).ok, true);
  assert.equal(instance.getState().historyCompare.selectedPath, "docs/note.md");
  assert.equal(fileDiffCalls, 0);
  assert.equal((await instance.runOperation("history-compare-file", { path: "docs/note.md" })).ok, true);
  assert.equal(fileDiffCalls, 1);
  assert.equal(instance.getState().historyCompare.selectedDiff.diff.rows[0].kind, "modified");
});

test("历史对比单文件读取失败时保留文件摘要列表", async () => {
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000, logRetentionDays: 30 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [],
    diffSummaryBetweenRevisions: async () => [{ path: "docs/note.md", kind: "modified" }],
    diffFileBetweenRevisions: async () => { throw new Error("单文件差异失败"); },
    diff: async () => "", update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => ({}), removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => {}, clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  await instance.runOperation("history-compare", { fromRevision: "183", toRevision: "184" });
  const result = await instance.runOperation("history-compare-file", { path: "docs/note.md" });
  assert.equal(result.ok, false);
  assert.deepEqual(instance.getState().historyCompare.files, [{ path: "docs/note.md", kind: "modified" }]);
  assert.equal(instance.getState().historyCompare.selectedDiff.status, "error");
});

test("运行时历史对比成功写入结构化状态并保持工作副本关联", async () => {
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000, logRetentionDays: 30 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [{ revision: "184", author: "lin", time: "2026-01-01T00:00:00Z", message: "new", files: ["note.md"] }, { revision: "183", author: "wei", time: "2025-12-31T00:00:00Z", message: "old", files: ["note.md"] }],
    diffSummaryBetweenRevisions: async (_cwd, fromRevision, toRevision) => { assert.deepEqual([fromRevision, toRevision], ["183", "184"]); return [{ path: "note.md", kind: "modified" }]; },
    diffFileBetweenRevisions: async () => "Index: note.md\n--- note.md\t(revision 183)\n+++ note.md\t(revision 184)\n@@ -1 +1 @@\n-old\n+new",
    diff: async () => "", update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => {}, removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => ({}), clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  const result = await instance.runOperation("history-compare", { fromRevision: "184", toRevision: "183" });
  assert.equal(result.ok, true);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().historyCompare.status, "success");
  assert.deepEqual([instance.getState().historyCompare.fromRevision, instance.getState().historyCompare.toRevision], ["183", "184"]);
  assert.deepEqual(instance.getState().historyCompare.files[0], { path: "note.md", kind: "modified" });
});

test("历史 UI 显示格式化时间并提供两条记录对比入口", async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(main, /formatHistoryTime\(entry\.time\)/);
  assert.match(main, /toggleHistorySelection/);
  assert.match(main, /history-compare/);
  assert.match(main, /最多选择两条历史记录/);
  assert.match(styles, /\.svn-history-item\.is-selected/);
  assert.match(styles, /\.svn-history-compare-file/);
});

test("历史对比 UI 只提供文件清单和当前文件差异入口", async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(main, /history-compare-file/);
  assert.match(main, /selectedPath/);
  assert.match(main, /aria-selected/);
  assert.match(main, /svn-history-compare-list/);
  assert.match(main, /svn-history-compare-detail/);
  assert.match(styles, /\.svn-history-compare-list/);
  assert.match(styles, /\.svn-history-compare-file-item\.is-selected/);
});

test("历史 UI 使用可读的卡片信息层级和空状态", async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(main, /formatHistoryRelativeTime\(entry\.time\)/);
  assert.match(main, /svn-history-item-revision/);
  assert.match(main, /svn-history-item-meta/);
  assert.match(main, /svn-history-empty/);
  assert.match(styles, /\.svn-history-timeline::before/);
  assert.match(styles, /\.svn-history-item-meta/);
  assert.match(styles, /\.svn-history-detail-section/);
});

test("历史 UI 让左侧时间线和右侧详情独立滚动", async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(main, /content\.addClass\("svn-history-content"\)/);
  assert.match(main, /content\.removeClass\("svn-history-content"\)/);
  assert.match(styles, /\.svn-center-content\.svn-history-content[\s\S]*display:\s*flex/);
  assert.match(styles, /\.svn-history-layout[\s\S]*align-items:\s*stretch/);
  assert.match(styles, /\.svn-history-timeline[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /\.svn-history-detail[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.svn-center-content\.svn-history-content[\s\S]*overflow:\s*auto/);
});

test("普通历史详情文件行切换单文件差异并保留文件历史入口", async () => {
  const [main, styles] = await Promise.all([
    readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(main, /historyDetail\.revision === entry\.revision/);
  assert.match(main, /role: "button", tabindex: "0"/);
  assert.match(main, /loadHistoryFileDiff\(entry\.revision, file\)/);
  assert.match(main, /clear-history-detail/);
  assert.match(main, /historyDetail\.selectedDiff\.diff/);
  assert.match(main, /this\.button\(row, "按文件历史"/);
  assert.match(styles, /\.svn-history-file-row\.is-selected/);
  assert.match(styles, /\.svn-history-file-row:focus-visible/);
});

test("运行时历史对比失败只更新对比错误，不改变关联状态", async () => {
  const settings = { svnExecutablePath: "C:\\Tools\\svn.exe", defaultCheckoutDirectory: "D:\\Checkouts", repositoryUrlByVault: {}, ignorePatterns: [], commandTimeoutMs: 4000, logRetentionDays: 30 };
  const service = {
    inspect: async () => ({ workingCopyPath: "C:\\Vault", repositoryUrl: "https://svn.example/vault", changes: [], conflicts: [] }),
    history: async () => [], diffSummaryBetweenRevisions: async () => { throw new Error("svn diff range failed"); }, diffFileBetweenRevisions: async () => "",
    diff: async () => "", update: async () => ({}), add: async () => ({}), commit: async () => ({}), cleanup: async () => ({}), checkout: async () => ({}), import: async () => ({}), restore: async () => {}, ignore: async () => {}, removeVersionedFileKeepLocal: async () => ({}), resolveTextConflict: async () => ({}), clearAuthCache: async () => {}, cancelCurrent: () => false,
  };
  const instance = new runtime.SvnRuntimeStateSource({
    platform: "win32", vaultPath: () => "C:\\Vault", vaultName: () => "团队库", getSettings: () => settings,
    locator: { locate: async () => ({ found: true, executable: "C:\\Tools\\svn.exe", source: "configured", version: "1.14", diagnostics: [] }) },
    createRunner: () => ({ run: async () => ({ args: [], stdout: "", stderr: "", exitCode: 0 }), cancelCurrent: () => false }),
    createService: () => service,
    fileSystem: { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], realpath: async (value) => value, removeDirectory: async () => {} },
  });
  await instance.detect();
  const result = await instance.runOperation("history-compare", { fromRevision: "184", toRevision: "183" });
  assert.equal(result.ok, false);
  assert.equal(instance.getState().associationStatus, "associated");
  assert.equal(instance.getState().historyCompare.status, "error");
  assert.match(instance.getState().historyCompare.message, /svn diff range failed/);
});
