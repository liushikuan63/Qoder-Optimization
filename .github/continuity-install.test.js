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

for (const mutation of ['matcher', 'type', 'timeout', 'operation', 'duplicate', 'malformed']) {
  test('conflicting continuity wiring is rejected without overwriting local settings: ' + mutation, () => {
    const o = sandbox();
    try {
      assert.equal(run(o, ['--yes']).status, 0);
      const settings = JSON.parse(fs.readFileSync(o.settings, 'utf8'));
      const group = settings.hooks.PostToolUse[0], hook = group.hooks[0];
      if (mutation === 'matcher') group.matcher = '^Read$';
      if (mutation === 'type') hook.type = 'prompt';
      if (mutation === 'timeout') hook.timeout = 1;
      if (mutation === 'operation') hook.command = hook.command.replace(/ hook$/, ' disable');
      if (mutation === 'duplicate') settings.hooks.PostToolUse.push(structuredClone(group));
      if (mutation === 'malformed') settings.hooks.PostToolUse = { preserve: true };
      const before = JSON.stringify(settings, null, 2) + '\n';
      fs.writeFileSync(o.settings, before);
      fs.writeFileSync(o.target, 'local script bytes');
      const result = run(o, ['--yes']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(fs.readFileSync(o.settings, 'utf8'), before);
      assert.equal(fs.readFileSync(o.target, 'utf8'), 'local script bytes');
    } finally { cleanup(o); }
  });
}

for (const prior of [false, true]) {
  test('settings publication failure rolls back only the installed script: prior=' + prior, () => {
    const o = sandbox();
    try {
      const before = fs.readFileSync(o.settings);
      if (prior) fs.writeFileSync(o.target, 'prior script bytes');
      const preload = path.join(o.home, 'publication-failure.cjs');
      fs.writeFileSync(preload, 'const fs=require("node:fs"),rename=fs.renameSync;fs.renameSync=function(from,to){if(to===' + JSON.stringify(o.settings) + ')throw new Error("injected settings failure");return rename.call(this,from,to);};');
      const result = spawnSync(process.execPath, ['--require', preload, installer, '--client-root', o.client, '--yes'], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, HOME: o.home, USERPROFILE: o.home, QODER_HOME: o.client },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.deepEqual(fs.readFileSync(o.settings), before);
      assert.equal(fs.existsSync(o.target), prior);
      if (prior) assert.equal(fs.readFileSync(o.target, 'utf8'), 'prior script bytes');
      assert.equal(fs.readdirSync(o.client).some(name => name.includes('.tmp-')), false);
    } finally { cleanup(o); }
  });
}

for (const prior of [false, true]) {
  test('a concurrent replacement during rollback is preserved: prior=' + prior, () => {
    const o = sandbox();
    try {
      if (prior) fs.writeFileSync(o.target, 'prior script bytes');
      const preload = path.join(o.home, 'rollback-race.cjs');
      fs.writeFileSync(preload, 'const fs=require("node:fs"),rename=fs.renameSync,unlink=fs.unlinkSync;let failed=false,fired=false;const target=' + JSON.stringify(o.target) + ';function race(p){if(failed&&!fired&&p===target){fired=true;fs.writeFileSync(target,"concurrent script bytes");}}fs.renameSync=function(from,to){if(to===' + JSON.stringify(o.settings) + '){failed=true;throw new Error("injected settings failure");}race(from===target?from:to);return rename.call(this,from,to);};fs.unlinkSync=function(p){race(p);return unlink.call(this,p);};');
      const r = spawnSync(process.execPath, ['--require', preload, installer, '--client-root', o.client, '--yes'], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: o.home, USERPROFILE: o.home, QODER_HOME: o.client },
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(fs.existsSync(o.target), true);
      assert.equal(fs.readFileSync(o.target, 'utf8'), 'concurrent script bytes');
    } finally { cleanup(o); }
  });
}

test('catalog installation includes the continuity installer runtime closure', () => {
  const o = sandbox();
  try {
    const env = { ...process.env, HOME: o.home, USERPROFILE: o.home, QODER_HOME: o.client };
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/pkg-catalog.cjs'), 'install', 'script:install-continuity.cjs', '--apply', '--catalog', path.join(root, 'catalog.json')], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(o.target), true, 'continuity runtime must be installed as a dependency');
    const installed = path.join(o.client, 'scripts/install-continuity.cjs');
    const preview = spawnSync(process.execPath, [installed, '--client-root', o.client, '--yes', '--dry-run'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  } finally { cleanup(o); }
});
