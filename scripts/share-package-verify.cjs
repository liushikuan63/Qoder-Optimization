#!/usr/bin/env node
/**
 * 分享包打包前校验：只对「要发出去的这个包」判红，不干扰本机体检。
 *
 * 用法：
 *   node share-package-verify.cjs <包目录>
 *   node share-package-verify.cjs <包目录> --agents ~/.qoder/AGENTS.md   # 额外校验规则文档第一节与真源一致
 *   node share-package-verify.cjs <包目录> --agents=~/.qoder/AGENTS.md   # 等号形同义；缺值/未知开关一律退 2
 *   node share-package-verify.cjs --selftest
 *
 * 判据（任一不过 → 退出码 2）：
 *   1. 每个 skills/<名>/SKILL.md 的 description ≤300 字符；载体技能按 skills-doctor 的 DESC_CARRIERS.max 放宽
 *   2. 无 .bak / .log / backups/ / node_modules / .export-* / .DS_Store / Thumbs.db
 *   3. 无零字节文件
 *   4. 必需件齐全（VERSION / catalog.json / skills-manifest.json / 规则文档 / README / INDEX）
 *   5. catalog 计数与目录实际数量一致（skill / command / agent / script）；
 *      shipped 条目的 source 必须存在且为包内相对路径，依赖 id 必须能在 catalog 中找到
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
  // 与生产者 pack-share-extras 共用同一解析真源：此前这里取含引号的原始行、不解码，
  // 导致 89 个 quoted 技能长度多算 2、含转义的多算 3（实测 90/133 分歧）。
  try { return require('./skill-description.cjs').descriptionOfFile(file); } catch (e) { return null; }
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
  // `.bak` 必须带右边界：备份命名真源是 backup-file.js 的 BAK_RE = /^(.*)\.bak(?:[-._].*)?$/，
  // 即 `.bak` 后只能跟 `-`/`_`/`.` 分隔的后缀或结束。旧写法裸 `\.bak` 把 `notes.bakery.md`
  // 这种正常文档也判成垃圾（2026-11-12 probe-f77-79 F79-A/A2 修前红：exit 2）。
  // 目录形 `foo.bak/x.md` 仍要拦，所以边界是「后缀 + (/ 或 结束)」。
  const JUNK = /(^|\/)(\.export-|backups\/|node_modules\/|\.DS_Store$|Thumbs\.db$)|\.bak(?:[-._][^/]*)?(\/|$)|\.log$/i;
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
    const entries = Array.isArray(cat.entries) ? cat.entries.filter((e) => e && e.status === 'shipped') : [];
    // source 必须是**包内相对路径**。旧写法只按 '/' 切段找 '..'：Windows 反斜杠形
    // `..\outside.md` 切不开 ⇒ 不算 unsafe，而 existsSync 在 Windows 上照样解析到包外真实文件
    // ⇒ 判绿（2026-11-12 probe-f77-79 F77-A/B 修前红）。这里改成"先归一化分隔符，再验解析结果仍在包内"：
    // 「解析后仍在包根内」才是真正的判据，任何绕法（..、绝对路径、盘符相对路径）都逃不出去。
    const rootAbs = path.resolve(pkgDir);
    const normSep = (s) => String(s).replace(/\\/g, '/');
    const insidePkg = (rel) => {
      const abs = path.resolve(rootAbs, normSep(rel));
      return abs === rootAbs || abs.startsWith(rootAbs + path.sep);
    };
    const unsafe = entries.filter((e) => typeof e.source !== 'string' || !e.source.trim()
      || path.isAbsolute(e.source) || path.isAbsolute(normSep(e.source))
      || normSep(e.source).split('/').includes('..') || !insidePkg(e.source));
    const absent = entries.filter((e) => !unsafe.includes(e) && !fs.existsSync(path.join(pkgDir, e.source)));
    if (unsafe.length || absent.length) {
      fails.push(`catalog 来源无效/缺失 ${unsafe.length + absent.length} 条: ` + [...unsafe, ...absent].slice(0, 5).map((e) => e.id || e.source).join(', '));
    } else passes.push(`catalog 来源存在 (${entries.length} 条)`);
    const ids = new Set((Array.isArray(cat.entries) ? cat.entries : []).map((e) => e && e.id));
    const dangling = entries.flatMap((e) => (Array.isArray(e.dependencies) ? e.dependencies : []).filter((id) => !ids.has(id)).map((id) => `${e.id}->${id}`));
    dangling.length ? fails.push(`catalog 依赖悬空 ${dangling.length} 条: ` + dangling.slice(0, 5).join(', ')) : passes.push('catalog 依赖齐全');
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
  // 带 source 条目的包：counts 保持不变，红/绿才可归因到 source 判据本身。
  const withEntries = (tag, entries, files = {}) => {
    const root = path.join(tmp, tag);
    base(root); mk(root, 'ok-skill', '短描述');
    fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({
      counts: { skill: 1, command: 0, agent: 0, script: 0 },
      entries: [{ id: 'skill:ok-skill', status: 'shipped', source: 'skills/ok-skill/SKILL.md' }, ...entries],
    }));
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return root;
  };
  const withFiles = (tag, files) => withEntries(tag, [], files);
  const run = (dir, ...extra) => spawnSync(process.execPath, [__filename, dir, ...extra], { encoding: 'utf8' });

  let bad = 0;
  let pos = 0;
  let neg = 0;
  const assert = (cond, msg) => { if (!cond) { console.log('SELFTEST-FAIL ' + msg); bad++; } };
  // 条数由实跑累计，不手写：手写数字会随判据增加而过期（同族缺陷已在两份文档上咬过）。
  const expectCase = (kind, label, r, wantStatus, msg, mustInclude) => {
    kind === '正例' ? pos++ : neg++;
    const out = String(r.stdout || '') + String(r.stderr || '');
    assert(r.status === wantStatus && (!mustInclude || out.includes(mustInclude)),
      `[${kind}·${label}] ${msg}（期望 exit=${wantStatus}${mustInclude ? ' 且含「' + mustInclude + '」' : ''}，实得 exit=${r.status}）`);
    console.log(`  [${kind}·${label}] exit=${r.status}`);
  };

  // 正例
  const good = path.join(tmp, 'good'); base(good); mk(good, 'ok-skill', '短描述');
  expectCase('正例', '干净包', run(good), 0, '干净包应判绿', 'VERDICT=CLEAN');

  // 正例 2/3：解码后恰好 300 字符，quoted 与 unquoted 必须同结论（T-01 边界）。
  // 旧裸正则把引号算进长度 ⇒ quoted 300 被误判 exit 2、unquoted 300 exit 0，同一描述两种结论。
  const q300 = path.join(tmp, 'quoted300'); base(q300); mk(q300, 'ok-skill', '"' + 'x'.repeat(300) + '"');
  expectCase('正例', 'quoted300', run(q300), 0, 'quoted 解码后 300 应判绿', 'VERDICT=CLEAN');
  const u300 = path.join(tmp, 'unquoted300'); base(u300); mk(u300, 'ok-skill', 'x'.repeat(300));
  expectCase('正例', 'unquoted300', run(u300), 0, 'unquoted 300 应判绿', 'VERDICT=CLEAN');

  // 负例 1：超长描述
  const longD = path.join(tmp, 'long'); base(longD); mk(longD, 'long-skill', 'x'.repeat(301));
  expectCase('负例', '超长', run(longD), 2, '超 300 应判红并点名', 'long-skill');

  // 负例 1b：quoted 301（剥引号后仍超限）——与正例 2 只差一个字符，判据必须能失败。
  const q301 = path.join(tmp, 'quoted301'); base(q301); mk(q301, 'long-skill', '"' + 'x'.repeat(301) + '"');
  expectCase('负例', 'quoted301', run(q301), 2, 'quoted 解码后 301 应判红', 'long-skill');

  // 负例 2：垃圾文件
  const junk = path.join(tmp, 'junk'); base(junk); mk(junk, 'ok-skill', '短描述');
  fs.writeFileSync(path.join(junk, 'a.bak'), 'x');
  expectCase('负例', '.bak', run(junk), 2, '.bak 应判红', '垃圾文件');

  // 负例 3：零字节
  const zero = path.join(tmp, 'zero'); base(zero); mk(zero, 'ok-skill', '短描述');
  fs.writeFileSync(path.join(zero, 'empty.md'), '');
  expectCase('负例', '零字节', run(zero), 2, '零字节应判红', '零字节');

  // 负例 4：计数不符
  const cnt = path.join(tmp, 'count'); base(cnt, { counts: { skill: 9 } }); mk(cnt, 'ok-skill', '短描述');
  expectCase('负例', '计数', run(cnt), 2, '计数不符应判红', 'catalog 计数不符');

  // 负例 5：计数一致但来源缺失
  const src = path.join(tmp, 'source'); base(src); mk(src, 'ok-skill', '短描述');
  fs.writeFileSync(path.join(src, 'catalog.json'), JSON.stringify({ counts: { skill: 1, command: 0, agent: 0, script: 0 }, entries: [{ id: 'skill:ok-skill', status: 'shipped', source: 'skills/not-here' }] }));
  expectCase('负例', '来源', run(src), 2, '来源缺失应判红', 'catalog 来源');

  // 负例 6：依赖悬空
  const dep = path.join(tmp, 'dependency'); base(dep); mk(dep, 'ok-skill', '短描述');
  fs.writeFileSync(path.join(dep, 'catalog.json'), JSON.stringify({ counts: { skill: 1, command: 0, agent: 0, script: 0 }, entries: [{ id: 'skill:ok-skill', status: 'shipped', source: 'skills/ok-skill', dependencies: ['script:missing'] }] }));
  expectCase('负例', '依赖', run(dep), 2, '依赖悬空应判红', 'catalog 依赖悬空');

  // ---- F77-F79 ----
  // 2026-11-12 第七段通读实测出的三处缺口（probe-f77-79-pkgverify.cjs 修前 9 条红、16 条对照绿）。
  // F77：source 用反斜杠越界，split('/') 认不出 '..'，包外真实文件被判"来源存在"。
  const outside = path.join(tmp, 'outside.md');
  fs.writeFileSync(outside, '包外文件\n');
  expectCase('负例', 'F77 反斜杠越界', run(withEntries('f77-bs', [{ id: 'script:evil', status: 'shipped', source: '..\\outside.md' }])), 2,
    '反斜杠越界 source 应判红', 'catalog 来源');
  expectCase('负例', 'F77 深层反斜杠', run(withEntries('f77-bs2', [{ id: 'script:evil', status: 'shipped', source: 'skills\\..\\..\\outside.md' }])), 2,
    'skills\\..\\..\\ 越界应判红', 'catalog 来源');
  expectCase('负例', 'F77 正斜杠越界', run(withEntries('f77-fs', [{ id: 'script:evil', status: 'shipped', source: '../outside.md' }])), 2,
    '正斜杠越界应判红（旧实现已能拦）', 'catalog 来源');
  expectCase('负例', 'F77 绝对路径', run(withEntries('f77-abs', [{ id: 'script:evil', status: 'shipped', source: outside }])), 2,
    '绝对路径 source 应判红', 'catalog 来源');
  expectCase('正例', 'F77 包内反斜杠', run(withEntries('f77-in', [{ id: 'script:winpath', status: 'shipped', source: 'skills\\ok-skill\\SKILL.md' }])), 0,
    '包内反斜杠 source 不越界，应判绿', 'VERDICT=CLEAN');

  // F78：--agents 缺值/等号形/未知开关必须失败关闭，不能静默跳过文档一致性校验。
  const agentsGood = path.join(tmp, 'AGENTS-good.md');
  fs.writeFileSync(agentsGood, '# 标题\n\n规则正文一行\n');
  const agentsBad = path.join(tmp, 'AGENTS-bad.md');
  fs.writeFileSync(agentsBad, '# 标题\n\n完全不同的正文\n');
  const docPkg = withFiles('f78-doc', { 'Qoder-AI编码通用规则.md': '## 一、全局开发规则\n\n规则正文一行\n\n## 二、领域规则\n\nx\n' });
  expectCase('正例', 'F78 一致·空格形', run(docPkg, '--agents', agentsGood), 0, '一致时应判绿且真的比过', '规则文档第一节 == AGENTS.md');
  expectCase('正例', 'F78 一致·等号形', run(docPkg, '--agents=' + agentsGood), 0, '等号形同义，应判绿且真的比过', '规则文档第一节 == AGENTS.md');
  expectCase('正例', 'F78 不带开关', run(docPkg), 0, '不带 --agents 时这道校验本就可选', 'VERDICT=CLEAN');
  expectCase('负例', 'F78 缺值', run(docPkg, '--agents'), 2, '--agents 缺值应判红（旧实现静默跳过还退 0）');
  expectCase('负例', 'F78 等号缺值', run(docPkg, '--agents='), 2, '--agents= 缺值应判红');
  expectCase('负例', 'F78 等号不一致', run(docPkg, '--agents=' + agentsBad), 2, '等号形不一致应判红（旧实现整条认不出开关）', '不一致');
  expectCase('负例', 'F78 空格不一致', run(docPkg, '--agents', agentsBad), 2, '空格形不一致应判红（旧实现已能拦）', '不一致');
  expectCase('负例', 'F78 未知开关', run(docPkg, '--agentsx'), 2, '未知开关应失败关闭');
  expectCase('负例', 'F78 值位置是开关', run(docPkg, '--agents', '--selftest'), 2, '--agents 后跟开关应判红');
  expectCase('负例', 'F78 路径不存在', run(docPkg, '--agents', path.join(tmp, 'nope.md')), 2, '--agents 指向不存在文件应判红');

  // F79：.bak 必须带右边界——正常文档 notes.bakery.md 不许被误判，真备份的各种历史命名仍要拦。
  expectCase('正例', 'F79 bakery.md', run(withFiles('f79-bakery', { 'notes.bakery.md': '正常文档\n' })), 0,
    'notes.bakery.md 是正常文档，应判绿', 'VERDICT=CLEAN');
  expectCase('正例', 'F79 bakery.json', run(withFiles('f79-bakery2', { 'docs/catalog.bakery.json': '{"a":1}\n' })), 0,
    'catalog.bakery.json 是正常文档，应判绿', 'VERDICT=CLEAN');
  expectCase('正例', 'F79 log.md', run(withFiles('f79-logmd', { 'x.log.md': '正常文档\n' })), 0,
    'x.log.md 不是日志，应判绿', 'VERDICT=CLEAN');
  for (const name of ['a.bak.20261014-093000', 'a.bak-byok-guard.20261014', 'a.bak_20261013', 'foo.bak/x.md', 'x.log']) {
    expectCase('负例', 'F79 ' + name, run(withFiles('f79-' + name.replace(/[^A-Za-z0-9]+/g, '-'), { [name]: '备份内容\n' })), 2,
      `真备份/日志 ${name} 应判红`, '垃圾文件');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `SELFTEST=FAIL (${bad})` : `SELFTEST=PASS (${pos} 正例 / ${neg} 负例)`);
  return bad ? 2 : 0;
}

const USAGE = '用法：share-package-verify.cjs <包目录> [--agents <AGENTS.md> | --agents=<AGENTS.md>] | --selftest';

// 参数解析失败关闭：认不出的开关、缺值的 --agents、多余的位置参数一律退 2。
// 旧写法 `indexOf('--agents')` + `argv[ai+1]`：缺值时取到 undefined，被当成"没传这个开关"，
// 文档一致性校验**静默跳过**还退 0（2026-11-12 probe-f77-79 F78-A/B/C 修前红）；
// 等号形 `--agents=<路径>` 更是整条认不出来。一道关卡悄悄不跑，比判红更坏。
function parseArgs(argv) {
  const opts = { dir: null, agents: null, selftest: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--selftest') { opts.selftest = true; continue; }
    if (a === '--agents' || a.startsWith('--agents=')) {
      const v = a === '--agents' ? argv[++i] : a.slice('--agents='.length);
      if (v === undefined || !String(v).trim() || String(v).startsWith('--')) {
        opts.errors.push('--agents 需要紧跟 AGENTS.md 路径（--agents <路径> 或 --agents=<路径>）；'
          + '缺值时静默跳过文档一致性校验＝这道关卡形同不存在，所以拒绝继续。');
      } else opts.agents = String(v);
      continue;
    }
    if (a.startsWith('--')) { opts.errors.push('未知开关 ' + a + '：拒绝继续（静默忽略会让校验少跑一道）。'); continue; }
    if (opts.dir === null) opts.dir = a;
    else opts.errors.push('多余的位置参数 ' + a + '：只接受一个包目录。');
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.errors.length) {
  for (const e of opts.errors) console.error('参数错误：' + e);
  console.error(USAGE);
  process.exit(2);
}
if (opts.selftest) process.exit(selftest());
if (!opts.dir || !fs.existsSync(opts.dir)) { console.error(USAGE); process.exit(2); }
if (opts.agents && !fs.existsSync(opts.agents)) {
  console.error('--agents 指向的文件不存在：' + opts.agents + '（不静默跳过文档一致性校验）');
  process.exit(2);
}
process.exit(verify(path.resolve(opts.dir), opts.agents));
