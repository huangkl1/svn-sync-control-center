import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SvnErrorKind = "authentication" | "network" | "working-copy-locked" | "working-copy-damaged" | "conflict" | "timeout" | "not-working-copy" | "unknown";
export type SvnChangeKind = "added" | "modified" | "deleted" | "unversioned" | "conflict" | "missing" | "replaced" | "ignored" | "normal" | "unknown";
export type SvnDiffSummaryKind = "added" | "modified" | "deleted";

export interface SvnCommandResult { args: string[]; cwd?: string; stdout: string; stderr: string; stdoutBytes?: Uint8Array; exitCode: number; }
export interface SvnRunOptions { cwd?: string; timeoutMs?: number; write?: boolean; signal?: AbortSignal; captureStdoutBytes?: boolean; maxOutputChars?: number; }
export interface SvnCommandExecutor { (executable: string, args: string[], options: SvnRunOptions): Promise<Partial<SvnCommandResult>>; }
export interface SvnCommandRunnerLike { run(args: string[], options?: SvnRunOptions): Promise<SvnCommandResult>; cancelCurrent(): boolean; }
export interface SvnProcess { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null; on(event: "error" | "close", listener: (...args: any[]) => void): this; kill(signal?: NodeJS.Signals | number): boolean; }
export interface SvnSpawn { (command: string, args: readonly string[], options: { cwd?: string; shell: false; windowsHide: true }): SvnProcess; }
export interface SvnDiffSummaryFile { path: string; kind: SvnDiffSummaryKind; }

export class SvnCommandError extends Error {
  readonly result: SvnCommandResult;
  constructor(result: SvnCommandResult) { super(result.stderr || result.stdout || `SVN command failed with exit code ${result.exitCode}`); this.name = "SvnCommandError"; this.result = result; }
}

const MAX_COMMAND_OUTPUT = 256 * 1024;
const MAX_STRUCTURED_XML_OUTPUT = 8 * 1024 * 1024;
function truncateOutput(value: string, limit = MAX_COMMAND_OUTPUT): string { return value.length <= limit ? value : `${value.slice(0, limit)}\n[SVN output truncated]`; }
function appendOutput(current: string, chunk: string): string { if (current.includes("\n[SVN output truncated]")) return current; const remaining = MAX_COMMAND_OUTPUT - current.length; return chunk.length <= remaining ? current + chunk : `${current}${chunk.slice(0, Math.max(0, remaining))}\n[SVN output truncated]`; }

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8LossyDecoder = new TextDecoder("utf-8");
const gb18030Decoder = new TextDecoder("gb18030");
const REPLACEMENT_CHARACTER = "\uFFFD";
const MIN_GB18030_REPLACEMENTS = 2;
const MIN_GB18030_REPLACEMENT_RATIO = 0.02;

function replacementCount(value: string): number { return Array.from(value).filter((character) => character === REPLACEMENT_CHARACTER).length; }

function decodeSvnTextBytes(value: Uint8Array): string {
  if (!value.length) return "";
  if (value[0] === 0xff && value[1] === 0xfe) return new TextDecoder("utf-16le").decode(value);
  if (value[0] === 0xfe && value[1] === 0xff) return new TextDecoder("utf-16be").decode(value);
  if (value[0] === 0xef && value[1] === 0xbb && value[2] === 0xbf) return new TextDecoder("utf-8").decode(value);
  const declaration = new TextDecoder("ascii").decode(value.slice(0, 256)).toLowerCase();
  if (/encoding\s*=\s*["']utf-16le["']/.test(declaration)) return new TextDecoder("utf-16le").decode(value);
  if (/encoding\s*=\s*["']utf-16be["']/.test(declaration)) return new TextDecoder("utf-16be").decode(value);
  if (/encoding\s*=\s*["'](?:gb2312|gbk|gb18030)["']/.test(declaration)) return gb18030Decoder.decode(value);
  try { return utf8Decoder.decode(value); }
  catch {
    const utf8 = utf8LossyDecoder.decode(value);
    const gb18030 = gb18030Decoder.decode(value);
    const utf8Replacements = replacementCount(utf8);
    const gb18030Replacements = replacementCount(gb18030);
    const replacementRatio = utf8Replacements / Math.max(1, Array.from(utf8).length);
    const gb18030IsBetter = gb18030Replacements < utf8Replacements;
    return utf8Replacements >= MIN_GB18030_REPLACEMENTS && replacementRatio >= MIN_GB18030_REPLACEMENT_RATIO && gb18030IsBetter ? gb18030 : utf8;
  }
}

function decodeSvnDiffBytes(value: Uint8Array): string {
  let decoded = "";
  let lineStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0x0a) continue;
    const hasCarriageReturn = index > lineStart && value[index - 1] === 0x0d;
    const lineEnd = hasCarriageReturn ? index - 1 : index;
    decoded += decodeSvnTextBytes(value.slice(lineStart, lineEnd));
    decoded += hasCarriageReturn ? "\r\n" : "\n";
    lineStart = index + 1;
  }
  if (lineStart < value.length) decoded += decodeSvnTextBytes(value.slice(lineStart));
  return decoded;
}

export function decodeSvnOutput(value: string | Uint8Array, options: { kind?: "text" | "diff" } = {}): string {
  if (typeof value === "string") return value;
  return options.kind === "diff" ? decodeSvnDiffBytes(value) : decodeSvnTextBytes(value);
}

/** Redacts command logging; execution always receives the original argument array. */
export function sanitizeSvnLog(value: string | string[]): string {
  const args = sanitizeSvnArgs(Array.isArray(value) ? value : value.split(/\s+/));
  return args.join(" ")
    .replace(/(Authorization\s*:\s*)[^\r\n]*/gi, "$1***");
}
function sanitizeSvnArgs(value: string[]): string[] { const args = value.slice(); for (let i = 0; i < args.length; i += 1) { if (args[i] === "--password") args[i + 1] = "***"; else if (/^--password=/i.test(args[i])) args[i] = "--password=***"; args[i] = args[i].replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://***:***@").replace(/([?&](?:token|access_token|password|passwd|key|signature|sig)=)[^&#\s]*/gi, "$1***"); } return args; }

export class SvnCommandRunner implements SvnCommandRunnerLike {
  private readonly writes = new Map<string, Promise<void>>();
  private activeWrite?: SvnProcess;
  private activeWriteAbort?: AbortController;
  private readonly executable: string;
  private readonly spawn: SvnSpawn;
  private readonly execute?: SvnCommandExecutor;
  private readonly onLog?: (line: string) => void;
  constructor(executable: string, options: { spawn?: SvnSpawn; execute?: SvnCommandExecutor; onLog?: (line: string) => void } = {}) {
    this.executable = executable; this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as unknown as SvnProcess); this.execute = options.execute; this.onLog = options.onLog;
  }
  run(args: string[], options: SvnRunOptions = {}): Promise<SvnCommandResult> {
    const invoke = () => this.runImmediately(args, options);
    if (!options.write || !options.cwd) return invoke();
    const key = path.resolve(options.cwd).toLowerCase();
    const previous = this.writes.get(key) ?? Promise.resolve();
    let settled: Promise<void> = Promise.resolve();
    const next = previous.catch(() => undefined).then(() => { const operation = invoke(); settled = (operation as Promise<SvnCommandResult> & { settled?: Promise<void> }).settled ?? operation.then(() => undefined, () => undefined); return operation; });
    const lock = next.then(() => settled, () => settled).then(() => undefined, () => undefined);
    this.writes.set(key, lock);
    void lock.finally(() => { if (this.writes.get(key) === lock) this.writes.delete(key); });
    return next;
  }
  cancelCurrent(): boolean { const aborted = this.activeWriteAbort ? (this.activeWriteAbort.abort(), true) : false; const killed = this.activeWrite ? this.activeWrite.kill("SIGTERM") : false; return aborted || killed; }
  private runImmediately(args: string[], options: SvnRunOptions): Promise<SvnCommandResult> {
    this.onLog?.(sanitizeSvnLog([this.executable, ...args]));
    const raw = this.execute ? this.executeWithTimeout(args, options) : this.spawnCommand(args, options);
    const completed = raw.then((result) => {
      if (typeof result.exitCode !== "number") throw new Error("SVN executor did not return an exit code.");
      const outputLimit = options.maxOutputChars ?? MAX_COMMAND_OUTPUT;
      const output: SvnCommandResult = { args: [...args], cwd: options.cwd, stdout: truncateOutput(result.stdout ?? (result.stdoutBytes ? decodeSvnOutput(result.stdoutBytes, args[0] === "diff" ? { kind: "diff" } : undefined) : ""), outputLimit), stderr: truncateOutput(result.stderr ?? "", outputLimit), ...(options.captureStdoutBytes && result.stdoutBytes ? { stdoutBytes: result.stdoutBytes } : {}), exitCode: result.exitCode };
      if (output.exitCode !== 0) throw new SvnCommandError(output);
      return output;
    }) as Promise<SvnCommandResult> & { settled?: Promise<void> };
    completed.settled = (raw as Promise<Partial<SvnCommandResult>> & { settled?: Promise<void> }).settled ?? completed.then(() => undefined, () => undefined);
    return completed;
  }
  private executeWithTimeout(args: string[], options: SvnRunOptions): Promise<Partial<SvnCommandResult>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(); const forwardAbort = () => controller.abort(); options.signal?.addEventListener("abort", forwardAbort, { once: true }); if (options.signal?.aborted) controller.abort(); const context = { ...options, signal: controller.signal }; if (options.write) this.activeWriteAbort = controller;
    let execution: Promise<Partial<SvnCommandResult>>;
    try { execution = Promise.resolve(this.execute!(this.executable, args, context)); } catch (error) { execution = Promise.reject(error); }
    const settled = execution.then(() => undefined, () => undefined).finally(() => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", forwardAbort); if (this.activeWriteAbort === controller) this.activeWriteAbort = undefined; });
    const result = !options.timeoutMs || options.timeoutMs <= 0 ? execution : Promise.race([execution, new Promise<Partial<SvnCommandResult>>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ stdout: "", stderr: "Command timed out", exitCode: 124 }); }, options.timeoutMs); })]);
    (result as Promise<Partial<SvnCommandResult>> & { settled?: Promise<void> }).settled = settled;
    return result;
  }
  private spawnCommand(args: string[], options: SvnRunOptions): Promise<Partial<SvnCommandResult>> {
    return new Promise((resolve, reject) => {
      const process = this.spawn(this.executable, args, { cwd: options.cwd, shell: false, windowsHide: true });
      const abort = () => process.kill("SIGTERM"); options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
      if (options.write) this.activeWrite = process;
      const stdoutBytes: Buffer[] = []; const stderrBytes: Buffer[] = []; let timer: ReturnType<typeof setTimeout> | undefined; let timedOut = false; let finished = false;
      const finish = (error?: Error, result?: Partial<SvnCommandResult>) => { if (finished) return; finished = true; if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (this.activeWrite === process) this.activeWrite = undefined; if (error) reject(error); else resolve(result!); };
      const collect = (stream: NodeJS.ReadableStream | null | undefined, bytes: Buffer[]) => { stream?.on("data", (chunk: Buffer | string) => { bytes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }); stream?.on("error", (error: Error) => finish(error)); };
      collect(process.stdout, stdoutBytes); collect(process.stderr, stderrBytes);
      if (options.timeoutMs && options.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; process.kill("SIGTERM"); }, options.timeoutMs);
      process.on("error", (error: Error) => finish(error));
      process.on("close", (code: number | null) => { const stdout = decodeSvnOutput(Buffer.concat(stdoutBytes), args[0] === "diff" ? { kind: "diff" } : undefined); const stderr = decodeSvnOutput(Buffer.concat(stderrBytes)); const outputLimit = options.maxOutputChars ?? MAX_COMMAND_OUTPUT; finish(undefined, { stdout: truncateOutput(stdout, outputLimit), ...(options.captureStdoutBytes ? { stdoutBytes: Buffer.concat(stdoutBytes) } : {}), stderr: timedOut ? `${stderr}\nCommand timed out`.trim() : truncateOutput(stderr, outputLimit), exitCode: timedOut ? 124 : code ?? 1 }); });
    });
  }
}

export interface SvnClientInfo { found: boolean; executable?: string; source?: "configured" | "path" | "tortoisesvn" | "sliksvn"; version?: string; diagnostics: string[]; }
export interface SvnProbe { run(executable: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>; }
const defaultProbe: SvnProbe = { run: async (executable, args) => new SvnCommandRunner(executable).run(args) };
export class SvnClientLocator {
  private readonly exists: (candidate: string) => Promise<boolean>;
  private readonly probe: SvnProbe;
  private readonly candidates?: string[];
  constructor(options: { pathExists?: (candidate: string) => Promise<boolean>; run?: SvnProbe["run"]; pathCandidates?: string[] } = {}) { this.exists = options.pathExists ?? (async (candidate) => fs.stat(candidate).then(() => true).catch(() => false)); this.probe = { run: options.run ?? defaultProbe.run }; this.candidates = options.pathCandidates; }
  async locate(configuredPath?: string): Promise<SvnClientInfo> {
    const diagnostics: string[] = [];
    if (configuredPath?.trim()) { const found = await this.fromConfigured(configuredPath.trim(), diagnostics); if (found) return found; }
    try {
      const where = await this.probe.run("where.exe", ["svn.exe"]);
      const candidates = where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (where.exitCode === 0 && candidates.length) { for (const candidate of candidates) { const verified = await this.verify(candidate, "path", diagnostics); if (verified) return verified; } }
      else diagnostics.push("PATH 中未检测到 svn.exe。");
    } catch { diagnostics.push("无法通过 PATH 探测 svn.exe。"); }
    for (const candidate of this.candidates ?? defaultCandidates()) { if (await this.exists(candidate)) { const source = /TortoiseSVN/i.test(candidate) ? "tortoisesvn" : "sliksvn"; const verified = await this.verify(candidate, source, diagnostics); if (verified) return verified; } }
    return { found: false, diagnostics };
  }
  private async fromConfigured(configured: string, diagnostics: string[]): Promise<SvnClientInfo | undefined> {
    const direct = /svn\.exe$/i.test(configured) ? configured : undefined;
    const choices = direct ? [direct] : [path.join(configured, "svn.exe"), path.join(configured, "bin", "svn.exe")];
    for (const candidate of choices) if (await this.exists(candidate)) return this.verify(candidate, "configured", diagnostics);
    diagnostics.push(`配置的 SVN 路径不可用：${configured}`); return undefined;
  }
  private async verify(executable: string, source: NonNullable<SvnClientInfo["source"]>, diagnostics: string[]): Promise<SvnClientInfo | undefined> {
    try { const result = await this.probe.run(executable, ["--version", "--quiet"]); if (result.exitCode === 0) return { found: true, executable, source, version: result.stdout.trim(), diagnostics }; diagnostics.push(`${executable} 无法执行：${result.stderr || "未知错误"}`); } catch (error) { diagnostics.push(`${executable} 无法执行：${error instanceof Error ? error.message : String(error)}`); }
    return undefined;
  }
}
function defaultCandidates(): string[] { const programFiles = process.env.ProgramFiles ?? "C:\\Program Files"; const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"; return [path.join(programFiles, "TortoiseSVN", "bin", "svn.exe"), path.join(programFilesX86, "TortoiseSVN", "bin", "svn.exe"), path.join(programFiles, "SlikSvn", "bin", "svn.exe"), path.join(programFilesX86, "SlikSvn", "bin", "svn.exe")]; }

export interface SvnInfo { repositoryUrl: string; repositoryRoot?: string; workingCopyPath?: string; revision?: string; }
export interface SvnStatusEntry { path: string; kind: SvnChangeKind; rawItem: string; conflicted: boolean; binary?: boolean; }
export interface SvnStatus { entries: SvnStatusEntry[]; conflicts: SvnStatusEntry[]; }
export interface SvnHistoryEntry { revision: string; author: string; time: string; message: string; files: string[]; }
export interface SvnDiffSide { lineNumber?: number; text: string; kind: "context" | "added" | "deleted"; }
export interface SvnDiffRow { kind: "context" | "added" | "deleted" | "modified"; left?: SvnDiffSide; right?: SvnDiffSide; }
export interface SvnFileDiff { status: "modified" | "added" | "deleted" | "binary" | "empty"; rows: SvnDiffRow[]; message?: string; }
export interface SvnRevisionDiffFile { path: string; diff: SvnFileDiff; }
export interface SvnRevisionDiff { files: SvnRevisionDiffFile[]; }
export interface SvnUiSnapshot { workingCopyPath: string; repositoryUrl: string; changes: Array<{ id: string; path: string; kind: "added" | "modified" | "deleted" | "unversioned" | "conflict"; selected: boolean }>; conflicts: Array<{ id: string; path: string; type: "text" | "binary"; occurredAt: string; resolved: boolean }>; history: SvnHistoryEntry[]; operation?: { args: string[]; cwd?: string; output: string; exitCode: number }; }
export class SvnParseError extends Error { constructor(message: string) { super(message); this.name = "SvnParseError"; } }
function validateXmlStructure(xml: string): void {
  const withoutCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!\[CDATA|\]\]>/i.test(withoutCdata) || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(withoutCdata)) throw new SvnParseError("SVN XML 包含不支持的实体或 CDATA 结构。");
  const source = withoutCdata.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, ""); const stack: string[] = [];
  for (const match of source.matchAll(/<\/?([\w:-]+)(?:\s[^<>]*)?\/?\s*>/g)) { const raw = match[0]; const name = match[1]; if (raw.startsWith("</")) { if (stack.pop() !== name) throw new SvnParseError("SVN XML 标签嵌套不完整。"); } else if (!/\/\s*>$/.test(raw)) stack.push(name); }
  if (stack.length) throw new SvnParseError("SVN XML 标签嵌套不完整。");
}
function requireXmlRoot(xml: string, root: string): void { const source = xml.replace(/^\uFEFF/, "").trim().replace(/^<\?xml[\s\S]*?\?>\s*/i, "").replace(/^(?:<!--(?:[\s\S]*?)-->\s*)+/, ""); validateXmlStructure(source); if (!new RegExp(`^<${root}(?:\\s[^>]*)?>[\\s\\S]*<\\/${root}>$`, "i").test(source)) throw new SvnParseError(`无效或不完整的 SVN ${root} XML。`); }
function protectCdata(xml: string): { xml: string; restore(value: string | undefined): string | undefined } { const values: string[] = []; let nonce = 0; let prefix = ""; do { prefix = `\uE000SVN_CDATA_${nonce++}_`; } while (xml.includes(prefix)); const suffix = "\uE001"; const token = (index: number) => `${prefix}${index}${suffix}`; return { xml: xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, value: string) => token(values.push(value) - 1)), restore: (value) => value?.replace(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)${suffix}`, "g"), (_, index: string) => values[Number(index)] ?? "") }; }
function decodeCodePoint(value: number): string { if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new SvnParseError("SVN XML 包含无效数值实体。"); return String.fromCodePoint(value); }
export function decodeXml(value: string): string { const namedEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }; return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, decimal: string) => decodeCodePoint(parseInt(decimal, 10))).replace(/&(amp|lt|gt|quot|apos);/g, (_, named: string) => namedEntities[named]); }
function attrs(openTag: string): Record<string, string> { const values: Record<string, string> = {}; for (const match of openTag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) values[match[1]] = decodeXml(match[3]); return values; }
function element(body: string, name: string): string | undefined { const match = body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); return match ? decodeXml(match[1].trim()) : undefined; }
export function parseInfoXml(xml: string): SvnInfo {
  const protectedXml = protectCdata(xml); xml = protectedXml.xml; requireXmlRoot(xml, "info");
  const entry = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/i)?.[0] ?? ""; const opening = entry.match(/<entry\b[^>]*>/i)?.[0] ?? "";
  if (!entry || !element(entry, "url")) throw new SvnParseError("SVN info XML 缺少工作副本条目或仓库地址。");
  return { repositoryUrl: protectedXml.restore(element(entry, "url")) ?? "", repositoryRoot: protectedXml.restore(element(entry, "root")), workingCopyPath: protectedXml.restore(element(entry, "wcroot-abspath")), revision: attrs(opening).revision };
}
const statusKind: Record<string, SvnChangeKind> = { added: "added", modified: "modified", deleted: "deleted", unversioned: "unversioned", conflicted: "conflict", missing: "missing", replaced: "replaced", ignored: "ignored", normal: "normal", incomplete: "unknown", obstructed: "unknown", external: "unknown", none: "unknown" };
export function parseStatusXml(xml: string): SvnStatus {
  const protectedXml = protectCdata(xml); xml = protectedXml.xml; requireXmlRoot(xml, "status");
  const entries: SvnStatusEntry[] = []; for (const match of xml.matchAll(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi)) { const whole = match[0]; const entryOpen = whole.match(/<entry\b[^>]*>/i)?.[0] ?? ""; const wc = whole.match(/<wc-status\b[^>]*?(?:\/>|>[\s\S]*?<\/wc-status>)/i)?.[0] ?? ""; const wcOpen = wc.match(/<wc-status\b[^>]*>/i)?.[0] ?? ""; const rawItem = attrs(wcOpen).item ?? "unknown"; const conflicted = rawItem === "conflicted" || /<(tree-conflict|conflict)\b/i.test(wc); entries.push({ path: protectedXml.restore(attrs(entryOpen).path) ?? "", kind: conflicted ? "conflict" : statusKind[rawItem] ?? "unknown", rawItem, conflicted }); }
  return { entries, conflicts: entries.filter((entry) => entry.conflicted) };
}
export function parseLogXml(xml: string): SvnHistoryEntry[] { const protectedXml = protectCdata(xml); xml = protectedXml.xml; requireXmlRoot(xml, "log"); return Array.from(xml.matchAll(/<logentry\b[^>]*>[\s\S]*?<\/logentry>/gi), (match) => { const whole = match[0]; const open = whole.match(/<logentry\b[^>]*>/i)?.[0] ?? ""; const files = Array.from(whole.matchAll(/<path\b[^>]*>([\s\S]*?)<\/path>/gi), (pathMatch) => protectedXml.restore(decodeXml(pathMatch[1].trim())) ?? ""); return { revision: attrs(open).revision ?? "", author: protectedXml.restore(element(whole, "author")) ?? "", time: protectedXml.restore(element(whole, "date")) ?? "", message: protectedXml.restore(element(whole, "msg")) ?? "", files }; }); }
function diffHeaderNumber(value: string | undefined, fallback: number): { start: number; count: number } { const match = value?.match(/^(\d+)(?:,(\d+))?/); return { start: Number(match?.[1] ?? fallback), count: Number(match?.[2] ?? 1) }; }
export function parseUnifiedDiff(diff: string, changeKind?: "added" | "modified" | "deleted" | "unversioned" | "conflict"): SvnFileDiff {
  const source = diff.replace(/\r\n/g, "\n");
  if (!source.trim()) return { status: "empty", rows: [], message: "当前文件没有可显示的差异。" };
  if (/^\s*(?:Binary files?.*\bdiffer\b|Cannot display:\s*file marked as a binary type\.?)\s*$/im.test(source)) return { status: "binary", rows: [], message: "该文件为二进制文件，SVN 不提供文本差异。" };
  const lines = source.split("\n");
  const rows: SvnDiffRow[] = [];
  let leftLine = 0; let rightLine = 0;
  let pendingDeleted: SvnDiffSide[] = []; let pendingAdded: SvnDiffSide[] = []; let inHunk = false;
  const flush = () => {
    const count = Math.max(pendingDeleted.length, pendingAdded.length);
    for (let index = 0; index < count; index += 1) {
      const left = pendingDeleted[index]; const right = pendingAdded[index];
      rows.push({ kind: left && right ? "modified" : left ? "deleted" : "added", ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
    pendingDeleted = []; pendingAdded = [];
  };
  for (const line of lines) {
    const hunk = line.match(/^@@ -([^ ]+) \+([^ ]+) @@/);
    if (hunk) { flush(); inHunk = true; leftLine = diffHeaderNumber(hunk[1], 1).start; rightLine = diffHeaderNumber(hunk[2], 1).start; continue; }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("-")) { pendingDeleted.push({ lineNumber: leftLine, text: line.slice(1), kind: "deleted" }); leftLine += 1; continue; }
    if (line.startsWith("+")) { pendingAdded.push({ lineNumber: rightLine, text: line.slice(1), kind: "added" }); rightLine += 1; continue; }
    if (line.startsWith(" ")) { flush(); rows.push({ kind: "context", left: { lineNumber: leftLine, text: line.slice(1), kind: "context" }, right: { lineNumber: rightLine, text: line.slice(1), kind: "context" } }); leftLine += 1; rightLine += 1; }
  }
  flush();
  const status = changeKind === "added" ? "added" : changeKind === "deleted" ? "deleted" : "modified";
  return rows.length ? { status, rows } : { status: "empty", rows: [], message: "当前文件没有可显示的差异。" };
}
function diffPathFromHeaders(source: string): string {
  const header = source.match(/^---\s+(.+?)(?:\t+|\s+\(revision\b|\s+\(working copy\b)/m)?.[1]?.trim() ?? source.match(/^---\s+(.+)$/m)?.[1]?.trim();
  return header?.replace(/^a\//, "").replace(/^b\//, "") ?? "未知文件";
}
export function parseUnifiedDiffFiles(diff: string): SvnRevisionDiff {
  const source = diff.replace(/\r\n/g, "\n");
  const indexes = Array.from(source.matchAll(/^Index:\s+(.+)$/gm));
  if (!indexes.length) return { files: [{ path: diffPathFromHeaders(source), diff: parseUnifiedDiff(source) }] };
  const files: SvnRevisionDiffFile[] = [];
  indexes.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = indexes[index + 1]?.index ?? source.length;
    const pathName = match[1].trim();
    const body = source.slice(start, end);
    const kind = /@@\s+-0(?:,0)?\s+\+\d/.test(body) ? "added" : /@@\s+-\d+(?:,\d+)?\s+\+0(?:,0)?/.test(body) ? "deleted" : undefined;
    const parsed = parseUnifiedDiff(body, kind);
    files.push({ path: pathName, diff: parsed });
  });
  return { files };
}
export function parseSvnDiffSummary(output: string): SvnDiffSummaryFile[] {
  return output.replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    const match = line.match(/^\s*([MADRU])\s+(.+?)\s*$/i);
    if (!match) return [];
    const code = match[1].toUpperCase();
    const kind: SvnDiffSummaryKind = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    const pathName = match[2].trim();
    return pathName ? [{ path: pathName, kind }] : [];
  });
}
/** Structural DTO only: it intentionally does not import Obsidian UI types. */
export function toSvnUiSnapshot(scan: { workingCopyPath: string; repositoryUrl: string; changes: SvnStatusEntry[]; conflicts: SvnStatusEntry[] }, history: SvnHistoryEntry[] = [], operation?: SvnCommandResult): SvnUiSnapshot {
  const uiKind = (kind: SvnChangeKind): SvnUiSnapshot["changes"][number]["kind"] => kind === "added" || kind === "deleted" || kind === "unversioned" || kind === "conflict" ? kind : "modified";
  return { workingCopyPath: scan.workingCopyPath, repositoryUrl: scan.repositoryUrl, changes: scan.changes.map((entry) => { const kind = uiKind(entry.kind); return { id: entry.path, path: entry.path, kind, selected: kind !== "unversioned" && kind !== "conflict" }; }), conflicts: scan.conflicts.map((entry) => ({ id: entry.path, path: entry.path, type: entry.binary ? "binary" : "text", occurredAt: "", resolved: false })), history, ...(operation ? { operation: { args: sanitizeSvnArgs(operation.args), cwd: operation.cwd, output: sanitizeSvnLog(`${operation.stdout}${operation.stderr ? `\n${operation.stderr}` : ""}`).trim(), exitCode: operation.exitCode } } : {}) };
}
export function classifySvnError(value: unknown): SvnErrorKind { const text = (value instanceof SvnCommandError ? `${value.result.stderr}\n${value.result.stdout}` : value instanceof Error ? value.message : String(value)).toLowerCase(); if (/timed out|timeout/.test(text)) return "timeout"; if (/e155007|not a working copy|不是.*工作副本/.test(text)) return "not-working-copy"; if (/authenti|e170001|authorization failed/.test(text)) return "authentication"; if (/working copy.*locked|e155004|e155009/.test(text)) return "working-copy-locked"; if (/working copy.*(corrupt|damaged)|e1550(04|10)/.test(text)) return "working-copy-damaged"; if (/conflict|e155015/.test(text)) return "conflict"; if (/network|hostname|connection|e170013|e730054/.test(text)) return "network"; return "unknown"; }
export class SvnServiceError extends Error { readonly workingCopyMetadataPresent: boolean; constructor(public readonly kind: SvnErrorKind, public readonly cause: unknown, details: { workingCopyMetadataPresent?: boolean } = {}) { super(cause instanceof Error ? cause.message : String(cause)); this.name = "SvnServiceError"; this.workingCopyMetadataPresent = details.workingCopyMetadataPresent === true; } }
function xmlParseDiagnostic(stage: "info" | "status", workingCopy: string, output: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const preview = output.replace(/\0/g, "\\0").trim().slice(0, 8192) || "(空输出)";
  return new Error(`${reason}\nXML 阶段：${stage}\n工作目录：${workingCopy}\n${stage} 输出：${preview}`);
}
export interface SvnFileSystem { readFile(file: string): Promise<string>; writeFile(file: string, contents: string | Uint8Array): Promise<void>; directoryEntries(directory: string): Promise<string[]>; realpath(file: string): Promise<string>; ensureDirectory?(directory: string): Promise<void>; removeDirectory?(directory: string): Promise<void>; }
const defaultFileSystem: SvnFileSystem = { readFile: (file) => fs.readFile(file, "utf8"), writeFile: (file, contents) => fs.writeFile(file, contents), directoryEntries: (directory) => fs.readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)), realpath: (file) => fs.realpath(file), ensureDirectory: (directory) => fs.mkdir(directory, { recursive: true }).then(() => undefined), removeDirectory: (directory) => fs.rm(directory, { recursive: true, force: true }) };
export interface SvnCredentials { username?: string; password?: string; }
function authArgs(credentials?: SvnCredentials): string[] { if (!credentials?.username && !credentials?.password) return []; const result = ["--non-interactive"]; if (credentials.username) result.push("--username", credentials.username); if (credentials.password) result.push("--password", credentials.password); return result; }
function required(value: string, message: string): string { if (!value.trim()) throw new Error(message); return value; }
function rejectMarkers(text: string): void { if (/^\s*(<{7}|\|{7}|={7}|>{7})/m.test(text)) throw new Error("合并结果仍包含冲突标记，请先完成合并。"); }
function safeWorkingCopyFile(workingCopy: string, file: string): string { if (!file || path.isAbsolute(file)) throw new Error("文件路径必须位于工作副本内。"); const root = path.resolve(workingCopy); const candidate = path.resolve(root, file); if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error("文件路径必须位于工作副本内。"); return candidate; }
async function canonicalWorkingCopyFile(fileSystem: SvnFileSystem, workingCopy: string, file: string): Promise<string> {
  const candidate = safeWorkingCopyFile(workingCopy, file);
  const root = await fileSystem.realpath(path.resolve(workingCopy));
  let existingParent = path.dirname(candidate);
  while (true) {
    try {
      const canonicalParent = await fileSystem.realpath(existingParent);
      const target = path.join(canonicalParent, path.relative(existingParent, candidate));
      const canonicalRoot = path.resolve(root);
      if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("文件路径必须位于工作副本内。");
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existingParent === path.dirname(existingParent)) throw error;
      existingParent = path.dirname(existingParent);
    }
  }
}
function propertyIsAbsent(error: unknown): boolean { const text = error instanceof Error ? error.message : String(error); return /property.*not found|no such property|e200017/i.test(text); }
export class SvnWorkingCopyService {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly timeoutMs?: number;
  private readonly authCacheDirectory: string;
  constructor(private readonly runner: SvnCommandRunnerLike, private readonly fileSystem: SvnFileSystem = defaultFileSystem, options: { timeoutMs?: number; authCacheDirectory?: string; approvedSubversionRoot?: string } = {}) { this.timeoutMs = options.timeoutMs; const expected = options.approvedSubversionRoot ? path.join(options.approvedSubversionRoot, "auth") : path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Roaming"), "Subversion", "auth"); this.authCacheDirectory = path.resolve(options.authCacheDirectory ?? expected); if (this.authCacheDirectory !== path.resolve(expected)) throw new Error("认证缓存目录必须是 %APPDATA%\\Subversion\\auth 或批准的 Subversion 根目录下 auth。"); }
  cancelCurrent(): boolean { return this.runner.cancelCurrent(); }
  async inspect(workingCopy: string): Promise<{ workingCopyPath: string; repositoryUrl: string; info: SvnInfo; changes: SvnStatusEntry[]; conflicts: SvnStatusEntry[]; workingCopyMetadataPresent: boolean }> { const entries = await this.fileSystem.directoryEntries(workingCopy).catch(() => []); const workingCopyMetadataPresent = entries.some((entry) => path.basename(entry).toLowerCase() === ".svn"); try { const [infoResult, statusResult] = await Promise.all([this.runner.run(["info", "--xml"], { cwd: workingCopy, timeoutMs: this.timeoutMs, maxOutputChars: MAX_STRUCTURED_XML_OUTPUT }), this.runner.run(["status", "--xml"], { cwd: workingCopy, timeoutMs: this.timeoutMs, maxOutputChars: MAX_STRUCTURED_XML_OUTPUT })]); let info: SvnInfo; let status: SvnStatus; try { info = parseInfoXml(infoResult.stdout); } catch (error) { throw new SvnServiceError("unknown", xmlParseDiagnostic("info", workingCopy, infoResult.stdout, error), { workingCopyMetadataPresent }); } try { status = parseStatusXml(statusResult.stdout); } catch (error) { throw new SvnServiceError("unknown", xmlParseDiagnostic("status", workingCopy, statusResult.stdout, error), { workingCopyMetadataPresent }); } for (const entry of status.conflicts) { try { const mime = (await this.runner.run(["propget", "svn:mime-type", "--", entry.path], { cwd: workingCopy, timeoutMs: this.timeoutMs })).stdout.trim(); entry.binary = Boolean(mime) && !/^text\//i.test(mime); } catch (error) { if (!propertyIsAbsent(error)) throw error; } } return { workingCopyPath: info.workingCopyPath ?? workingCopy, repositoryUrl: info.repositoryUrl, info, changes: status.entries.filter((entry) => entry.kind !== "normal"), conflicts: status.conflicts, workingCopyMetadataPresent }; } catch (error) { if (error instanceof SvnServiceError) throw error; throw new SvnServiceError(classifySvnError(error), error, { workingCopyMetadataPresent }); } }
  async update(workingCopy: string, credentials?: SvnCredentials): Promise<SvnCommandResult> { return this.write(["update", ...authArgs(credentials)], workingCopy); }
  async add(workingCopy: string, paths: string[]): Promise<SvnCommandResult> { if (!paths.length) throw new Error("请至少选择一个加入版本控制的文件。"); paths.forEach((file) => safeWorkingCopyFile(workingCopy, file)); return this.write(["add", "--", ...paths], workingCopy); }
  async commit(workingCopy: string, paths: string[], message: string, credentials?: SvnCredentials): Promise<SvnCommandResult> { if (!paths.length) throw new Error("请至少选择一个提交文件。"); paths.forEach((file) => safeWorkingCopyFile(workingCopy, file)); return this.write(["commit", "-m", message.trim(), ...authArgs(credentials), "--", ...paths], workingCopy); }
  async cleanup(workingCopy: string): Promise<SvnCommandResult> { return this.write(["cleanup"], workingCopy); }
  async checkout(repositoryUrl: string, targetDirectory: string, credentials?: SvnCredentials): Promise<SvnCommandResult> { required(repositoryUrl, "仓库地址不能为空。"); required(targetDirectory, "检出目标目录不能为空。"); return this.withWriteLock(targetDirectory, async () => { if ((await this.fileSystem.directoryEntries(targetDirectory)).length) throw new Error("检出目标目录非空；必须使用新建目录或空目录。"); await this.fileSystem.ensureDirectory?.(targetDirectory); if ((await this.fileSystem.directoryEntries(targetDirectory)).length) throw new Error("检出目标目录非空；必须使用新建目录或空目录。"); return this.directWrite(["checkout", ...authArgs(credentials), "--", repositoryUrl, targetDirectory], targetDirectory); }); }
  async import(sourceDirectory: string, repositoryUrl: string, message: string, credentials?: SvnCredentials): Promise<SvnCommandResult> { return this.write(["import", "-m", required(message, "导入说明不能为空。"), ...authArgs(credentials), "--", sourceDirectory, required(repositoryUrl, "仓库地址不能为空。")], sourceDirectory); }
  async history(workingCopy: string, target = "."): Promise<SvnHistoryEntry[]> { if (target !== ".") safeWorkingCopyFile(workingCopy, target); return parseLogXml((await this.run(["log", "--xml", "-v", "-r", "HEAD:1", "--", target], workingCopy, false, MAX_STRUCTURED_XML_OUTPUT)).stdout); }
  async fileHistory(workingCopy: string, file: string): Promise<SvnHistoryEntry[]> { safeWorkingCopyFile(workingCopy, file); return this.history(workingCopy, file); }
  async diff(workingCopy: string, target = ".", revision?: string, mode: "revision" | "changeset" = "revision"): Promise<string> { if (target !== ".") safeWorkingCopyFile(workingCopy, target); const args = ["diff"]; if (revision) args.push(mode === "changeset" ? "-c" : "-r", revision); args.push("--", target); return (await this.run(args, workingCopy)).stdout; }
  async diffBetweenRevisions(workingCopy: string, fromRevision: string, toRevision: string): Promise<string> { const from = safeRevision(fromRevision, "旧版本"); const to = safeRevision(toRevision, "新版本"); if (from === to) throw new Error("对比的两个版本不能相同。"); return (await this.run(["diff", "-r", `${from}:${to}`, "--", "."], workingCopy)).stdout; }
  async diffSummaryBetweenRevisions(workingCopy: string, fromRevision: string, toRevision: string): Promise<SvnDiffSummaryFile[]> { const from = safeRevision(fromRevision, "旧版本"); const to = safeRevision(toRevision, "新版本"); if (from === to) throw new Error("对比的两个版本不能相同。"); return parseSvnDiffSummary((await this.run(["diff", "--summarize", "-r", `${from}:${to}`, "--", "."], workingCopy)).stdout); }
  async diffFileBetweenRevisions(workingCopy: string, fromRevision: string, toRevision: string, file: string): Promise<string> { const from = safeRevision(fromRevision, "旧版本"); const to = safeRevision(toRevision, "新版本"); if (from === to) throw new Error("对比的两个版本不能相同。"); safeWorkingCopyFile(workingCopy, file); return (await this.run(["diff", "-r", `${from}:${to}`, "--", file], workingCopy)).stdout; }
  async restore(workingCopy: string, file: string, revision: string): Promise<void> { safeWorkingCopyFile(workingCopy, file); required(revision, "必须指定要恢复的版本。"); await this.withWriteLock(workingCopy, async () => { const target = await canonicalWorkingCopyFile(this.fileSystem, workingCopy, file); const content = await this.run(["cat", "-r", revision, "--", file], workingCopy, true); await this.fileSystem.writeFile(target, content.stdoutBytes ?? content.stdout); }); }
  async ignore(workingCopy: string, file: string, pattern: string): Promise<void> { safeWorkingCopyFile(workingCopy, file); required(pattern, "忽略规则不能为空。"); await this.withWriteLock(workingCopy, async () => { const parent = path.dirname(file) === "." ? "." : path.dirname(file); let existing = ""; try { existing = (await this.run(["propget", "svn:ignore", "--", parent], workingCopy)).stdout; } catch (error) { if (!propertyIsAbsent(error)) throw error; } const rules = existing.replace(/\r\n/g, "\n").split("\n").filter(Boolean); if (!rules.includes(pattern)) rules.push(pattern); await this.directWrite(["propset", "svn:ignore", rules.join("\n"), "--", parent], workingCopy); }); }
  async removeVersionedFileKeepLocal(workingCopy: string, file: string): Promise<SvnCommandResult> { safeWorkingCopyFile(workingCopy, file); return this.write(["delete", "--keep-local", "--", file], workingCopy); }
  async resolveTextConflict(workingCopy: string, file: string, mergedText: string): Promise<SvnCommandResult> { safeWorkingCopyFile(workingCopy, file); rejectMarkers(mergedText); return this.withWriteLock(workingCopy, async () => { const target = await canonicalWorkingCopyFile(this.fileSystem, workingCopy, file); await this.fileSystem.writeFile(target, mergedText); return this.directWrite(["resolve", "--accept", "working", "--", file], workingCopy); }); }
  async clearAuthCache(directory = this.authCacheDirectory): Promise<void> { if (!this.fileSystem.removeDirectory) throw new Error("当前文件系统不支持清除认证缓存。"); if (path.resolve(directory) !== this.authCacheDirectory) throw new Error("只能清除已批准的 SVN 认证缓存目录。"); await this.fileSystem.removeDirectory(this.authCacheDirectory); }
  private withWriteLock<T>(cwd: string, work: () => Promise<T>): Promise<T> { const key = path.resolve(cwd).toLowerCase(); const previous = this.writes.get(key) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(work); const lock = next.then(() => undefined, () => undefined); this.writes.set(key, lock); void lock.finally(() => { if (this.writes.get(key) === lock) this.writes.delete(key); }); return next; }
  private async run(args: string[], cwd: string, captureStdoutBytes = false, maxOutputChars?: number): Promise<SvnCommandResult> { try { return await this.runner.run(args, { cwd, timeoutMs: this.timeoutMs, ...(captureStdoutBytes ? { captureStdoutBytes: true } : {}), ...(maxOutputChars ? { maxOutputChars } : {}) }); } catch (error) { throw new SvnServiceError(classifySvnError(error), error); } }
  private write(args: string[], cwd: string): Promise<SvnCommandResult> { return this.withWriteLock(cwd, () => this.directWrite(args, cwd)); }
  private async directWrite(args: string[], cwd: string): Promise<SvnCommandResult> { try { return await this.runner.run(args, { cwd, write: true, timeoutMs: this.timeoutMs }); } catch (error) { throw new SvnServiceError(classifySvnError(error), error); } }
}
function safeRevision(value: string, label: string): string { const revision = String(value ?? "").trim().replace(/^r/i, ""); if (!/^\d+$/.test(revision)) throw new Error(`${label}版本号无效。`); return revision; }
