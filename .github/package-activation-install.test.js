'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const installer = path.join(root, 'scripts/install-package.cjs');
const { BASE_IDS } = require(installer);
const { dependenciesFor } = require('../scripts/package-dependencies.cjs');
const { isPublicFile } = require('../scripts/pack-share-extras.cjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-package-activation-'));
  const client = path.join(home, 'client'); fs.mkdirSync(client);
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: client, CONTINUITY_STORE: path.join(home, 'store') };
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8'));
  if (!catalog.entries.some(entry => entry.id === 'script:capability-advisor.cjs')) catalog.entries.push({ id: 'script:capability-advisor.cjs', name: 'capability-advisor.cjs', source: 'scripts/capability-advisor.cjs', category: 'script', status: 'shipped', install: { mode: 'copy-file' } });
  const entries = [], seen = new Set();
  const visit = id => {
    if (seen.has(id)) return; seen.add(id);
    const entry = catalog.entries.find(item => item.id === id); assert.ok(entry, id);
    dependenciesFor(root, entry).forEach(visit); entries.push(entry);
  };
  BASE_IDS.forEach(visit);
  entries.push({ id: 'script:fixture-update.js', name: 'fixture-update.js', category: 'script', status: 'shipped', source: 'scripts/fixture-update.js', install: { mode: 'copy-file' } });
  for (const name of ['office-docs', 'write-repowiki', 'fixture-specialized']) entries.push({ id: 'skill:' + name, name, category: 'skill', tier: 'library', status: 'shipped', source: 'skills/' + name, description: 'fixture capability', install: { mode: 'copy-skill', tier: 'library' } });
  const packageAt = (label, version) => {
    const pkg = path.join(home, label); fs.mkdirSync(pkg);
    for (const entry of entries) {
      const target = path.join(pkg, entry.source); fs.mkdirSync(path.dirname(target), { recursive: true });
      if (entry.id === 'script:fixture-update.js') fs.writeFileSync(target, 'console.log(' + JSON.stringify(version) + ');\n');
      else if (['skill:office-docs', 'skill:write-repowiki', 'skill:fixture-specialized'].includes(entry.id)) { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: ' + entry.name + '\ndescription: fixture capability\n---\nFixture.\n'); }
      else fs.cpSync(path.join(root, entry.source), target, { recursive: true, force: false, errorOnExist: true, filter: file => isPublicFile(path.relative(root, file).split(path.sep).join('/')) });
    }
    const file = path.join(pkg, 'catalog.json'); fs.writeFileSync(file, JSON.stringify({ schema: 1, package: { name: 'Qoder-Optimization', version }, entries }));
    return { root: pkg, catalog: file };
  };
  const old = packageAt('old-package', 'old-fixture'), next = packageAt('next-package', 'new-fixture');
  t.after(() => { assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(home, { recursive: true, force: true }); });
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [installer, '--profile', 'routing', '--client-root', client, '--catalog', next.catalog, ...args], { env, encoding: 'utf8', input: '', timeout: 120000, ...extra });
  const put = (rel, value) => { const file = path.join(client, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  return { home, client, env, old, next, run, put };
}

test('installed skill catalog follows fresh install, direct install and tier changes', t => {
  const f = fixture(t);
  const check = () => {
    const r = spawnSync(process.execPath, [path.join(f.client, 'scripts/build-skills-index.cjs'), '--check'], { env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  const installed = f.run(['--yes', '--json']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  check();
  const selected = spawnSync(process.execPath, [path.join(root, 'scripts/pkg-catalog.cjs'), 'install', 'skill:fixture-specialized', '--catalog', f.next.catalog, '--apply'], { env: f.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  check();
  for (const flag of ['--promote', '--demote']) {
    const moved = spawnSync(process.execPath, [path.join(root, 'scripts/tier-skills.cjs'), flag, 'fixture-specialized', '--apply'], { env: f.env, encoding: 'utf8', timeout: 60000 });
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    check();
  }
});

test('new install selects model workflow while an existing route selection survives reconciliation', t => {
  const f = fixture(t), target = path.join(f.client, 'scripts/rules-reminder.js');
  const { settingsFor } = require(installer);
  const fresh = JSON.parse(settingsFor(null, target).bytes);
  assert.match(fresh.hooks.UserPromptSubmit[0].hooks[0].command, /--workflow-mode model$/);
  const settings = JSON.parse(JSON.stringify(fresh));
  settings.hooks.UserPromptSubmit[0].hooks[0].command = settings.hooks.UserPromptSubmit[0].hooks[0].command.replace(' --workflow-mode model', ' --workflow-mode route');
  settings.permissions = { fixture: 'unchanged' };
  const bytes = Buffer.from(JSON.stringify(settings));
  const result = settingsFor(bytes, target);
  assert.equal(result.state, 'KEEP');
  assert.deepEqual(JSON.parse(result.bytes), settings);
  assert.equal(bytes.toString(), JSON.stringify(settings));
});

test('installer refuses invalid workflow flags rather than reverting the selected mode', t => {
  const f = fixture(t), target = path.join(f.client, 'scripts/rules-reminder.js');
  const { settingsFor } = require(installer);
  for (const flags of [' --workflow-mode automatic', ' --workflow-mode model --workflow-mode route', ' --workflow-mode model --unexpected']) {
    const settings = JSON.parse(settingsFor(null, target).bytes);
    settings.hooks.UserPromptSubmit[0].hooks[0].command += flags;
    assert.throws(() => settingsFor(Buffer.from(JSON.stringify(settings)), target), /冲突/);
  }
});

test('clean installed model workflow has its validators and remains selected on reinstallation', t => {
  const f = fixture(t);
  const first = f.run(['--yes', '--json']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const file = path.join(f.client, 'settings.json'), settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /--workflow-mode model$/);
  const next = f.run(['--yes', '--json']);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  const selected = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(selected.hooks.UserPromptSubmit[0].hooks[0].command, /--workflow-mode model$/);
  assert.equal(selected.hooks.UserPromptSubmit.length, 1);
  for (const name of ['parallel-plan.cjs', 'verification-policy.cjs']) assert.equal(fs.existsSync(path.join(f.client, 'scripts', name)), true, name);
  const result = spawnSync(process.execPath, [path.join(f.client, 'scripts/rules-reminder.js'), '--client-root', f.client, '--workflow-mode', 'model'], {
    env: f.env, input: JSON.stringify({ prompt: '分别核对两个入口后再实施', session_id: 'installed-workflow', cwd: f.home }), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /WORKFLOW_CONTEXT/);
  assert.doesNotMatch(result.stderr, /WORKFLOW_NOTE_UNAVAILABLE/);
});

test('explicit workflow mode switches an existing selection and rejects invalid values', t => {
  const f = fixture(t), target = path.join(f.client, 'scripts/rules-reminder.js');
  const { settingsFor, parseArgs } = require(installer);
  const route = JSON.parse(settingsFor(null, target, 'route').bytes);
  assert.match(route.hooks.UserPromptSubmit[0].hooks[0].command, /--workflow-mode route$/);
  const switched = settingsFor(Buffer.from(JSON.stringify(route)), target, 'model');
  assert.equal(switched.state, 'UPDATE');
  assert.match(JSON.parse(switched.bytes).hooks.UserPromptSubmit[0].hooks[0].command, /--workflow-mode model$/);
  assert.equal(parseArgs(['--workflow-mode', 'model']).workflowMode, 'model');
  for (const argv of [['--workflow-mode', 'automatic'], ['--workflow-mode', 'model', '--workflow-mode', 'route'], ['--workflow-mode']]) {
    assert.throws(() => parseArgs(argv), /workflow-mode/);
  }
});

test('private activation metadata keeps owner-only permissions on POSIX', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), file = f.put('settings.json', '{"fixtureSecret":"private"}'); fs.chmodSync(file, 0o600);
  const runner = path.join(f.home, 'private-modes.cjs');
  fs.writeFileSync(runner, `process.umask(0o022);const installer=require(${JSON.stringify(installer)});installer.apply(installer.prepare({profile:'routing',client:${JSON.stringify(f.client)},catalogFile:${JSON.stringify(f.next.catalog)}}),{yes:true});`);
  const r = spawnSync(process.execPath, [runner], { env: f.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ['settings.json', 'share-package.json', 'skills-index.json', 'package-activation.json']) assert.equal(fs.statSync(path.join(f.client, name)).mode & 0o777, 0o600, name);
});

test('default and explicit dry-run are read-only, even without SQLite', t => {
  const f = fixture(t), preload = path.join(f.home, 'no-sqlite.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(request,...args){if(request==='node:sqlite')throw new Error('SQLite must remain optional');return load.call(this,request,...args);};`);
  for (const args of [[], ['--yes', '--dry-run']]) {
    const r = f.run([...args, '--json'], { env: { ...f.env, NODE_OPTIONS: '--require ' + preload } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'DRY_RUN');
    assert.deepEqual(fs.readdirSync(f.client), []);
    assert.equal(fs.existsSync(f.env.CONTINUITY_STORE), false);
  }
});

test('--yes activates routing without SQLite and leaves new optional capabilities pending', t => {
  const f = fixture(t), preload = path.join(f.home, 'no-sqlite.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(request,...args){if(request==='node:sqlite')throw new Error('SQLite must remain optional');return load.call(this,request,...args);};`);
  const r = f.run(['--yes', '--json'], { env: { ...f.env, NODE_OPTIONS: '--require ' + preload } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ready, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.client, 'share-package.json'))).catalog, f.next.catalog);
  const settings = JSON.parse(fs.readFileSync(path.join(f.client, 'settings.json')));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /rules-reminder\.js" --client-root "/);
  for (const file of ['rules-reminder.js', 'capability-advisor.cjs', 'pkg-catalog.cjs', 'skill-load.cjs', 'build-skills-index.cjs']) assert.equal(fs.existsSync(path.join(f.client, 'scripts', file)), true, file);
  assert.equal(fs.existsSync(path.join(f.client, 'skills/skills-router/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/office-docs')), false);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/fixture-specialized')), false);
  assert.equal(fs.existsSync(path.join(f.client, 'scripts/continuity.cjs')), false);
  assert.equal(fs.existsSync(f.env.CONTINUITY_STORE), false);
  const hook = spawnSync(process.execPath, [path.join(f.client, 'scripts/rules-reminder.js')], { env: f.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '检查技能路由', cwd: f.home }), encoding: 'utf8', timeout: 10000 });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /规则提醒/);
  assert.equal(result.plan.items.find(item => item.id === 'skill:office-docs').action, 'ASK_INSTALL');
});

test('explicit continuity stays independent and JSON output remains one complete result', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.next.root, 'scripts/install-continuity.cjs'), 'console.log("fixture optional continuity unsupported");process.exit(3);');
  const catalog = JSON.parse(fs.readFileSync(f.next.catalog));
  catalog.entries.push({ id: 'script:install-continuity.cjs', name: 'install-continuity.cjs', category: 'script', status: 'shipped', source: 'scripts/install-continuity.cjs', install: { mode: 'copy-file' } });
  fs.writeFileSync(f.next.catalog, JSON.stringify(catalog));
  const r = f.run(['--yes', '--continuity', '--json']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, 'INSTALLED');
  assert.equal(result.ready, true);
  assert.equal(result.continuity.exit, 3);
  assert.match(result.continuity.stdout, /fixture optional continuity/);
  assert.equal(fs.existsSync(path.join(f.client, 'scripts/continuity.cjs')), false);
});

test('an exact current install selection can override a prior profile exclusion without changing that profile', t => {
  const f = fixture(t);
  const profile = JSON.stringify({ schema: 1, enabled: false, excludedIds: ['skill:fixture-specialized'] });
  f.put('capability-preferences.json', profile);
  const r = f.run(['--yes', '--install', 'skill:fixture-specialized', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/fixture-specialized/SKILL.md')), true);
  assert.equal(fs.readFileSync(path.join(f.client, 'capability-preferences.json'), 'utf8'), profile);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/office-docs')), false);
});

test('--resident installs the selected skill into the resident tier and refuses to move an installed skill silently', t => {
  const f = fixture(t);
  const bad = f.run(['--yes', '--resident', 'skill:fixture-specialized', '--json']);
  assert.notEqual(bad.status, 0);
  const r = f.run(['--yes', '--install', 'skill:fixture-specialized', '--resident', 'skill:fixture-specialized', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'skills/fixture-specialized/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/fixture-specialized')), false);
  const resident = JSON.parse(fs.readFileSync(path.join(f.client, 'skills-resident.json'), 'utf8'));
  assert.ok(resident.skills.includes('fixture-specialized'));
  const index = JSON.parse(fs.readFileSync(path.join(f.client, 'skills-index.json'), 'utf8'));
  assert.equal(index.entries.find(entry => entry.name === 'fixture-specialized').tier, 'core');
  const second = f.run(['--yes', '--install', 'skill:fixture-specialized', '--resident', 'skill:fixture-specialized', '--json']);
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /tier-skills --promote/);
});

test('an activated client treats the complete explicit install closure as selected despite disabled suggestions', t => {
  const f = fixture(t), initial = f.run(['--yes', '--json']);
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  const profile = JSON.stringify({ schema: 1, enabled: false, excludedIds: ['skill:fixture-specialized', 'script:client-root.js'], excludedKeywords: ['script'] });
  f.put('capability-preferences.json', profile);
  const r = f.run(['--yes', '--install', 'skill:fixture-specialized', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ready, true);
  assert.equal(result.plan.items.find(item => item.id === 'script:client-root.js').action, 'KEEP');
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/fixture-specialized/SKILL.md')), true);
  assert.equal(fs.readFileSync(path.join(f.client, 'capability-preferences.json'), 'utf8'), profile);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/office-docs')), false);
});

test('explicit dependency selection still preserves a modified installed dependency', t => {
  const f = fixture(t), initial = f.run(['--yes', '--json']);
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  const target = path.join(f.client, 'scripts/client-root.js'), modified = fs.readFileSync(target, 'utf8') + '\n// user-local fixture change\n';
  fs.writeFileSync(target, modified);
  const profile = JSON.stringify({ schema: 1, enabled: false, excludedIds: ['skill:fixture-specialized', 'script:client-root.js'] });
  f.put('capability-preferences.json', profile);
  const r = f.run(['--yes', '--install', 'skill:fixture-specialized', '--json']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, 'ACTIVATION_BLOCKED');
  assert.equal(result.pendingItems.some(item => item.id === 'script:client-root.js' && item.action === 'REVIEW_UPDATE'), true);
  assert.equal(fs.readFileSync(target, 'utf8'), modified);
  assert.equal(fs.readFileSync(path.join(f.client, 'capability-preferences.json'), 'utf8'), profile);
});

test('existing settings and unrelated installed skills survive activation and real index generation', t => {
  const f = fixture(t);
  f.put('settings.json', JSON.stringify({ opaqueSetting: 'fixture-private-value', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'existing-hook', timeout: 4 }] }], Stop: [] } }));
  f.put('skills-library/unrelated-user-skill/SKILL.md', '---\nname: unrelated-user-skill\ndescription: User metadata stays present.\n---\nUser content.\n');
  const r = f.run(['--yes', '--json']); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /fixture-private-value|settingsBytes|sourceBefore/);
  const settings = JSON.parse(fs.readFileSync(path.join(f.client, 'settings.json')));
  assert.equal(settings.opaqueSetting, 'fixture-private-value');
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'existing-hook');
  const index = JSON.parse(fs.readFileSync(path.join(f.client, 'skills-index.json')));
  assert.equal(index.entries.some(entry => entry.name === 'unrelated-user-skill'), true);
  for (const entry of index.entries) { assert.equal(fs.existsSync(entry.path), true, entry.path); assert.equal(entry.path.includes('.package-activation-'), false, entry.path); }
  const again = f.run(['--yes', '--json']); assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.client, 'settings.json'))).hooks.UserPromptSubmit.length, 2);
});

test('--yes updates only pristine old-package copies and preserves local edits', t => {
  const f = fixture(t), file = f.put('scripts/fixture-update.js', fs.readFileSync(path.join(f.old.root, 'scripts/fixture-update.js')));
  f.put('share-package.json', JSON.stringify({ catalog: f.old.catalog }));
  const r = f.run(['--yes', '--json']); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).plan.items.find(item => item.id === 'script:fixture-update.js').action, 'UPDATE');
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(f.next.root, 'scripts/fixture-update.js'), 'utf8'));
  fs.writeFileSync(file, 'user local edits');
  const edited = f.run(['--yes', '--json']); assert.equal(edited.status, 0, edited.stdout + edited.stderr);
  assert.equal(JSON.parse(edited.stdout).plan.items.find(item => item.id === 'script:fixture-update.js').action, 'REVIEW_UPDATE');
  assert.equal(fs.readFileSync(file, 'utf8'), 'user local edits');
});

test('an upgrade that changes the index builder and a skill stages unchanged sibling modules', t => {
  const f = fixture(t);
  const runCatalog = catalog => spawnSync(process.execPath, [installer, '--profile', 'routing', '--client-root', f.client, '--catalog', catalog, '--yes', '--json'], { env: f.env, encoding: 'utf8', input: '', timeout: 120000 });
  const first = runCatalog(f.old.catalog);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  fs.appendFileSync(path.join(f.next.root, 'scripts/build-skills-index.cjs'), '\n// next fixture revision\n');
  fs.appendFileSync(path.join(f.next.root, 'skills/skills-router/SKILL.md'), '\n<!-- next fixture revision -->\n');
  const upgrade = runCatalog(f.next.catalog);
  assert.equal(upgrade.status, 0, upgrade.stdout + upgrade.stderr);
  assert.equal(JSON.parse(upgrade.stdout).status, 'INSTALLED');
  assert.match(fs.readFileSync(path.join(f.client, 'skills/skills-router/SKILL.md'), 'utf8'), /next fixture revision/);
  assert.match(fs.readFileSync(path.join(f.client, 'scripts/build-skills-index.cjs'), 'utf8'), /next fixture revision/);
  assert.equal(fs.existsSync(path.join(f.client, 'scripts/client-root.js')), true);
  const index = JSON.parse(fs.readFileSync(path.join(f.client, 'skills-index.json'), 'utf8'));
  assert.equal(index.entries.some(entry => entry.name === 'skills-router'), true);
});

test('a locally changed base blocks activation and retains the old package pointer', t => {
  const f = fixture(t);
  const pointer = JSON.stringify({ catalog: f.old.catalog }); f.put('share-package.json', pointer);
  f.put('scripts/rules-reminder.js', 'user local reminder');
  const independent = f.put('scripts/fixture-update.js', fs.readFileSync(path.join(f.old.root, 'scripts/fixture-update.js')));
  const r = f.run(['--yes', '--json']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).status, 'ACTIVATION_BLOCKED');
  assert.equal(fs.readFileSync(path.join(f.client, 'share-package.json'), 'utf8'), pointer);
  assert.equal(fs.readFileSync(path.join(f.client, 'scripts/rules-reminder.js'), 'utf8'), 'user local reminder');
  assert.equal(fs.existsSync(path.join(f.client, 'settings.json')), false);
  assert.equal(fs.readFileSync(independent, 'utf8'), fs.readFileSync(path.join(f.next.root, 'scripts/fixture-update.js'), 'utf8'));
});

test('an independent update still installs its new required dependency while base activation is blocked', t => {
  const f = fixture(t);
  f.put('share-package.json', JSON.stringify({ catalog: f.old.catalog }));
  f.put('scripts/rules-reminder.js', 'user local reminder');
  f.put('scripts/fixture-update.js', fs.readFileSync(path.join(f.old.root, 'scripts/fixture-update.js')));
  fs.writeFileSync(path.join(f.next.root, 'scripts/fixture-update.js'), "require('./client-root.js');\nconsole.log('new-fixture');\n");
  const r = f.run(['--yes', '--json']); assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'scripts/client-root.js')), true);
  assert.equal(fs.existsSync(path.join(f.client, 'settings.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.client, 'share-package.json'))).catalog, f.old.catalog);
});

test('conflicting hook wiring rejects the entire install before any publication', t => {
  const f = fixture(t);
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', timeout: 10, command: 'node /somewhere/rules-reminder.js --unexpected' }] }] } });
  f.put('settings.json', text);
  const r = f.run(['--yes']); assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(f.client), ['settings.json']);
  assert.equal(fs.readFileSync(path.join(f.client, 'settings.json'), 'utf8'), text);
});

test('a legacy two-argument hook upgrades to a same-client binding and stays idempotent', t => {
  const f = fixture(t), target = path.join(f.client, 'scripts/rules-reminder.js');
  f.put('settings.json', JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', timeout: 10, command: '"' + process.execPath + '" "' + target + '"' }] }] } }));
  const first = f.run(['--yes', '--json']); assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(JSON.parse(first.stdout).receipt.hook, 'UPDATE');
  const bytes = fs.readFileSync(path.join(f.client, 'settings.json'));
  const settings = JSON.parse(bytes);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, '"' + process.execPath + '" "' + target + '" --client-root "' + f.client + '"');
  const second = f.run(['--yes', '--json']); assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(JSON.parse(second.stdout).receipt.hook, 'KEEP');
  assert.deepEqual(fs.readFileSync(path.join(f.client, 'settings.json')), bytes);
});

for (const variant of ['different-client', 'relative-client', 'extra-argument', 'duplicate-client']) {
  test('hook migration rejects unapproved client bindings or trailing arguments: ' + variant, t => {
    const f = fixture(t), target = path.join(f.client, 'scripts/rules-reminder.js');
    const tail = variant === 'different-client' ? '--client-root "' + path.join(f.home, 'other-client') + '"' : variant === 'relative-client' ? '--client-root client' : variant === 'extra-argument' ? '--client-root "' + f.client + '" --unexpected' : '--client-root "' + f.client + '" --client-root "' + f.client + '"';
    const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', timeout: 10, command: '"' + process.execPath + '" "' + target + '" ' + tail }] }] } });
    f.put('settings.json', text);
    const r = f.run(['--yes']); assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(f.client), ['settings.json']);
    assert.equal(fs.readFileSync(path.join(f.client, 'settings.json'), 'utf8'), text);
  });
}

for (const race of [false, true]) {
  test('settings publication failure rolls back owned routing and preserves other writes: race=' + race, t => {
    const f = fixture(t), target = f.put('settings.json', '{"preserve":"prior"}');
    const preload = path.join(f.home, 'publication-failure.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs'),rename=fs.renameSync,open=fs.openSync;let fired=false;const target=${JSON.stringify(target)};
      fs.renameSync=function(from,to){if(${race}&&!fired&&from===target){fired=true;fs.writeFileSync(target,'{"preserve":"concurrent"}');}return rename.call(this,from,to);};
      fs.openSync=function(file,flags,...args){if(!${race}&&file===target&&flags==='wx')throw new Error('fixture settings publication failure');return open.call(this,file,flags,...args);};`);
    const r = f.run(['--yes'], { env: { ...f.env, NODE_OPTIONS: '--require ' + preload } });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(target, 'utf8'), race ? '{"preserve":"concurrent"}' : '{"preserve":"prior"}');
    assert.equal(fs.existsSync(path.join(f.client, 'scripts/rules-reminder.js')), false);
    assert.equal(fs.existsSync(path.join(f.client, 'share-package.json')), false);
    assert.equal(fs.existsSync(path.join(f.client, 'skills-index.json')), false);
    const stages = fs.readdirSync(f.client).filter(name => name.startsWith('.package-activation-'));
    assert.equal(stages.length, 1);
    assert.equal(fs.existsSync(path.join(f.client, stages[0], 'transaction.json')), true);
  });
}

test('rollback preserves a concurrent replacement of an installer-owned script', t => {
  const f = fixture(t), settings = f.put('settings.json', '{"preserve":"prior"}');
  const target = path.join(f.client, 'scripts/rules-reminder.js'), preload = path.join(f.home, 'rollback-race.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs'),rename=fs.renameSync,open=fs.openSync,unlink=fs.unlinkSync;let failed=false,fired=false;const target=${JSON.stringify(target)};
    function race(file){if(failed&&!fired&&file===target){fired=true;fs.writeFileSync(target,'concurrent writer content');}}
    fs.openSync=function(file,flags,...args){if(file===${JSON.stringify(settings)}&&flags==='wx'){failed=true;throw new Error('fixture settings publication failure');}return open.call(this,file,flags,...args);};
    fs.renameSync=function(from,to){race(from);return rename.call(this,from,to);};
    fs.unlinkSync=function(file){race(file);return unlink.call(this,file);};`);
  const r = f.run(['--yes'], { env: { ...f.env, NODE_OPTIONS: '--require ' + preload } });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent writer content');
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"preserve":"prior"}');
});

test('target child junctions escaping the authorized client are refused', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), outside = path.join(f.home, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.client, 'scripts'), 'junction');
  const r = f.run(['--yes']); assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(f.client, 'share-package.json')), false);
});

test('the Windows wrapper runs the package entry and preserves a custom client argument', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), wrapper = path.join(f.home, 'install.cmd'), output = path.join(f.home, 'wrapper-args.json');
  fs.copyFileSync(path.join(root, 'install.cmd'), wrapper);
  fs.mkdirSync(path.join(f.home, 'scripts'));
  fs.writeFileSync(path.join(f.home, 'scripts/install-package.cjs'), 'require("node:fs").writeFileSync(' + JSON.stringify(output) + ',JSON.stringify(process.argv.slice(2)));');
  fs.writeFileSync(path.join(f.home, 'scripts/install-continuity.cjs'), 'throw new Error("continuity was not selected");');
  const custom = path.join(f.home, 'custom client');
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'install.cmd --yes --client-root "' + custom + '"'], { cwd: f.home, env: f.env, encoding: 'utf8', input: '', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), ['--yes', '--client-root', custom]);
});

for (const mode of ['original-persistent', 'original-transient', 'frozen-transient', 'original-executor']) {
  test('unapproved source bytes never publish or execute: ' + mode, t => {
    const f = fixture(t), runner = path.join(f.home, 'source-race.cjs');
    const transient = mode.endsWith('transient'), frozen = mode === 'frozen-transient', executor = mode === 'original-executor';
    fs.writeFileSync(runner, `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),real=cp.spawnSync;
      const installer=${JSON.stringify(installer)},client=${JSON.stringify(f.client)},catalogFile=${JSON.stringify(f.next.catalog)};
      const plan=require(installer).prepare({profile:'routing',client,catalogFile}),source=path.join(${JSON.stringify(f.next.root)},${JSON.stringify(executor ? 'scripts/pkg-catalog.cjs' : 'scripts/rules-reminder.js')}),approved=fs.readFileSync(source),executionMarker=${JSON.stringify(path.join(f.home, 'unapproved-execution-marker'))};let fired=false;const entriesUsed=[];
      cp.spawnSync=function(command,args,options){if(Array.isArray(args)&&String(args[0]).endsWith('pkg-catalog.cjs'))entriesUsed.push(args[0]);if(Array.isArray(args)&&args[0]==='-e')entriesUsed.push(args[2]);if(!fired&&Array.isArray(args)&&String(args[0]).endsWith('pkg-catalog.cjs')&&args.includes('install')&&(!${transient}||args.includes('script:rules-reminder.js'))){fired=true;const changed=${frozen} ? path.join(path.dirname(args[0]),'rules-reminder.js') : source;fs.writeFileSync(changed,Buffer.concat([approved,Buffer.from(${JSON.stringify(executor ? '\nrequire("node:fs").writeFileSync(' + JSON.stringify(path.join(f.home, 'unapproved-execution-marker')) + ',"unapproved");\n' : '\n// UNAPPROVED_SOURCE_RACE_FIXTURE\n')})]));try{return real(command,args,options);}finally{if(${transient})fs.writeFileSync(changed,approved);}}return real(command,args,options);};
      delete require.cache[require.resolve(installer)];let result,error;try{result=require(installer).apply(plan,{yes:true});}catch(e){error=e.message;}
      console.log(JSON.stringify({fired,error,status:result?.status,ready:result?.ready,entriesUsed,unapprovedExecuted:fs.existsSync(executionMarker),sourceRestored:fs.readFileSync(source).equals(approved),files:fs.readdirSync(client)}));`);
    const r = spawnSync(process.execPath, [runner], { env: f.env, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.fired, true);
    assert.equal(result.unapprovedExecuted, false, r.stdout);
    assert.equal(result.entriesUsed.every(entry => entry.includes(path.sep + 'frozen-package' + path.sep)), true, r.stdout);
    if (transient) assert.equal(result.sourceRestored, true);
    const installed = path.join(f.client, 'scripts/rules-reminder.js');
    if (fs.existsSync(installed)) assert.doesNotMatch(fs.readFileSync(installed, 'utf8'), /UNAPPROVED_SOURCE_RACE_FIXTURE/);
    if (mode === 'original-transient' && result.status === 'INSTALLED') {
      assert.equal(result.ready, true);
      assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(path.join(f.next.root, 'scripts/rules-reminder.js')));
      return;
    }
    assert.equal(typeof result.error, 'string', r.stdout);
    assert.notEqual(result.ready, true, r.stdout);
    assert.equal(result.files.length, 1, r.stdout);
    assert.match(result.files[0], /^\.package-activation-/);
    const transaction = JSON.parse(fs.readFileSync(path.join(f.client, result.files[0], 'transaction.json')));
    assert.equal(transaction.status, 'ROLLED_BACK');
    assert.equal(fs.existsSync(path.join(f.client, 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(f.client, 'share-package.json')), false);
    assert.equal(fs.existsSync(path.join(f.client, 'scripts')), false);
  });
}

test('ignored source backups are outside the approved public copy proof', t => {
  const f = fixture(t), runner = path.join(f.home, 'ignored-backup.cjs');
  fs.writeFileSync(runner, `const fs=require('node:fs'),installer=require(${JSON.stringify(installer)});
    const plan=installer.prepare({profile:'routing',client:${JSON.stringify(f.client)},catalogFile:${JSON.stringify(f.next.catalog)}});
    fs.writeFileSync(${JSON.stringify(path.join(f.next.root, 'skills/skills-router/SKILL.md.bak-fixture'))},'ignored fixture backup');
    console.log(JSON.stringify(installer.apply(plan,{yes:true}).receipt));`);
  const r = spawnSync(process.execPath, [runner], { env: f.env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ready, true);
  assert.equal(fs.existsSync(path.join(f.client, 'skills/skills-router/SKILL.md.bak-fixture')), false);
});

test('completed exact/base choices leave only unselected generic candidates pending', t => {
  const f = fixture(t);
  const dry = f.run(['--yes', '--dry-run', '--install', 'skill:office-docs', '--json']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  const preview = JSON.parse(dry.stdout);
  assert.equal(preview.status, 'DRY_RUN');
  assert.equal(preview.pendingItems.some(item => item.id === 'skill:office-docs'), true);
  assert.deepEqual(fs.readdirSync(f.client), []);
  const r = f.run(['--yes', '--install', 'skill:office-docs', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout), pending = result.pendingItems.map(item => item.id);
  assert.equal(pending.includes('skill:office-docs'), false);
  for (const id of BASE_IDS) assert.equal(pending.includes(id), false, id);
  assert.equal(pending.includes('skill:write-repowiki'), true);
  assert.equal(result.nextActions.includes('ASK_INSTALL'), true);
  assert.equal(result.nextAction, 'ASK_INSTALL_OR_UPDATE');
  const text = f.run(['--yes']); assert.equal(text.status, 0, text.stdout + text.stderr);
  const asks = text.stdout.split('ASK_INSTALL:')[1].split('REVIEW_UPDATE:')[0];
  assert.match(asks, /skill:write-repowiki/);
  assert.doesNotMatch(asks, /skill:office-docs|rules-reminder|skills-router/);
  assert.match(text.stdout, /NEXT_ACTION: ASK_INSTALL_OR_UPDATE/);
});

test('authorized but blocked base installation is reported as blocked, never requested again', t => {
  const f = fixture(t);
  f.put('scripts/rules-reminder.js', 'user-owned existing reminder');
  const r = f.run(['--yes', '--json']); assert.equal(r.status, 3, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, 'ACTIVATION_BLOCKED');
  assert.equal(result.pendingItems.some(item => item.id === 'script:rules-reminder.js' && item.action === 'REVIEW_UPDATE'), true);
  for (const id of BASE_IDS) assert.equal(result.pendingItems.some(item => item.id === id && item.action === 'ASK_INSTALL'), false, id);
  assert.equal(result.blockedItems.some(item => item.id === 'script:skill-load.cjs' && item.requiresConfirmation === false), true);
  assert.equal(result.pendingItems.some(item => item.id === 'skill:office-docs' && item.action === 'ASK_INSTALL'), true);
});

test('reinstallation through a client directory alias keeps the same physical hook scope', t => {
  const f = fixture(t), first = f.run(['--yes', '--json']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const file = path.join(f.client, 'settings.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  original.fixtureSetting = 'preserve user settings';
  fs.writeFileSync(file, JSON.stringify(original));
  const alias = path.join(f.home, 'client alias with spaces');
  fs.symlinkSync(f.client, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(f.client));
  const args = [installer, '--profile', 'routing', '--client-root', alias, '--catalog', f.next.catalog, '--yes', '--json'];
  const invoke = () => spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8', timeout: 120000 });
  const updated = invoke();
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  const selected = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(selected.fixtureSetting, original.fixtureSetting);
  assert.equal(selected.hooks.UserPromptSubmit.length, 1);
  const command = selected.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(command.includes('"' + path.join(alias, 'scripts/rules-reminder.js') + '"'));
  assert.ok(command.includes('--client-root "' + alias + '"'));
  assert.match(command, /--workflow-mode model$/);
  const second = invoke();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command, command);
  const env = { ...f.env }; delete env.QODER_HOME;
  const hook = spawnSync(process.execPath, [path.join(alias, 'scripts/rules-reminder.js'), '--client-root', alias, '--workflow-mode', 'model'], {
    cwd: f.home, env, encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({ prompt: '分别分析两个模块并修复问题', session_id: 'alias-scope', cwd: f.home }),
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /WORKFLOW_CONTEXT/);
  assert.doesNotMatch(hook.stderr, /WORKFLOW_NOTE_UNAVAILABLE/);
});

for (const variant of ['different-script', 'different-client-root']) {
  test('physical alias support still rejects another real client: ' + variant, t => {
    const f = fixture(t), target = f.put('scripts/rules-reminder.js', 'same script bytes');
    const other = path.join(f.home, 'different-real-client');
    const otherScript = path.join(other, 'scripts/rules-reminder.js');
    fs.mkdirSync(path.dirname(otherScript), { recursive: true });
    fs.writeFileSync(otherScript, fs.readFileSync(target));
    const { settingsFor } = require(installer);
    const settings = JSON.parse(settingsFor(null, target).bytes);
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
    hook.command = variant === 'different-script'
      ? hook.command.replace('"' + target + '"', '"' + otherScript + '"')
      : hook.command.replace('--client-root "' + f.client + '"', '--client-root "' + other + '"');
    assert.throws(() => settingsFor(Buffer.from(JSON.stringify(settings)), target), /冲突/);
  });
}
