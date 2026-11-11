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

fs.rmSync(SB, { recursive: true, force: true });
console.log(fail ? `\nrefcov FAIL ${fail}` : '\nrefcov ALL PASS');
process.exitCode = fail ? 1 : 0;