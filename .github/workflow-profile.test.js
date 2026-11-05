'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const installer = require('../scripts/install-package.cjs');
const profile = require('../scripts/workflow-profile.cjs');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-complete-profile-'));
  const client = path.join(home, "client ' dollar$ 中文");
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: path.join(home, 'decoy') };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const install = (extra = {}) => installer.apply(installer.prepare({ client, catalogFile: path.join(root, 'catalog.json'), ...extra }), { yes: true });
  const hooks = () => Object.entries(JSON.parse(fs.readFileSync(path.join(client, 'settings.json'))).hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({ event, group, hook }))));
  const run = (script, payload) => {
    const selected = hooks().find(item => item.event === payload.hook_event_name && (item.hook.args?.[0].endsWith('/' + script) || item.hook.args?.[0].endsWith('\\' + script) || (item.hook.args?.[1] && Buffer.from(item.hook.args[1], 'base64url').toString().includes('"script":"' + script + '"'))));
    assert.ok(selected, script);
    return spawnSync(selected.hook.command, selected.hook.args, { input: JSON.stringify(payload), env, encoding: 'utf8', cwd: home, timeout: 20000, windowsHide: true });
  };
  return { home, client, env, install, hooks, run };
}
test('clean complete installation owns 16 exec hooks, 12 usable core entries and portable rules', t => {
  const f = fixture(t), result = f.install();
  assert.equal(result.ready, true);
  assert.equal(result.receipt.profile, 'complete');
  assert.equal(f.hooks().length, 16);
  assert.ok(f.hooks().every(({ hook }) => hook.command === process.execPath && Array.isArray(hook.args)));
  for (const name of profile.CORE_SKILLS) assert.ok(fs.existsSync(path.join(f.client, 'skills', name, 'SKILL.md')), name);
  for (const rel of Object.keys(profile.RULES)) assert.match(fs.readFileSync(path.join(f.client, rel), 'utf8'), /qoder-package-workflow:start/);
  assert.equal(profile.health(f.client).status, 'READY');
  assert.equal(fs.existsSync(path.join(f.home, 'decoy')), false);
  const settings = fs.readFileSync(path.join(f.client, 'settings.json'));
  const second = f.install(); assert.equal(second.ready, true);
  assert.ok(fs.readFileSync(path.join(f.client, 'settings.json')).equals(settings));
  assert.equal(f.hooks().length, 16);
});
test('installed async fact hook reads payload cwd and never the launcher cwd', t => {
  const f = fixture(t); f.install();
  const project = path.join(f.home, 'project-B'); fs.mkdirSync(project);
  const add = spawnSync(process.execPath, [path.join(f.client, 'scripts/fact-ledger.cjs'), '--add', 'FACT_SENTINEL_B'], { cwd: project, env: { ...f.env, QODER_HOME: f.client }, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const result = f.run('fact-ledger.cjs', { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: 'facts-B', prompt: '核对事实' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /FACT_SENTINEL_B/);
});
test('profile health detects removal of every declared hook, including routing', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.client, 'settings.json'), bytes = fs.readFileSync(file);
  const all = f.hooks();
  for (const { event, hook } of all) {
    const settings = JSON.parse(bytes);
    for (const group of settings.hooks[event]) group.hooks = group.hooks.filter(item => JSON.stringify(item) !== JSON.stringify(hook));
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    assert.equal(profile.health(f.client).status, 'INCOMPLETE', event + ':' + hook.args[0]);
  }
  fs.writeFileSync(file, bytes);
  assert.equal(profile.health(f.client).status, 'READY');
});
test('managed rule changes require review while unrelated local prose survives updates', t => {
  const f = fixture(t); fs.mkdirSync(f.client, { recursive: true });
  fs.writeFileSync(path.join(f.client, 'AGENTS.md'), '# Personal rules\nLOCAL_SENTINEL\n');
  f.install(); f.install();
  const file = path.join(f.client, 'AGENTS.md'), text = fs.readFileSync(file, 'utf8');
  assert.match(text, /LOCAL_SENTINEL/); assert.equal(text.split(profile.START).length, 2);
  fs.writeFileSync(file, text.replace('默认简体中文', 'LOCAL_CUSTOMIZATION'));
  const changed = fs.readFileSync(file);
  assert.throws(() => f.install(), /本地定制/);
  assert.ok(fs.readFileSync(file).equals(changed));
  assert.equal(profile.health(f.client).status, 'INCOMPLETE');
});
test('legacy routing remains selected until an explicit complete upgrade', t => {
  const f = fixture(t); f.install({ profile: 'routing', workflowMode: 'route' });
  const keep = f.install(); assert.equal(keep.receipt.profile, 'routing'); assert.equal(f.hooks().length, 1);
  const upgrade = f.install({ profile: 'complete' }); assert.equal(upgrade.ready, true);
  assert.equal(f.hooks().length, 16);
  assert.equal(f.hooks().find(item => item.hook.args[0].endsWith('rules-reminder.js')).hook.args.at(-1), 'route');
  assert.throws(() => f.install({ profile: 'routing' }), /不能.*卸载/);
});
test('selected client budget ignores another client with the same session id', t => {
  const f = fixture(t); f.install();
  const cwd = path.join(f.home, 'project'), rel = cwd.replace(/[\\/:]/g, '-');
  const selected = path.join(f.client, 'projects', rel), other = path.join(f.home, '.qoder-cn/projects', rel);
  for (const dir of [selected, other]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(selected, 'same-session.jsonl'), '{}\n');
  fs.writeFileSync(path.join(other, 'same-session.jsonl'), 'x'.repeat(4096));
  const spec = profile.HOOKS.find(item => item[0] === 'UserPromptSubmit' && item[1] === 'session-budget.js'), call = profile.invocation(f.client, spec);
  const result = spawnSync(call.executable, call.args, { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, session_id: 'same-session' }), env: { ...f.env, SB_YELLOW_MB: '0.001', SB_ORANGE_MB: '1', SB_RED_MB: '2' }, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), '');
});
test('legacy full hooks upgrade in place and preserve the private extra hook', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.client, 'settings.json'), settings = JSON.parse(fs.readFileSync(file));
  for (const { event, hook } of f.hooks()) {
    if (hook.args[0].endsWith('rules-reminder.js')) continue;
    const payload = JSON.parse(Buffer.from(hook.args[1], 'base64url'));
    const target = settings.hooks[event].flatMap(group => group.hooks).find(item => JSON.stringify(item) === JSON.stringify(hook));
    target.command = '"' + process.execPath + '" "' + path.join(f.client, 'scripts', payload.script) + '"' + (payload.args.length ? ' --hook' : '');
    delete target.args;
  }
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'PRIVATE_BYOK_SENTINEL', timeout: 10 }] });
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.equal(f.install().ready, true);
  assert.equal(f.hooks().length, 17);
  assert.equal(f.hooks().filter(item => item.hook.command === 'PRIVATE_BYOK_SENTINEL').length, 1);
  assert.equal(profile.health(f.client).status, 'READY');
});
test('conflicting/disabled hooks refuse before publication and preserve settings', t => {
  const f = fixture(t); f.install();
  const file = path.join(f.client, 'settings.json'), settings = JSON.parse(fs.readFileSync(file));
  const first = settings.hooks.PreToolUse[0].hooks[0]; first.args[1] += 'INVALID';
  fs.writeFileSync(file, JSON.stringify(settings));
  const before = fs.readFileSync(file);
  assert.throws(() => f.install(), /冲突/);
  assert.ok(fs.readFileSync(file).equals(before));
  assert.equal(profile.health(f.client).status, 'INCOMPLETE');
  const disabled = { ...settings, disableAllHooks: true };
  fs.writeFileSync(file, JSON.stringify(disabled));
  assert.throws(() => f.install(), /已禁用/);
});
test('settings publication failure rolls back complete rules and newly installed capabilities', t => {
  const f = fixture(t); fs.mkdirSync(f.client, { recursive: true });
  const settings = path.join(f.client, 'settings.json'), agents = path.join(f.client, 'AGENTS.md');
  fs.writeFileSync(settings, '{"personal":"PRESERVE"}'); fs.writeFileSync(agents, '# Personal\nPRESERVE_RULE\n');
  const preload = path.join(f.home, 'fail-settings.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),open=fs.openSync;fs.openSync=function(file,flags,...args){if(file===${JSON.stringify(settings)}&&flags==='wx')throw new Error('fixture profile publication failure');return open.call(this,file,flags,...args);};`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-package.cjs'), '--yes', '--client-root', f.client], { env: { ...f.env, NODE_OPTIONS: '--require ' + JSON.stringify(preload) }, input: '', encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /本事务变更已回滚/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"personal":"PRESERVE"}');
  assert.equal(fs.readFileSync(agents, 'utf8'), '# Personal\nPRESERVE_RULE\n');
  for (const rel of ['rules/long-task.md', 'rules/vibe-coding.md', 'scripts/run-package-hook.cjs', 'skills/skills-router/SKILL.md', 'skills-index.json', 'share-package.json']) assert.equal(fs.existsSync(path.join(f.client, rel)), false, rel);
});
test('concurrent managed rule edits after publication refuse ready and retain the writer bytes', t => {
  const f = fixture(t), settings = path.join(f.client, 'settings.json'), agents = path.join(f.client, 'AGENTS.md');
  const preload = path.join(f.home, 'concurrent-rule.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),open=fs.openSync;let fired=false;fs.openSync=function(file,flags,...args){if(!fired&&file===${JSON.stringify(settings)}&&flags==='wx'){fired=true;fs.writeFileSync(${JSON.stringify(agents)},'CONCURRENT_WRITER_RULE');}return open.call(this,file,flags,...args);};`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-package.cjs'), '--yes', '--client-root', f.client], { env: { ...f.env, NODE_OPTIONS: '--require ' + JSON.stringify(preload) }, input: '', encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /已发布内容在事务期间改变/);
  assert.equal(fs.readFileSync(agents, 'utf8'), 'CONCURRENT_WRITER_RULE');
  assert.equal(fs.existsSync(path.join(f.client, 'package-activation.json')), false);
  assert.equal(fs.existsSync(path.join(f.client, 'share-package.json')), false);
});
