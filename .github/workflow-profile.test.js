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
const catalogEntries = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')).entries;
const manifestSkills = JSON.parse(fs.readFileSync(path.join(root, 'skills-manifest.json'), 'utf8')).skills;
// 落位由 install-package.cjs 的 targetFor 按 tier 决定：core → skills/，library → skills-library/。
// 两份随包载体互校，常驻数量不写死（README「不写死常驻数量」），只要求 12 条工作流技能各就其位。
function coreSkillTier(name) {
  const entry = catalogEntries.find(item => item.id === 'skill:' + name);
  assert.ok(entry, 'catalog 缺少 skill:' + name);
  const manifest = manifestSkills.find(item => item.name === name);
  assert.ok(manifest, 'skills-manifest 缺少 ' + name);
  const tier = entry.install?.tier === 'core' || entry.tier === 'core' ? 'core' : 'library';
  assert.equal(manifest.tier, tier, 'catalog 与 manifest 默认层不一致：' + name);
  return tier === 'core' ? 'skills' : 'skills-library';
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-complete-profile-'));
  const client = path.join(home, "client ' dollar$ 中文");
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: path.join(home, 'decoy') };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // 本文件验规则块与 hook 接线，与安装范围无关：固定 base，避免整包技能进临时客户端。
  const install = (extra = {}) => installer.apply(installer.prepare({ client, skillsScope: 'base', catalogFile: path.join(root, 'catalog.json'), ...extra }), { yes: true });
  const hooks = () => Object.entries(JSON.parse(fs.readFileSync(path.join(client, 'settings.json'))).hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({ event, group, hook }))));
  const run = (script, payload) => {
    const selected = hooks().find(item => item.event === payload.hook_event_name && (item.hook.args?.[0].endsWith('/' + script) || item.hook.args?.[0].endsWith('\\' + script) || (item.hook.args?.[1] && Buffer.from(item.hook.args[1], 'base64url').toString().includes('"script":"' + script + '"'))));
    assert.ok(selected, script);
    return spawnSync(selected.hook.command, selected.hook.args, { input: JSON.stringify(payload), env, encoding: 'utf8', cwd: home, timeout: 20000, windowsHide: true });
  };
  return { home, client, env, install, hooks, run };
}
test('clean complete installation owns 17 exec hooks, 12 usable core entries and portable rules', t => {
  const f = fixture(t), result = f.install();
  assert.equal(result.ready, true);
  assert.equal(result.receipt.profile, 'complete');
  assert.equal(f.hooks().length, 17);
  assert.ok(f.hooks().every(({ hook }) => hook.command === process.execPath && Array.isArray(hook.args)));
  assert.equal(profile.CORE_SKILLS.length, 12);
  for (const name of profile.CORE_SKILLS) {
    const tier = coreSkillTier(name), other = tier === 'skills' ? 'skills-library' : 'skills';
    assert.ok(fs.existsSync(path.join(f.client, tier, name, 'SKILL.md')), tier + '/' + name);
    assert.equal(fs.existsSync(path.join(f.client, other, name, 'SKILL.md')), false, '装错层 ' + other + '/' + name);
  }
  for (const rel of Object.keys(profile.RULES)) assert.match(fs.readFileSync(path.join(f.client, rel), 'utf8'), /qoder-package-workflow:start/);
  assert.equal(profile.health(f.client).status, 'READY');
  assert.equal(fs.existsSync(path.join(f.home, 'decoy')), false);
  const settings = fs.readFileSync(path.join(f.client, 'settings.json'));
  const second = f.install(); assert.equal(second.ready, true);
  assert.ok(fs.readFileSync(path.join(f.client, 'settings.json')).equals(settings));
  assert.equal(f.hooks().length, 17);
  const stop = f.hooks().filter(item => item.event === 'Stop').map(item => JSON.parse(Buffer.from(item.hook.args[1], 'base64url').toString()).script).sort();
  assert.deepEqual(stop, ['evolution-capture.cjs', 'stop-gate.js']);
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
  assert.equal(f.hooks().length, 17);
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
  assert.equal(f.hooks().length, 18);
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
  // 本文件验规则块与 hook 接线，与安装范围无关：固定 base，避免整包技能进临时客户端。
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-package.cjs'), '--yes', '--skills-scope', 'base', '--client-root', f.client], { env: { ...f.env, NODE_OPTIONS: '--require ' + JSON.stringify(preload) }, input: '', encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /本事务变更已回滚/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"personal":"PRESERVE"}');
  assert.equal(fs.readFileSync(agents, 'utf8'), '# Personal\nPRESERVE_RULE\n');
  for (const rel of ['rules/long-task.md', 'rules/vibe-coding.md', 'scripts/run-package-hook.cjs', 'skills/skills-router/SKILL.md', 'skills-index.json', 'share-package.json']) assert.equal(fs.existsSync(path.join(f.client, rel)), false, rel);
});
test('concurrent managed rule edits after publication refuse ready and retain the writer bytes', t => {
  const f = fixture(t), settings = path.join(f.client, 'settings.json'), agents = path.join(f.client, 'AGENTS.md');
  const preload = path.join(f.home, 'concurrent-rule.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),open=fs.openSync;let fired=false;fs.openSync=function(file,flags,...args){if(!fired&&file===${JSON.stringify(settings)}&&flags==='wx'){fired=true;fs.writeFileSync(${JSON.stringify(agents)},'CONCURRENT_WRITER_RULE');}return open.call(this,file,flags,...args);};`);
  // 本文件验规则块与 hook 接线，与安装范围无关：固定 base，避免整包技能进临时客户端。
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/install-package.cjs'), '--yes', '--skills-scope', 'base', '--client-root', f.client], { env: { ...f.env, NODE_OPTIONS: '--require ' + JSON.stringify(preload) }, input: '', encoding: 'utf8', timeout: 90000, windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /已发布内容在事务期间改变/);
  assert.equal(fs.readFileSync(agents, 'utf8'), 'CONCURRENT_WRITER_RULE');
  assert.equal(fs.existsSync(path.join(f.client, 'package-activation.json')), false);
  assert.equal(fs.existsSync(path.join(f.client, 'share-package.json')), false);
});
test('health reports a missing workflow skill in either tier and recovers after restore', t => {
  const f = fixture(t); f.install();
  const sample = new Map();
  for (const name of profile.CORE_SKILLS) { const tier = coreSkillTier(name); if (!sample.has(tier)) sample.set(tier, name); }
  // 负对照必须两层各取一个样本：只测常驻层会让「按需层漏登记」这种缺陷永远绿。
  assert.deepEqual([...sample.keys()].sort(), ['skills', 'skills-library']);
  for (const [tier, name] of sample) {
    const rel = tier + '/' + name + '/SKILL.md', file = path.join(f.client, ...rel.split('/'));
    const bytes = fs.readFileSync(file);
    fs.rmSync(file);
    const broken = profile.health(f.client);
    assert.equal(broken.status, 'INCOMPLETE', name);
    assert.ok(broken.issues.includes('FILE_MISSING:' + rel), name + ' :: ' + broken.issues.join(','));
    fs.writeFileSync(file, bytes);
    assert.equal(profile.health(f.client).status, 'READY', name);
  }
});

// ── 本地 timeout 余量：随包默认是下限，不是唯一合法值 ─────────────────────────────
// 根修背景：现役 profile 故意把 hook 余量调大（本机 12 条为 30），旧守卫硬要求 === 10，
// 于是 command 逐字一致、本该 KEEP 的接线被整体判冲突，包部署 fail-closed 拒绝。
// 修法是只放开安全方向：更长的正整数保留，更短/非正整数仍判冲突（短 timeout 会静默掐断 hook）。
test('local hook timeout predicate accepts only integer headroom at or above the shipped floor', () => {
  for (const shipped of [10, 15, 20]) {
    for (const value of [shipped, shipped + 1, 30, 600]) assert.equal(profile.localHookTimeout(value, shipped), true, shipped + '/' + value);
    for (const value of [shipped - 1, 1, 0, -1, 1.5, NaN, Infinity]) assert.equal(profile.localHookTimeout(value, shipped), false, shipped + '/' + value);
    for (const value of ['30', undefined, null, {}, []]) assert.equal(profile.localHookTimeout(value, shipped), false, shipped + '/' + JSON.stringify(value));
  }
  // 负对照：把下限当成「唯一合法值」的旧写法必须被这条断言否证（30 在旧写法下会被拒）。
  assert.equal(profile.localHookTimeout(30, 10), true);
});

test('completeSettings preserves larger local hook timeouts and still rejects shorter or non-integer ones', t => {
  const f = fixture(t);
  f.install();
  const file = path.join(f.client, 'settings.json');
  const shipped = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = () => Object.values(shipped.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  const before = entries().map(hook => hook.timeout);
  assert.ok(before.length >= 16, 'hooks=' + before.length);

  // 正例：全部调大到 30（>= 各自随包下限）⇒ 不抛错，且逐条保留 30，不被静默降回默认。
  for (const hook of entries()) hook.timeout = 30;
  fs.writeFileSync(file, JSON.stringify(shipped, null, 2) + '\n');
  const kept = profile.completeSettings(fs.readFileSync(file), f.client);
  const after = Object.values(JSON.parse(kept.bytes.toString()).hooks).flatMap(groups => groups.flatMap(group => group.hooks));
  assert.ok(after.length >= 16);
  for (const hook of after) assert.equal(hook.timeout, 30, '本地余量被降回随包默认');

  // 负例：更短 / 非正整数 / 字符串一律仍判冲突（既有 timeout=1 负对照语义不变）。
  for (const bad of [9, 1, 0, -1, 1.5, '30']) {
    const broken = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Object.values(broken.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
    // 必须挑 completeSettings 真正拥有的 hook：rules-reminder 不在 HOOKS 表内，会被直接跳过，
    // 改它的 timeout 不触发本守卫（首版误挑 list[0] 正是它 ⇒ 假红，已按真实归属改正）。
    const owned = list.find(hook => {
      // 随包 hook 经 run-package-hook.cjs 包装，脚本名在 args[1] 的 base64url token 内，
      // 直接 stringify(args) 匹配不到字面名（第二版假红即此因），按夹具既有解码方式取。
      let decoded = '';
      const token = Array.isArray(hook.args) && hook.args[1];
      if (token) { try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch { /* 非本格式 */ } }
      return decoded.includes('"script":"' + profile.HOOKS[0][1] + '"')
        || String(hook.command || '').includes(profile.HOOKS[0][1])
        || JSON.stringify(hook.args || []).includes(profile.HOOKS[0][1]);
    });
    assert.ok(owned, '找不到随包 hook ' + profile.HOOKS[0][1]);
    owned.timeout = bad;
    fs.writeFileSync(file, JSON.stringify(broken, null, 2) + '\n');
    assert.throws(() => profile.completeSettings(fs.readFileSync(file), f.client), /完整工作流 hook 冲突/, 'timeout=' + JSON.stringify(bad));
  }
});

test('completeSettings accepts legacy stop-gate 10 but normalizes it, and rejects 14 while preserving 30', t => {
  const f = fixture(t);
  f.install();
  const file = path.join(f.client, 'settings.json');
  const stopGate = settings => Object.values(settings.hooks).flatMap(groups => groups.flatMap(group => group.hooks))
    .find(hook => {
      let decoded = '';
      const token = Array.isArray(hook.args) && hook.args[1];
      if (token) { try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch { /* 非本格式 */ } }
      return decoded.includes('"script":"stop-gate.js"');
    });
  const shippedStopGate = profile.HOOKS.find(spec => spec[1] === 'stop-gate.js')[2];
  assert.equal(shippedStopGate, 15);

  // legacy 10：守卫接受（旧装机不抛错），但落盘归正为随包 15，不永久保留低于下限的值。
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  stopGate(legacy).timeout = 10;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n');
  const normalized = JSON.parse(profile.completeSettings(fs.readFileSync(file), f.client).bytes.toString());
  assert.equal(stopGate(normalized).timeout, shippedStopGate, 'legacy 10 应归正为随包默认');

  // 边界负例：14 低于下限 15 且不是 legacy 10 ⇒ 仍判冲突。
  const short = JSON.parse(fs.readFileSync(file, 'utf8'));
  stopGate(short).timeout = 14;
  fs.writeFileSync(file, JSON.stringify(short, null, 2) + '\n');
  assert.throws(() => profile.completeSettings(fs.readFileSync(file), f.client), /完整工作流 hook 冲突/);

  // 正例：30 >= 15 ⇒ 保留 30。
  const headroom = JSON.parse(fs.readFileSync(file, 'utf8'));
  stopGate(headroom).timeout = 30;
  fs.writeFileSync(file, JSON.stringify(headroom, null, 2) + '\n');
  const kept = JSON.parse(profile.completeSettings(fs.readFileSync(file), f.client).bytes.toString());
  assert.equal(stopGate(kept).timeout, 30);
});

test('installer preserves and names a larger local rules-reminder timeout, and stays silent without deviation', t => {
  const f = fixture(t);
  f.install();
  const file = path.join(f.client, 'settings.json');
  const findRules = settings => Object.values(settings.hooks).flatMap(groups => groups.flatMap(group => group.hooks))
    .find(hook => String(hook.command || '').includes('rules-reminder.js') || (Array.isArray(hook.args) && String(hook.args[0]).includes('rules-reminder.js')));
  const prepare = () => installer.prepare({ client: f.client, skillsScope: 'base', catalogFile: path.join(root, 'catalog.json') });

  // 模式隔离：随包默认 10 时不报保留值，输出与改动前一致。
  const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(findRules(baseline).timeout, 10);
  assert.equal(prepare().hook.preservedTimeout, undefined);

  // 正例：本地余量 30 ⇒ 不再整体判冲突，保留值被点名，落盘字节仍是 30。
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  findRules(local).timeout = 30;
  fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n');
  const plan = prepare();
  assert.equal(plan.hook.preservedTimeout, 30);
  assert.equal(findRules(JSON.parse(plan.hook.bytes.toString())).timeout, 30);

  // 负例：比随包下限更短仍判冲突，错误原文不变（不放宽危险方向）。
  for (const bad of [9, 1, 0, 1.5, '30']) {
    const broken = JSON.parse(fs.readFileSync(file, 'utf8'));
    findRules(broken).timeout = bad;
    fs.writeFileSync(file, JSON.stringify(broken, null, 2) + '\n');
    assert.throws(prepare, /rules-reminder .*接线.*冲突/, 'timeout=' + JSON.stringify(bad));
  }
});
