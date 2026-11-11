#!/usr/bin/env node
// T-19 coverage self-test: proves the broadened reference checker sees the three
// classes the old prefix whitelist missed, and that it does not flag prose examples.
// Includes a mutation control reproducing the old blind behaviour.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'skill-reference-integrity.cjs');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-refcov-'));
const SK = path.join(SB, 'skills', 'probe-skill');
fs.mkdirSync(path.join(SK, 'design-md', 'sub'), { recursive: true });
fs.mkdirSync(path.join(SK, 'references'), { recursive: true });

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

// resources/ link (class 1: prefix not in the old whitelist)
// ../absent-sibling/SKILL.md link (class 2: cross-skill)
// prose example src/a.js (must NOT be flagged)
fs.writeFileSync(path.join(SK, 'SKILL.md'), [
  '---', 'name: probe-skill', 'description: probe', '---', '',
  '# Probe', '',
  'See [guide](resources/missing-guide.md) and [sibling](../absent-sibling/SKILL.md).', '',
  'In your project you might have `src/a.js` or `app/routes/x.tsx` — those are examples.', '',
  'Anchor link to an existing file: [ok](references/real.md#section-1).', ''
].join('\n'));
fs.writeFileSync(path.join(SK, 'references', 'real.md'), '# real\n');
// design-md subtree (class 3: never traversed before)
fs.writeFileSync(path.join(SK, 'design-md', 'sub', 'DESIGN.md'),
  '# Design\n\nDerived by `scripts/absent-derive.mjs`.\n');

function run(extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', SB, '--check', '--json', ...extra], { encoding: 'utf8', timeout: 30000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch (e) {}
  return { code: r.status, json: j };
}
const r = run();
const refs = r.json ? r.json.missing.map(m => m.ref) : [];
check('resources/ 悬空被发现', refs.includes('resources/missing-guide.md'), JSON.stringify(refs));
check('../<兄弟技能>/ 悬空被发现', refs.includes('../absent-sibling/SKILL.md'));
check('design-md/ 子树被遍历且其悬空被发现', refs.includes('scripts/absent-derive.mjs'));
check('散文示例 src/a.js 不被误报', !refs.some(x => /src\/a\.js|app\/routes/.test(x)));
check('带锚点的存在文件不被误报', !refs.some(x => /real\.md/.test(x)));
check('filesScanned 覆盖 design-md 子树', r.json && r.json.filesScanned >= 3, String(r.json && r.json.filesScanned));

// Mutation control: the OLD prefix-only regex must be blind to all three classes.
const OLD_REF_RE = /(?:\.\.\/)*(?:references|scripts)\/[A-Za-z0-9._\/-]+\.(?:json|mjs|cjs|md|js|ps1|sh|py)(?![A-Za-z0-9])/g;
const oldFound = new Set();
for (const f of [path.join(SK, 'SKILL.md'), path.join(SK, 'design-md', 'sub', 'DESIGN.md')]) {
  const text = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(OLD_REF_RE)) oldFound.add(m[0]);
}
// old traversal only followed recognised prefixes from SKILL.md, so design-md was never read
const oldFromSkillOnly = new Set();
const skillText = fs.readFileSync(path.join(SK, 'SKILL.md'), 'utf8');
for (const m of skillText.matchAll(OLD_REF_RE)) oldFromSkillOnly.add(m[0]);
check('变异负对照：旧前缀白名单对 resources/ 与 ../sibling/ 全盲',
  !oldFromSkillOnly.has('resources/missing-guide.md') && !oldFromSkillOnly.has('../absent-sibling/SKILL.md'),
  JSON.stringify([...oldFromSkillOnly]));
check('变异负对照：旧实现即便读到 design-md 也只认 scripts/ 前缀（子树根本不被遍历）',
  oldFound.has('scripts/absent-derive.mjs') && r.json.filesScanned > 2);

// ---- F22：发布包按设计不含 .github/，仓库根含；豁免必须只在目录整体缺席时生效 ----
function refFixture(label, body, withGithubDir) {
  const base = path.join(SB, label);
  const skill = path.join(base, 'skills', 'probe-skill');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), ['---', 'name: probe-skill', 'description: probe', '---', '', body, ''].join('\n'));
  if (withGithubDir) {
    fs.mkdirSync(path.join(base, '.github'), { recursive: true });
    fs.writeFileSync(path.join(base, '.github', 'run-tests.js'), '// ci\n');
  }
  return base;
}
function runRoot(base, script = SCRIPT) {
  const r = spawnSync(process.execPath, [script, '--root', base, '--check', '--json'], { encoding: 'utf8', timeout: 30000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch (e) {}
  return { code: r.status, json: j };
}
const BODY = 'CI 入口见 `.github/run-tests.js`，脚本见 `scripts/absent-helper.cjs`。';

const pkgLike = runRoot(refFixture('f22-pkg', BODY, false));
const pkgMissing = pkgLike.json ? pkgLike.json.missing.map(m => m.ref) : [];
const pkgExcluded = pkgLike.json ? pkgLike.json.excluded.map(m => m.ref) : [];
check('F22 包内扫描：.github/ 整体缺席时该引用记为 notShipped 而非悬空',
  !pkgMissing.includes('.github/run-tests.js') && pkgExcluded.includes('.github/run-tests.js'), JSON.stringify({ pkgMissing, pkgExcluded }));
check('F22 豁免只覆盖缺席目录：同一文件里的 scripts/ 悬空仍判红',
  pkgMissing.includes('scripts/absent-helper.cjs') && pkgLike.code === 2, JSON.stringify(pkgMissing));
check('F22 notShipped 明示缺席目录，读数不静默',
  pkgLike.json && JSON.stringify(pkgLike.json.notShipped) === JSON.stringify(['.github']));

const repoLike = runRoot(refFixture('f22-repo', BODY, true));
check('F22 仓库根扫描：.github/ 存在时该引用照常解析，不进豁免',
  repoLike.json && repoLike.json.notShipped.length === 0 && repoLike.json.excluded.length === 0
  && !repoLike.json.missing.some(m => m.ref === '.github/run-tests.js'), JSON.stringify(repoLike.json && repoLike.json.missing));

const repoBogus = runRoot(refFixture('f22-repo-bogus', '见 `.github/definitely-absent.js`。', true));
check('F22 负对照：.github/ 存在但引用伪造时仍必须判红',
  repoBogus.code === 2 && repoBogus.json.missing.some(m => m.ref === '.github/definitely-absent.js'), JSON.stringify(repoBogus.json && repoBogus.json.missing));

const traversal = runRoot(refFixture('f22-traversal', '见 `.github/../scripts/absent-traversal.cjs`。', false));
check('F22 负对照：.github/../scripts/ 归一后不得蹭豁免',
  traversal.code === 2 && traversal.json.missing.some(m => m.ref.includes('absent-traversal.cjs'))
  && !traversal.json.excluded.length, JSON.stringify(traversal.json && traversal.json.missing));

// 变异负对照：把 REPO_ONLY_DIRS 清空（＝修复前行为），同一包内夹具必须把 .github 引用判成悬空
const mutantScript = path.join(SB, 'skill-reference-integrity.mutant.cjs');
const mutantSource = fs.readFileSync(SCRIPT, 'utf8').replace("const REPO_ONLY_DIRS = ['.github'];", 'const REPO_ONLY_DIRS = [];');
check('F22 变异命中目标常量', mutantSource !== fs.readFileSync(SCRIPT, 'utf8') && mutantSource.includes('const REPO_ONLY_DIRS = [];'));
fs.writeFileSync(mutantScript, mutantSource);
const mutantRun = runRoot(path.join(SB, 'f22-pkg'), mutantScript);
check('F22 变异负对照：无包感知时同一夹具判红 .github 引用（证明豁免改变了真实读数）',
  mutantRun.code === 2 && mutantRun.json.missing.some(m => m.ref === '.github/run-tests.js'), JSON.stringify(mutantRun.json && mutantRun.json.missing));

// 真实仓库根：随包技能文档里的 .github 引用必须全部可解析
const realRepo = runRoot(path.join(__dirname, '..'));
check('F22 真实仓库根扫描 missing=0 且无豁免',
  realRepo.code === 0 && realRepo.json.missing.length === 0 && realRepo.json.excluded.length === 0, JSON.stringify(realRepo.json && realRepo.json.missing));

fs.rmSync(SB, { recursive: true, force: true });
console.log(fail ? `\nrefcov FAIL ${fail}` : '\nrefcov ALL PASS');
process.exitCode = fail ? 1 : 0;