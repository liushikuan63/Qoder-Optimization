'use strict';
// T-07 / F8 / A2：触发短语唯一性校验器的永久回归。
// 关键判据不是「当前为 0」，而是「造一组重复必须判红」＋「旧模糊阈值对同一夹具仍给 0」。
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan, triggerPhrases } = require('../scripts/skill-trigger-uniqueness.cjs');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'scripts', 'skill-trigger-uniqueness.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-trigger-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

function fixture(skills) {
  const base = path.join(root, 'case-' + (++seq));
  for (const [name, description] of Object.entries(skills)) {
    const dir = path.join(base, 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`);
  }
  return base;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });
}

// skill-collisions.cjs:33-54 的模糊判据复刻，仅用于证明粒度缺口真实存在（不是新判据）。
function legacyFuzzyPairs(descriptions) {
  const tokens = value => {
    const set = new Set();
    for (const m of value.matchAll(/[A-Za-z][A-Za-z0-9_.+-]{3,}/g)) set.add(m[0].toLowerCase());
    for (const m of value.matchAll(/[一-鿿]{2,4}/g)) set.add(m[0]);
    return set;
  };
  const names = Object.keys(descriptions);
  const tk = Object.fromEntries(names.map(name => [name, tokens(descriptions[name])]));
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      let shared = 0;
      for (const t of tk[a]) if (tk[b].has(t)) shared++;
      if (shared < 12) continue;
      if (shared / Math.min(tk[a].size, tk[b].size) < 0.22) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

test('覆盖面等于仓库技能目录全量，且当前无精确短语重复', () => {
  const dirCount = fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory()).length;
  const result = scan(repo);
  assert.equal(result.skills, dirCount, '校验器必须扫到每一个技能目录，不得只扫常驻集');
  assert.ok(result.skills >= 134, '本轮基线 134 个技能（0.1.7 新增 image-detail-inspect）');
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.duplicateGroups, 0, JSON.stringify(result.duplicates));
  assert.equal(result.phrases, result.uniquePhrases);
  const cli = run([]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /duplicateGroups=0/);
});

test('负对照：人为造一组完全相同短语必须 exit 非 0', () => {
  const base = fixture({
    'alpha-skill': '甲技能：磁盘索引结构。触发词：HNSW、磁盘结构。',
    'beta-skill': '乙技能：内存近邻图。触发词：HNSW、近邻图。',
  });
  const result = scan(base);
  assert.equal(result.skills, 2);
  assert.equal(result.duplicateGroups, 1);
  assert.deepEqual(result.duplicates[0], { phrase: 'hnsw', skills: ['alpha-skill', 'beta-skill'] });
  const cli = run(['--root', base]);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /DUP hnsw :: alpha-skill \| beta-skill/);
});

test('粒度缺口负对照：同一夹具旧模糊阈值仍给 0 对', () => {
  const descriptions = {
    'alpha-skill': '甲技能：磁盘索引结构。触发词：HNSW、磁盘结构。',
    'beta-skill': '乙技能：内存近邻图。触发词：HNSW、近邻图。',
  };
  const base = fixture(descriptions);
  assert.equal(legacyFuzzyPairs(descriptions).length, 0, '旧判据对单短语重复结构上不可能命中');
  assert.equal(scan(base).duplicateGroups, 1, '新判据必须命中');
});

test('大小写与空白归一后仍算重复', () => {
  const base = fixture({
    'alpha-skill': '甲技能。触发词：Vector Search、磁盘结构。',
    'beta-skill': '乙技能。触发词：vector   search、近邻图。',
  });
  assert.equal(scan(base).duplicateGroups, 1);
  assert.equal(scan(base).duplicates[0].phrase, 'vector search');
});

test('「不用于 / 也用于」里的排除项不算触发短语', () => {
  const base = fixture({
    'alpha-skill': '甲技能。触发词：磁盘结构。不用于：近邻图、HNSW → beta-skill。',
    'beta-skill': '乙技能。触发词：近邻图。不用于：磁盘结构、HNSW → alpha-skill。',
  });
  const result = scan(base);
  assert.equal(result.duplicateGroups, 0, JSON.stringify(result.duplicates));
  assert.deepEqual(triggerPhrases('甲技能。触发词：磁盘结构。不用于：近邻图、HNSW → beta-skill。'), ['磁盘结构']);
});

test('同一技能内重复列同一短语不算跨技能冲突', () => {
  const base = fixture({ 'alpha-skill': '甲技能。触发词：HNSW、hnsw、HNSW 。' });
  const result = scan(base);
  assert.equal(result.duplicateGroups, 0);
  assert.deepEqual(result.entries[0].phrases, ['hnsw']);
});

test('无触发词段落的技能被计入覆盖面但不贡献短语', () => {
  const base = fixture({
    'plain-skill': 'A plain upstream description without any trigger list.',
    'alpha-skill': '甲技能。触发词：磁盘结构。',
  });
  const result = scan(base);
  assert.equal(result.skills, 2);
  assert.equal(result.withTriggerSegment, 1);
  assert.equal(result.phrases, 1);
  assert.equal(result.duplicateGroups, 0);
});

test('本轮改动的技能独占路由线索逐条保留', () => {
  const expected = {
    'vibecoding-doc': ['写 vibecoding 文档', 'spec', 'agents.md', '上下文工程', '氛围编程', '实施规格'],
    'mongodb-search-and-ai': ['atlas search', '全文检索', 'vector search', 'rag', 'atlas 向量检索', 'atlas 混合检索', 'atlas hnsw'],
    'redis-search': ['redisearch', 'ft.create', 'ft.search', 'redis 向量检索', 'redis hnsw', 'redis 混合检索'],
    'skill-tiering-lazy-load': ['技能分层', '按需库', 'skills-library', 'skill-load 检索'],
    'skills-router': ['技能路由', '技能索引', 'skill-load', '按需技能', '能力安装', '能力更新', '主动使用', '路由回归', '联网搜索', '工具下载'],
    'svg-scene-animation': ['svg 动画', 'css keyframes', 'playwright 动画断言', 'reduced-motion'],
    'verify-ui-in-browser': ['前端验收', 'ui 验证', '打开界面', 'dev server', 'playwright'],
    'deliver-prd': ['prd', '产品需求文档', '需求规格', '验收标准', '干系人对齐', '功能立项'],
  };
  const result = scan(repo);
  for (const [name, phrases] of Object.entries(expected)) {
    const entry = result.entries.find(item => item.skill === name);
    assert.ok(entry, name + ' 必须在扫描结果里');
    for (const phrase of phrases) assert.ok(entry.phrases.includes(phrase), name + ' 缺少线索 ' + phrase);
  }
});

test('限定说法保留原短语子串，描述仍在上限内', () => {
  const { parseDescription } = require('../scripts/skill-description.cjs');
  const substrings = {
    'mongodb-search-and-ai': ['向量检索', '混合检索', 'HNSW'],
    'redis-search': ['向量检索', '混合检索', 'HNSW'],
    'skill-tiering-lazy-load': ['skill-load'],
    'svg-scene-animation': ['Playwright'],
  };
  for (const [name, needles] of Object.entries(substrings)) {
    const description = parseDescription(fs.readFileSync(path.join(repo, 'skills', name, 'SKILL.md'), 'utf8'));
    assert.ok(description.length <= 300, name + ' 描述 ' + description.length + ' 字符超上限');
    for (const needle of needles) assert.ok(description.includes(needle), name + ' 丢掉了子串 ' + needle);
  }
});

test('skill-collisions 输出明确标注只适用现役常驻集', () => {
  const source = fs.readFileSync(path.join(repo, 'scripts', 'skill-collisions.cjs'), 'utf8');
  assert.match(source, /仅现役常驻集/);
  assert.match(source, /skill-trigger-uniqueness\.cjs/);
  assert.match(source, /0 对不等于无精确短语重复/);
});

test('--root 缺值与未知参数返回 2', () => {
  assert.equal(run(['--root']).status, 2);
  assert.equal(run(['--root', '--json']).status, 2);
  assert.equal(run(['--nope']).status, 2);
});