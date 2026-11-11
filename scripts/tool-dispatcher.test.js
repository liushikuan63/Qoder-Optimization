'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = __dirname;
const REPO = path.resolve(SCRIPTS, '..');
const PRE = path.join(SCRIPTS, 'pre-tool-dispatcher.js');
const POST = path.join(SCRIPTS, 'post-tool-dispatcher.js');
const TEST_ROOT = process.env.DISPATCHER_TEST_ROOT
  || (process.platform === 'win32' && fs.existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir());
const ROOT = path.join(TEST_ROOT, `tool-dispatcher-test-${process.pid}-${Date.now()}`);
const BACKSLASH = String.fromCharCode(92);
const UNBOUNDED = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'grep -rn needle .' } };
const WIN_PATH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `node -e "console.log('C:${BACKSLASH}Users${BACKSLASH}x')"` } };

function sandbox(name) {
  const dir = path.join(ROOT, name);
  const box = { dir, client: path.join(dir, 'client'), home: path.join(dir, 'home') };
  fs.mkdirSync(box.client, { recursive: true });
  fs.mkdirSync(box.home, { recursive: true });
  return box;
}

function run(file, event, box, extraEnv = {}) {
  const stateDir = path.join(box.dir, 'state');
  const result = spawnSync(process.execPath, [file], {
    input: typeof event === 'string' ? event : JSON.stringify(event),
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    env: {
      ...process.env,
      QODER_HOME: box.client,
      HOME: box.home,
      USERPROFILE: box.home,
      PRE_TOOL_DISPATCHER_STATE_DIR: stateDir,
      POST_TOOL_DISPATCHER_STATE_DIR: stateDir,
      PRE_TOOL_DISPATCHER_DUMP: '0',
      ...extraEnv,
    },
  });
  const ledgerFile = path.join(stateDir, 'decisions.log');
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ledger: fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '',
  };
}

function only(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, '分发器最多输出一行合并结果：' + stdout);
  return JSON.parse(lines[0]);
}

test('tool dispatchers', async (t) => {
  t.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  await t.test('both dispatchers are shipped and catalogued', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8'));
    const shipped = (cat) => ['script:pre-tool-dispatcher.js', 'script:post-tool-dispatcher.js'].every((id) => {
      const entry = cat.entries.find((item) => item.id === id);
      return Boolean(entry) && entry.status === 'shipped' && fs.existsSync(path.join(REPO, entry.source));
    });
    assert.ok(shipped(catalog), '两个分发器必须随包且在 catalog 里');
    const stripped = { ...catalog, entries: catalog.entries.filter((entry) => !/dispatcher/.test(entry.id)) };
    assert.equal(shipped(stripped), false, '抽掉 catalog 条目必须判红');
  });

  await t.test('dispatchers resolve helpers from the client root, not a machine path', () => {
    const portable = (text) => !/[A-Za-z]:\/tools\//.test(text) && !/[A-Za-z]:\/qoder-data/.test(text);
    for (const file of [PRE, POST]) {
      assert.ok(portable(fs.readFileSync(file, 'utf8')), path.basename(file) + ' 不得写死本机工具或数据目录');
    }
    assert.ok(fs.readFileSync(POST, 'utf8').includes("process.env.CONTINUITY_CJS || path.join(CLIENT_ROOT, 'scripts', 'continuity.cjs')"),
      'continuity 必须按 env 或客户端目录解析');
    assert.equal(portable("file: 'D:/tools/qoder-context-continuity/continuity.cjs'"), false, '旧的本机专用路径必须被这条判据杀掉');
  });

  await t.test('PreToolUse propagates a real guard allow with updatedInput', () => {
    const box = sandbox('pre-allow');
    const result = run(PRE, UNBOUNDED, box);
    assert.equal(result.status, 0);
    const out = only(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(out.hookSpecificOutput.updatedInput.command, 'grep -rn needle . | head -100');
    assert.match(result.ledger, /hit\|huge-output-guard\|Bash/);
  });

  await t.test('PreToolUse aggregates a real guard deny into one block', () => {
    const box = sandbox('pre-deny');
    const result = run(PRE, UNBOUNDED, box, { HOG_MODE: 'deny' });
    assert.equal(result.status, 0);
    const out = only(result.stdout);
    assert.equal(out.decision, 'block');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /grep/);
    assert.match(result.ledger, /deny\|Bash/);
  });

  await t.test('Bash-only guards stay away from other tools', () => {
    const box = sandbox('pre-matcher');
    const bash = run(PRE, WIN_PATH, box);
    assert.equal(bash.status, 0);
    assert.equal(only(bash.stdout).decision, 'block', 'Bash 事件必须被 win-path-guard 拦');
    assert.match(bash.ledger, /hit\|win-path-guard\|Bash/);

    const readBox = sandbox('pre-matcher-read');
    const read = run(PRE, { ...WIN_PATH, tool_name: 'Read', tool_input: { ...WIN_PATH.tool_input, file_path: path.join(readBox.dir, 'x.txt') } }, readBox);
    assert.equal(read.status, 0);
    assert.equal(read.stdout.trim(), '', 'Read 事件不得触发 Bash-only 守卫');
    assert.ok(!/hit\|win-path-guard/.test(read.ledger), 'matcher 不命中时不得调用该守卫');
  });

  await t.test('disabled switch short-circuits before any guard runs', () => {
    const box = sandbox('pre-disabled');
    fs.writeFileSync(path.join(box.client, 'pre-tool-dispatcher.json'), JSON.stringify({ disabled: true }));
    const result = run(PRE, UNBOUNDED, box, { HOG_MODE: 'deny' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '');
    assert.equal(result.ledger, '', '关闭时不得产生台账');
  });

  await t.test('mutation control: dropping a dispatch branch removes the interception', () => {
    const box = sandbox('pre-mutant');
    const mutantDir = path.join(box.dir, 'mutant');
    fs.mkdirSync(mutantDir, { recursive: true });
    for (const dep of ['hook-crash-guard.js', 'client-root.js']) {
      fs.copyFileSync(path.join(SCRIPTS, dep), path.join(mutantDir, dep));
    }
    let source = fs.readFileSync(PRE, 'utf8');
    const branch = "  { name: 'huge-output-guard', file: 'huge-output-guard.js', matcher: null },\n";
    assert.ok(source.includes(branch), '变异锚点必须存在于实现中');
    source = source.replace(branch, '');
    // 变异体仍在隔离目录，但分发到真实守卫（不 stub 守卫本身）。
    source = source.replace('const file = path.join(__dirname, g.file);', 'const file = path.join(' + JSON.stringify(SCRIPTS) + ', g.file);');
    const mutant = path.join(mutantDir, 'pre-tool-dispatcher.js');
    fs.writeFileSync(mutant, source);
    const result = run(mutant, UNBOUNDED, box);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), '', '摘掉 huge-output-guard 分支后必须不再改写命令——证明上面的判据真的依赖该分支');
    assert.ok(!/hit\|huge-output-guard/.test(result.ledger));
  });

  await t.test('PostToolUse skips an absent continuity and honours CONTINUITY_CJS', () => {
    const event = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'post-write.txt') }, tool_response: { ok: true } };
    const absent = run(POST, event, sandbox('post-absent'));
    assert.equal(absent.status, 0);
    assert.match(absent.ledger, /skip-missing\|continuity/);

    const presentBox = sandbox('post-present');
    const present = run(POST, event, presentBox, {
      CONTINUITY_CJS: path.join(SCRIPTS, 'continuity.cjs'),
      CONTINUITY_STORE: path.join(presentBox.dir, 'store'),
    });
    assert.equal(present.status, 0);
    assert.ok(!/skip-missing\|continuity/.test(present.ledger), 'env 指到真实脚本后不得再记 skip-missing');
  });

  await t.test('PostToolUse disabled switch and malformed input stay fail-open', () => {
    const box = sandbox('post-disabled');
    fs.writeFileSync(path.join(box.client, 'post-tool-dispatcher.json'), JSON.stringify({ disabled: true }));
    const off = run(POST, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, box);
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), '');

    for (const file of [PRE, POST]) {
      const broken = run(file, 'this is not json', sandbox('malformed-' + path.basename(file, '.js')));
      assert.equal(broken.status, 0, path.basename(file) + ' 遇到坏输入必须 exit 0');
      assert.equal(broken.stdout.trim(), '');
    }
  });
});