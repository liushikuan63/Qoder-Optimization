#!/usr/bin/env node
'use strict';
// 自进化证据晋升候选扫描（2026-11-02）：只读汇总三源，输出四类候选报告。
// 不写规则 / 技能 / hook / 数据库；报告是候选入口，不是晋升授权。
// 用法：
//   node evolution-candidates.cjs [--days 30] [--json] [--write] [--out <dir>]
// 退出码：0 正常（含无候选）；2 参数或输出目录错误。

const fs = require('fs');
const path = require('path');
const { clientRoot } = require('./client-root.js');

const KIND_ORDER = {
  'promote-global': 0,
  'promote-local': 1,
  observe: 2,
  rejected: 3,
  covered: 4,
};
const KIND_LABEL = {
  'promote-global': '建议全局晋升',
  'promote-local': '建议局部沉淀',
  observe: '证据不足 / 观察',
  rejected: '已拒绝',
  covered: '已有载体覆盖',
};
const STOPWORDS = new Set([
  '用户', '要求', '必须', '不要', '可以', '已经', '通过', '进行', '出现', '问题', '这个', '那个',
  '以及', '或者', '如果', '因为', '所以', '需要', '应该', '没有', '不能', '一个', '使用', '时候',
  '之后', '之前', '现在', '仍然', '还是', '就是', '只是', '不是', '可能', '默认', '内容', '行为',
  '场景', '情况', '方式', '结果', '证据',
]);
const SPLIT_WORDS = /(?:必须|需要|不要|不能|应该|可以|已经|通过|出现|使用|进行|以及|或者|如果|因为|所以)/g;

function parseArgs(argv) {
  const options = { days: 30, json: false, write: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') {
      const raw = argv[++i];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) <= 0) return { error: '--days 需要正整数' };
      options.days = Number(raw);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--write') {
      options.write = true;
    } else if (arg === '--out') {
      const raw = argv[++i];
      if (!raw) return { error: '--out 需要目录' };
      options.out = path.resolve(raw);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      return { error: '未知参数：' + arg };
    }
  }
  return { options };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseFrontmatter(text) {
  if (!text || !text.startsWith('---')) return { meta: {}, body: text || '' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const raw = text.slice(3, end).replace(/^\r?\n/, '');
  const meta = {};
  let section = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && section) {
      meta[section] = meta[section] || {};
      meta[section][nested[1]] = nested[2].replace(/^["']|["']$/g, '');
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      meta[section] = top[2].replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: text.slice(end + 4) };
}

function scanFeedback(root) {
  const dir = path.join(root, 'memory');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch {
    return { status: 'missing', count: 0, items: [] };
  }
  const items = [];
  for (const file of files) {
    const text = readText(path.join(dir, file));
    if (!text) continue;
    const { meta, body } = parseFrontmatter(text);
    const type = (meta.metadata && meta.metadata.type) || meta.type || '';
    if (type !== 'feedback') continue;
    items.push({
      file,
      name: meta.name || file.replace(/\.md$/, ''),
      description: meta.description || '',
      body,
    });
  }
  return { status: 'ok', count: items.length, items };
}

function extractKeywords(item) {
  const out = new Set();
  const name = String(item.name || '').replace(/^feedback[-_]/, '');
  for (const word of name.split(/[-_\s]+/)) {
    if (/^[A-Za-z][A-Za-z0-9]{2,}$/.test(word)) out.add(word.toLowerCase());
  }
  const desc = String(item.description || '');
  for (const word of desc.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || []) out.add(word.toLowerCase());
  const parts = desc.split(/[，。；：、！？,.;:!?（）()\s/]+/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    for (const piece of part.split(SPLIT_WORDS)) {
      const trimmed = piece.trim();
      if (/^[\u4e00-\u9fa5]{2,20}$/.test(trimmed) && !STOPWORDS.has(trimmed)) out.add(trimmed);
    }
  }
  return [...out].slice(0, 16);
}

function loadCarrierText(root) {
  const chunks = [];
  const files = [];
  const push = (file, limit) => {
    const text = readText(file);
    if (!text) return;
    files.push(file);
    chunks.push(limit ? text.split(/\r?\n/).slice(0, limit).join('\n') : text);
  };
  push(path.join(root, 'AGENTS.md'));
  try {
    for (const file of fs.readdirSync(path.join(root, 'rules')).filter((f) => f.endsWith('.md'))) {
      push(path.join(root, 'rules', file));
    }
  } catch {}
  for (const tier of ['skills', 'skills-library']) {
    try {
      for (const name of fs.readdirSync(path.join(root, tier))) {
        push(path.join(root, tier, name, 'SKILL.md'), 200);
      }
    } catch {}
  }
  return { text: chunks.join('\n').toLowerCase(), files };
}

function countSessions(text) {
  const ids = new Set((String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).map((s) => s.toLowerCase()));
  return ids.size;
}

function suggestCarrier(name, description) {
  const text = (String(name).replace(/^feedback[-_]/, '') + ' ' + description).toLowerCase();
  if (/记忆|memory|记忆条目|索引更新/.test(text)) return 'self-evolution / memory-entry-update 技能';
  if (/回复|语言|中文|风格|语气|输出格式|reply|language|style/.test(text)) return 'AGENTS.md（个人偏好）';
  if (/hook|门禁|拦截|guard|gate/.test(text)) return 'hook（确定性纪律）';
  if (/(?:数据库|\bsql\b|\bdb\b|mysql|postgres|redis|mongodb|瀚高|慢查询)/.test(text)) return 'rules/databases.md 或领域技能';
  if (/部署|发布|推送|deploy|release/.test(text)) return '技能或交付规则';
  return '技能（按需库）或项目规则';
}

function classifyFeedback(item, carrierText) {
  const keywords = extractKeywords(item);
  const hits = keywords.filter((k) => carrierText.includes(k));
  const coverage = keywords.length ? hits.length / keywords.length : 0;
  const sessions = countSessions(item.body);
  const reasons = [];
  let kind;
  if (!item.description && String(item.body).trim().length < 20) {
    kind = 'observe';
    reasons.push('描述与正文都过短，证据不足');
  } else if (coverage >= 0.5) {
    kind = 'covered';
    reasons.push(`关键词覆盖 ${Math.round(coverage * 100)}%（${hits.length}/${keywords.length}）`);
  } else if (coverage >= 0.2) {
    kind = 'promote-local';
    reasons.push(`已有部分覆盖 ${Math.round(coverage * 100)}%，建议并入既有载体`);
  } else if (sessions >= 2) {
    kind = 'promote-global';
    reasons.push(`未覆盖且正文含 ${sessions} 个不同会话标识`);
  } else {
    kind = 'promote-local';
    reasons.push('未覆盖；单会话证据，按项目/技术栈沉淀，不推广全机');
  }
  return {
    id: 'feedback:' + item.file,
    source: 'feedback',
    title: item.name,
    kind,
    score: Number((coverage + (sessions >= 2 ? 0.2 : 0)).toFixed(3)),
    evidence: {
      file: item.file,
      description: String(item.description || '').slice(0, 160),
      keywords: keywords.length,
      matched: hits.length,
      coverage: Number(coverage.toFixed(3)),
      sessions,
    },
    suggested_carrier: suggestCarrier(item.name, item.description),
    reasons,
  };
}

function scanViolations(root, days, warnings) {
  const file = path.join(root, 'tmp', 'stop-gate', 'violations.log');
  const text = readText(file);
  if (text === null) {
    warnings.push('violations.log 缺失，违规源跳过');
    return { status: 'missing', lines: 0, items: [] };
  }
  const since = Date.now() - days * 86400000;
  const groups = new Map();
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines++;
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const at = Date.parse(parts[0]);
    if (!Number.isFinite(at) || at < since) continue;
    const rawRule = parts[1];
    if (rawRule === 'SECOND-STOP') continue;
    const suppressed = /-SUPPRESSED$/.test(rawRule);
    const rule = rawRule.replace(/-SUPPRESSED$/, '');
    const session = (parts[2] || '').replace(/^sess=/, '') || 'unknown';
    const group = groups.get(rule) || { rule, count: 0, suppressed: 0, sessions: new Set(), lastAt: 0 };
    group.count++;
    if (suppressed) group.suppressed++;
    group.sessions.add(session);
    group.lastAt = Math.max(group.lastAt, at);
    groups.set(rule, group);
  }
  const items = [...groups.values()].map((group) => {
    const kind = group.count >= 3 && group.sessions.size >= 2 ? 'promote-global' : 'observe';
    return {
      id: 'violation:' + group.rule,
      source: 'violation',
      title: group.rule,
      kind,
      score: group.count,
      evidence: {
        count: group.count,
        sessions: group.sessions.size,
        suppressed: group.suppressed,
        lastAt: group.lastAt ? new Date(group.lastAt).toISOString() : null,
      },
      suggested_carrier: 'hook / 规则（先核对是否该机制化）',
      reasons: [
        group.count >= 3 && group.sessions.size >= 2
          ? `近 ${days} 天命中 ${group.count} 次、${group.sessions.size} 个会话，提示词可能未生效`
          : `近 ${days} 天命中 ${group.count} 次，继续观察`,
      ],
    };
  });
  return { status: 'ok', lines, items };
}

function scanRecords(root, days, warnings) {
  const dir = path.join(root, 'evolution', 'records');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    warnings.push('evolution/records 缺失，记录源跳过');
    return { status: 'missing', count: 0, items: [] };
  }
  const since = Date.now() - days * 86400000;
  const groups = new Map();
  let count = 0;
  for (const file of files) {
    const text = readText(path.join(dir, file));
    if (!text) continue;
    let data;
    try { data = JSON.parse(text); } catch { continue; }
    const at = Date.parse(data.created_at || data.at || '');
    if (Number.isFinite(at) && at < since) continue;
    const topic = data.topic || data.summary || file;
    const scope = typeof data.scope === 'string' ? data.scope : '';
    const key = JSON.stringify([topic, scope]);
    const group = groups.get(key) || { topic, scope, types: {}, tasks: new Set(), sessions: new Set(), qualifiedTasks: new Set(), qualifiedSessions: new Set(), explicit: false, verified: 0, records: 0 };
    group.records++;
    group.types[data.type || 'observation'] = (group.types[data.type || 'observation'] || 0) + 1;
    const evidence = data.evidence || {};
    if (evidence.task_id) group.tasks.add(String(evidence.task_id));
    if (evidence.session_id) group.sessions.add(String(evidence.session_id));
    const trusted = evidence.source === 'user' || (evidence.source === 'local-validation' && data.verified === true);
    if (scope && evidence.task_id && trusted && ['observation', 'correction', 'preference'].includes(data.type)) {
      group.qualifiedTasks.add(String(evidence.task_id));
      if (evidence.session_id) group.qualifiedSessions.add(String(evidence.session_id));
      if (data.type === 'preference' && data.explicit === true && evidence.source === 'user') group.explicit = true;
      if (data.verified === true) group.verified++;
    }
    groups.set(key, group);
    count++;
  }
  const items = [...groups.values()].map((group) => {
    let kind;
    const reasons = [];
    if ((group.types.rejection || 0) > 0) {
      kind = 'rejected';
      reasons.push('存在 rejection 记录，不进入晋升候选');
    } else if (group.verified > 0) {
      kind = 'covered';
      reasons.push(`已有 ${group.verified} 条 verified 记录`);
    } else if (group.explicit || (group.qualifiedTasks.size >= 3 && group.qualifiedSessions.size >= 2)) {
      kind = group.scope === 'global' ? 'promote-global' : 'promote-local';
      reasons.push(group.explicit ? '用户明确的长期偏好，仍按原范围与当前授权处理' : `合格独立任务 ${group.qualifiedTasks.size} 个、${group.qualifiedSessions.size} 个会话，达到候选门槛`);
    } else {
      kind = 'observe';
      reasons.push(`合格独立任务 ${group.qualifiedTasks.size} 个、${group.qualifiedSessions.size} 个会话，继续观察`);
    }
    return {
      id: 'record:' + group.topic + (group.scope && group.scope !== 'global' ? ':' + require('crypto').createHash('sha256').update(group.scope).digest('hex').slice(0, 12) : ''),
      source: 'record',
      title: group.topic,
      kind,
      score: group.records,
      evidence: {
        records: group.records,
        types: group.types,
        tasks: group.tasks.size,
        sessions: group.sessions.size,
        verified: group.verified,
      },
      suggested_carrier: '按 self-evolution 证据门槛选择最窄载体',
      reasons,
    };
  });
  return { status: 'ok', count, items };
}

function buildReport(options) {
  const root = clientRoot();
  const warnings = [];
  const feedback = scanFeedback(root);
  const carrier = loadCarrierText(root);
  const records = scanRecords(root, options.days, warnings);
  const violations = scanViolations(root, options.days, warnings);
  if (feedback.status === 'missing') warnings.push('memory 目录或 feedback 文件缺失，记忆源跳过');
  if (!carrier.files.length) warnings.push('未找到 AGENTS/rules/skills 载体，覆盖检测结果不可用');
  warnings.push('feedback 无统一时间字段，--days 不作用于记忆源');
  warnings.push('覆盖检测是关键词初筛，需人工核对语义与反例');

  const candidates = [
    ...feedback.items.map((item) => classifyFeedback(item, carrier.text)),
    ...violations.items,
    ...records.items,
  ].sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || (b.score - a.score));

  const counts = { 'promote-global': 0, 'promote-local': 0, observe: 0, rejected: 0, covered: 0 };
  for (const candidate of candidates) counts[candidate.kind] = (counts[candidate.kind] || 0) + 1;

  return {
    generated_at: new Date().toISOString(),
    days: options.days,
    root,
    sources: {
      feedback: { status: feedback.status, count: feedback.count },
      violations: { status: violations.status, lines: violations.lines },
      records: { status: records.status, count: records.count },
      carriers: { files: carrier.files.length },
    },
    counts,
    candidates,
    warnings,
  };
}

function escapeCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# 自进化候选报告 ' + report.generated_at.slice(0, 10));
  lines.push('');
  lines.push('- 扫描窗口：近 ' + report.days + ' 天');
  lines.push('- 数据根：`' + report.root + '`');
  lines.push('- 数据源：feedback ' + report.sources.feedback.count + '（' + report.sources.feedback.status + '）；'
    + 'violations ' + report.sources.violations.lines + ' 行（' + report.sources.violations.status + '）；'
    + 'records ' + report.sources.records.count + '（' + report.sources.records.status + '）；'
    + '载体 ' + report.sources.carriers.files + ' 个');
  lines.push('');
  lines.push('## 计数');
  lines.push('');
  lines.push('| 分类 | 数量 |');
  lines.push('|---|---|');
  for (const kind of Object.keys(KIND_ORDER)) lines.push('| ' + KIND_LABEL[kind] + ' | ' + (report.counts[kind] || 0) + ' |');
  lines.push('');
  lines.push('## 候选');
  lines.push('');
  lines.push('只列非 covered 项；covered 已在现有载体中出现，仅计数。');
  lines.push('');
  lines.push('| 分类 | 来源 | 主题 | 证据 | 建议落点 |');
  lines.push('|---|---|---|---|---|');
  const visible = report.candidates.filter((candidate) => candidate.kind !== 'covered');
  for (const candidate of visible) {
    const evidence = candidate.source === 'feedback'
      ? '覆盖 ' + Math.round((candidate.evidence.coverage || 0) * 100) + '%，会话 ' + candidate.evidence.sessions
      : candidate.source === 'violation'
        ? '命中 ' + candidate.evidence.count + ' 次，会话 ' + candidate.evidence.sessions
        : '记录 ' + candidate.evidence.records + ' 条，任务 ' + candidate.evidence.tasks;
    lines.push('| ' + KIND_LABEL[candidate.kind] + ' | ' + candidate.source + ' | ' + escapeCell(candidate.title)
      + ' | ' + escapeCell(evidence) + ' | ' + escapeCell(candidate.suggested_carrier) + ' |');
  }
  if (!visible.length) lines.push('| - | - | 无候选 | - | - |');
  lines.push('');
  lines.push('## 警告');
  lines.push('');
  for (const warning of report.warnings) lines.push('- ' + warning);
  lines.push('');
  lines.push('> 报告是候选入口，不是晋升授权。处理前逐条核对用户原话、现有载体、反例与适用范围；');
  lines.push('> 晋升落到最窄载体并验证，然后写 `evolution.js record`。');
  return lines.join('\n') + '\n';
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error('[evolution-candidates] ' + parsed.error);
    process.exit(2);
  }
  const options = parsed.options;
  if (options.help) {
    console.log('用法: node evolution-candidates.cjs [--days 30] [--json] [--write] [--out <dir>]');
    return;
  }
  const report = buildReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const summary = `自进化候选：promote-global ${report.counts['promote-global']} / promote-local ${report.counts['promote-local']}`
    + ` / observe ${report.counts.observe} / rejected ${report.counts.rejected} / covered ${report.counts.covered}`;
  if (!options.write) {
    console.log(summary);
    for (const warning of report.warnings) console.log('[warn] ' + warning);
    return;
  }
  const outDir = options.out || path.join(report.root, 'evolution', 'candidates');
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (error) {
    console.error('[evolution-candidates] 输出目录不可写：' + outDir + ' :: ' + error.message);
    process.exit(2);
  }
  const day = report.generated_at.slice(0, 10);
  const mdFile = path.join(outDir, day + '.md');
  const jsonFile = path.join(outDir, day + '.json');
  try {
    fs.writeFileSync(mdFile, renderMarkdown(report), 'utf8');
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (error) {
    console.error('[evolution-candidates] 报告写入失败：' + error.message);
    process.exit(2);
  }
  console.log(summary);
  console.log('报告：' + mdFile);
  console.log('数据：' + jsonFile);
  for (const warning of report.warnings) console.log('[warn] ' + warning);
}

main();
