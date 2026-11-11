#!/usr/bin/env node
// T-01 / F1 / A3 / A4: single description parser + differential criterion.
'use strict';
const fs = require('fs');
const path = require('path');
const { parseDescription } = require('./skill-description.cjs');

const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };
const fm = (body) => `---\nname: probe\n${body}\nversion: 1.0.0\n---\n\n# body\n`;

// ---- unit: scalar styles ----
check('plain 单行', parseDescription(fm('description: hello world')) === 'hello world');
check('双引号剥除', parseDescription(fm('description: "hello world"')) === 'hello world');
check('双引号 \\\\ 解码', parseDescription(fm('description: "path D:\\\\Program\\\\x"')) === 'path D:\\Program\\x');
check('双引号 \\n 解码', parseDescription(fm('description: "a\\nb"')) === 'a\nb');
check('双引号 \\uXXXX 解码', parseDescription(fm('description: "caf\\u00e9"')) === 'café');
check('双引号 \\" 解码', parseDescription(fm('description: "say \\"hi\\""')) === 'say "hi"');
check("单引号 '' 转义", parseDescription(fm("description: 'it''s fine'")) === "it's fine");
check('多行 plain 折叠', parseDescription(fm('description: first line\n  second line')) === 'first line second line');
check('多行双引号折叠', parseDescription(fm('description: "first\n  second"')) === 'first second');
check('续行遇到下一个顶层键即停', parseDescription(fm('description: only this\nmetadata:\n  category: x')) === 'only this');

// ---- unit: error paths (must throw, never return a half value) ----
const throws = (body) => { try { parseDescription(body); return false; } catch (e) { return true; } };
check('缺 frontmatter 抛错', throws('# no frontmatter\ndescription: x'));
check('缺 description 抛错', throws(fm('version: 1.0.0')));
check('空 description 抛错', throws(fm('description:')));
check('双引号未闭合抛错', throws(fm('description: "unterminated')));
check('非法转义抛错', throws(fm('description: "bad \\q escape"')));

// ---- differential: catalog vs unified parser over the whole corpus ----
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const byId = new Map(catalog.entries.map(e => [e.id, e]));
const dirs = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
let compared = 0; const drift = [];
for (const d of dirs) {
  const f = path.join(ROOT, 'skills', d, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  let value; try { value = parseDescription(fs.readFileSync(f, 'utf8')); } catch (e) { drift.push({ skill: d, error: e.code }); continue; }
  const e = byId.get('skill:' + d);
  if (!e) { drift.push({ skill: d, error: 'NOT_IN_CATALOG' }); continue; }
  compared++;
  if (e.description !== value) drift.push({ skill: d, catalogLen: e.description.length, parsedLen: value.length });
}
check('全量语料 catalog 与统一解析一致（差分判据）', drift.length === 0, `compared=${compared} drift=${JSON.stringify(drift.slice(0, 6))}`);

// ---- differential: the enforcer's own descOf must equal the unified parser ----
const verifySrc = fs.readFileSync(path.join(ROOT, 'scripts/share-package-verify.cjs'), 'utf8');
check('执行器已改为共用真源（不再自带裸正则）', /skill-description\.cjs/.test(verifySrc) && !/t\.match\(\/\^description:\\s\*\(\.\+\)\$\/m\)/.test(verifySrc));
const extrasSrc = fs.readFileSync(path.join(ROOT, 'scripts/pack-share-extras.cjs'), 'utf8');
check('生产者已改为共用真源', /skill-description\.cjs/.test(extrasSrc));
const collSrc = fs.readFileSync(path.join(ROOT, 'scripts/skill-collisions.cjs'), 'utf8');
check('碰撞扫描已改为共用真源', /skill-description\.cjs/.test(collSrc));

// ---- mutation control: the OLD enforcer regex must disagree on the quoted corpus ----
const oldEnforcer = (text) => (text.match(/^description:\s*(.+)$/m) || [])[1] || null;
let oldDiff = 0;
for (const d of dirs) {
  const f = path.join(ROOT, 'skills', d, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  let v; try { v = parseDescription(t); } catch (e) { continue; }
  if (oldEnforcer(t) !== v) oldDiff++;
}
check('变异负对照：旧执行器裸正则与真源分歧数 > 0（证明判据能失败）', oldDiff > 0, `oldDiff=${oldDiff}`);

// ---- length headroom report (contract is String.length) ----
const capsSrc = fs.readFileSync(path.join(ROOT, 'scripts/skills-doctor.cjs'), 'utf8');
const capsBlock = (capsSrc.match(/const DESC_CARRIERS = \{([\s\S]*?)\n\};/) || [])[1] || '';
const caps = {}; for (const m of capsBlock.matchAll(/'([a-z0-9-]+)':\s*\{\s*max:\s*(\d+)/g)) caps[m[1]] = Number(m[2]);
let over = 0;
for (const d of dirs) {
  const f = path.join(ROOT, 'skills', d, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  let v; try { v = parseDescription(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  if (v.length > (caps[d] || 300)) over++;
}
check('按载体上限无超限描述', over === 0, `over=${over}`);

console.log(fail ? `\nskill-description FAIL ${fail}` : '\nskill-description ALL PASS');
process.exitCode = fail ? 1 : 0;