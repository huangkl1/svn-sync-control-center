import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const mainSource = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const stylesSource = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("提交工作台按文件、提交信息、差异顺序渲染，并提供两个可访问分隔条", () => {
  assert.match(mainSource, /svn-center-main/);
  assert.match(mainSource, /renderCommitWorkbench\(main\)/);
  assert.match(stylesSource, /\.svn-center-main/);
  assert.match(mainSource, /svn-commit-files-pane/);
  assert.match(mainSource, /svn-commit-message-pane/);
  assert.match(mainSource, /svn-commit-diff-pane/);
  assert.equal((mainSource.match(/svn-commit-splitter/g) ?? []).length >= 2, true);
  assert.match(mainSource, /aria-valuemin/);
  assert.match(mainSource, /ArrowUp/);
  assert.match(stylesSource, /\.svn-commit-workbench/);
  assert.match(stylesSource, /minmax\(150px/);
  assert.match(stylesSource, /minmax\(130px/);
  assert.match(stylesSource, /minmax\(260px/);
});

test("提交说明失去焦点时只结束编辑，不触发工作副本刷新", () => {
  const blurHandler = mainSource.match(/message\.addEventListener\("blur", \(\) => \{([^}]*)\}\);/)?.[1] ?? "";
  assert.match(blurHandler, /editingCommitMessage\s*=\s*false/);
  assert.doesNotMatch(blurHandler, /refreshFromSource/);
});

test("提交工作台说明失焦不会在首次点击提交时重建按钮", () => {
  const commitMessageRenderer = mainSource.match(/private renderCommitMessage\(parent: HTMLElement\): void \{([\s\S]*?)\n  \}\n\n  private renderCommitDiff/)?.[1] ?? "";
  const blurHandler = commitMessageRenderer.match(/message\.addEventListener\("blur", \(\) => \{([\s\S]*?)\}\);/)?.[1] ?? "";
  assert.match(blurHandler, /editingCommitMessage\s*=\s*false/);
  assert.doesNotMatch(blurHandler, /setTimeout|this\.render\(\)/);
});

test("弹框缩放以实际尺寸为起点，并支持三个主弹框最大化恢复", () => {
  assert.match(mainSource, /const rect = modalEl\.getBoundingClientRect\(\)/);
  assert.match(mainSource, /size: clampModalSize\(kind, \{ width: rect\.width, height: rect\.height \}\)/);
  assert.match(mainSource, /applyMaximizedModalLayout/);
  assert.equal((mainSource.match(/最大化窗口/g) ?? []).length >= 3, true);
  assert.equal((mainSource.match(/恢复窗口/g) ?? []).length >= 3, true);
  assert.match(mainSource, /window\.addEventListener\("resize", this\.onWindowResize\)/);
  assert.match(mainSource, /window\.removeEventListener\("resize", this\.onWindowResize\)/);
});

test("提交操作栏固定可见，缩小时提交信息区改为内部滚动", () => {
  assert.match(mainSource, /svn-commit-message-actions/);
  assert.match(stylesSource, /\.svn-commit-message-pane \{ overflow: auto/);
  assert.match(stylesSource, /\.svn-commit-message-actions \{[^}]*position: sticky/);
  assert.match(stylesSource, /\.svn-commit-message-actions \.svn-button \{[^}]*flex: 0 0 auto/);
});

test("全局结果卡片位于上下文条之后，并提供成功失败语义与诊断入口", () => {
  assert.match(mainSource, /renderOperationResult\(root\)/);
  assert.match(mainSource, /svn-operation-result/);
  assert.match(mainSource, /role: status === "error" \? "alert" : "status"/);
  assert.match(mainSource, /查看诊断日志/);
  assert.match(stylesSource, /\.svn-operation-result\.is-success/);
  assert.match(stylesSource, /\.svn-operation-result\.is-error/);
  assert.match(stylesSource, /\.svn-operation-result__content/);
});

test("开始新操作前清除上一轮界面错误", () => {
  const requestOperation = mainSource.match(/private async requestOperation\([\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(requestOperation, /this\.uiError = "";/);
  assert.match(requestOperation, /this\.stateSource\.runOperation/);
});

test("提交确认框使用独立的结构化确认界面", () => {
  assert.match(mainSource, /class CommitConfirmationModal extends Modal/);
  assert.match(mainSource, /svn-commit-confirmation/);
  assert.match(mainSource, /svn-confirmation-summary/);
  assert.match(mainSource, /svn-confirmation-repository/);
  assert.match(mainSource, /private confirmCommit\(/);
  assert.match(mainSource, /title: this\.data\.repositoryUrl/);
});

test("提交确认框限制长地址溢出并保留移动端布局", () => {
  assert.match(stylesSource, /\.svn-commit-confirmation-modal \{/);
  assert.match(stylesSource, /\.svn-confirmation \{[^}]*overflow: hidden/);
  assert.match(stylesSource, /\.svn-confirmation-repository \{[^}]*text-overflow: ellipsis/);
  assert.match(stylesSource, /\.svn-confirmation-repository \{[^}]*min-width: 0/);
  assert.match(stylesSource, /\.svn-commit-confirmation \.svn-confirmation-actions/);
  assert.match(stylesSource, /@media \(max-width: 680px\)[\s\S]*\.svn-commit-confirmation-modal/);
});

test("更新确认框使用同一套结构化信息层级", () => {
  assert.match(mainSource, /class UpdateConfirmationModal extends Modal/);
  assert.match(mainSource, /svn-update-confirmation/);
  assert.match(mainSource, /svn-confirmation-working-copy/);
  assert.match(mainSource, /private confirmUpdate\(/);
  assert.match(mainSource, /确认更新/);
});

test("更新确认框的工作副本和仓库地址不会产生横向滚动", () => {
  assert.match(stylesSource, /\.svn-update-confirmation-modal \{/);
  assert.match(stylesSource, /\.svn-confirmation-working-copy \{[^}]*text-overflow: ellipsis/);
  assert.match(stylesSource, /\.svn-confirmation-working-copy \{[^}]*min-width: 0/);
  assert.match(stylesSource, /\.svn-update-confirmation \.svn-confirmation-actions/);
  assert.match(stylesSource, /@media \(max-width: 680px\)[\s\S]*\.svn-update-confirmation-modal/);
});
