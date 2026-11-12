#!/usr/bin/env node
// T-01 / F1 / A3 / A4: single description parser + differential criterion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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

// ---- T-01 补：astral 字符（契约口径＝String.length，即 UTF-16 码元，不是码点数）----
const astral = parseDescription(fm('description: "a\\ud83d\\ude00b"'));
const astralWant = 'a' + String.fromCodePoint(0x1F600) + 'b';
check('astral \\uD83D\\uDE00 正确解码', astral === astralWant, JSON.stringify(astral));
check('astral 长度按 UTF-16 计＝4（码点数是 3，口径不能混）', astral.length === 4, 'len=' + astral.length);

// ---- T-01 补：多行 description 三处同一结论（契约＝折叠拼接；不是拒绝、也不是取首行）----
// 三处＝执行器 share-package-verify、生产者 pack-share-extras、碰撞扫描 skill-collisions。
// 判别力来自 M2：首行 299 字符、折叠后 301 ⇒ 取首行的实现会判绿，折叠的实现必须判红。
const extras = require('./pack-share-extras.cjs');
const VERIFY = path.join(ROOT, 'scripts', 'share-package-verify.cjs');
const COLL = path.join(ROOT, 'scripts', 'skill-collisions.cjs');
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'desc-threeway-'));
const SK = 'probe-skill';
const skillMd = (l1, l2) => `---\nname: ${SK}\ndescription: ${l1}\n  ${l2}\nversion: 1.0.0\n---\n\n# body\n`;
function verifyPkg(tag, text) {
  const dir = path.join(tmp3, tag);
  fs.mkdirSync(path.join(dir, 'skills', SK), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', SK, 'SKILL.md'), text);
  for (const f of ['VERSION', 'README-安装说明.md', 'Qoder-AI编码通用规则.md', 'INDEX.md']) fs.writeFileSync(path.join(dir, f), 'x\n');
  fs.writeFileSync(path.join(dir, 'skills-manifest.json'), JSON.stringify({ total: 1, skills: [] }));
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ counts: { skill: 1, command: 0, agent: 0, script: 0 }, entries: [] }));
  return spawnSync(process.execPath, [VERIFY, dir], { encoding: 'utf8' });
}
function collisionsLen(text) {
  // 沙箱 HOME：只放这一个技能，于是 sum(cn) = desc.length + name.length + 4 可反解出解析长度。
  const home = path.join(tmp3, 'home-' + Math.random().toString(36).slice(2, 8));
  for (const side of ['.qoder', '.qoder-cn']) {
    const d = path.join(home, side, 'skills', SK);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), text);
  }
  const r = spawnSync(process.execPath, [COLL], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) });
  const m = /CN 侧当前每轮注入≈(\d+) 字符/.exec(r.stdout || '');
  return m ? Number(m[1]) - SK.length - 4 : null;
}
const M1 = skillMd('x'.repeat(298), 'y');   // 折叠后 300
const M2 = skillMd('x'.repeat(299), 'y');   // 首行 299、折叠后 301
const want1 = 'x'.repeat(298) + ' y';
const want2 = 'x'.repeat(299) + ' y';
const f1 = path.join(tmp3, 'm1.md'); fs.writeFileSync(f1, M1);
const f2 = path.join(tmp3, 'm2.md'); fs.writeFileSync(f2, M2);
// 每处只跑一次，结果留变量：既避免重复 spawn，也让「三处一致」能拿真实判定来比。
const e1 = extras.descriptionOf(f1), e2 = extras.descriptionOf(f2);
const c1 = collisionsLen(M1), c2 = collisionsLen(M2);
const r1 = verifyPkg('m1', M1), r2 = verifyPkg('m2', M2);
check('多行 M1：生产者给出折叠值（精确比对，不只比长度）', e1 === want1, 'len=' + String(e1 || '').length);
check('多行 M1：碰撞扫描解析长度＝300', c1 === 300, 'got=' + c1);
check('多行 M1：执行器判绿 exit 0', r1.status === 0, 'exit=' + r1.status);
check('多行 M2：生产者折叠后精确等于 want2（301 字符，不是取首行 299）', e2 === want2, 'len=' + String(e2 || '').length);
check('多行 M2：碰撞扫描解析长度＝301', c2 === 301, 'got=' + c2);
check('多行 M2：执行器判红 exit 2（取首行的实现会在这里假绿）', r2.status === 2, 'exit=' + r2.status);
// 三处一致＝把三处对同一夹具的「是否合规」归一成布尔后必须相同。
// 旧写法比的是 want1.length===300 && want2.length===301，那是我自己算的常数，恒真、无判别力。
const compliant = (e, c, r) => [String(e || '').length <= 300, c !== null && c <= 300, r.status === 0];
const v1 = compliant(e1, c1, r1), v2 = compliant(e2, c2, r2);
check('多行三处判定一致（M1 三处同判合规 / M2 三处同判超限）',
  v1.every((x) => x === true) && v2.every((x) => x === false),
  'M1=' + JSON.stringify(v1) + ' M2=' + JSON.stringify(v2));
fs.rmSync(tmp3, { recursive: true, force: true });

// ---- T-01 补：余量 ≤5 字符的技能逐个复核仍合规 ----
const tight = [];
for (const d of dirs) {
  const f = path.join(ROOT, 'skills', d, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  let v; try { v = parseDescription(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  const cap = caps[d] || 300;
  const head = cap - v.length;
  if (head <= 5) tight.push({ skill: d, cap, len: v.length, head });
}
tight.sort((a, b) => a.head - b.head);
check('余量 ≤5 的技能全部仍合规（headroom ≥ 0，且清单非空以免空集恒真）', tight.length > 0 && tight.every((t) => t.head >= 0), 'count=' + tight.length);
console.log('TIGHT_HEADROOM=' + tight.length + ' ' + JSON.stringify(tight));

console.log(fail ? `\nskill-description FAIL ${fail}` : '\nskill-description ALL PASS');
process.exitCode = fail ? 1 : 0;