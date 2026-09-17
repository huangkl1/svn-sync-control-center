import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

let svn;

test.before(async () => {
  const source = await readFile("src/svn/index.ts", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 } }).outputText;
  svn = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
});

class FakeRunner {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async run(args, options = {}) {
    this.calls.push({ args, options });
    const response = this.responses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
    if (response instanceof Error) throw response;
    return { args, cwd: options.cwd, ...response };
  }
}

test("命令参数始终以数组传递，认证密码不会出现在日志中", async () => {
  const events = [];
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: async (executable, args) => ({ executable, args, stdout: "ok", stderr: "", exitCode: 0 }), onLog: (line) => events.push(line) });
  await runner.run(["update", "--username", "lin", "--password", "top-secret", "https://a.example/svn?token=abc"], { cwd: "C:\\Notes" });
  assert.equal(events[0].includes("top-secret"), false);
  assert.equal(events[0].includes("token=abc"), false);
  assert.equal(events[0].includes("--password ***"), true);
});

test("客户端检测依次优先配置、PATH 与常见安装路径", async () => {
  const probes = [];
  const locator = new svn.SvnClientLocator({
    pathExists: async (path) => path === "D:\\Tools\\svn.exe" || path === "C:\\Program Files\\TortoiseSVN\\bin\\svn.exe",
    run: async (executable, args) => { probes.push({ executable, args }); return executable === "where.exe" ? { stdout: "", stderr: "", exitCode: 1 } : { stdout: "1.14.2\n", stderr: "", exitCode: 0 }; },
    pathCandidates: ["C:\\Program Files\\TortoiseSVN\\bin\\svn.exe"],
  });
  const configured = await locator.locate("D:\\Tools");
  assert.equal(configured.source, "configured");
  assert.equal(configured.executable, "D:\\Tools\\svn.exe");
  assert.deepEqual(probes[0].args, ["--version", "--quiet"]);
  const fromCandidates = await locator.locate();
  assert.equal(fromCandidates.source, "tortoisesvn");
});

test("XML 解析保留信息、变更和历史的安全文本", () => {
  const info = svn.parseInfoXml('<info><entry path="." revision="42"><url>https://svn.example/a?x=1</url><repository><root>https://svn.example</root></repository><wc-info><wcroot-abspath>C:\\Notes</wcroot-abspath></wc-info></entry></info>');
  assert.equal(info.repositoryUrl, "https://svn.example/a?x=1");
  assert.equal(info.revision, "42");
  const status = svn.parseStatusXml('<status><target path="."><entry path="a &amp; b.md"><wc-status item="modified" props="none"/></entry><entry path="bad.md"><wc-status item="conflicted" props="none"><tree-conflict/></wc-status></entry><entry path="mystery"><wc-status item="future-item" props="none"/></entry></target></status>');
  assert.deepEqual(status.entries.map((entry) => entry.kind), ["modified", "conflict", "unknown"]);
  assert.equal(status.conflicts[0].path, "bad.md");
  const logs = svn.parseLogXml('<log><logentry revision="8"><author>Lin &amp; Co</author><date>2026-01-02T03:04:05.000000Z</date><msg>Fix &lt;note&gt;</msg><paths><path action="M">a.md</path></paths></logentry></log>');
  assert.deepEqual(logs, [{ revision: "8", author: "Lin & Co", time: "2026-01-02T03:04:05.000000Z", message: "Fix <note>", files: ["a.md"] }]);
});

test("unified diff 转换为带行号的左右差异行", () => {
  const diff = svn.parseUnifiedDiff("--- a/note.md\n+++ b/note.md\n@@ -1,3 +1,3 @@\n 保留\n-旧内容\n+新内容\n 结尾\n", "modified");
  assert.equal(diff.status, "modified");
  assert.deepEqual(diff.rows.map((row) => row.kind), ["context", "modified", "context"]);
  assert.deepEqual(diff.rows[1], { kind: "modified", left: { lineNumber: 2, text: "旧内容", kind: "deleted" }, right: { lineNumber: 2, text: "新内容", kind: "added" } });
});

test("unified diff 对新增、删除、二进制和空差异返回明确状态", () => {
  assert.equal(svn.parseUnifiedDiff("@@ -0,0 +1 @@\n+新文件\n", "added").status, "added");
  assert.equal(svn.parseUnifiedDiff("@@ -1 +0,0 @@\n-旧文件\n", "deleted").status, "deleted");
  assert.equal(svn.parseUnifiedDiff("Binary files a/image.png and b/image.png differ").status, "binary");
  assert.equal(svn.parseUnifiedDiff("Cannot display: file marked as a binary type.\nsvn:mime-type = application/octet-stream").status, "binary");
  assert.equal(svn.parseUnifiedDiff("").status, "empty");
});

test("Markdown 差异正文包含二进制字样时仍按文本差异解析", () => {
  const diff = svn.parseUnifiedDiff("--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-旧内容\n+单个静态二进制文件，零依赖。\n", "modified");
  assert.equal(diff.status, "modified");
  assert.equal(diff.rows[0].right?.text, "单个静态二进制文件，零依赖。");
});

test("SVN diff 摘要保留修改、新增、删除、替换和带空格的文件路径", () => {
  const parsed = svn.parseSvnDiffSummary([
    "M       docs/changed.md",
    "A       docs/new note.md",
    "D       docs/removed.md",
    "R       docs/replaced.md",
  ].join("\n"));
  assert.deepEqual(parsed, [
    { path: "docs/changed.md", kind: "modified" },
    { path: "docs/new note.md", kind: "added" },
    { path: "docs/removed.md", kind: "deleted" },
    { path: "docs/replaced.md", kind: "modified" },
  ]);
});

test("大型 SVN 历史 XML 不会在解析前被默认日志上限截断", async () => {
  const longMessage = "x".repeat(300_000);
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: async () => ({ stdout: `<log><logentry revision="1"><author>wu</author><date>2026-01-01</date><msg>${longMessage}</msg></logentry></log>`, stderr: "", exitCode: 0 }) });
  const service = new svn.SvnWorkingCopyService(runner);
  const history = await service.history("D:\\笔记库");
  assert.equal(history[0].message.length, longMessage.length);
});

test("工作副本历史显式从仓库 HEAD 读取，避免混合版本工作副本停在 BASE", async () => {
  const runner = new FakeRunner([{ stdout: "<log></log>", stderr: "", exitCode: 0 }]);
  const service = new svn.SvnWorkingCopyService(runner);
  await service.history("D:\\笔记库");
  assert.deepEqual(runner.calls[0].args, ["log", "--xml", "-v", "-r", "HEAD:1", "--", "."]);
});

test("版本对比先读取文件摘要，点击文件时读取单文件差异", async () => {
  const runner = new FakeRunner([
    { stdout: "M       docs/note.md\nA       docs/new note.md\n", stderr: "", exitCode: 0 },
    { stdout: "Index: docs/note.md\n@@ -1 +1 @@\n-old\n+new\n", stderr: "", exitCode: 0 },
  ]);
  const service = new svn.SvnWorkingCopyService(runner);
  const summary = await service.diffSummaryBetweenRevisions("D:\\笔记库", "183", "184");
  const diff = await service.diffFileBetweenRevisions("D:\\笔记库", "183", "184", "docs/note.md");
  assert.deepEqual(summary, [{ path: "docs/note.md", kind: "modified" }, { path: "docs/new note.md", kind: "added" }]);
  assert.equal(diff.includes("+new"), true);
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["diff", "--summarize", "-r", "183:184", "--", "."],
    ["diff", "-r", "183:184", "--", "docs/note.md"],
  ]);
});

test("单文件版本对比拒绝工作副本外的路径", async () => {
  const service = new svn.SvnWorkingCopyService(new FakeRunner());
  await assert.rejects(() => service.diffFileBetweenRevisions("D:\\笔记库", "183", "184", "..\\secret.txt"), /工作副本/);
});

test("Windows SVN 中文错误输出按 GB18030 解码，不产生替换字符", () => {
  const bytes = Uint8Array.from([0x73, 0x76, 0x6e, 0x3a, 0x20, 0x45, 0x31, 0x35, 0x35, 0x30, 0x30, 0x37, 0x3a, 0x20, 0x27, 0x44, 0x3a, 0x5c, 0xb1, 0xca, 0xbc, 0xc7, 0xbf, 0xe2, 0x27]);
  assert.equal(svn.decodeSvnOutput(bytes), "svn: E155007: 'D:\\笔记库'");
});

test("UTF-8 差异混入单个非法字节时保留中文，不整体降级为 GB18030", () => {
  const prefix = new TextEncoder().encode("Index: note.md\n@@ -1 +1 @@\n-旧内容\n+中文内容\n");
  const bytes = Uint8Array.from([...prefix, 0x80]);
  const decoded = svn.decodeSvnOutput(bytes);
  assert.equal(decoded.includes("+中文内容"), true);
  assert.equal(decoded.includes("涓枃"), false);
  assert.equal((decoded.match(/�/g) ?? []).length, 1);
});

test("完整 UTF-8 SVN 输出不经过兼容编码转换", () => {
  const expected = "Index: 杂项/开服流程.md\n+中文内容\n";
  assert.equal(svn.decodeSvnOutput(new TextEncoder().encode(expected)), expected);
});

test("混合编码 SVN 差异按行解码，GBK 头部与 UTF-8 正文都保留", () => {
  const gbkHeader = Uint8Array.from([
    0x49, 0x6e, 0x64, 0x65, 0x78, 0x3a, 0x20,
    0xd4, 0xd3, 0xcf, 0xee, 0x2f, 0xd3, 0xce, 0xcf, 0xb7, 0x2f,
    0xbb, 0xc3, 0xca, 0xde, 0xc5, 0xc1, 0xc2, 0xb3, 0x2f,
    0xbf, 0xaa, 0xb7, 0xfe, 0xc1, 0xf7, 0xb3, 0xcc, 0x2e, 0x6d, 0x64, 0x0d, 0x0a,
  ]);
  const utf8Body = new TextEncoder().encode("===================================================================\r\n@@ -1 +1,2 @@\r\n 服务器存档位置：\r\n+修改存档工具：\r\n");
  const decoded = svn.decodeSvnOutput(Uint8Array.from([...gbkHeader, ...utf8Body]), { kind: "diff" });
  assert.equal(decoded, "Index: 杂项/游戏/幻兽帕鲁/开服流程.md\r\n===================================================================\r\n@@ -1 +1,2 @@\r\n 服务器存档位置：\r\n+修改存档工具：\r\n");
});

test("spawn 的 SVN diff 使用混合编码解码，而普通输出保持自动兼容", async () => {
  const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.kill = () => true;
  const runner = new svn.SvnCommandRunner("svn.exe", { spawn: () => process });
  const pending = runner.run(["diff", "--", "note.md"]);
  process.stdout.emit("data", Uint8Array.from([0x2b, ...new TextEncoder().encode("中文内容"), 0x0d, 0x0a]));
  process.emit("close", 0);
  assert.equal((await pending).stdout, "+中文内容\r\n");
});

test("inspect 报告当前目录存在 .svn 元数据", async () => {
  const runner = new FakeRunner([{ stdout: "", stderr: "E155007", exitCode: 1 }]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [".svn"] });
  await assert.rejects(() => service.inspect("D:\\笔记库"), (error) => error instanceof svn.SvnServiceError && error.workingCopyMetadataPresent === true);
});

test("inspect 的 XML 解析失败日志包含阶段、工作目录和原始输出", async () => {
  const runner = new FakeRunner([
    { stdout: '<info><entry path=".">', stderr: "", exitCode: 0 },
    { stdout: '<status><target path="."></target></status>', stderr: "", exitCode: 0 },
  ]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await assert.rejects(() => service.inspect("D:\\笔记库"), (error) => error instanceof svn.SvnServiceError
    && error.message.includes("XML 阶段：info")
    && error.message.includes("工作目录：D:\\笔记库")
    && error.message.includes("info 输出：<info><entry path=\".\">"));
});

test("扫描 DTO 可直接适配控制中心所需的工作副本、变更、冲突与历史字段", () => {
  const snapshot = svn.toSvnUiSnapshot({
    workingCopyPath: "C:\\Notes", repositoryUrl: "https://svn.example/notes", info: { repositoryUrl: "https://svn.example/notes" },
    changes: [{ path: "a.md", kind: "modified", rawItem: "modified", conflicted: false }, { path: "bad.md", kind: "conflict", rawItem: "conflicted", conflicted: true }],
    conflicts: [{ path: "bad.md", kind: "conflict", rawItem: "conflicted", conflicted: true }],
  }, [{ revision: "8", author: "lin", time: "2026-01-01", message: "修复", files: ["a.md"] }]);
  assert.deepEqual(snapshot, {
    workingCopyPath: "C:\\Notes", repositoryUrl: "https://svn.example/notes",
    changes: [{ id: "a.md", path: "a.md", kind: "modified", selected: true }, { id: "bad.md", path: "bad.md", kind: "conflict", selected: false }],
    conflicts: [{ id: "bad.md", path: "bad.md", type: "text", occurredAt: "", resolved: false }],
    history: [{ revision: "8", author: "lin", time: "2026-01-01", message: "修复", files: ["a.md"] }],
  });
});

test("认证、网络、锁和超时错误可分类", () => {
  assert.equal(svn.classifySvnError("svn: E170001: Authentication failed"), "authentication");
  assert.equal(svn.classifySvnError("E155004: Working copy locked"), "working-copy-locked");
  assert.equal(svn.classifySvnError("Could not resolve hostname"), "network");
  assert.equal(svn.classifySvnError("Command timed out"), "timeout");
});

test("更新携带一次性认证并分类认证失败", async () => {
  const runner = new FakeRunner([new svn.SvnCommandError({ args: [], stdout: "", stderr: "Authentication failed", exitCode: 1 })]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await assert.rejects(() => service.update("C:\\Notes", { username: "lin", password: "secret" }), (error) => error.kind === "authentication");
  assert.deepEqual(runner.calls[0].args, ["update", "--non-interactive", "--username", "lin", "--password", "secret"]);
});

test("提交传递路径清单并允许空说明", async () => {
  const runner = new FakeRunner();
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await service.commit("C:\\Notes", ["a.md", "b.md"], "同步笔记");
  assert.deepEqual(runner.calls[0].args, ["commit", "-m", "同步笔记", "--", "a.md", "b.md"]);
  await service.commit("C:\\Notes", ["a.md"], "   ");
  assert.deepEqual(runner.calls[1].args, ["commit", "-m", "", "--", "a.md"]);
  await assert.rejects(() => service.commit("C:\\Notes", [], ""), /至少选择一个提交文件/);
});

test("加入版本控制传递路径清单并拒绝空路径或越界路径", async () => {
  const runner = new FakeRunner();
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await service.add("C:\\Notes", ["new.md", "folder/child.md"]);
  assert.deepEqual(runner.calls[0].args, ["add", "--", "new.md", "folder/child.md"]);
  await assert.rejects(() => service.add("C:\\Notes", []), /至少选择一个/);
  await assert.rejects(() => service.add("C:\\Notes", ["..\\outside.md"]), /工作副本/);
});

test("检出拒绝非空目录", async () => {
  const runner = new FakeRunner();
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => ["existing.md"] });
  await assert.rejects(() => service.checkout("https://svn.example/notes", "C:\\Notes"), /非空/);
  assert.equal(runner.calls.length, 0);
});

test("忽略规则读取并保留现有值", async () => {
  const runner = new FakeRunner([{ stdout: "*.tmp\n.cache\n", stderr: "", exitCode: 0 }, { stdout: "", stderr: "", exitCode: 0 }]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await service.ignore("C:\\Notes", "folder/file.md", "*.bak");
  assert.deepEqual(runner.calls[1].args, ["propset", "svn:ignore", "*.tmp\n.cache\n*.bak", "--", "folder"]);
});

test("合并结果含冲突标记时拒绝写入", async () => {
  const runner = new FakeRunner();
  const writes = [];
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async (...args) => writes.push(args), directoryEntries: async () => [] });
  await assert.rejects(() => service.resolveTextConflict("C:\\Notes", "a.md", "<<<<<<< local\nx\n=======\ny\n>>>>>>> remote"), /冲突标记/);
  assert.equal(writes.length, 0);
});

test("解决文本冲突先写入再以 working 标记已解决", async () => {
  const runner = new FakeRunner();
  const events = [];
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async (path, text) => events.push({ path, text }), directoryEntries: async () => [], realpath: async (value) => value });
  await service.resolveTextConflict("C:\\Notes", "a.md", "合并结果");
  assert.deepEqual(events, [{ path: "C:\\Notes\\a.md", text: "合并结果" }]);
  assert.deepEqual(runner.calls[0].args, ["resolve", "--accept", "working", "--", "a.md"]);
});

test("runner 的 spawn 注入保持参数数组且取消当前进程", async () => {
  const process = new EventEmitter();
  process.stdout = new EventEmitter(); process.stderr = new EventEmitter();
  let killed = false; let received;
  process.kill = () => { killed = true; queueMicrotask(() => process.emit("close", 1)); return true; };
  const runner = new svn.SvnCommandRunner("svn.exe", { spawn: (executable, args, options) => { received = { executable, args, options }; return process; } });
  const pending = runner.run(["update", "a & b.md"], { cwd: "C:\\Notes", write: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, { executable: "svn.exe", args: ["update", "a & b.md"], options: { cwd: "C:\\Notes", shell: false, windowsHide: true } });
  assert.equal(runner.cancelCurrent(), true);
  assert.equal(killed, true);
  await assert.rejects(pending, svn.SvnCommandError);
});

test("并发读取不会覆盖可取消的写操作句柄", async () => {
  const read = new EventEmitter(); const write = new EventEmitter();
  for (const process of [read, write]) { process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); }
  let readKilled = false; let writeKilled = false;
  read.kill = () => { readKilled = true; return true; }; write.kill = () => { writeKilled = true; queueMicrotask(() => write.emit("close", 1)); return true; };
  const queue = [read, write]; const runner = new svn.SvnCommandRunner("svn.exe", { spawn: () => queue.shift() });
  const readPending = runner.run(["status"], { cwd: "C:\\Notes" });
  const writePending = runner.run(["update"], { cwd: "C:\\Notes", write: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.cancelCurrent(), true); assert.equal(writeKilled, true); assert.equal(readKilled, false);
  read.emit("close", 0); await readPending; await assert.rejects(writePending, svn.SvnCommandError);
});

test("同一工作副本写操作串行", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const started = [];
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: async (_exe, args) => { started.push(args[1]); if (args[1] === "first") await pending; return { args, stdout: "", stderr: "", exitCode: 0 }; } });
  const first = runner.run(["test", "first"], { cwd: "C:\\Notes", write: true });
  const second = runner.run(["test", "second"], { cwd: "C:\\Notes", write: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
});

test("认证缓存只能删除构造时批准的 SVN auth 目录", async () => {
  const removed = [];
  const service = new svn.SvnWorkingCopyService(new FakeRunner(), { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], removeDirectory: async (directory) => removed.push(directory) }, { authCacheDirectory: "C:\\Users\\Lin\\AppData\\Roaming\\Subversion\\auth", approvedSubversionRoot: "C:\\Users\\Lin\\AppData\\Roaming\\Subversion" });
  await assert.rejects(() => service.clearAuthCache("C:\\Notes"), /认证缓存目录/);
  await service.clearAuthCache("C:\\Users\\Lin\\AppData\\Roaming\\Subversion\\auth");
  assert.deepEqual(removed, ["C:\\Users\\Lin\\AppData\\Roaming\\Subversion\\auth"]);
  assert.throws(() => new svn.SvnWorkingCopyService(new FakeRunner(), { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] }, { authCacheDirectory: "C:\\Vault" }), /auth/);
});

test("注入执行器同样遵循超时，并将超时归类", async () => {
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: () => new Promise((resolve) => setTimeout(() => resolve({ stdout: "late", stderr: "", exitCode: 0 }), 30)) });
  await assert.rejects(() => runner.run(["status"], { timeoutMs: 1 }), (error) => error instanceof svn.SvnCommandError && svn.classifySvnError(error) === "timeout");
});

test("服务调用将配置超时传给 runner", async () => {
  const runner = new FakeRunner();
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] }, { timeoutMs: 2468 });
  await service.update("C:\\Notes");
  assert.equal(runner.calls[0].options.timeoutMs, 2468);
});

test("无效 XML 抛出专用解析错误，CDATA 与嵌套文本可解析", () => {
  assert.throws(() => svn.parseInfoXml("<info><entry>"), svn.SvnParseError);
  assert.throws(() => svn.parseStatusXml("not xml"), svn.SvnParseError);
  assert.throws(() => svn.parseLogXml("<log><logentry revision=\"1\">"), svn.SvnParseError);
  const logs = svn.parseLogXml("<log><logentry revision=\"1\"><author><![CDATA[Lin & Co]]></author><msg><![CDATA[<nested>正文</nested>]]></msg><paths><path><![CDATA[a.md]]></path></paths></logentry></log>");
  assert.deepEqual(logs[0], { revision: "1", author: "Lin & Co", time: "", message: "<nested>正文</nested>", files: ["a.md"] });
});

test("PATH 探测会跳过不可用的首个 where 候选", async () => {
  const verified = [];
  const locator = new svn.SvnClientLocator({ pathExists: async () => false, run: async (executable, args) => {
    if (executable === "where.exe") return { stdout: "C:\\bad\\svn.exe\nC:\\good\\svn.exe", stderr: "", exitCode: 0 };
    verified.push(executable); return executable.includes("good") ? { stdout: "1.14", stderr: "", exitCode: 0 } : { stdout: "", stderr: "broken", exitCode: 1 };
  }, pathCandidates: [] });
  const found = await locator.locate();
  assert.equal(found.executable, "C:\\good\\svn.exe");
  assert.deepEqual(verified, ["C:\\bad\\svn.exe", "C:\\good\\svn.exe"]);
});

test("无法确认属性不存在时 ignore 不覆盖原规则", async () => {
  const runner = new FakeRunner([new svn.SvnCommandError({ args: [], stdout: "", stderr: "unexpected property failure", exitCode: 1 })]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await assert.rejects(() => service.ignore("C:\\Notes", "a.md", "*.bak"));
  assert.equal(runner.calls.length, 1);
});

test("恢复与合并拒绝绝对路径、越界路径及缩进冲突标记", async () => {
  const runner = new FakeRunner();
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await assert.rejects(() => service.restore("C:\\Notes", "..\\outside.md", "1"), /工作副本/);
  await assert.rejects(() => service.resolveTextConflict("C:\\Notes", "C:\\outside.md", "正文"), /工作副本/);
  await assert.rejects(() => service.resolveTextConflict("C:\\Notes", "a.md", "  ||||||| base\ntext"), /冲突标记/);
});

test("检出拒绝空目录参数，并在创建后复查目录仍为空", async () => {
  const runner = new FakeRunner(); let checks = 0;
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => ++checks === 1 ? [] : ["raced.md"], ensureDirectory: async () => {} });
  await assert.rejects(() => service.checkout("https://svn.example/notes", ""), /目标目录/);
  await assert.rejects(() => service.checkout("https://svn.example/notes", "C:\\New"), /非空/);
  assert.equal(runner.calls.length, 0);
});

test("同一工作副本的 ignore 临界区不会交错 propget 与 propset", async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; }); const calls = [];
  const runner = { cancelCurrent: () => false, run: async (args, options) => { calls.push(args[0]); if (args[0] === "propget" && calls.filter((item) => item === "propget").length === 1) await gate; return { args, cwd: options.cwd, stdout: "", stderr: "", exitCode: 0 }; } };
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  const first = service.ignore("C:\\Notes", "a.md", "*.a"); const second = service.ignore("C:\\Notes", "b.md", "*.b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["propget"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, ["propget", "propset", "propget", "propset"]);
});

test("inspect 将 XML 解析错误封装为 service error", async () => {
  const runner = new FakeRunner([{ stdout: "<info><entry>", stderr: "", exitCode: 0 }, { stdout: "<status></status>", stderr: "", exitCode: 0 }]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await assert.rejects(() => service.inspect("C:\\Notes"), (error) => error instanceof svn.SvnServiceError && error.kind === "unknown");
});

test("XML 声明、BOM 和注释不影响 info/status/log 根校验", () => {
  const prefix = "\uFEFF<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- svn -->\n";
  assert.equal(svn.parseInfoXml(`${prefix}<info><entry revision=\"1\"><url>https://svn.example</url></entry></info>`).revision, "1");
  assert.equal(svn.parseStatusXml(`${prefix}<status><target path=\".\"></target></status>`).entries.length, 0);
  assert.equal(svn.parseLogXml(`${prefix}<log></log>`).length, 0);
});

test("inspect 透传 service timeout，服务公开取消委托", async () => {
  const runner = new FakeRunner([{ stdout: "<info><entry><url>https://x</url></entry></info>", stderr: "", exitCode: 0 }, { stdout: "<status></status>", stderr: "", exitCode: 0 }]);
  runner.cancelCurrent = () => true;
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] }, { timeoutMs: 99 });
  await service.inspect("C:\\Notes");
  assert.deepEqual(runner.calls.map((call) => call.options.timeoutMs), [99, 99]);
  assert.equal(service.cancelCurrent(), true);
});

test("commit、历史、diff 和移除版本控制文件拒绝越出工作副本的路径", async () => {
  const runner = new FakeRunner(); const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await assert.rejects(() => service.commit("C:\\Notes", ["a.md", "..\\bad.md"], "msg"), /工作副本/);
  await assert.rejects(() => service.fileHistory("C:\\Notes", "C:\\bad.md"), /工作副本/);
  await assert.rejects(() => service.diff("C:\\Notes", "..\\bad.md"), /工作副本/);
  await assert.rejects(() => service.removeVersionedFileKeepLocal("C:\\Notes", "..\\bad.md"), /工作副本/);
});

test("认证缓存拒绝非 APPDATA Subversion auth 或未批准根下 auth", () => {
  assert.throws(() => new svn.SvnWorkingCopyService(new FakeRunner(), undefined, { authCacheDirectory: "C:\\Vault\\auth" }), /Subversion/);
});

test("调用方 AbortSignal 会中止注入 executor，并由 cancelCurrent 中止写 executor", async () => {
  let abortedByCaller = false; let abortedByService = false;
  const executor = (_executable, _args, options) => new Promise((resolve) => options.signal.addEventListener("abort", () => { if (options.write) abortedByService = true; else abortedByCaller = true; resolve({ stdout: "", stderr: "aborted", exitCode: 1 }); }, { once: true }));
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: executor });
  const caller = new AbortController(); const read = runner.run(["status"], { signal: caller.signal }); caller.abort();
  await assert.rejects(read, svn.SvnCommandError); assert.equal(abortedByCaller, true);
  const write = runner.run(["update"], { cwd: "C:\\Notes", write: true }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.cancelCurrent(), true); await assert.rejects(write, svn.SvnCommandError); assert.equal(abortedByService, true);
});

test("调用方 AbortSignal 会终止 spawn 的具体进程", async () => {
  const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); let killed = false;
  process.kill = () => { killed = true; queueMicrotask(() => process.emit("close", 1)); return true; };
  const runner = new svn.SvnCommandRunner("svn.exe", { spawn: () => process }); const controller = new AbortController();
  const pending = runner.run(["status"], { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, svn.SvnCommandError); assert.equal(killed, true);
});

test("超时的写 executor 忽略 abort 时，后续写必须等待其真正结束", async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const started = [];
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: async (_exe, args) => {
    started.push(args[1]);
    if (args[1] === "first") await stalled;
    return { stdout: "", stderr: "", exitCode: 0 };
  } });
  await assert.rejects(() => runner.run(["update", "first"], { cwd: "C:\\Notes", write: true, timeoutMs: 1 }), svn.SvnCommandError);
  const second = runner.run(["update", "second"], { cwd: "C:\\Notes", write: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  release();
  await second;
  assert.deepEqual(started, ["first", "second"]);
});

test("恢复拒绝 realpath 指向工作副本外的 junction，且保留 cat 的原始字节", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 65]);
  const writes = [];
  const fs = {
    readFile: async () => "", writeFile: async (...args) => writes.push(args), directoryEntries: async () => [],
    realpath: async (value) => value === "C:\\Notes" ? "C:\\Canonical" : value === "C:\\Notes\\junction" ? "E:\\outside" : "C:\\Canonical",
  };
  const service = new svn.SvnWorkingCopyService(new FakeRunner([{ stdout: "", stdoutBytes: bytes, stderr: "", exitCode: 0 }]), fs);
  await assert.rejects(() => service.restore("C:\\Notes", "junction\\secret.bin", "1"), /工作副本/);
  assert.equal(writes.length, 0);
});

test("恢复将 cat 的二进制 stdoutBytes 原样写入", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 65]);
  const writes = [];
  const fs = { readFile: async () => "", writeFile: async (...args) => writes.push(args), directoryEntries: async () => [], realpath: async (value) => value.replace("C:\\Notes", "C:\\Canonical") };
  const service = new svn.SvnWorkingCopyService(new FakeRunner([{ stdout: "lossy", stdoutBytes: bytes, stderr: "", exitCode: 0 }]), fs);
  await service.restore("C:\\Notes", "asset.bin", "1");
  assert.deepEqual(Array.from(writes[0][1]), Array.from(bytes));
  assert.equal(writes[0][0], "C:\\Canonical\\asset.bin");
});

test("inspect 使用 svn:mime-type 将二进制冲突带入 UI snapshot", async () => {
  const runner = new FakeRunner([
    { stdout: '<info><entry><url>https://svn.example</url></entry></info>', stderr: "", exitCode: 0 },
    { stdout: '<status><target><entry path="image.bin"><wc-status item="conflicted"/></entry></target></status>', stderr: "", exitCode: 0 },
    { stdout: "application/octet-stream\n", stderr: "", exitCode: 0 },
  ]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  const scan = await service.inspect("C:\\Notes");
  assert.equal(svn.toSvnUiSnapshot(scan).conflicts[0].type, "binary");
  assert.deepEqual(runner.calls[2].args, ["propget", "svn:mime-type", "--", "image.bin"]);
});

test("executor 缺失 exitCode 会失败，日志会遮蔽等号密码与 URL 用户密码", async () => {
  const events = [];
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: async () => ({ stdout: "ok" }), onLog: (line) => events.push(line) });
  await assert.rejects(() => runner.run(["status"]), /exit code/i);
  const log = svn.sanitizeSvnLog(["--password=secret", "https://lin:secret@example.test/repo?access_token=abc"]);
  assert.equal(log.includes("secret"), false);
  assert.equal(log.includes("access_token=abc"), false);
});

test("复杂 CDATA 中的类似 closing tag 与未知实体不会被截断为成功 DTO", () => {
  assert.throws(() => svn.parseLogXml('<log><logentry revision="1"><msg><![CDATA[x]]></msg> tail ]]></msg></logentry></log>'), svn.SvnParseError);
  assert.throws(() => svn.parseLogXml('<log><logentry revision="1"><msg>bad &unknown;</msg></logentry></log>'), svn.SvnParseError);
});

test("spawn 流错误会拒绝命令，过长输出带有截断说明", async () => {
  const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter(); process.kill = () => true;
  const runner = new svn.SvnCommandRunner("svn.exe", { spawn: () => process });
  const pending = runner.run(["status"]); process.stdout.emit("error", new Error("stdout failed"));
  await assert.rejects(pending, /stdout failed/);
  const longRunner = new svn.SvnCommandRunner("svn.exe", { execute: async () => ({ stdout: "x".repeat(256 * 1024 + 1), stderr: "", exitCode: 0 }) });
  assert.match((await longRunner.run(["status"])).stdout, /\[SVN output truncated\]$/);
});

test("UI operation 参数脱敏 password、等号密码与 URL userinfo", () => {
  const snapshot = svn.toSvnUiSnapshot({ workingCopyPath: "C:\\Notes", repositoryUrl: "https://x", changes: [], conflicts: [] }, [], {
    args: ["commit", "--password", "secret", "--password=also-secret", "https://lin:pass@example.test/repo"], stdout: "", stderr: "", exitCode: 0,
  });
  assert.equal(snapshot.operation.args.includes("secret"), false);
  assert.equal(snapshot.operation.args.join(" ").includes("also-secret"), false);
  assert.equal(snapshot.operation.args.join(" ").includes("lin:pass@"), false);
});

test("合法 CDATA 中的 closing-tag 文本完整保留，非法数值实体抛 SvnParseError", () => {
  const logs = svn.parseLogXml('<log><logentry revision="1"><msg><![CDATA[literal </logentry> remains]]></msg></logentry></log>');
  assert.equal(logs[0].message, "literal </logentry> remains");
  assert.throws(() => svn.parseLogXml('<log><logentry revision="1"><msg>&#x110000;</msg></logentry></log>'), svn.SvnParseError);
  assert.throws(() => svn.parseLogXml('<log><logentry revision="1"><msg>&#-1;</msg></logentry></log>'), svn.SvnParseError);
});

test("checkout 与 import 在 URL/目录前放置 options 分隔符", async () => {
  const runner = new FakeRunner();
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [], ensureDirectory: async () => {} });
  await service.checkout("https://svn.example/repo", "C:\\New");
  await service.import("C:\\Source", "https://svn.example/repo", "import");
  assert.deepEqual(runner.calls[0].args, ["checkout", "--", "https://svn.example/repo", "C:\\New"]);
  assert.deepEqual(runner.calls[1].args, ["import", "-m", "import", "--", "C:\\Source", "https://svn.example/repo"]);
});

test("只有显式 captureStdoutBytes 才保留 runner 原始 stdoutBytes", async () => {
  const runner = new svn.SvnCommandRunner("svn.exe", { execute: async () => ({ stdout: "ok", stdoutBytes: Uint8Array.from([0, 255]), stderr: "", exitCode: 0 }) });
  assert.equal((await runner.run(["status"])).stdoutBytes, undefined);
  assert.deepEqual(Array.from((await runner.run(["cat"], { captureStdoutBytes: true })).stdoutBytes), [0, 255]);
});

test("changeset 差异使用 svn diff -c，原 revision 模式保持兼容", async () => {
  const runner = new FakeRunner([{ stdout: "change", stderr: "", exitCode: 0 }, { stdout: "range", stderr: "", exitCode: 0 }]);
  const service = new svn.SvnWorkingCopyService(runner, { readFile: async () => "", writeFile: async () => {}, directoryEntries: async () => [] });
  await service.diff("C:\\Notes", "note.md", "42", "changeset");
  await service.diff("C:\\Notes", "note.md", "41");
  assert.deepEqual(runner.calls[0].args, ["diff", "-c", "42", "--", "note.md"]);
  assert.deepEqual(runner.calls[1].args, ["diff", "-r", "41", "--", "note.md"]);
});

test("UI operation 输出同样脱敏 Authorization、URL userinfo 与 query secret", () => {
  const snapshot = svn.toSvnUiSnapshot({ workingCopyPath: "C:\\Notes", repositoryUrl: "https://x", changes: [], conflicts: [] }, [], {
    args: ["status"], stdout: "https://lin:secret@example.test/repo?token=abc", stderr: "Authorization: Basic dXNlcjpzZWNyZXQ=", exitCode: 1,
  });
  assert.equal(snapshot.operation.output.includes("secret"), false);
  assert.equal(snapshot.operation.output.includes("token=abc"), false);
  assert.equal(snapshot.operation.output.includes("dXNlcjpzZWNyZXQ="), false);
});

test("CDATA 原文本即使包含旧式占位符也不会被误恢复", () => {
  const logs = svn.parseLogXml('<log><logentry revision="1"><msg>__SVN_CDATA_0__<![CDATA[real]]></msg></logentry></log>');
  assert.equal(logs[0].message, "__SVN_CDATA_0__real");
});

test("sanitizeSvnLog 遮蔽任意 Authorization scheme 的完整凭据", () => {
  const value = svn.sanitizeSvnLog("Authorization: Bearer bearer-secret\nAuthorization: Digest username=lin, response=digest-secret");
  assert.equal(value.includes("bearer-secret"), false);
  assert.equal(value.includes("digest-secret"), false);
});
