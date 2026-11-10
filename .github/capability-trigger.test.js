'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const marker = '【当前任务能力建议】';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-trigger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = path.join(dir, 'client'), scripts = path.join(dir, 'hook'), pkg = path.join(dir, 'package');
  for (const folder of [path.join(client, 'scripts'), scripts, pkg]) fs.mkdirSync(folder, { recursive: true });
  for (const name of ['rules-reminder.js', 'client-root.js', 'capability-roots.cjs', 'hook-crash-guard.js', 'goal-candidate-core.js', 'verification-trigger-core.js', 'recheck-protocol.cjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name));
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  // A deterministic advisor boundary keeps these tests about the hook, not a
  // second copy of catalog matching. Actual advisor semantics have their own suite.
  write(path.join(scripts, 'capability-advisor.cjs'), `exports.planCapabilities = options => {
    const fs = require('node:fs');
    const data = JSON.parse(fs.readFileSync(options.catalogFile, 'utf8'));
    if (options.phase !== 'task') throw new Error('wrong phase');
    return {schema:1,items:data.adviceItems||[],summary:{}};
  };`);
  const catalog = path.join(pkg, 'catalog.json');
  write(catalog, { schema: 1, entries: [], adviceItems: [] });
  const register = () => write(path.join(client, 'share-package.json'), { catalog });
  const setItems = items => write(catalog, { schema: 1, entries: [], adviceItems: items });
  const skill = (name = 'browser-helper', action = 'ASK_USE') => {
    const entryPath = path.join(client, 'skills', name, 'SKILL.md');
    write(entryPath, '# ' + name + '\nUse this installed skill.\n');
    return { id: 'skill:' + name, name, category: 'skill', action, reason: 'TASK_MATCH', installedPath: path.dirname(entryPath), installedPaths: [path.dirname(entryPath)], entryPath, generic: true, matched: true };
  };
  const env = { ...process.env, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), QODER_HOME: client };
  const invoke = (script, prompt = '修复浏览器页面', ...sessionIds) => {
    const session_id = sessionIds.length ? sessionIds[0] : 'session-a';
    const r = spawnSync(process.execPath, [script], { env, cwd: dir, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id }), encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const run = (...args) => invoke(path.join(scripts, 'rules-reminder.js'), ...args);
  const runActual = (...args) => invoke(path.join(root, 'scripts/rules-reminder.js'), ...args);
  return { dir, client, scripts, pkg, catalog, write, register, setItems, skill, env, run, runActual };
}

function workflowHook(f, prompt, extra = [], target = path.join(root, 'scripts/rules-reminder.js')) {
  return spawnSync(process.execPath, [target, '--workflow-mode', 'model', ...extra], {
    env: f.env, cwd: f.dir, input: JSON.stringify({ prompt, session_id: 'workflow-native-shape', cwd: f.dir }), encoding: 'utf8', timeout: 20000,
  });
}

test('model mode injects a bound decision contract and keeps the explicit verification and goal asks', t => {
  const f = fixture(t);
  const result = workflowHook(f, '实现多个模块，部署验收后提交；再判断是否成文');
  assert.equal(result.status, 0, result.stderr);
  const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /【工作方式 · 模型判断】/);
  assert.match(text, /【B05 自动选档 · 已触发】/);
  assert.match(text, /用 AskUserQuestion 原样提问/);
  assert.match(text, /【目标候选 · 需弹窗确认】/);
  assert.match(text, /用 AskUserQuestion 同轮询问两项/);
  assert.match(text, /并行可先出计划/);
  assert.match(text, /文档、目标与并行统一并入开工确认卡/);
  assert.match(text, /含混自检/);
  assert.match(text, /能力自检/);
  assert.match(text, /多种合理解读/);
  const reminder = text.split('【工作方式 · 模型判断】')[0];
  assert.match(reminder, /含混自检/);
  assert.match(reminder, /能力自检/);
  assert.match(reminder, /除简单纯问答外/);
  assert.doesNotMatch(reminder, /全项目\/多模块\/多端\/多文件\/多版本任务先按 parallel-orchestration|中大型、多阶段或审查\+成文任务先用 AskUserQuestion/);
  const context = JSON.parse(text.match(/^WORKFLOW_CONTEXT (.+)$/m)[1]);
  const binding = text.match(/^WORKFLOW_BINDING ([a-f0-9]{64})$/m)[1];
  const advisor = require('../scripts/capability-advisor.cjs');
  assert.equal(binding, advisor.workflowBinding(context));
  const input = { schema: 1, context, model: { schema: 1, bindingDigest: binding, taskId: 'native-shape', intent: 'execute', confidence: 'high', sourceRefs: ['request:current'], reason: '任务需要持续推进，但必须保留用户批准', parallel: 'skip', goal: 'recommend', verification: 'skip', documentation: 'skip' } };
  const evaluated = advisor.evaluateWorkflowDecision(input, binding);
  assert.equal(evaluated.goal.action, 'CHECK_ACTIVE_GOAL_THEN_ASK_IF_NEEDED');
  assert.equal(evaluated.authorizesExecution, false);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/capability-advisor/sessions')), false);
});

test('the actual model hook emits executable argv and a local shell command for a quoted client path', t => {
  const f = fixture(t);
  const client = path.join(f.dir, "client with spaces and quote's $value");
  const advisor = path.join(client, 'scripts', 'capability-advisor.cjs');
  const implementation = path.join(root, 'scripts', 'capability-advisor.cjs');
  f.env.QODER_HOME = client;
  // The installed entry forwards CLI execution while its require path exposes
  // the real implementation; no model, service or live client is involved.
  f.write(advisor, `if (require.main === module) { const child = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(implementation)}, ...process.argv.slice(2)], {stdio:'inherit'}); process.exitCode = child.status === null ? 1 : child.status; } else module.exports = require(${JSON.stringify(implementation)});`);
  const hook = workflowHook(f, '请帮我只读审查这两个模块');
  assert.equal(hook.status, 0, hook.stderr);
  const note = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  const context = JSON.parse(note.match(/^WORKFLOW_CONTEXT (.+)$/m)[1]);
  const binding = note.match(/^WORKFLOW_BINDING (.+)$/m)[1];
  const command = JSON.parse(note.match(/^WORKFLOW_COMMAND (.+)$/m)[1]);
  assert.equal(context.restrictions.readOnly, true);
  assert.equal(command.args[0], advisor);
  const input = JSON.stringify({ schema: 1, context, model: {
    schema: 1, bindingDigest: binding, taskId: 'installed-hook', intent: 'execute', confidence: 'high',
    sourceRefs: ['request:current'], reason: 'explicit read-only request', parallel: 'skip', goal: 'recommend', verification: 'skip', documentation: 'recommend',
  } });
  const options = { env: f.env, cwd: f.dir, input, encoding: 'utf8', timeout: 60000, windowsHide: true };
  const direct = spawnSync(command.executable, command.args, options);
  assert.equal(direct.status, 0, direct.stderr);
  const shell = JSON.parse(note.match(/^WORKFLOW_SHELL_COMMAND (.+)$/m)[1]);
  const viaShell = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', shell], options)
    : spawnSync('/bin/sh', ['-c', shell], options);
  assert.equal(viaShell.status, 0, viaShell.stderr);
  for (const child of [direct, viaShell]) {
    const result = JSON.parse(child.stdout);
    assert.equal(result.authorizesExecution, false);
    assert.equal(result.goal.action, 'TASK_LIST');
    assert.equal(result.documentation.action, 'NONE');
    assert.ok(result.reasonCodes.includes('READ_ONLY_SCOPE'));
  }
});

test('model mode keeps capability routing and explicit current choices authoritative', t => {
  const f = fixture(t);
  const installed = f.skill('parallel-orchestration');
  const entry = { id: installed.id, name: installed.name, category: 'skill', status: 'shipped', tier: 'library', source: 'skills/parallel-orchestration', description: 'parallel orchestration', install: { mode: 'copy-skill', tier: 'library' }, dependencies: [] };
  f.write(path.join(f.pkg, entry.source, 'SKILL.md'), fs.readFileSync(installed.entryPath, 'utf8'));
  f.write(f.catalog, { schema: 1, entries: [entry] }); f.register();
  let result = workflowHook(f, '把多个模块并行审查');
  assert.equal(result.status, 0, result.stderr);
  let text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /【当前任务能力建议】/);
  assert.match(text, /parallel-orchestration（AUTO_USE）/);
  assert.match(text, /已自动触发/);
  assert.match(text, /不得自动派发 worker/);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/capability-advisor/sessions')), true);
  result = workflowHook(f, '请使用 parallel-orchestration 审查模块');
  text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /本轮已明确指定 parallel-orchestration/);
  assert.doesNotMatch(text, /是否使用 parallel-orchestration/);
});

test('model mode restores the capability use question for ASK_USE candidates', t => {
  const f = fixture(t), item = f.skill(); f.setItems([item]); f.register();
  // The fixture advisor boundary supplies adviceItems; the copied hook uses it.
  const result = workflowHook(f, '修复浏览器页面', [], path.join(f.scripts, 'rules-reminder.js'));
  assert.equal(result.status, 0, result.stderr);
  const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /【当前任务能力建议】/);
  assert.match(text, /browser-helper（ASK_USE）/);
  assert.match(text, /用 AskUserQuestion 提问/);
  assert.match(text, /是否使用 browser-helper 来完成当前任务/);
});

test('model mode cannot silently fall back when optional decision support or identity is absent', t => {
  const f = fixture(t);
  const result = workflowHook(f, '实现多个模块，部署验收后提交', [], path.join(f.scripts, 'rules-reminder.js'));
  assert.equal(result.status, 0, result.stderr);
  const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /模型判断不可绑定/);
  assert.match(result.stderr, /WORKFLOW_NOTE_UNAVAILABLE/);
  assert.match(text, /【B05 自动选档 · 已触发】/);
  assert.match(text, /【目标候选 · 需弹窗确认】/);
  const missingIdentity = spawnSync(process.execPath, [path.join(root, 'scripts/rules-reminder.js'), '--workflow-mode', 'model'], { env: f.env, cwd: f.dir, input: JSON.stringify({ prompt: '实现完整功能并提交' }), encoding: 'utf8', timeout: 20000 });
  assert.equal(missingIdentity.status, 0);
  const missingText = JSON.parse(missingIdentity.stdout).hookSpecificOutput.additionalContext;
  assert.match(missingText, /模型判断不可绑定/);
  assert.match(missingText, /【B05 自动选档 · 已触发】/);
});

test('workflow route mode preserves default output and malformed model flags do not select another mode', t => {
  const f = fixture(t), target = path.join(root, 'scripts/rules-reminder.js');
  const input = JSON.stringify({ prompt: '实现完整功能并部署验收后提交', session_id: 'route-isolation', cwd: f.dir });
  const options = { env: f.env, cwd: f.dir, input, encoding: 'utf8', timeout: 20000 };
  const original = spawnSync(process.execPath, [target], options);
  const route = spawnSync(process.execPath, [target, '--workflow-mode', 'route'], options);
  assert.equal(original.status, 0); assert.equal(route.status, 0);
  assert.equal(route.stdout, original.stdout);
  for (const args of [['--workflow-mode'], ['--workflow-mode', 'automatic'], ['--workflow-mode', 'model', '--workflow-mode', 'route']]) {
    const result = spawnSync(process.execPath, [target, ...args], options);
    assert.equal(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /RULES_REMINDER_WORKFLOW_MODE_INVALID/);
  }
});

test('an existing verification opt-out remains a veto in model mode', t => {
  const f = fixture(t);
  f.write(path.join(f.client, 'verification-trigger.json'), { enabled: false });
  const result = workflowHook(f, '实现完整功能并测试');
  const text = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  const context = JSON.parse(text.match(/^WORKFLOW_CONTEXT (.+)$/m)[1]);
  assert.equal(context.restrictions.verification, true);
  assert.doesNotMatch(text, /【B05 自动选档 · 已触发】/);
});

test('registered installed capability becomes a concrete use question once per request', t => {
  const f = fixture(t), item = f.skill(); f.setItems([item]); f.register();
  const prompt = '修复浏览器页面，保留 PRIVATE_PROMPT_SENTINEL 不写台账';
  const first = f.run(prompt);
  assert.match(first, /是否使用 browser-helper 来完成当前任务/);
  assert.ok(first.includes(item.entryPath.replace(/\\/g, '/')));
  assert.match(first, /AskUserQuestion/);
  assert.equal(f.run(prompt).includes(marker), false);
  // 同一会话的新请求仍要能重新推荐；只有同一请求重试才去重。
  assert.equal(f.run('修复浏览器页面并补充截图', 'session-a').includes(marker), true);
  assert.equal(f.run(prompt, 'session-b').includes(marker), true);
  const runtime = path.join(f.client, 'tmp/capability-advisor');
  const files = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else files.push(file); } };
  walk(runtime);
  const ledger = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.match(ledger, /delivered/);
  assert.match(ledger, /skill:browser-helper/);
  assert.equal(ledger.includes('PRIVATE_PROMPT_SENTINEL'), false);
  assert.equal(ledger.includes('session-a'), false);
});

test('AUTO_USE injects an auto-load directive without a use question and dedupes per request', t => {
  const f = fixture(t), item = f.skill('parallel-orchestration', 'AUTO_USE'); f.setItems([item]); f.register();
  const text = f.run('把订单、用户、报表三个模块拆分开发', 'auto-a');
  const capabilityLine = text.split('\n').find(line => line.includes('parallel-orchestration（AUTO_USE）')) || '';
  assert.match(capabilityLine, /已自动触发/);
  assert.ok(capabilityLine.includes(item.entryPath.replace(/\\/g, '/')));
  assert.match(capabilityLine, /计划.*确认/);
  assert.doesNotMatch(capabilityLine, /是否使用|AskUserQuestion/);
  assert.equal(f.run('把订单、用户、报表三个模块拆分开发', 'auto-a').includes(marker), false);
  assert.equal(f.run('订单、用户、报表三个模块要并行拆分', 'auto-a').includes(marker), true);
  assert.equal(f.run('把订单、用户、报表三个模块拆分开发', 'auto-b').includes(marker), true);
});

test('local library skill auto-loads without any registered package and is not permanently deduped', t => {
  const f = fixture(t);
  const file = path.join(f.client, 'skills-library/postgresql/SKILL.md');
  f.write(file, '---\nname: postgresql\ndescription: PostgreSQL 开发指南。触发词：PostgreSQL、慢查询\n---\n# postgresql\n');
  const first = f.runActual('排查 PostgreSQL 慢查询', 'local-a');
  const line = first.split('\n').find(item => item.includes('postgresql（AUTO_LOAD）')) || '';
  assert.match(line, /读取入口/);
  assert.ok(line.includes(file.replace(/\\/g, '/')));
  assert.match(line, /只读/);
  assert.doesNotMatch(line, /是否使用|AskUserQuestion/);
  assert.match(f.runActual('排查 PostgreSQL 慢查询', 'local-a'), /postgresql（AUTO_LOAD）/);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/capability-advisor/sessions')), false);
});

test('the actual hook honors explicit local choices and current refusals without a registered package', t => {
  const f = fixture(t);
  for (const name of ['sql', 'db', 'mysql-review']) f.write(path.join(f.client, 'skills-library', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} helper\n---\n`);
  f.write(path.join(f.client, 'capability-preferences.json'), { schema: 1, enabled: false, excludedIds: ['skill:sql', 'skill:db'] });
  const selected = f.runActual('请使用 sql 排查 MySQL 查询，同时使用 db 检查连接', 'selected-local');
  assert.match(selected, /已明确指定 sql/); assert.match(selected, /已明确指定 db/);
  assert.doesNotMatch(selected, /mysql-review（AUTO_LOAD）/);
  f.write(path.join(f.client, 'capability-preferences.json'), { schema: 1 });
  assert.equal(f.runActual('本次不要使用 mysql-review 检查 MySQL', 'declined-local').includes(marker), false);
});

test('the installed hook command selects model mode and binds a custom client without an inherited QODER_HOME', t => {
  const f = fixture(t), item = f.skill(); f.setItems([item]); f.register();
  fs.cpSync(f.scripts, path.join(f.client, 'scripts'), { recursive: true });
  const { settingsFor } = require('../scripts/install-package.cjs');
  const settings = JSON.parse(settingsFor(null, path.join(f.client, 'scripts/rules-reminder.js')).bytes);
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(command, /--workflow-mode model$/);
  const args = [...command.matchAll(/"([^"\r\n]*)"|([^\s]+)/g)].map(match => match[1] ?? match[2]);
  const env = { ...f.env }; delete env.QODER_HOME;
  const r = spawnSync(args[0], args.slice(1), { env, cwd: f.dir, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '修复浏览器页面', session_id: 'custom-profile' }), encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(text, /browser-helper/);
  assert.equal(fs.existsSync(path.join(env.HOME, '.qoder')), false, 'hook wrote to a different default client');
});

test('malformed explicit client binding never falls back to another client', t => {
  const f = fixture(t), env = { ...f.env }; delete env.QODER_HOME;
  for (const args of [['--client-root'], ['--client-root', 'relative'], ['--client-root', f.client, '--client-root', f.client]]) {
    const r = spawnSync(process.execPath, [path.join(f.scripts, 'rules-reminder.js'), ...args], { env, cwd: f.dir, input: '{}', encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, ''); assert.match(r.stderr, /RULES_REMINDER_CLIENT_ROOT_INVALID/);
    assert.equal(fs.existsSync(path.join(env.HOME, '.qoder')), false);
  }
});

test('missing capability asks installation while excluded or irrelevant entries remain quiet', t => {
  const f = fixture(t); f.register();
  const source = path.join(f.pkg, 'skills/generic-helper/SKILL.md'); f.write(source, '# generic\n');
  f.setItems([{ id: 'skill:generic-helper', name: 'generic-helper', category: 'skill', action: 'ASK_INSTALL', reason: 'MISSING_GENERIC', generic: true, entryPath: source, installedPaths: [] }, { id: 'skill:irrelevant', name: 'irrelevant', category: 'skill', action: 'SKIP', reason: 'NOT_APPLICABLE' }]);
  const text = f.run();
  assert.match(text, /是否安装 generic-helper/);
  assert.doesNotMatch(text, /是否使用 generic-helper/);
  assert.doesNotMatch(text, /irrelevant/);
});

test('explicit authorized use routes to installed entry without asking again', t => {
  const f = fixture(t), item = f.skill('browser-helper', 'KEEP');
  Object.assign(item, { requested: true, authorized: true, reason: 'EXPLICIT_USE_REQUEST' }); f.setItems([item]); f.register();
  const text = f.run('使用 browser-helper 修复页面');
  assert.ok(text.includes(item.entryPath.replace(/\\/g, '/')));
  assert.match(text, /读取|Read/);
  assert.doesNotMatch(text, /是否使用 browser-helper/);
});

test('no registered package, no related advice, kill switch and missing optional module preserve baseline', t => {
  const f = fixture(t), item = f.skill(); f.setItems([item]);
  const noPackage = f.run();
  assert.equal(noPackage.includes(marker), false);
  f.register(); f.write(path.join(f.client, 'capability-advisor.json'), { enabled: false });
  assert.equal(f.run(), noPackage);
  fs.rmSync(path.join(f.client, 'capability-advisor.json'));
  f.setItems([{ ...item, action: 'SKIP' }, { ...item, id: 'skill:kept', action: 'KEEP' }]);
  assert.equal(f.run(), noPackage);
  fs.rmSync(path.join(f.scripts, 'capability-advisor.cjs'));
  assert.equal(f.run(), noPackage);
});

test('invalid or missing session IDs do not create permanent suppression', t => {
  const f = fixture(t); f.register(); f.setItems([f.skill()]);
  for (const sid of ['', '../escape', undefined]) {
    assert.equal(f.run('修复浏览器页面', sid).includes(marker), true);
    assert.equal(f.run('修复浏览器页面', sid).includes(marker), true);
  }
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/capability-advisor/sessions')), false);
});

test('actual advisor routes a real installed skill, respects profile exclusion and honors a current explicit request', t => {
  const f = fixture(t), installed = f.skill('safe-text-editing');
  const entry = { id: installed.id, name: installed.name, category: 'skill', status: 'shipped', tier: 'core', source: 'skills/safe-text-editing', description: 'safe text editing', install: { mode: 'copy-skill', tier: 'core' }, dependencies: [] };
  f.write(path.join(f.pkg, entry.source, 'SKILL.md'), fs.readFileSync(installed.entryPath, 'utf8'));
  f.write(f.catalog, { schema: 1, entries: [entry] }); f.register();
  const question = f.runActual('请修改文本，保留指定段落', 'actual-a');
  assert.match(question, /是否使用 safe-text-editing 来完成当前任务/);
  assert.ok(question.includes(installed.entryPath.replace(/\\/g, '/')));
  const preferences = { schema: 1, excludedIds: [entry.id] };
  f.write(path.join(f.client, 'capability-preferences.json'), preferences);
  assert.equal(f.runActual('请修改文本，保留指定段落', 'actual-b').includes(marker), false);
  const requested = f.runActual('使用 safe-text-editing 修改文本', 'actual-c');
  assert.ok(requested.includes(installed.entryPath.replace(/\\/g, '/')));
  assert.match(requested, /现在读取/);
  assert.doesNotMatch(requested, /是否使用 safe-text-editing/);
  f.write(installed.entryPath, '# safe-text-editing\nLOCAL_CUSTOM_BODY\n');
  const localUse = f.runActual('使用 safe-text-editing 修改文本', 'actual-d');
  assert.match(localUse, /现在读取/);
  assert.match(localUse, /本地版本/);
  assert.doesNotMatch(localUse, /是否更新 safe-text-editing/);
  assert.match(fs.readFileSync(installed.entryPath, 'utf8'), /LOCAL_CUSTOM_BODY/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.client, 'capability-preferences.json'), 'utf8')), preferences);
});

test('actual advisor asks for a relevant missing generic skill and stays silent for an unselected specialty', t => {
  const f = fixture(t);
  const entries = ['parallel-orchestration', 'kafka-best-practices'].map(name => ({ id: 'skill:' + name, name, category: 'skill', status: 'shipped', tier: 'library', source: 'skills/' + name, description: name, install: { mode: 'copy-skill', tier: 'library' }, dependencies: [] }));
  for (const entry of entries) f.write(path.join(f.pkg, entry.source, 'SKILL.md'), '# ' + entry.name + '\n');
  f.write(f.catalog, { schema: 1, entries }); f.register();
  assert.match(f.runActual('并行审查两个模块', 'generic-a'), /是否安装 parallel-orchestration/);
  assert.equal(f.runActual('审查 Kafka 消费者配置', 'specialty-a').includes(marker), false);
  assert.equal(fs.existsSync(path.join(f.client, 'skills-library/parallel-orchestration')), false);
});

function stopReplay(f, command, output, asked = false) {
  const entries = [{ message: { role: 'user', content: '核对能力建议' } }, { message: { role: 'assistant', content: [{ type: 'tool_use', id: 'cap', name: 'Bash', input: { command } }] } }, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cap', content: output }] } }];
  if (asked) entries.push({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ question: '是否使用 browser-helper 来完成当前任务？', options: ['使用', '本次不用'] }] } }] } }, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask', content: '本次不用' }] } });
  entries.push({ message: { role: 'assistant', content: '结论：已核对。' } });
  const file = path.join(f.dir, 'transcript.jsonl'); f.write(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/stop-gate.js')], { env: { ...f.env, STOP_GATE_STATE_DIR: path.join(f.dir, 'stop') }, cwd: f.dir, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'gate-' + Math.random(), cwd: f.dir, transcript_path: file }), encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout;
}

test('installer/advisor capability asks enter existing R10 and quoted examples stay quiet', t => {
  const f = fixture(t);
  for (const command of ['node scripts/install-package.cjs --client-root fixture', '"C:/Program Files/nodejs/node.exe" "D:/package/scripts/capability-advisor.cjs" task --prompt x']) {
    for (const action of ['ASK_USE', 'ASK_INSTALL', 'ASK_UPDATE']) {
      assert.match(stopReplay(f, command, 'NEXT_ACTION: ' + action), /R10-next-action-not-asked/);
      assert.doesNotMatch(stopReplay(f, command, 'NEXT_ACTION: ' + action, true), /R10-next-action-not-asked/);
    }
  }
  assert.doesNotMatch(stopReplay(f, 'echo "node scripts/capability-advisor.cjs task"', 'NEXT_ACTION: ASK_USE'), /R10-next-action-not-asked/);
  assert.doesNotMatch(stopReplay(f, 'node --eval "console.log(\'capability-advisor.cjs\')"', 'NEXT_ACTION: ASK_USE'), /R10-next-action-not-asked/);
});
