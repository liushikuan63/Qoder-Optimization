'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts', 'install-continuity.cjs');
const source = path.join(root, 'scripts', 'continuity.cjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-continuity-install-'));
  const client = path.join(home, '.qoder');
  const scripts = path.join(client, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const settings = path.join(client, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'existing-hook.js' }] }] } }, null, 2) + '\n');
  return { home, client, settings, target: path.join(scripts, 'continuity.cjs') };
}

function run(o, args = []) {
  return spawnSync(process.execPath, [installer, '--client-root', o.client, ...args], {
    encoding: 'utf8',
    input: '',
    timeout: 30000,
    env: { ...process.env, HOME: o.home, USERPROFILE: o.home, QODER_HOME: o.client },
  });
}

function cleanup(o) {
  fs.rmSync(o.home, { recursive: true, force: true });
}

test('dry-run 只显示计划，不写脚本或 settings', () => {
  const o = sandbox();
  try {
    const before = fs.readFileSync(o.settings, 'utf8');
    const result = run(o, ['--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run/);
    assert.equal(fs.existsSync(o.target), false);
    assert.equal(fs.readFileSync(o.settings, 'utf8'), before);
  } finally { cleanup(o); }
});

test('--yes 安装脚本并合并 hooks，保留既有接线，重复运行幂等', () => {
  const o = sandbox();
  try {
    const first = run(o, ['--yes']);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.existsSync(o.target), true);
    assert.deepEqual(fs.readFileSync(o.target), fs.readFileSync(source));
    const settings = JSON.parse(fs.readFileSync(o.settings, 'utf8'));
    const commands = settings.hooks.UserPromptSubmit.map(group => group.hooks[0].command);
    assert.ok(commands.includes('existing-hook.js'));
    assert.ok(commands.some(value => value.includes('continuity.cjs') && value.endsWith(' hook')));
    for (const event of ['PreCompact', 'PostCompact', 'UserPromptSubmit', 'SessionStart', 'PostToolUse']) {
      assert.ok(Array.isArray(settings.hooks[event]) && settings.hooks[event].length >= 1, event);
    }
    assert.equal(settings.hooks.SessionStart.at(-1).matcher, 'compact|resume');
    assert.equal(settings.hooks.PostToolUse.at(-1).matcher, '^(Write|Edit|Bash)$');
    const backups = () => fs.readdirSync(o.client).filter(name => name.startsWith('settings.json.bak'));
    assert.equal(backups().length, 1);
    const afterFirst = fs.readFileSync(o.settings, 'utf8');
    const second = run(o, ['--yes']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(o.settings, 'utf8'), afterFirst);
    assert.equal(backups().length, 1);
  } finally { cleanup(o); }
});

test('同一脚本的 Node 路径变化时就地更新 hook', () => {
  const o = sandbox();
  try {
    assert.equal(run(o, ['--yes']).status, 0);
    const settings = JSON.parse(fs.readFileSync(o.settings, 'utf8'));
    settings.hooks.PreCompact[0].hooks[0].command = '"C:\\Program Files\\nodejs\\node.exe" "' + o.target + '" hook';
    fs.writeFileSync(o.settings, JSON.stringify(settings, null, 2) + '\n');
    const result = run(o, ['--yes']);
    assert.equal(result.status, 0, result.stderr);
    const updated = JSON.parse(fs.readFileSync(o.settings, 'utf8'));
    assert.equal(updated.hooks.PreCompact[0].hooks[0].command, '"' + process.execPath + '" "' + o.target + '" hook');
  } finally { cleanup(o); }
});

test('settings.json 损坏时拒绝写入', () => {
  const o = sandbox();
  try {
    fs.writeFileSync(o.settings, '{bad');
    const result = run(o, ['--yes']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONTINUITY_INSTALL_ERROR/);
    assert.equal(fs.readFileSync(o.settings, 'utf8'), '{bad');
    assert.equal(fs.existsSync(o.target), false);
  } finally { cleanup(o); }
});

test('非交互且未加 --yes 时默认跳过', () => {
  const o = sandbox();
  try {
    const before = fs.readFileSync(o.settings, 'utf8');
    const result = run(o, []);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /非交互环境：默认跳过|已跳过/);
    assert.equal(fs.existsSync(o.target), false);
    assert.equal(fs.readFileSync(o.settings, 'utf8'), before);
  } finally { cleanup(o); }
});
