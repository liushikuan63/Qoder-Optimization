#!/usr/bin/env node
/**
 * 分享包打包前校验：只对「要发出去的这个包」判红，不干扰本机体检。
 *
 * 用法：
 *   node share-package-verify.cjs <包目录>
 *   node share-package-verify.cjs <包目录> --agents ~/.qoder/AGENTS.md   # 额外校验规则文档第一节与真源一致
 *   node share-package-verify.cjs --selftest
 *
 * 判据（任一不过 → 退出码 2）：
 *   1. 每个 skills/<名>/SKILL.md 的 description ≤300 字符；载体技能按 skills-doctor 的 DESC_CARRIERS.max 放宽
 *   2. 无 .bak / .log / backups/ / node_modules / .export-* / .DS_Store / Thumbs.db
 *   3. 无零字节文件
 *   4. 必需件齐全（VERSION / catalog.json / skills-manifest.json / 规则文档 / README / INDEX）
 *   5. catalog 计数与目录实际数量一致（skill / command / agent / script）
 *   6. （可选）规则文档「一、全局开发规则」与 AGENTS.md 正文逐字节一致
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DESC_MAX = 300;
const DOCTOR = path.join(__dirname, 'skills-doctor.cjs');

function carrierCaps() {
  try {
    const t = fs.readFileSync(DOCTOR, 'utf8');
    const m = t.match(/const DESC_CARRIERS = \{([\s\S]*?)\n\};/);
    if (!m) return {};
    const caps = {};
    const re = /'([a-z0-9-]+)':\s*\{\s*max:\s*(\d+)/g;
    let x;
    while ((x = re.exec(m[1]))) caps[x[1]] = Number(x[2]);
    return caps;
  } catch {
    return {};
  }
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).replace(/\\/g, '/');
    if (e.isDirectory()) walk(p, base, out);
    else out.push(rel);
  }
  return out;
}

function descOf(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = t.match(/^description:\s*(.+)$/m);
  return m ? m[1] : null;
}

function verify(pkgDir, agentsPath) {
  const fails = [];
  const passes = [];
  const caps = carrierCaps();

  // 4. 必需件
  const required = ['VERSION', 'catalog.json', 'skills-manifest.json', 'Qoder-AI编码通用规则.md', 'README-安装说明.md', 'INDEX.md'];
  const missing = required.filter((f) => !fs.existsSync(path.join(pkgDir, f)));
  missing.length ? fails.push(`必需件缺失: ${missing.join(', ')}`) : passes.push(`必需件齐 (${required.length})`);

  const files = walk(pkgDir, pkgDir, []);

  // 2. 垃圾文件
  const JUNK = /(^|\/)(\.export-|backups\/|node_modules\/|\.DS_Store$|Thumbs\.db$)|\.bak|\.log$/i;
  const junk = files.filter((f) => JUNK.test(f));
  junk.length ? fails.push(`垃圾文件 ${junk.length} 个: ${junk.slice(0, 5).join(', ')}`) : passes.push('无垃圾文件（.bak/日志/node_modules/.export-*）');

  // 3. 零字节
  const empty = files.filter((f) => fs.statSync(path.join(pkgDir, f)).size === 0);
  empty.length ? fails.push(`零字节文件 ${empty.length} 个: ${empty.slice(0, 5).join(', ')}`) : passes.push('无零字节文件');

  // 1. 描述长度
  const skillsDir = path.join(pkgDir, 'skills');
  const over = [];
  let maxSeen = [0, ''];
  const skillNames = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  for (const n of skillNames) {
    const f = path.join(skillsDir, n, 'SKILL.md');
    if (!fs.existsSync(f)) { fails.push(`技能缺 SKILL.md: ${n}`); continue; }
    const d = descOf(f);
    if (d === null) { fails.push(`技能缺 description: ${n}`); continue; }
    const cap = caps[n] || DESC_MAX;
    if (d.length > cap) over.push(`${n}(${d.length}>${cap})`);
    if (d.length > maxSeen[0]) maxSeen = [d.length, n + (caps[n] ? '²' : '')];
  }
  over.length ? fails.push(`description 超限 ${over.length} 个: ${over.join(', ')}`) : passes.push(`description ≤300（载体按 DESC_CARRIERS 放宽）: ${skillNames.length} 个技能, max=${maxSeen[0]} ${maxSeen[1]}`);

  // 5. catalog 计数
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(pkgDir, 'catalog.json'), 'utf8'));
    const actual = {
      skill: skillNames.length,
      command: fs.existsSync(path.join(pkgDir, 'commands')) ? fs.readdirSync(path.join(pkgDir, 'commands')).filter((f) => f.endsWith('.md')).length : 0,
      agent: fs.existsSync(path.join(pkgDir, 'agents')) ? fs.readdirSync(path.join(pkgDir, 'agents')).filter((f) => f.endsWith('.md')).length : 0,
      script: fs.existsSync(path.join(pkgDir, 'scripts')) ? fs.readdirSync(path.join(pkgDir, 'scripts'), { withFileTypes: true }).filter((entry) => entry.isFile() || entry.isDirectory()).length : 0,
    };
    const bad = Object.keys(actual).filter((k) => (cat.counts || {})[k] !== actual[k]);
    bad.length
      ? fails.push(`catalog 计数不符: ` + bad.map((k) => `${k} 标 ${cat.counts[k]} 实 ${actual[k]}`).join(', '))
      : passes.push(`catalog 计数一致 (${Object.entries(actual).map(([k, v]) => k + '=' + v).join(' ')})`);
  } catch (e) {
    fails.push('catalog.json 解析失败: ' + e.message.split('\n')[0]);
  }

  // 6. 文档与真源一致（可选）
  if (agentsPath) {
    try {
      const doc = fs.readFileSync(path.join(pkgDir, 'Qoder-AI编码通用规则.md'), 'utf8').replace(/\r\n/g, '\n');
      const agents = fs.readFileSync(agentsPath, 'utf8').replace(/\r\n/g, '\n').replace(/^# .*\n+/, '').replace(/^> 版本：.*\n+/, '').trim();
      const i = doc.indexOf('## 一、全局开发规则');
      const j = doc.indexOf('## 二、领域规则');
      const sec = i >= 0 && j > i ? doc.slice(i + '## 一、全局开发规则'.length, j).trim() : '';
      sec === agents ? passes.push('规则文档第一节 == AGENTS.md') : fails.push('规则文档第一节与 AGENTS.md 不一致');
    } catch (e) {
      fails.push('文档一致性校验失败: ' + e.message.split('\n')[0]);
    }
  }

  for (const p of passes) console.log('PASS  ' + p);
  for (const f of fails) console.log('FAIL  ' + f);
  console.log(fails.length ? `VERDICT=RED (${fails.length} 项)` : 'VERDICT=CLEAN');
  return fails.length ? 2 : 0;
}

function selftest() {
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgverify-'));
  const mk = (root, name, desc) => {
    fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# x\n`);
  };
  const base = (root, extra = {}) => {
    fs.mkdirSync(root, { recursive: true });
    for (const f of ['VERSION', 'README-安装说明.md', 'Qoder-AI编码通用规则.md', 'INDEX.md']) fs.writeFileSync(path.join(root, f), 'x\n');
    fs.writeFileSync(path.join(root, 'skills-manifest.json'), JSON.stringify({ total: 1, skills: [] }));
    const counts = { skill: 1, command: 0, agent: 0, script: 0, ...(extra.counts || {}) };
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ counts, entries: [] }));
  };
  const run = (dir) => spawnSync(process.execPath, [__filename, dir], { encoding: 'utf8' });

  let bad = 0;
  const assert = (cond, msg) => { if (!cond) { console.log('SELFTEST-FAIL ' + msg); bad++; } };

  // 正例
  const good = path.join(tmp, 'good'); base(good); mk(good, 'ok-skill', '短描述');
  let r = run(good);
  assert(r.status === 0 && r.stdout.includes('VERDICT=CLEAN'), '干净包应判绿');
  console.log('  [正例] exit=' + r.status);

  // 负例 1：超长描述
  const longD = path.join(tmp, 'long'); base(longD); mk(longD, 'long-skill', 'x'.repeat(301));
  r = run(longD);
  assert(r.status === 2 && r.stdout.includes('long-skill'), '超 300 应判红并点名');
  console.log('  [负例·超长] exit=' + r.status);

  // 负例 2：垃圾文件
  const junk = path.join(tmp, 'junk'); base(junk); mk(junk, 'ok-skill', '短描述');
  fs.writeFileSync(path.join(junk, 'a.bak'), 'x');
  r = run(junk);
  assert(r.status === 2 && r.stdout.includes('垃圾文件'), '.bak 应判红');
  console.log('  [负例·.bak] exit=' + r.status);

  // 负例 3：零字节
  const zero = path.join(tmp, 'zero'); base(zero); mk(zero, 'ok-skill', '短描述');
  fs.writeFileSync(path.join(zero, 'empty.md'), '');
  r = run(zero);
  assert(r.status === 2 && r.stdout.includes('零字节'), '零字节应判红');
  console.log('  [负例·零字节] exit=' + r.status);

  // 负例 4：计数不符
  const cnt = path.join(tmp, 'count'); base(cnt, { counts: { skill: 9 } }); mk(cnt, 'ok-skill', '短描述');
  r = run(cnt);
  assert(r.status === 2 && r.stdout.includes('catalog 计数不符'), '计数不符应判红');
  console.log('  [负例·计数] exit=' + r.status);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `SELFTEST=FAIL (${bad})` : 'SELFTEST=PASS (1 正例 / 4 负例)');
  return bad ? 2 : 0;
}

if (process.argv[2] === '--selftest') process.exit(selftest());
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('用法：share-package-verify.cjs <包目录> [--agents AGENTS.md] | --selftest'); process.exit(2); }
const ai = process.argv.indexOf('--agents');
process.exit(verify(path.resolve(dir), ai > 0 ? process.argv[ai + 1] : null));
