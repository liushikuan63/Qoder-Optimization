'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const probe = path.join(root, 'scripts/shell-boundary-probe.cjs');
const audit = path.join(root, 'skills/skill-reference-integrity-audit/scripts/audit-references.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (rel, bytes) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
  return { dir, write };
}
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
test('boundary probe compares literal argv without executing or disclosing it', t => {
  const f = fixture(t), marker = path.join(f.dir, 'never-created');
  const args = ['', '中文 İ', 'a b', '"quoted"', 'tail\\', '/switch', '$(touch ' + marker + ')', 'a&b', 'line\nbreak'];
  const expected = f.write('expected.json', JSON.stringify(args));
  const r = run(probe, ['--expect-file', expected, '--', ...args]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'MATCH'); assert.equal(out.receivedCount, args.length);
  assert.equal(out.expectedDigest, out.receivedDigest);
  assert.equal(r.stdout.includes('never-created'), false);
  assert.equal(r.stdout.includes('中文'), false); assert.equal(fs.existsSync(marker), false);
});
test('boundary probe fails a changed or dropped argument', t => {
  const f = fixture(t), expected = f.write('expected.json', JSON.stringify(['kept', 'tail\\']));
  for (const args of [['changed', 'tail\\'], ['kept']]) {
    const r = run(probe, ['--expect-file', expected, '--', ...args]);
    assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).status, 'MISMATCH');
  }
});
test('boundary probe distinguishes diagnostics and invalid expectations', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(run(probe, []).stdout).status, 'INFO');
  const malformed = f.write('malformed.json', '{ private-value-do-not-echo');
  for (const args of [['--bad'], ['--expect-file'], ['--expect-file', malformed, '--'], ['--expect-file', f.write('object.json', '{}'), '--']]) {
    const r = run(probe, args); assert.equal(r.status, 2); assert.equal((r.stdout + r.stderr).includes('private-value'), false);
  }
});
test('reference audit traverses Unicode markdown links and reports nested non-JS resources', t => {
  const f = fixture(t);
  f.write('SKILL.md', '[入口](references/入口.md#段落)');
  f.write('references/入口.md', '[helper](../scripts/子目录/验证.ps1)');
  let r = run(audit, [f.dir]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(JSON.parse(r.stdout).missing.some(x => x.includes('验证.ps1')));
  f.write('scripts/子目录/验证.ps1', '# owned fixture');
  r = run(audit, [f.dir]); assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('reference audit terminates cycles and checks assets and arbitrary extensions', t => {
  const f = fixture(t);
  f.write('SKILL.md', '[first](references/a.md) and `assets/图示.svg`');
  f.write('references/a.md', '[back](../SKILL.md) [typed](../scripts/nested/check.ts)');
  f.write('assets/图示.svg', '<svg/>');
  const r = run(audit, [f.dir]); assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(JSON.parse(r.stdout).missing.some(x => x.includes('check.ts')));
});
test('reference audit skips examples, remote links and comments without ignoring ordinary example prose', t => {
  const f = fixture(t);
  f.write('SKILL.md', '~~~text\nreferences/not-real.md\n~~~\n<!-- `scripts/no.js` -->\n[web](https://example.invalid/no.md)\n例如实际使用 `scripts/工具/真实.py`。');
  const r = run(audit, [f.dir]); assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.missing.length, 1); assert.match(out.missing[0], /真实.py/);
});
test('reference audit reports unreadable input separately and never follows external links', t => {
  const f = fixture(t), other = fixture(t);
  f.write('SKILL.md', '[external](references/secret.md)');
  other.write('secret.md', 'PRIVATE_OUTSIDE_DO_NOT_ECHO');
  fs.symlinkSync(other.dir, path.join(f.dir, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = run(audit, [f.dir]); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal((r.stdout + r.stderr).includes('PRIVATE_OUTSIDE'), false);
  assert.equal(run(audit, [path.join(f.dir, 'absent')]).status, 2);
});
test('reference audit refuses Markdown traversal beyond the requested skill root', t => {
  const f = fixture(t);
  f.write('SKILL.md', '[neighbor](../outside.md)');
  const r = run(audit, [f.dir]); assert.equal(r.status, 2, r.stdout + r.stderr);
});
test('reference audit gives input failures precedence over missing references across targets', t => {
  const f = fixture(t);
  f.write('SKILL.md', '`assets/missing.svg`');
  const r = run(audit, [f.dir, path.join(f.dir, 'absent')]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.results[0].missing.length, 1); assert.ok(out.results[1].errors.length);
});
test('actual prompt hook delivers bounded recovery and task-scoped tool discovery', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'scripts'));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/rules-reminder.js')], {
    env: { ...process.env, QODER_HOME: f.dir, HOME: f.dir, USERPROFILE: f.dir }, cwd: f.dir,
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'owned-feedback', prompt: '只读核对当前工具入口' }), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /唯一重试预算/); assert.match(text, /操作标识只读查回/);
  assert.match(text, /工具按当前步骤定向检索/); assert.doesNotMatch(text, /3 种不同手段|约 10 次即锁号/);
});
test('a document-relative Markdown link cannot borrow a root-level file of the same name', t => {
  const f = fixture(t);
  f.write('SKILL.md', '[nested](references/a.md)');
  f.write('references/a.md', '[child](references/helper.txt)');
  f.write('references/helper.txt', 'wrong-level decoy');
  const r = run(audit, [f.dir]); assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.missing.includes('references/helper.txt'));
  assert.equal(out.existing.includes('references/helper.txt'), false);
});
test('invalid UTF-8 expectations and Markdown cannot become successful replacement-character matches', t => {
  const f = fixture(t), expected = f.write('invalid.json', Buffer.from([91, 34, 255, 34, 93]));
  assert.equal(run(probe, ['--expect-file', expected, '--', '\uFFFD']).status, 2);
  f.write('SKILL.md', Buffer.concat([Buffer.from('[bad](references/'), Buffer.from([255]), Buffer.from('.md)')]));
  f.write('references/\uFFFD.md', 'replacement decoy');
  const r = run(audit, [f.dir]); assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).existing.length, 0);
});
test('a parent directory replaced during asset metadata checks cannot produce an existing reference', t => {
  const f = fixture(t), other = fixture(t);
  f.write('SKILL.md', '`assets/item.bin`'); f.write('assets/item.bin', 'owned'); other.write('item.bin', 'outside decoy');
  const assets = path.join(f.dir, 'assets'), original = fs.lstatSync;
  let fired = 0;
  fs.lstatSync = function(file, options) {
    const result = original.call(fs, file, options);
    if (path.resolve(String(file)) === assets && !fired) {
      fired++; fs.renameSync(assets, assets + '-original');
      fs.symlinkSync(other.dir, assets, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return result;
  };
  let out;
  try { out = require(audit).scan(f.dir); } finally { fs.lstatSync = original; }
  assert.equal(fired, 1); assert.ok(out.errors.length); assert.equal(out.existing.includes('assets/item.bin'), false);
});
