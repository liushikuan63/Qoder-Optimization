'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts/capability-advisor.cjs');
const advisor = options => require(script).planCapabilities(options);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-advisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = path.join(dir, 'client'), current = path.join(dir, 'new'), previous = path.join(dir, 'old');
  const entries = [
    ...[['safe-text-editing', 'core'], ['verify-before-claim', 'core'], ['parallel-orchestration', 'library'], ['kafka-best-practices', 'library'], ['redis-security', 'library']].map(([name, tier]) => ({ id: 'skill:' + name, name, category: 'skill', status: 'shipped', tier, source: 'skills/' + name, description: name, install: { mode: 'copy-skill', tier }, dependencies: [] })),
    { id: 'script:rules-reminder.js', name: 'rules-reminder.js', category: 'script', status: 'shipped', source: 'scripts/rules-reminder.js', install: { mode: 'copy-file' } },
    { id: 'mcp:database', name: 'database', category: 'mcp', status: 'shipped', source: 'mcp/database.json', install: { mode: 'merge' } },
  ];
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const local = (name, description) => {
    const file = path.join(client, 'skills-library', name, 'SKILL.md');
    put(file, `---\nname: ${name}\ndescription: ${description}\n---\n`);
    return file;
  };
  const index = (list) => put(path.join(client, 'skills-index.json'), JSON.stringify({ entries: list }));
  const catalog = { schema: 1, entries };
  for (const [base, version] of [[current, 'new'], [previous, 'old']]) {
    put(path.join(base, 'catalog.json'), JSON.stringify(catalog));
    for (const entry of entries.filter(entry => entry.category !== 'mcp')) put(path.join(base, entry.source, ...(entry.category === 'skill' ? ['SKILL.md'] : [])), version + ':' + entry.name);
  }
  const install = (id, from = previous, tier = 'skills-library') => {
    const entry = entries.find(entry => entry.id === id);
    const target = path.join(client, entry.category === 'skill' ? tier : entry.category === 'script' ? 'scripts' : 'commands', entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(path.join(from, entry.source), target, { recursive: true });
    return target;
  };
  const args = { catalogFile: path.join(current, 'catalog.json'), clientRoot: client, phase: 'install' };
  return { dir, client, current, previous, entries, put, local, index, install, args, plan: override => advisor({ ...args, ...override }) };
}
const item = (result, id) => result.items.find(entry => entry.id === id);

test('corner-quoted capability names distinguish discussion, refusal and explicit use', t => {
  const f = fixture(t); f.install('skill:parallel-orchestration', f.current);
  for (const [left, right] of [['「', '」'], ['『', '』']]) {
    assert.equal(item(f.plan({ phase: 'task', prompt: '修改文档中' + left + '使用 parallel-orchestration' + right + '的措辞' }), 'skill:parallel-orchestration'), undefined);
    const explicit = item(f.plan({ phase: 'task', prompt: '请使用' + left + 'parallel-orchestration' + right + '完成审查' }), 'skill:parallel-orchestration');
    assert.equal(explicit.action, 'KEEP'); assert.equal(explicit.authorized, true);
    const decline = item(f.plan({ phase: 'task', prompt: '请不要使用' + left + 'parallel-orchestration' + right }), 'skill:parallel-orchestration');
    assert.ok(!decline || decline.action === 'SKIP');
  }
});

test('install phase asks only generic missing capabilities and never claims unknown MCP is missing', t => {
  const f = fixture(t), result = f.plan();
  assert.equal(result.schema, 1); assert.equal(result.items.length, f.entries.length);
  assert.equal(item(result, 'skill:safe-text-editing').action, 'ASK_INSTALL');
  assert.equal(item(result, 'skill:kafka-best-practices').action, 'SKIP');
  assert.equal(item(result, 'mcp:database').action, 'SKIP');
  assert.equal(item(result, 'mcp:database').present, null);
  assert.equal(fs.existsSync(f.client), false, 'advisor wrote to the client');
});

test('installed old pristine content qualifies for UPDATE only with a readable old registered source', t => {
  const f = fixture(t), target = f.install('skill:safe-text-editing');
  f.put(path.join(f.client, 'share-package.json'), JSON.stringify({ catalog: path.join(f.previous, 'catalog.json') }));
  const result = item(f.plan(), 'skill:safe-text-editing');
  assert.equal(result.action, 'UPDATE'); assert.equal(result.baseline.verified, true);
  assert.deepEqual(result.installedPaths, [target]); assert.equal(result.entryPath, path.join(target, 'SKILL.md'));
  assert.equal(result.entry.source, 'skills/safe-text-editing');
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'old:safe-text-editing');
});

test('unknown, moved or overwritten old baselines never qualify for automatic UPDATE', t => {
  const f = fixture(t); f.install('skill:safe-text-editing');
  for (const previousCatalogFile of [undefined, path.join(f.dir, 'missing/catalog.json'), f.args.catalogFile]) {
    const result = item(f.plan({ previousCatalogFile }), 'skill:safe-text-editing');
    assert.equal(result.action, 'REVIEW_UPDATE'); assert.equal(result.baseline.verified, false);
  }
});

test('local modifications, extra files and duplicate tiers remain review-only', t => {
  const f = fixture(t), target = f.install('skill:safe-text-editing');
  const options = { previousCatalogFile: path.join(f.previous, 'catalog.json') };
  f.put(path.join(target, 'local.md'), 'local unique content');
  assert.equal(item(f.plan(options), 'skill:safe-text-editing').action, 'REVIEW_UPDATE');
  fs.rmSync(path.join(target, 'local.md'));
  f.put(path.join(target, 'SKILL.md'), 'user edits');
  assert.equal(item(f.plan(options), 'skill:safe-text-editing').action, 'REVIEW_UPDATE');
  f.put(path.join(target, 'SKILL.md'), 'old:safe-text-editing'); f.install('skill:safe-text-editing', f.previous, 'skills');
  const duplicate = item(f.plan(options), 'skill:safe-text-editing');
  assert.equal(duplicate.action, 'REVIEW_UPDATE'); assert.equal(duplicate.reason, 'AMBIGUOUS_INSTALLED_TIERS');
});

test('explicit preference exclusion wins over generic and preferred recommendations', t => {
  const f = fixture(t); f.install('skill:safe-text-editing');
  const preferences = { schema: 1, enabled: true, preferredIds: ['skill:kafka-best-practices'], excludedIds: ['skill:safe-text-editing', 'skill:kafka-best-practices'], preferredKeywords: [], excludedKeywords: [] };
  const result = f.plan({ preferences });
  assert.equal(item(result, 'skill:safe-text-editing').action, 'SKIP');
  assert.equal(item(result, 'skill:kafka-best-practices').action, 'SKIP');
});

test('preferred IDs and keywords can ask for missing specialized capabilities but never install them', t => {
  const f = fixture(t);
  const preferences = { schema: 1, enabled: true, preferredIds: ['skill:kafka-best-practices'], preferredKeywords: ['redis'], excludedIds: [], excludedKeywords: [] };
  const result = f.plan({ preferences });
  assert.equal(item(result, 'skill:kafka-best-practices').action, 'ASK_INSTALL');
  assert.equal(item(result, 'skill:redis-security').action, 'ASK_INSTALL');
  assert.equal(fs.existsSync(f.client), false);
});

test('profile reads only the selected client and a disabled profile remains quiet for ordinary tasks', t => {
  const f = fixture(t);
  const profile = { schema: 1, enabled: false, preferredIds: [], excludedIds: [], preferredKeywords: [], excludedKeywords: [] };
  f.put(path.join(f.client, 'capability-preferences.json'), JSON.stringify(profile));
  const before = fs.readFileSync(path.join(f.client, 'capability-preferences.json'));
  const result = f.plan({ phase: 'task', prompt: '请修改文本并运行测试验证' });
  assert.ok(result.items.every(entry => entry.action === 'SKIP'));
  assert.deepEqual(fs.readFileSync(path.join(f.client, 'capability-preferences.json')), before);
});

test('ordinary task routing matches relevant installed capabilities and caps the plan at three', t => {
  const f = fixture(t);
  for (const entry of f.entries.filter(entry => entry.category === 'skill')) f.install(entry.id, f.current);
  const result = f.plan({ phase: 'task', prompt: '请修改文本文件，完成并行开发并测试验证，给出修复证据' });
  assert.ok(result.items.length > 0 && result.items.length <= 3);
  assert.ok(result.items.every(entry => ['ASK_USE', 'AUTO_USE'].includes(entry.action)));
  assert.equal(item(result, 'skill:parallel-orchestration').action, 'AUTO_USE');
  assert.equal(item(result, 'skill:kafka-best-practices'), undefined);
  assert.equal(item(result, 'skill:redis-security'), undefined);
});

test('multi-module tasks auto-trigger parallel orchestration while unrelated splits stay quiet', t => {
  const f = fixture(t); f.install('skill:parallel-orchestration', f.current);
  for (const prompt of ['把订单、用户、报表三个模块拆分开发', '这是多模块任务，先判断能否并行', '按依赖图拆分任务']) {
    const result = item(f.plan({ phase: 'task', prompt }), 'skill:parallel-orchestration');
    assert.equal(result.action, 'AUTO_USE', prompt);
    assert.equal(result.reason, 'AUTO_TRIGGERED_INSTALLED_CAPABILITY');
    assert.equal(result.requiresConfirmation, false);
  }
  assert.equal(item(f.plan({ phase: 'task', prompt: '拆分字符串函数并补测试' }), 'skill:parallel-orchestration'), undefined);
});

test('installed local-only library skills surface when no catalog capability matches', t => {
  const f = fixture(t);
  const file = f.local('kafka-development', 'Kafka 开发指南。触发词：kafka、消费延迟、分区');
  f.index([{ name: 'kafka-development', tier: 'library', path: file, description: 'Kafka 开发指南。触发词：kafka、消费延迟、分区' }]);
  const result = f.plan({ phase: 'task', prompt: 'Kafka 消费延迟怎么排查' });
  const local = item(result, 'skill:kafka-development');
  assert.equal(local.action, 'AUTO_LOAD');
  assert.equal(local.reason, 'RELEVANT_LOCAL_LIBRARY_SKILL');
  assert.equal(local.entryPath, file);
  assert.equal(local.requiresConfirmation, false);
});

test('local discovery stays quiet for unrelated prompts but coexists with unrelated catalog matches', t => {
  const f = fixture(t);
  f.local('kafka-development', 'Kafka 开发指南。触发词：kafka、消费延迟');
  assert.equal(item(f.plan({ phase: 'task', prompt: '修复按钮文案' }), 'skill:kafka-development'), undefined);
  f.install('skill:safe-text-editing', f.current);
  const result = f.plan({ phase: 'task', prompt: '修改文本并检查 Kafka' });
  assert.equal(item(result, 'skill:kafka-development')?.action, 'AUTO_LOAD');
  assert.ok(result.items.some(entry => entry.id === 'skill:safe-text-editing'));
  assert.ok(result.items.length <= 3);
});

test('local discovery needs no registered catalog and follows the live filesystem instead of the index', t => {
  const f = fixture(t);
  const file = f.local('postgresql', 'PostgreSQL 开发指南。触发词：PostgreSQL、慢查询');
  f.index([{ name: 'deleted-skill', tier: 'library', path: path.join(f.client, 'skills-library/gone/SKILL.md'), description: 'PostgreSQL 慢查询' }]);
  const result = f.plan({ phase: 'task', catalogFile: undefined, prompt: '排查 PostgreSQL 慢查询' });
  const local = item(result, 'skill:postgresql');
  assert.equal(result.summary.reason, 'LOCAL_DISCOVERY_ONLY');
  assert.equal(local?.action, 'AUTO_LOAD');
  assert.equal(local?.entryPath, file);
  assert.equal(item(result, 'skill:deleted-skill'), undefined);
});

test('local library discovery honors explicit use, decline and exclusion', t => {
  const f = fixture(t);
  f.local('postgresql', 'PostgreSQL 开发指南。触发词：PostgreSQL、慢查询');
  const explicit = item(f.plan({ phase: 'task', prompt: '请使用 postgresql 排查慢查询' }), 'skill:postgresql');
  assert.equal(explicit?.action, 'KEEP');
  assert.equal(explicit?.authorized, true);
  assert.equal(item(f.plan({ phase: 'task', prompt: '不要使用 postgresql' }), 'skill:postgresql'), undefined);
  const preferences = { schema: 1, excludedIds: ['skill:postgresql'] };
  assert.equal(item(f.plan({ phase: 'task', prompt: '排查 PostgreSQL 慢查询', preferences }), 'skill:postgresql'), undefined);
  assert.equal(item(f.plan({ phase: 'task', prompt: '请使用 postgresql 排查慢查询', preferences }), 'skill:postgresql')?.action, 'KEEP');
});

test('local automatic or explicit routing rejects linked skill directories outside the client', t => {
  const f = fixture(t);
  const outside = path.join(f.dir, 'external/postgresql');
  f.put(path.join(outside, 'SKILL.md'), '---\nname: postgresql\ndescription: PostgreSQL helper\n---\n');
  const link = path.join(f.client, 'skills-library/postgresql');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const prompt of ['排查 PostgreSQL 查询', '请使用 postgresql 排查查询']) {
    assert.equal(item(f.plan({ phase: 'task', catalogFile: undefined, prompt }), 'skill:postgresql'), undefined, prompt);
  }
});

test('an explicit local selection overrides disabled ordinary advice and outranks other domain matches', t => {
  const f = fixture(t);
  f.local('sql', 'SQL task helper');
  f.local('mysql-review', 'MySQL review helper');
  const prompt = '请使用 sql 排查 MySQL 查询';
  for (const preferences of [{ schema: 1 }, { schema: 1, enabled: false, excludedIds: ['skill:sql'] }]) {
    const selected = item(f.plan({ phase: 'task', catalogFile: undefined, prompt, preferences }), 'skill:sql');
    assert.equal(selected?.action, 'KEEP', JSON.stringify(preferences));
    assert.equal(selected?.authorized, true);
  }
});

test('disabled ordinary advice does not discard a current explicit local use request', t => {
  const f = fixture(t); f.local('postgresql', 'PostgreSQL helper');
  const preferences = { schema: 1, enabled: false, excludedIds: ['skill:postgresql'] };
  const selected = item(f.plan({ phase: 'task', catalogFile: undefined, prompt: '请使用 postgresql 检查查询', preferences }), 'skill:postgresql');
  assert.equal(selected?.action, 'KEEP'); assert.equal(selected?.authorized, true);
  assert.deepEqual(f.plan({ phase: 'task', catalogFile: undefined, prompt: '检查 PostgreSQL 查询', preferences }).items, []);
});

test('explicitly selected local skills are not reduced to the single automatic discovery slot', t => {
  const f = fixture(t); f.local('sql', 'SQL helper'); f.local('db', 'Database helper');
  const result = f.plan({ phase: 'task', catalogFile: undefined, prompt: '请使用 sql 检查查询，同时使用 db 检查连接' });
  for (const name of ['sql', 'db']) assert.equal(item(result, 'skill:' + name)?.authorized, true, name);
});

test('current refusals with temporal prefixes suppress package and local auto routes', t => {
  const f = fixture(t); f.install('skill:parallel-orchestration', f.current);
  f.local('postgresql', 'PostgreSQL helper。触发词：慢查询');
  for (const prefix of ['本次', '这次', '暂时', '先']) {
    const packageItem = item(f.plan({ phase: 'task', prompt: prefix + '不要使用 parallel-orchestration' }), 'skill:parallel-orchestration');
    assert.ok(!packageItem || packageItem.action === 'SKIP', prefix + ': ' + JSON.stringify(packageItem));
    assert.equal(item(f.plan({ phase: 'task', prompt: prefix + '不要使用 postgresql 排查慢查询' }), 'skill:postgresql'), undefined);
  }
});

test('local fallback prefers the domain prefix over a generic later token', t => {
  const f = fixture(t);
  const spring = f.local('spring-boot', 'Spring Boot 3.x：REST API、JPA。');
  const legacy = f.local('legacy-java-webapp-boot-verification', '遗留 Java Web 启动取证。触发词：启动失败、遗留应用起不来。');
  f.index([
    { name: 'spring-boot', tier: 'library', path: spring, description: 'Spring Boot 3.x：REST API、JPA。' },
    { name: 'legacy-java-webapp-boot-verification', tier: 'library', path: legacy, description: '遗留 Java Web 启动取证。触发词：启动失败、遗留应用起不来。' },
  ]);
  const local = f.plan({ phase: 'task', prompt: 'Spring Boot 启动失败' }).items.filter(entry => entry.reason === 'RELEVANT_LOCAL_LIBRARY_SKILL');
  assert.equal(local.length, 1);
  assert.equal(local[0].id, 'skill:spring-boot');
});

test('unrelated or empty task text does not ask to use everything', t => {
  const f = fixture(t); f.install('skill:safe-text-editing', f.current);
  assert.deepEqual(f.plan({ phase: 'task', prompt: '' }).items, []);
  assert.deepEqual(f.plan({ phase: 'task', prompt: '今天是星期几' }).items, []);
  assert.deepEqual(f.plan({ phase: 'task', prompt: '解释函数定义的含义' }).items, []);
});

test('task routes missing specialized entries to SKIP unless a preference or current explicit request applies', t => {
  const f = fixture(t);
  assert.equal(item(f.plan({ phase: 'task', prompt: '请审查 Kafka 消费者配置' }), 'skill:kafka-best-practices').action, 'SKIP');
  const preferred = { schema: 1, preferredIds: ['skill:kafka-best-practices'] };
  assert.equal(item(f.plan({ phase: 'task', prompt: '请审查 Kafka 消费者配置', preferences: preferred }), 'skill:kafka-best-practices').action, 'ASK_INSTALL');
  assert.equal(item(f.plan({ phase: 'task', prompt: '请使用 kafka-best-practices 检查配置' }), 'skill:kafka-best-practices').action, 'ASK_INSTALL');
});

test('current explicit use is authorized above old exclusions but quotes, questions and negation are not', t => {
  const f = fixture(t); f.install('skill:safe-text-editing', f.current);
  const preferences = { schema: 1, excludedIds: ['skill:safe-text-editing'] };
  const result = item(f.plan({ phase: 'task', prompt: '请使用 safe-text-editing 修改这份文件', preferences }), 'skill:safe-text-editing');
  assert.equal(result.action, 'KEEP'); assert.equal(result.requested, true); assert.equal(result.authorized, true);
  for (const prompt of ['不要使用 safe-text-editing', '如何使用 safe-text-editing？', '文档中写着“使用 safe-text-editing”', '使用 safe-text-editing 是否合适？']) {
    const recommendation = item(f.plan({ phase: 'task', prompt, preferences }), 'skill:safe-text-editing');
    assert.ok(!recommendation || recommendation.action === 'SKIP', prompt);
    assert.ok(!recommendation || !recommendation.authorized, prompt);
  }
});

test('localPresence supports an explicit client without falling back to a live root', t => {
  const f = fixture(t), entry = f.entries[0]; f.install(entry.id, f.current);
  const presence = require('../scripts/pkg-catalog.cjs').localPresence(entry, f.current, f.client);
  assert.equal(presence.present, true); assert.equal(presence.differs, false);
  assert.deepEqual(presence.installedPaths, [path.join(f.client, 'skills-library', entry.name)]);
});

test('absent catalog keeps local discovery read-only while malformed preferences and phase fail closed', t => {
  const f = fixture(t);
  assert.deepEqual(f.plan({ catalogFile: path.join(f.dir, 'absent') }).items, []);
  assert.equal(f.plan({ catalogFile: path.join(f.dir, 'absent') }).summary.reason, 'LOCAL_DISCOVERY_ONLY');
  assert.throws(() => f.plan({ phase: 'other' }), /phase/i);
  assert.throws(() => f.plan({ preferences: { schema: 1, preferredIds: 'all' } }), /prefer/i);
  assert.equal(fs.existsSync(f.client), false);
});

test('advisor CLI rejects unknown or missing values without creating a client', t => {
  const f = fixture(t);
  for (const args of [['--catalog'], ['--catalog', ''], ['--wat'], ['--phase', 'other'], ['--client-root']]) {
    const result = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
  }
  assert.equal(fs.existsSync(f.client), false);
});

test('task advice and status questions do not request using or installing the discussed capability', t => {
  const f = fixture(t); f.install('skill:parallel-orchestration', f.current);
  for (const prompt of ['并行编排是什么', '解释一下 parallel-orchestration', 'parallel-orchestration 安装了吗？', '使用 parallel-orchestration 是否合适？']) {
    const result = item(f.plan({ phase: 'task', prompt }), 'skill:parallel-orchestration');
    assert.ok(!result || result.action === 'SKIP', prompt + ': ' + JSON.stringify(result));
    assert.ok(!result || !result.authorized);
  }
});

test('quoted capability discussion is not a route while an explicit quoted capability use remains authorized', t => {
  const f = fixture(t); f.install('skill:parallel-orchestration', f.current); f.install('skill:safe-text-editing', f.current);
  const result = f.plan({ phase: 'task', prompt: '修改文档中“使用 parallel-orchestration”的措辞' });
  assert.equal(item(result, 'skill:parallel-orchestration'), undefined);
  assert.equal(item(result, 'skill:safe-text-editing').action, 'ASK_USE');
  const explicit = item(f.plan({ phase: 'task', prompt: '请使用“parallel-orchestration”完成审查' }), 'skill:parallel-orchestration');
  assert.equal(explicit.action, 'KEEP'); assert.equal(explicit.authorized, true);
});

test('polite current refusals override generic advice and never become a use authorization', t => {
  const f = fixture(t); f.install('skill:parallel-orchestration', f.current);
  for (const prompt of ['请不要使用 parallel-orchestration', '请不要使用“parallel-orchestration”', 'please do not use parallel-orchestration', '别用 parallel-orchestration', '不要用 parallel-orchestration']) {
    const result = item(f.plan({ phase: 'task', prompt }), 'skill:parallel-orchestration');
    assert.ok(!result || result.action === 'SKIP', prompt + ': ' + JSON.stringify(result));
    assert.ok(!result || !result.authorized);
  }
});

test('explicit task use preserves a modified local version without requiring a package update', t => {
  const f = fixture(t), target = f.install('skill:safe-text-editing', f.current);
  f.put(path.join(target, 'SKILL.md'), 'LOCAL_CUSTOM_BODY');
  const result = item(f.plan({ phase: 'task', prompt: '请使用 safe-text-editing 修改文件' }), 'skill:safe-text-editing');
  assert.equal(result.action, 'KEEP'); assert.equal(result.authorized, true); assert.equal(result.differs, true);
  assert.equal(result.maintenanceNeeded, true); assert.equal(result.requiresConfirmation, false);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'LOCAL_CUSTOM_BODY');
  assert.equal(item(f.plan(), 'skill:safe-text-editing').action, 'REVIEW_UPDATE');
});

test('explicit use does not authorize missing or linked local entrypoints or linked client tiers', t => {
  const f = fixture(t), target = f.install('skill:safe-text-editing', f.current);
  const entryFile = path.join(target, 'SKILL.md'); fs.rmSync(entryFile);
  const prompt = '请使用 safe-text-editing 修改文件';
  assert.notEqual(item(f.plan({ phase: 'task', prompt }), 'skill:safe-text-editing').authorized, true);
  const outside = path.join(f.dir, 'external'); fs.mkdirSync(outside); f.put(path.join(outside, 'SKILL.md'), 'new:safe-text-editing');
  fs.rmdirSync(target); fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(item(f.plan({ phase: 'task', prompt }), 'skill:safe-text-editing').authorized, true);
});
