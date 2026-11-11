#!/usr/bin/env node
// check-vibecoding-doc：校验四层文档的结构完整性（不是质量）。
//
// 用法: node check-vibecoding-doc.js <AGENTS.md | spec.md | plan.md | tasks.md | CLAUDE.md | 目录 | 单篇 .md>
// 退出码: 0 通过 / 1 有问题 / 2 用法错误
//
// 模式:
//   AGENTS.md  —— 地图/命令/硬约束/按需阅读齐；命令≥2；根文件≤1000 行；无明文凭据
//   spec.md    —— 窄契约 6 节（目标/不做/关键路径/数据与行为约束/非功能/验收）；
//                 `强度: 大` 或存在第 7–10 节时，加查技术栈/目录/字段级/UI 四态；
//                 旧九节 SPEC 仍兼容校验
//   plan.md    —— 改动集合/方案/技术栈/验证/回滚齐；≤120 行
//   tasks.md   —— 每张卡有 只做/明确不做/入口/验证
//   CLAUDE.md  —— 前 10 行有 @AGENTS.md 桥接
//   目录        —— 根有 AGENTS.md 时按四层仓库查；否则按旧任务包查
//   其他 .md    —— 旧六节氛围稿，或自动识别的 spec
//
// 只查结构，不查内容对错——"都写了"和"都写对了"是两回事。
'use strict';
const fs = require('fs');
const path = require('path');

const USAGE = '用法: node check-vibecoding-doc.js <AGENTS.md | spec.md | plan.md | tasks.md | CLAUDE.md | 目录 | 单篇 .md> | --selftest';
const arg = process.argv[2];
if (!arg) { console.error(USAGE); process.exit(2); }
const SELFTEST = arg === '--selftest';
const TARGET = SELFTEST ? process.cwd() : path.resolve(arg);
if (!SELFTEST && !fs.existsSync(TARGET)) { console.error(`路径不存在: ${TARGET}`); process.exit(2); }

const problems = [];
const notes = [];
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (p) => path.relative(TARGET, p).replace(/\\/g, '/');
const CMD_RE = /\b(npm|pnpm|yarn|mvn|gradlew?|dotnet|pytest|go\s+test|node|curl|cargo|make|python|typecheck|lint|build|test)\b/i;
const hasCode = (t) => /(?:```[\s\S]*?```|`[^`\n]+`)/.test(t);

function listMd(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') listMd(p, out); }
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// 围栏感知逐行扫描：代码围栏内的 `#` 是 shell 注释，不是标题。
// 不跟踪围栏会把带注释的命令块切成多个假小节，截断真实小节正文（本项目实测误判过）。
// 闭合围栏必须同字符且不短于开启围栏，且不带 info string（CommonMark 语义）。
function* scannedLines(text) {
  let fence = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (m) {
      const run = m[1];
      if (!fence) fence = { ch: run[0], len: run.length };
      else if (run[0] === fence.ch && run.length >= fence.len && !m[2].trim()) fence = null;
      yield { line, heading: null };
      continue;
    }
    if (fence) { yield { line, heading: null }; continue; }
    yield { line, heading: line.match(/^(#{1,6})\s+(.*)$/) };
  }
}

// 任意层级标题切段（旧单篇/旧任务包沿用）
function sections(text) {
  const out = [];
  let cur = null;
  for (const { line, heading } of scannedLines(text)) {
    if (heading) { cur = { title: heading[2].trim(), body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() }));
}

// H1/H2 切段：H3+ 视为段内内容（spec/AGENTS/plan 用）
function topSections(text) {
  const out = [];
  let cur = null;
  for (const { line, heading } of scannedLines(text)) {
    if (heading && heading[1].length <= 2) { cur = { title: heading[2].trim(), body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() }));
}

// 按层级切块：H<=level 开新块，更深标题留在块内
function blocksAtLevel(text, level) {
  const out = [];
  let cur = null;
  for (const { line, heading } of scannedLines(text)) {
    if (heading && heading[1].length <= level) {
      if (cur) out.push(cur);
      cur = { title: heading[2].trim(), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() }));
}

function findInOrder(secs, specs) {
  const missing = [];
  const idx = [];
  let from = 0;
  for (const s of specs) {
    let found = -1;
    for (let i = from; i < secs.length; i++) {
      if (secs[i].title && s.re.test(secs[i].title)) { found = i; break; }
    }
    idx.push(found);
    if (found === -1) missing.push(s.key);
    else from = found + 1;
  }
  return { missing, idx };
}

function sectionOfNumber(secs, n) {
  for (const s of secs) {
    const m = (s.title || '').match(/^(\d+)\s*[.、)．]\s*/);
    if (m && Number(m[1]) === n) return s;
  }
  return null;
}

// ---------- 旧单篇（六节氛围稿） ----------
const SIX = [
  // \bvibe\b：标题 "Vibecoding Doc" 里也有 vibe 子串，不加词界会把 H1 误当成氛围节
  { key: 'Vibe 氛围', re: /\bvibe\b|氛围/i },
  { key: 'Intent 意图', re: /intent|意图/i },
  { key: 'User Stories', re: /user\s*stor|用户故事/i },
  { key: 'Tech Stack Vibe', re: /tech\s*stack|技术栈/i },
  { key: 'Constraints', re: /constraint|约束|边界/i },
  { key: 'Success Vibe', re: /success|成功|验收/i },
];

function checkSingle(file) {
  const text = read(file);
  const secs = sections(text);
  for (const s of SIX) {
    const hit = secs.find((x) => s.re.test(x.title));
    if (!hit) problems.push(`缺小节: ${s.key}`);
    else if (!hit.body) problems.push(`小节是空的: ${s.key}（"${hit.title}" 下没有任何内容）`);
  }
  const succ = secs.find((x) => SIX[5].re.test(x.title));
  if (succ && succ.body && !/^\s*[-*]\s*\[[ xX]\]/m.test(succ.body)) {
    problems.push('Success 节没有可勾选的验收条目（缺 `- [ ]`）——验收要能逐条判定');
  }
  const vibe = secs.find((x) => SIX[0].re.test(x.title));
  if (vibe && vibe.body && vibe.body.replace(/\s/g, '').length < 8) {
    notes.push('Vibe 氛围这节偏短——建议写 3–5 个形容词 + 一个参照物');
  }
  notes.push(`单篇模式：识别到 ${secs.filter((x) => x.title).length} 个小节`);
}

// ---------- 旧九节 SPEC（兼容） ----------
const SPEC_NINE = [
  { key: '1 目标与成功画面', re: /目标|成功画面|成功标准/i },
  { key: '2 明确不做', re: /明确不做|不做|out\s*of\s*scope|非目标/i },
  { key: '3 关键路径', re: /关键路径|用户路径|核心路径|调用路径|用例/i },
  { key: '4 技术栈冻结', re: /技术栈|tech\s*stack/i },
  { key: '5 目录结构与文件职责', re: /目录|文件职责|结构/i },
  { key: '6 数据模型与接口契约', re: /数据模型|接口契约|契约|接口|schema|数据表/i },
  { key: '7 UI 规格', re: /\bui\b|界面|页面规格|输出面/i },
  { key: '8 非功能约束与执行规则', re: /非功能|执行规则|约束/i },
  { key: '9 验收标准', re: /验收|acceptance/i },
];

function looksLegacyHeavy(text) {
  return /技术栈\s*[（(]\s*冻结\s*[)）]/.test(text)
    && /字段级|数据模型/.test(text)
    && /\bUI\s*规格|界面/.test(text)
    && /验收/.test(text);
}

function checkSpecLegacy(file, prefix = '') {
  const text = read(file);
  const secs = topSections(text);
  const { missing, idx } = findInOrder(secs, SPEC_NINE);
  for (const m of missing) problems.push(`${prefix}缺小节: ${m}`);
  for (const i of idx) if (i >= 0 && !secs[i].body) problems.push(`${prefix}小节是空的: ${secs[i].title}`);
  const get = (n) => (idx[n] === undefined || idx[n] < 0 ? '' : secs[idx[n]].body);

  const s2 = get(1);
  const bullets2 = (s2.match(/^\s*[-*]\s+\S+/gm) || []).length;
  if (!bullets2) problems.push(`${prefix}§2「明确不做」没有清单条目（\`- xxx\`）——这是最省钱的一段`);

  const s3 = get(2);
  if (!/UC\s*\d/i.test(s3)) problems.push(`${prefix}§3「关键路径」没有 UC 编号（形如 \`UC1: …\`）`);
  if (!/→|->/.test(s3)) problems.push(`${prefix}§3「关键路径」没有路径链（\`A → B → C\`）`);

  const s4 = get(3);
  if (!/\d+\.\d+/.test(s4) && !/待定|LTS|待确认/i.test(s4)) problems.push(`${prefix}§4「技术栈冻结」既没有版本号，也没有 \`待定 / LTS\` 标记`);
  if (!/禁止|不得|不要|禁用/.test(s4)) problems.push(`${prefix}§4「技术栈冻结」没有禁用项`);

  const s6 = get(5);
  if (!/```/.test(s6) && !/不适用/.test(s6)) problems.push(`${prefix}§6「数据模型与接口契约」没有代码块（TS 类型 / SQL / API 签名）`);

  const s7 = get(6);
  if (/不适用/.test(s7)) {
    if (!/原因|因为|无\s*ui|无界面|无前端/i.test(s7)) problems.push(`${prefix}§7 标了"不适用"但没写原因`);
  } else if (!(/空/.test(s7) && /加载/.test(s7) && /错误|失败/.test(s7) && /成功|正常/.test(s7))) {
    problems.push(`${prefix}§7「UI 规格」四态不齐（空 / 加载 / 错误 / 成功）`);
  }

  const s8 = get(7);
  if (!/歧义|未覆盖|不自行假设|停下/.test(s8)) problems.push(`${prefix}§8 没有规定"SPEC 未覆盖的歧义要停下问"`);

  const s9 = get(8);
  if (!hasCode(s9) || !CMD_RE.test(s9)) problems.push(`${prefix}§9「验收标准」没有可执行命令`);
  if (!/^\s*[-*]\s*\[[ xX]\]/m.test(s9)) problems.push(`${prefix}§9「验收标准」没有可勾选条目（\`- [ ]\`）`);

  notes.push(`${prefix}旧九节 SPEC 模式：识别到 ${idx.filter((i) => i >= 0).length}/9 节`);
}

// ---------- 新：AGENTS.md ----------
const AGENT_PARTS = [
  { key: '30 秒地图', re: /地图|概览|入口|结构/i },
  { key: '命令', re: /命令|常用|脚本|command/i },
  { key: '硬约束 / 禁区', re: /硬约束|禁区|红线|禁止/i },
  { key: '按需阅读', re: /按需|索引|详见|阅读|docs\//i },
];

function checkAgents(file) {
  const text = read(file);
  const secs = topSections(text);
  for (const p of AGENT_PARTS) {
    const hit = secs.find((s) => s.title && p.re.test(s.title));
    if (!hit) problems.push(`AGENTS.md 缺少「${p.key}」段——根文件只放地图/命令/红线/按需索引`);
    else if (!hit.body) problems.push(`AGENTS.md「${hit.title}」是空的`);
  }
  const cmdSec = secs.find((s) => /命令|command/i.test(s.title));
  if (cmdSec) {
    const n = cmdSec.body.split('\n').filter((l) => CMD_RE.test(l)).length;
    if (n < 2) problems.push('AGENTS.md 的「命令」段少于 2 条可执行命令');
  }
  const hardSec = secs.find((s) => /硬约束|禁区|红线/.test(s.title));
  if (hardSec && !/禁止|不得|不许|红线|禁区/.test(hardSec.body)) {
    problems.push('AGENTS.md 的硬约束段没有可判定的禁止项');
  }
  const onDemand = secs.find((s) => /按需|索引|详见|阅读/.test(s.title));
  if (onDemand && !/docs\/|DISCOVERIES|ADR|按需|spec\.md|plan\.md/.test(onDemand.body)) {
    problems.push('AGENTS.md 的按需阅读段没有文件指针');
  }
  const lines = text.split('\n').length;
  if (lines > 1000) problems.push(`AGENTS.md 有 ${lines} 行（>1000）——根文件应拆到 docs/ 或子目录`);
  else if (lines > 500) notes.push(`AGENTS.md 有 ${lines} 行（建议 200–500，超出部分拆文件）`);
  if (/(password|passwd|token|secret|api[_-]?key)\s*[=:：]\s*["']?[^\s"'<>{}$]{4,}/i.test(text)) {
    problems.push('AGENTS.md 疑似写了明文凭据——必须移除');
  }
  if (/尽量|尽可能|必要时|酌情|适当/.test(text)) {
    notes.push('AGENTS.md 出现软要求（尽量/必要时）——改成可判定规则');
  }
  if (!/当前会话规则|会话规则|每次只|一次只/.test(text)) {
    notes.push('建议补「当前会话规则」：一次一个任务、只输出 diff、失败写日志');
  }
  notes.push('AGENTS.md 模式：宪法检查完成');
}

// ---------- 新：窄契约 spec.md ----------
const SPEC_CORE = [
  { key: '1 目标与成功画面', re: /目标|成功画面|成功标准/i },
  { key: '2 明确不做', re: /明确不做|不做|out\s*of\s*scope|非目标/i },
  { key: '3 关键路径', re: /关键路径|用户路径|核心路径|调用路径|用例/i },
  { key: '4 数据与行为约束', re: /数据与行为|行为约束|业务规则|数据约束|数据规则|数据口径|状态|幂等|权限/ },
  { key: '5 非功能约束', re: /非功能|性能|安全|错误处理|兼容/i },
  { key: '6 验收标准', re: /验收|acceptance/i },
];
const SPEC_EXTRA_LABELS = ['7 技术栈与依赖冻结', '8 目录与文件边界', '9 字段级数据模型与接口契约', '10 UI 规格'];

function checkSpecNarrow(file, prefix = '') {
  const text = read(file);
  const secs = topSections(text);
  const core = [1, 2, 3, 4, 5, 6].map((n) => sectionOfNumber(secs, n));
  const numbered = core.filter(Boolean).length;
  if (numbered < 4) {
    const { missing, idx } = findInOrder(secs, SPEC_CORE);
    for (const m of missing) problems.push(`${prefix}缺小节: ${m}`);
    for (let i = 0; i < 6; i++) core[i] = idx[i] >= 0 ? secs[idx[i]] : null;
  } else {
    core.forEach((s, i) => { if (!s) problems.push(`${prefix}缺小节: ${SPEC_CORE[i].key}`); });
  }
  core.forEach((s) => { if (s && !s.body) problems.push(`${prefix}小节是空的: ${s.title}`); });
  const body = (i) => (core[i] ? core[i].body : '');

  const s2 = body(1);
  const bullets2 = (s2.match(/^\s*[-*]\s+\S+/gm) || []).length;
  if (!bullets2) problems.push(`${prefix}§2「明确不做」没有清单条目（\`- xxx\`）——这是最省钱的一段`);
  else if (bullets2 < 3) notes.push(`${prefix}§2 明确不做只有 ${bullets2} 条，建议 3 条以上`);

  const s3 = body(2);
  if (!/UC\s*\d/i.test(s3)) problems.push(`${prefix}§3「关键路径」没有 UC 编号（形如 \`UC1: …\`）`);
  if (!/→|->/.test(s3)) problems.push(`${prefix}§3「关键路径」没有路径链（\`A → B → C\`）`);

  const s4 = body(3);
  if (s4 && (s4.match(/^\s*[-*]\s+\S+/gm) || []).length === 0) {
    notes.push(`${prefix}§4 数据与行为约束建议写成条目（唯一性/状态/权限/时间口径）`);
  }

  const s6 = body(5);
  if (!hasCode(s6) || !CMD_RE.test(s6)) problems.push(`${prefix}§6「验收标准」没有可执行命令——验收不能跑，模型就无法自判完成`);
  if (!/^\s*[-*]\s*\[[ xX]\]/m.test(s6)) problems.push(`${prefix}§6「验收标准」没有可勾选条目（\`- [ ]\`）`);
  if (s6 && !/异常|失败|错误|冲突|409|403|空态|不可用/.test(s6)) {
    notes.push(`${prefix}§6 验收建议至少覆盖一条异常路径（空 / 冲突 / 失败 / 权限）`);
  }

  const heavy = /强度\s*[:：]\s*(大|高|高配|跨人|长周期)/.test(text)
    || [7, 8, 9, 10].every((n) => sectionOfNumber(secs, n));
  if (heavy) {
    const extras = [7, 8, 9, 10].map((n) => sectionOfNumber(secs, n));
    extras.forEach((s, i) => { if (!s) problems.push(`${prefix}强度=大 但缺小节: ${SPEC_EXTRA_LABELS[i]}`); });
    const s7 = extras[0] ? extras[0].body : '';
    if (extras[0] && !/\d+\.\d+|待定|LTS|plan\.md/i.test(s7)) {
      problems.push(`${prefix}§7「技术栈与依赖冻结」没有版本号、\`待定/LTS\` 标记或 plan.md 指针`);
    }
    if (extras[0] && !/禁止|不得|不要|禁用/.test(s7)) {
      problems.push(`${prefix}§7「技术栈与依赖冻结」没有禁用项`);
    }
    const s9 = extras[2] ? extras[2].body : '';
    if (extras[2] && !/```/.test(s9) && !/不适用/.test(s9)) {
      problems.push(`${prefix}§9「字段级数据模型与接口契约」没有代码块（TS 类型 / SQL / API 签名）`);
    }
    const s10 = extras[3] ? extras[3].body : '';
    if (extras[3] && /不适用/.test(s10)) {
      if (!/原因|因为|无\s*ui|无界面|无前端/i.test(s10)) problems.push(`${prefix}§10 标了"不适用"但没写原因`);
    } else if (extras[3] && !(/空/.test(s10) && /加载/.test(s10) && /错误|失败/.test(s10) && /成功|正常/.test(s10))) {
      problems.push(`${prefix}§10「UI 规格」四态不齐（空 / 加载 / 错误 / 成功）`);
    }
    notes.push(`${prefix}高配模式：已检查技术栈/目录/字段级契约/UI 四态`);
  } else {
    if (/type\s+\w+\s*=\s*\{|CREATE\s+TABLE/i.test(text)) {
      notes.push(`${prefix}检测到字段级契约但未标 \`强度: 大\`——小项目可删，或标大并补齐第 7–10 节`);
    }
    notes.push(`${prefix}窄契约模式：6 节核心检查完成`);
  }

  const strength = text.match(/强度\s*[:：]\s*([小中大高配跨人长周期]+)/);
  if (!strength) notes.push(`${prefix}建议在 spec 顶部写一行 \`强度: 小 / 中 / 大\``);
  if (/存量改造|改造\s*[:：]\s*存量/.test(text)) {
    if (!/旧入口|旧功能/.test(text)) notes.push(`${prefix}声明存量改造但 spec 内没有旧入口清单——放到 AGENTS.md / 任务卡，并在验收覆盖`);
    if (!/兼容回归/.test(text)) notes.push(`${prefix}声明存量改造但没提兼容回归批`);
  }
  const pending = (text.match(/\[待确认/g) || []).length;
  if (pending) notes.push(`${prefix}有 ${pending} 处 [待确认]——交付前集中列给用户`);
}

function checkSpecAuto(file, prefix = '') {
  const text = read(file);
  if (looksLegacyHeavy(text)) checkSpecLegacy(file, prefix);
  else checkSpecNarrow(file, prefix);
}

// ---------- 新：plan.md ----------
const PLAN_PARTS = [
  { key: '改动集合', re: /改动|文件|范围/ },
  { key: '方案', re: /方案|首选|回退/ },
  { key: '技术栈与依赖', re: /技术栈|依赖/ },
  { key: '验证', re: /验证|命令|验收/ },
  { key: '回滚', re: /回滚|rollback|恢复/ },
];

function checkPlan(file) {
  const text = read(file);
  const secs = topSections(text);
  const found = {};
  for (const p of PLAN_PARTS) {
    const hit = secs.find((s) => s.title && p.re.test(s.title));
    if (!hit) problems.push(`plan.md 缺少「${p.key}」段`);
    else { found[p.key] = hit.body; if (!hit.body) problems.push(`plan.md「${hit.title}」是空的`); }
  }
  const ver = found['验证'] || '';
  if (ver && !CMD_RE.test(ver)) problems.push('plan.md 的「验证」段没有可执行命令');
  const roll = found['回滚'] || '';
  if (roll && !/revert|回滚|恢复|开关|rollback/i.test(roll)) problems.push('plan.md 的「回滚」段没有可执行的回滚方式');
  const lines = text.split('\n').length;
  if (lines > 120) problems.push(`plan.md 有 ${lines} 行（>120）——计划已变成第二份 SPEC`);
  else if (lines > 80) notes.push(`plan.md 有 ${lines} 行（建议 ≤60）`);
  if (!/spec\.md|UC\s*\d/i.test(text)) notes.push('plan.md 建议引用 spec.md 的小节或 UC 编号');
  if (/尽量|尽可能|必要时|酌情/.test(text)) notes.push('plan.md 出现软要求——改成可判定动作');
  notes.push('plan.md 模式：计划检查完成');
}

// ---------- 新：tasks.md ----------
function checkTasks(file) {
  const text = read(file);
  let blocks = blocksAtLevel(text, 2).filter((b) => /T[-\s]?\d+|任务\s*\d+/i.test(b.title));
  if (!blocks.length) blocks = blocksAtLevel(text, 3).filter((b) => /T[-\s]?\d+|任务\s*\d+/i.test(b.title));
  if (!blocks.length) { problems.push('tasks.md 没有任务卡（形如 `## T-01：…`）'); return; }
  for (const b of blocks) {
    const missed = [];
    if (!/只做|做什么/.test(b.body)) missed.push('只做');
    if (!/明确不做|不做/.test(b.body)) missed.push('明确不做');
    if (!/入口|锚点|file:line|[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|java|go|py|rs|vue):\d+/i.test(b.body)) missed.push('入口(file:line)');
    if (!/验证|验收|命令/.test(b.body)) missed.push('验证');
    if (missed.length) problems.push(`tasks.md「${b.title}」缺少：${missed.join(' / ')}`);
    if (b.body.length > 1500) notes.push(`tasks.md「${b.title}」超过 1500 字——拆成更小的任务`);
  }
  notes.push(`tasks.md 模式：${blocks.length} 张任务卡`);
}

// ---------- 新：CLAUDE.md 桥接 ----------
function checkClaude(file) {
  const text = read(file);
  const head = text.split('\n').slice(0, 10).join('\n');
  if (!/@AGENTS\.md/i.test(head)) {
    problems.push('CLAUDE.md 前 10 行没有 `@AGENTS.md` 桥接——Claude Code 只在本目录及上层没有 CLAUDE.md 时才读 AGENTS.md');
  }
  const lines = text.split('\n').length;
  if (lines > 200) notes.push(`CLAUDE.md 有 ${lines} 行——长内容放 AGENTS.md，用 @AGENTS.md 导入`);
  notes.push('CLAUDE.md 模式：桥接检查完成');
}

// ---------- 旧任务包（B00 / 批次卡 / 台账） ----------
const FOUR = [
  { key: '禁止项', re: /禁止项|禁止|不得/ },
  { key: '产出文件清单', re: /产出.{0,4}文件|必须产出|文件清单/ },
  { key: '契约（输入/输出）', re: /契约|接口|输入.{0,3}输出/ },
  { key: '可勾选验收', re: /验收|success/i },
];

function checkPack(dir) {
  const files = listMd(dir);
  const name = (f) => path.basename(f);
  const root = path.resolve(dir);
  const atRoot = (f) => path.dirname(f) === root;
  if (files.length === 0) { problems.push('目录里没有 .md 文件'); return; }

  // 四层仓库：根 AGENTS.md 即宪法
  const rootAgents = files.find((f) => atRoot(f) && /^AGENTS\.md$/i.test(name(f)));
  if (rootAgents) {
    notes.push('四层仓库模式：AGENTS.md 作为宪法');
    checkAgents(rootAgents);
    const rootClaude = files.find((f) => atRoot(f) && /^CLAUDE\.md$/i.test(name(f)));
    if (rootClaude) checkClaude(rootClaude);
    const rootSpec = files.find((f) => atRoot(f) && /^spec\.md$/i.test(name(f)));
    if (!rootSpec) problems.push('四层仓库缺 spec.md（功能契约）');
    else checkSpecAuto(rootSpec, 'spec.md ');
    const rootPlan = files.find((f) => atRoot(f) && /^plan\.md$/i.test(name(f)));
    if (rootPlan) checkPlan(rootPlan);
    const rootTasks = files.find((f) => atRoot(f) && /^tasks\.md$/i.test(name(f)));
    if (rootTasks) checkTasks(rootTasks);
    if (!rootPlan || !rootTasks) notes.push('四层仓库建议同时有 plan.md 与 tasks.md（实施快照与任务卡）');
    const rootText = files.filter(atRoot).map(read).join('\n');
    if (/存量改造|改造\s*[:：]\s*存量/.test(rootText)) {
      if (!/旧入口|旧功能/.test(rootText)) problems.push('声明存量改造但缺「旧入口清单」——旧功能缺失会到上线后才暴露');
      if (!/偏差/.test(rootText)) problems.push('声明存量改造但缺「设计偏差表」');
      if (!/兼容回归/.test(rootText)) problems.push('存量改造缺「兼容回归」批次——回归未绿不得交付');
    }
    notes.push(`四层仓库模式：根级 ${files.filter(atRoot).length} 个 md`);
    return;
  }

  const shared = files.filter((f) => /^B00/i.test(name(f)) && /共享上下文/.test(name(f)));
  // 实机样例叫 `B00_总批发起工指令.md`（总·批·发起工），所以别写死"总发起"三个连字
  const launcher = files.filter((f) => /总.*发起/.test(name(f)));
  if (shared.length === 0) problems.push('缺 `B00_共享上下文.md`（宪法：铁律 / 技术栈 / 目录约定）');
  if (launcher.length === 0) problems.push('缺"总发起指令"（装配对照表 + 可复制的总发起提示词 + 停下条件）');
  for (const f of shared) {
    if (!/铁律|违反即视为任务失败/.test(read(f))) {
      problems.push(`${name(f)} 里找不到"铁律"段——宪法没有硬度，AI 会自由发挥`);
    }
  }

  const ledger = files.filter((f) => /收口清单|验收矩阵/.test(name(f)));
  if (ledger.length === 0) problems.push('缺台账（`收口清单.md` / `验收矩阵.md`）——每批收工要写一行');

  const spec = files.find((f) => atRoot(f) && /^spec\.md$/i.test(name(f)));
  if (spec) {
    checkSpecAuto(spec, name(spec) + ' ');
    if (shared.length && !shared.some((f) => /spec\.md/i.test(read(f)))) {
      problems.push('包内有 spec.md 但 B00 没引用它——契约没接线，执行者还是要靠猜');
    }
  }
  const plan = files.find((f) => atRoot(f) && /^plan\.md$/i.test(name(f)));
  if (plan) checkPlan(plan);
  const tasks = files.find((f) => atRoot(f) && /^tasks\.md$/i.test(name(f)));
  if (tasks) checkTasks(tasks);

  const cards = [];
  for (const f of files) {
    const m = name(f).match(/^B(\d{2})[_\-]/i);
    if (m && Number(m[1]) > 0) cards.push({ file: f, no: Number(m[1]), name: name(f) });
  }
  if (cards.length === 0) {
    problems.push('一张批次卡都没有（形如 `B01_名称.md`）——多文件包至少要有 1 张');
  } else {
    cards.sort((a, b) => a.no - b.no);
    const nos = cards.map((c) => c.no);
    for (let i = 0; i < nos.length; i++) {
      if (nos[i] !== i + 1) {
        problems.push(`批次卡编号不连续：期望 B${String(i + 1).padStart(2, '0')}，实际 B${String(nos[i]).padStart(2, '0')}（${cards[i].name}）`);
        break;
      }
    }
    const dup = nos.filter((n, i) => nos.indexOf(n) !== i);
    if (dup.length) problems.push(`批次卡编号重复：B${String(dup[0]).padStart(2, '0')}`);
    for (const c of cards) {
      const t = read(c.file);
      const secs = sections(t).map((s) => s.title + '\n' + s.body).join('\n');
      const missing = [];
      for (const r of FOUR) {
        if (r.key === '可勾选验收') {
          if (!/^\s*[-*]\s*\[[ xX]\]/m.test(t)) missing.push(`${r.key}(缺 \`- [ ]\`)`);
        } else if (!r.re.test(secs)) missing.push(r.key);
      }
      if (missing.length) problems.push(`${c.name} 四件不齐：缺 ${missing.join(' / ')}`);
    }
    notes.push(`批次卡 ${cards.length} 张：B01 … B${String(nos[nos.length - 1]).padStart(2, '0')}`);
  }

  const legacy = shared.some((f) => /存量改造/.test(read(f)));
  if (legacy) {
    const st = read(shared[0]);
    if (!/旧入口|旧功能/.test(st)) problems.push(`${name(shared[0])} 声明了存量改造但缺「现状与旧入口清单」`);
    if (!/偏差/.test(st)) problems.push(`${name(shared[0])} 声明了存量改造但缺「设计偏差表」`);
    const reg = cards.filter((c) => /兼容回归/.test(c.name) || /兼容回归/.test(read(c.file)));
    if (reg.length === 0) {
      problems.push('存量改造缺「兼容回归」批次卡——旧菜单/旧列表/旧流程/DDL 后旧 CRUD 必须独立回归');
    } else {
      notes.push(`存量改造加档：已启用（兼容回归批 B${String(Math.min(...reg.map((c) => c.no))).padStart(2, '0')}）`);
    }
  }
  notes.push(`旧任务包模式：共 ${files.length} 个 md`);
}

// ---------- 自测（A5：校验器自身也要有能失败的判据） ----------
function runSelfTest() {
  const os = require('os');
  let failed = 0;
  const ok = (label, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!cond) failed++; };
  const reset = () => { problems.length = 0; notes.length = 0; };

  // 1. 围栏内的 # 是注释，不得开新小节
  const cmdDoc = ['# AGENTS', '', '## 命令', '', '```bash',
    '# 结构校验', 'node a.js', '# 引用校验', 'node b.js', '# 合约', 'node c.js',
    '# 依赖', 'npm ci', '# 全量', 'node d.js', '# 体检', 'node e.js',
    '# 构建', 'node f.js', '# 复验', 'node g.js', '```', '', '## 禁区', '', '- 禁止 x'].join('\n');
  const secs = topSections(cmdDoc);
  const cmdSec = secs.find((s) => s.title === '命令');
  const cmdLines = cmdSec ? cmdSec.body.split('\n').filter((l) => CMD_RE.test(l)).length : 0;
  ok('围栏内 7 条 # 注释不开新小节，命令段保留 8 条命令', secs.length === 3 && cmdLines === 8, `sections=${secs.length} cmdLines=${cmdLines}`);
  ok('三个切段函数一致认定小节数', sections(cmdDoc).length === 3 && blocksAtLevel(cmdDoc, 2).length === 3);

  // 1b. 变异负对照：去掉围栏跟踪后必须复现截断（证明判据能失败）
  const naiveTop = (text) => {
    const out = []; let cur = null;
    for (const line of text.split('\n')) {
      const h = line.match(/^(#{1,2})\s+(.*)$/);
      if (h) { cur = { title: h[2].trim(), body: [] }; out.push(cur); continue; }
      if (cur) cur.body.push(line);
    }
    return out.map((s) => ({ title: s.title, body: s.body.join('\n').trim() }));
  };
  const naive = naiveTop(cmdDoc);
  const naiveCmd = naive.find((s) => s.title === '命令');
  const naiveLines = naiveCmd ? naiveCmd.body.split('\n').filter((l) => CMD_RE.test(l)).length : 0;
  ok('变异负对照：无围栏跟踪时命令段被截断', naive.length > 3 && naiveLines < 8, `naiveSections=${naive.length} naiveCmdLines=${naiveLines}`);

  // 2. 嵌套围栏：外层 ```` 不被内层 ``` 提前闭合
  const nested = ['## 任务', '', '````text', '```', '# 内层注释不是标题', '```', '````', '', '## 下一节'].join('\n');
  const nsecs = topSections(nested);
  ok('嵌套 ```` 内的 ``` 与 # 不开新小节', nsecs.length === 2 && nsecs[0].title === '任务', `n=${nsecs.length}`);

  // 3. 缺小节必判红
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbc-selftest-'));
  const badAgents = path.join(tmp, 'AGENTS.md');
  fs.writeFileSync(badAgents, '# AGENTS\n\n## 地图\n\n有内容\n');
  reset(); checkAgents(badAgents);
  ok('缺小节必判红', problems.length > 0, `problems=${problems.length}`);

  // 4. 空小节必判红
  const emptyAgents = path.join(tmp, 'AGENTS.md');
  fs.writeFileSync(emptyAgents, '# AGENTS\n\n## 地图\n\n## 命令\n\n## 硬约束 / 禁区\n\n## 按需阅读\n');
  reset(); checkAgents(emptyAgents);
  ok('空小节必判红', problems.some((p) => /空的/.test(p)), `problems=${problems.length}`);

  // 5. 合规 AGENTS 必须判绿（防止把判据改得过严）
  const goodAgents = path.join(tmp, 'AGENTS.md');
  fs.writeFileSync(goodAgents, ['# AGENTS', '', '## 地图', '', '入口见 docs/x.md', '', '## 命令', '',
    '- 校验：`node a.js`', '- 测试：`node b.js`', '', '## 硬约束 / 禁区', '', '- 禁止 git add -A', '',
    '## 按需阅读', '', '- 详见 docs/x.md'].join('\n'));
  reset(); checkAgents(goodAgents);
  ok('合规 AGENTS 判绿（负对照：不得过严）', problems.length === 0, problems.join(' | '));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\nselftest FAIL ${failed}` : '\nselftest ALL PASS');
  return failed ? 1 : 0;
}

// ---------- 分发 ----------
if (SELFTEST) process.exit(runSelfTest());
const isDir = fs.statSync(TARGET).isDirectory();
if (!isDir && !TARGET.toLowerCase().endsWith('.md')) {
  console.error(`不是 .md 也不是目录: ${TARGET}`);
  process.exit(2);
}

const base = path.basename(TARGET).toLowerCase();
let mode = '单篇';
if (isDir) { checkPack(TARGET); mode = '目录'; }
else if (base === 'agents.md') { checkAgents(TARGET); mode = 'AGENTS'; }
else if (base === 'spec.md') { checkSpecAuto(TARGET); mode = 'spec'; }
else if (base === 'plan.md') { checkPlan(TARGET); mode = 'plan'; }
else if (base === 'tasks.md') { checkTasks(TARGET); mode = 'tasks'; }
else if (base === 'claude.md') { checkClaude(TARGET); mode = 'CLAUDE'; }
else {
  const text = read(TARGET);
  if (looksLegacyHeavy(text) || (/明确不做|out\s*of\s*scope/i.test(text) && /关键路径|用户路径|核心路径/i.test(text) && /验收/.test(text))) {
    checkSpecAuto(TARGET);
    mode = 'spec';
  } else {
    checkSingle(TARGET);
  }
}

for (const n of notes) console.log('  ' + n);
console.log(`vibecoding 文档校验（${mode}）：${rel(TARGET) || path.basename(TARGET)}`);
if (problems.length === 0) { console.log('结果：通过（0 个问题）'); process.exit(0); }
console.log(`结果：${problems.length} 个问题`);
for (const p of problems) console.log('  ✗ ' + p);
process.exit(1);
