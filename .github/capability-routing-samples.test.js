'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const advisor = require(path.join(repo, 'scripts/capability-advisor.cjs'));
const { classifyAmbiguity } = require(path.join(repo, 'scripts/ambiguity-core.cjs'));

const USE_ACTIONS = new Set(['ASK_USE', 'AUTO_USE', 'AUTO_LOAD', 'KEEP']);
// 池里有源但本机不安装：用于验证缺失通用能力的安装占位排序。
const MISSING = ['write-repowiki'];
const WANTED = [
  'verify-before-claim', 'verify-ui-in-browser', 'parallel-orchestration', 'share-package-release',
  'ship-clean-pr', 'self-evolution', 'continuation-state-audit', 'vibecoding-doc', 'office-docs',
  'vibe-coding-workflow', 'frontend-development', 'local-db-migrations', 'local-performance-evidence',
  'mysql', 'redis-connections', 'redis-observability', 'redis-core', 'architecture-designer',
  'clarify', 'clean-temp', 'edge-net-check', 'update-share-package',
];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-routing-samples-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, 'pkg'), client = path.join(dir, 'client');
  const source = JSON.parse(fs.readFileSync(path.join(repo, 'catalog.json'), 'utf8'));
  const entries = source.entries.filter(entry => WANTED.includes(entry.name) || MISSING.includes(entry.name));
  assert.equal(entries.length, WANTED.length + MISSING.length, 'catalog sample entries must all exist');
  for (const entry of entries) {
    const from = path.join(repo, entry.source);
    const to = path.join(pkg, entry.source);
    const installed = WANTED.includes(entry.name);
    if (entry.category === 'skill') {
      // 匹配只读 SKILL.md；复制单个入口即可，避免测试因整目录复制变慢。
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(path.join(from, 'SKILL.md'), path.join(to, 'SKILL.md'));
      if (installed) {
        const tier = entry.install?.tier === 'core' ? 'skills' : 'skills-library';
        const target = path.join(client, tier, entry.name);
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(path.join(from, 'SKILL.md'), path.join(target, 'SKILL.md'));
      }
    } else if (entry.category === 'command') {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      if (installed) {
        fs.mkdirSync(path.join(client, 'commands'), { recursive: true });
        fs.copyFileSync(from, path.join(client, 'commands', path.basename(entry.source)));
      }
    }
  }
  fs.writeFileSync(path.join(pkg, 'catalog.json'), JSON.stringify({ schema: 1, entries }, null, 2));
  const local = path.join(client, 'skills-library', 'kafka-development');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'SKILL.md'), '---\nname: kafka-development\ndescription: Kafka 开发指南。触发词：kafka、消费延迟、分区\n---\n');
  const catalogFile = path.join(pkg, 'catalog.json');
  const plan = (prompt, phase = 'task') => advisor.planCapabilities({ catalogFile, clientRoot: client, prompt, phase });
  const hook = (prompt, session = 'hook-sample') => {
    fs.writeFileSync(path.join(client, 'share-package.json'), JSON.stringify({ catalog: catalogFile }));
    const env = { ...process.env, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), QODER_HOME: client };
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts/rules-reminder.js')], {
      env, cwd: dir, input: JSON.stringify({ prompt, session_id: session }), encoding: 'utf8', timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  };
  return { dir, pkg, client, catalogFile, plan, hook };
}

const samples = [
  { prompt: '帮我验证一下这个改动', expect: ['verify-before-claim'] },
  { prompt: '页面改好了，用浏览器验收并截图', expect: ['verify-ui-in-browser'] },
  { prompt: '把订单、用户、报表三个模块拆分开发', expect: ['parallel-orchestration'] },
  { prompt: '发布分享包 0.1.4', expect: ['share-package-release'] },
  { prompt: '提交并推送这个 PR', expect: ['ship-clean-pr'] },
  { prompt: '记住以后回复都用中文', expect: ['self-evolution'] },
  { prompt: '继续上次的任务', expect: ['continuation-state-audit'] },
  { prompt: '帮我澄清一下需求，现在说不清', expect: ['clarify'] },
  { prompt: '写一份需求文档', expect: ['vibecoding-doc'] },
  { prompt: '用 redis 排查连接超时', expect: ['redis-connections', 'redis-observability', 'redis-core'] },
  { prompt: '优化 MySQL 慢查询', expect: ['mysql'] },
  { prompt: '用 kafka 排查消费延迟', expect: ['kafka-development'] },
  { prompt: '表结构要迁移，加一个字段', expect: ['local-db-migrations'] },
  { prompt: '帮我做性能优化，先建基线', expect: ['local-performance-evidence'] },
  { prompt: '前端页面样式错乱，帮我修', expect: ['frontend-development', 'verify-ui-in-browser'] },
  { prompt: '梳理这个项目的架构', expect: ['architecture-designer', 'parallel-orchestration'] },
  { prompt: '帮我实现一个登录功能', expect: ['vibe-coding-workflow'] },
  { prompt: '临时文件太乱了，清理一下', expect: ['clean-temp'] },
  { prompt: '网络打不开网页了，帮我查一下', expect: ['edge-net-check'] },
];
const negatives = [
  '解释一下这个函数的作用',
  '如何验证前端页面',
  '这个按钮是什么颜色',
  '不要使用 verify-before-claim，只给结论',
  '我在考虑要不要用 kafka，先讲原理',
  '谢谢',
];

test('口语请求稳定召回对应能力（正例）', t => {
  const f = fixture(t);
  for (const sample of samples) {
    const names = f.plan(sample.prompt).items.filter(item => USE_ACTIONS.has(item.action)).map(item => item.name);
    assert.ok(sample.expect.some(name => names.includes(name)), sample.prompt + ' -> ' + names.join(',') || 'NONE');
  }
});

test('讨论、拒绝与无关请求保持静默（负对照）', t => {
  const f = fixture(t);
  for (const prompt of negatives) {
    const shown = f.plan(prompt).items.filter(item => !['SKIP'].includes(item.action));
    assert.deepEqual(shown.map(item => item.action + ':' + item.name), [], prompt);
  }
});

test('显式指令不清即使带对象也必须判高并强制提问', () => {
  for (const text of ['指令不清，帮我看看', '需求不清，先做哪个', '意图不明，你猜一下', '表述不清，改一下', '需求含糊，先出一版', '表述含糊，你决定', '指令不清，把 src/auth.ts 的 login 改成 401']) {
    assert.equal(classifyAmbiguity(text).level, 'high', text);
  }
  for (const text of ['把 src/auth.ts 的 login 改成返回 401', '解释一下 JWT 是什么']) {
    assert.equal(classifyAmbiguity(text).level, null, text);
  }
});

test('任务阶段本地差异仍给出使用建议，安装阶段才进入更新审查', t => {
  const f = fixture(t);
  const entry = path.join(f.client, 'skills', 'verify-before-claim', 'SKILL.md');
  fs.appendFileSync(entry, '\n本地补充内容\n');
  const task = f.plan('帮我验证一下这个改动').items.find(item => item.name === 'verify-before-claim');
  assert.equal(task.action, 'ASK_USE');
  assert.equal(task.localDiff, true);
  const install = f.plan('请使用 verify-before-claim 验证改动', 'install').items.find(item => item.name === 'verify-before-claim');
  assert.equal(install.action, 'REVIEW_UPDATE');
});

test('真实 hook 注入正例建议、负例静默，显式指令不清强制提问', t => {
  const f = fixture(t);
  const positive = f.hook('帮我验证一下这个改动', 'hook-positive');
  assert.match(positive, /【当前任务能力建议】/);
  assert.match(positive, /verify-before-claim（ASK_USE）/);
  assert.match(positive, /含混自检/);
  assert.match(positive, /能力自检/);
  assert.match(positive, /多种合理解读/);
  const negative = f.hook('解释一下这个函数的作用', 'hook-negative');
  assert.doesNotMatch(negative, /【当前任务能力建议】/);
  const unclear = f.hook('指令不清，帮我看看', 'hook-unclear');
  assert.match(unclear, /【需求含混 · 规则初筛命中（高）】/);
  assert.match(unclear, /必须先提问/);
});

test('使用类建议优先于安装类占位，不被低优先级动作挤掉', t => {
  const f = fixture(t);
  const actions = f.plan('写一份 wiki 并验证结果').items.map(item => item.action);
  const use = actions.indexOf('ASK_USE');
  const install = actions.indexOf('ASK_INSTALL');
  assert.notEqual(use, -1);
  assert.notEqual(install, -1);
  assert.ok(use < install, actions.join(','));
});
