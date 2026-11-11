'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan, triggerPhrases } = require('./skill-trigger-uniqueness.cjs');

const REPO = path.resolve(__dirname, '..');
const TOOL = path.join(__dirname, 'skill-trigger-uniqueness.cjs');
const TEMP = process.env.TRIGGER_TEST_ROOT
  || (process.platform === 'win32' && fs.existsSync('D:/tmp') ? 'D:/tmp' : os.tmpdir());
const ROOT = path.join(TEMP, `trigger-uniqueness-test-${process.pid}-${Date.now()}`);

function fixture(name, skills) {
  const root = path.join(ROOT, name);
  for (const [skill, description] of Object.entries(skills)) {
    const dir = path.join(root, 'skills', skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${description}\n---\n\n# ${skill}\n`, 'utf8');
  }
  return root;
}

function cli(args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// 旧判据的逐字复刻（scripts/skill-collisions.cjs:36-56）：共享区分性词 ≥12 且占小集合 ≥22%。
// 用来证明「单个精确短语重复」在旧判据下结构上不可能命中，而不是靠断言旧工具输出。
function legacyTokens(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9_.+-]{3,}/g)) set.add(m[0].toLowerCase());
  for (const m of String(text).matchAll(/[一-鿿]{2,4}/g)) set.add(m[0]);
  return set;
}
function legacyFuzzyPairs(descriptions) {
  const names = Object.keys(descriptions);
  const tk = Object.fromEntries(names.map((n) => [n, legacyTokens(descriptions[n])]));
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]; const b = names[j];
      let shared = 0;
      for (const t of tk[a]) if (tk[b].has(t)) shared++;
      if (shared < 12) continue;
      if (shared / Math.min(tk[a].size, tk[b].size) < 0.22) continue;
      pairs.push({ a, b, shared });
    }
  }
  return pairs;
}

test('skill-trigger-uniqueness', async (t) => {
  t.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  await t.test('the shipped repository has no duplicate trigger phrase', () => {
    const result = scan(REPO);
    assert.equal(result.skills, 133, '覆盖面必须是仓库全量技能，不是现役常驻集');
    assert.deepEqual(result.parseErrors, []);
    assert.equal(result.duplicateGroups, 0, JSON.stringify(result.duplicates));
    assert.equal(result.uniquePhrases, result.phrases);
    assert.equal(cli([]).status, 0);
  });

  await t.test('an exact duplicate phrase is reported and turns the CLI red', () => {
    const descriptions = {
      'vector-search': '向量检索与索引调优。触发词：向量检索、HNSW',
      'other-search': '另一种检索实现。触发词：HNSW、召回率',
    };
    const root = fixture('dup', descriptions);
    const result = scan(root);
    assert.equal(result.duplicateGroups, 1);
    assert.deepEqual(result.duplicates[0], { phrase: 'hnsw', skills: ['other-search', 'vector-search'] });
    const run = cli(['--root', root]);
    assert.equal(run.status, 1, '人为造重复必须 exit 非 0');
    assert.match(run.stdout, /DUP hnsw :: other-search \| vector-search/);
  });

  await t.test('negative control for the legacy fuzzy threshold: one shared phrase is invisible to it', () => {
    const descriptions = {
      'vector-search': '向量检索与索引调优。触发词：向量检索、HNSW',
      'other-search': '另一种检索实现。触发词：HNSW、召回率',
    };
    const root = fixture('legacy-gap', descriptions);
    assert.equal(scan(root).duplicateGroups, 1, '新判据必须判红');
    assert.equal(legacyFuzzyPairs(descriptions).length, 0, '旧模糊阈值对同一组重复给 0——粒度缺口真实存在');
  });

  await t.test('case and whitespace variants are the same phrase', () => {
    const root = fixture('normalize', {
      alpha: '第一个技能。触发词：HNSW',
      beta: '第二个技能。触发词： hnsw ',
    });
    assert.equal(scan(root).duplicateGroups, 1);
    assert.deepEqual(triggerPhrases('触发词：A、 a 、B'), ['a', 'b']);
  });

  await t.test('exclusion segments are not trigger cues', () => {
    const root = fixture('exclusion', {
      alpha: '向量检索。触发词：向量检索。不用于：混合检索（→beta）',
      beta: '混合检索实现。触发词：混合检索',
    });
    const result = scan(root);
    assert.equal(result.duplicateGroups, 0, '「不用于」里的短语不得参与重复判定');
    assert.deepEqual(result.entries.find((e) => e.skill === 'alpha').phrases, ['向量检索']);
  });

  await t.test('a malformed description is surfaced, never silently skipped', () => {
    const root = path.join(ROOT, 'broken');
    const dir = path.join(root, 'skills', 'broken-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: broken-skill\ndescription: "未闭合的双引号\n---\n', 'utf8');
    const result = scan(root);
    assert.equal(result.parseErrors.length, 1);
    assert.match(result.parseErrors[0].code, /未闭合/);
    assert.equal(cli(['--root', root]).status, 1);
  });

  await t.test('skills without a trigger segment are counted, not crashed on', () => {
    const root = fixture('no-trigger', { plain: '只做一件事，没有触发词段落。' });
    const result = scan(root);
    assert.equal(result.skills, 1);
    assert.equal(result.withTriggerSegment, 0);
    assert.equal(result.phrases, 0);
    assert.equal(cli(['--root', root]).status, 0);
  });

  await t.test('mutation control: requiring three owners hides a real two-way duplicate', () => {
    const mutantDir = path.join(ROOT, 'mutant');
    fs.mkdirSync(mutantDir, { recursive: true });
    for (const file of ['skill-trigger-uniqueness.cjs', 'skill-description.cjs']) {
      fs.copyFileSync(path.join(__dirname, file), path.join(mutantDir, file));
    }
    const source = fs.readFileSync(TOOL, 'utf8');
    const anchor = '.filter(([, owners]) => owners.length > 1)';
    assert.ok(source.includes(anchor), '变异锚点必须存在于实现中');
    fs.writeFileSync(path.join(mutantDir, 'skill-trigger-uniqueness.cjs'), source.replace(anchor, '.filter(([, owners]) => owners.length > 2)'));
    const root = fixture('mutant-dup', {
      alpha: '第一个技能。触发词：HNSW',
      beta: '第二个技能。触发词：HNSW',
    });
    const mutant = require(path.join(mutantDir, 'skill-trigger-uniqueness.cjs'));
    assert.equal(mutant.scan(root).duplicateGroups, 0, '放宽到三个归属方后必须漏掉真实重复——证明判据真的依赖 >1');
    assert.equal(scan(root).duplicateGroups, 1);
  });
});