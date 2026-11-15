'use strict';
// tag 附注中文摘要判据的正负对照（0.1.6/0.1.7 遗漏后新增，0.2.0 起硬拦）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chineseSummary, composeTagMessage, assertTagMessage, remoteTagMessage } = require('./publish-release.js');

function fixture(changelog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-tagmsg-'));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}
const GOOD = '## [0.2.0] - 2026-11-15' + '\n\n### Added\n- thing\n\n### 中文摘要\n- 新增载体入包契约门。\n- 描述上限单一真源。\n\n## [0.1.7] - 2026-11-14\n\n### 中文摘要\n- 旧版摘要。\n';

test('正例：从 CHANGELOG 取到中文摘要且只取本节', () => {
  const dir = fixture(GOOD);
  const zh = chineseSummary(dir, '0.2.0');
  assert.match(zh, /契约门/);
  assert.doesNotMatch(zh, /旧版摘要/, '不得串到下一版本节');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('正例：composeTagMessage 含标题与条目', () => {
  const dir = fixture(GOOD);
  const msg = composeTagMessage(dir, '0.2.0');
  assert.match(msg, /^Qoder-Optimization 0\.2\.0/);
  assert.match(msg, /### 中文摘要/);
  assert.equal(assertTagMessage(msg, 'v0.2.0'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('负对照：缺中文摘要节 ⇒ 拒绝生成', () => {
  const dir = fixture('## [0.2.0] - 2026-11-15\n\n### Added\n- thing\n');
  assert.equal(chineseSummary(dir, '0.2.0'), null);
  assert.throws(() => composeTagMessage(dir, '0.2.0'), /缺少非空中文摘要/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('负对照：中文摘要节存在但零条目 ⇒ 拒绝（防恒真）', () => {
  const dir = fixture('## [0.2.0] - 2026-11-15\n\n### 中文摘要\n\n### 下一节\n- x\n');
  assert.equal(chineseSummary(dir, '0.2.0'), null);
  assert.throws(() => composeTagMessage(dir, '0.2.0'), /缺少非空中文摘要/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('负对照：版本不存在 ⇒ 拒绝', () => {
  const dir = fixture(GOOD);
  assert.equal(chineseSummary(dir, '9.9.9'), null);
  assert.throws(() => composeTagMessage(dir, '9.9.9'), /缺少非空中文摘要/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('负对照：英文一行附注（0.1.6/0.1.7 的真实形态）必须判红', () => {
  assert.throws(() => assertTagMessage('Qoder-Optimization 0.1.7\n', 'v0.1.7'), /缺中文摘要/);
});

test('负对照：有标题但零条目必须判红', () => {
  assert.throws(() => assertTagMessage('Qoder-Optimization 0.2.0\n\n### 中文摘要\n', 'v0.2.0'), /中文摘要为空/);
});

test('负对照：空/null 附注必须判红', () => {
  assert.throws(() => assertTagMessage('', 'v0.2.0'), /缺中文摘要/);
  assert.throws(() => assertTagMessage(null, 'v0.2.0'), /缺中文摘要/);
});

test('正例：远端附注 tag 读回消息', () => {
  const calls = [];
  const invoke = args => { calls.push(args.join(' ')); return calls.length === 1 ? JSON.stringify({ object: { type: 'tag', sha: 'a'.repeat(40) } }) : JSON.stringify({ message: '### 中文摘要\n- 条目。\n' }); };
  assert.match(remoteTagMessage(invoke, 'o/r', 'v0.2.0'), /中文摘要/);
  assert.equal(calls.length, 2);
});

test('负对照：轻量 tag（type=commit）返回 null ⇒ 调用方判红', () => {
  const invoke = () => JSON.stringify({ object: { type: 'commit', sha: 'b'.repeat(40) } });
  assert.equal(remoteTagMessage(invoke, 'o/r', 'v0.2.0'), null);
  assert.throws(() => assertTagMessage(remoteTagMessage(invoke, 'o/r', 'v0.2.0'), 'v0.2.0'), /缺中文摘要/);
});

test('负对照：tag ref 不可读必须抛错而不是静默放行', () => {
  assert.throws(() => remoteTagMessage(() => JSON.stringify({}), 'o/r', 'v0.2.0'), /unreadable/);
});
