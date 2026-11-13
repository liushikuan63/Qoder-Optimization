#!/usr/bin/env node
// evolution-candidates.cjs 的隔离自测：分类、覆盖检测、降级、负对照与报告写入。
// 用法: node evolution-candidates.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'evolution-candidates.cjs');
const SB = path.join(os.tmpdir(), `evo-cand-${Date.now()}`);
const ROOT = path.join(SB, 'root');
const EMPTY = path.join(SB, 'empty');
const OUT = path.join(SB, 'out');

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

function write(rel, content) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

const twoSessions = '会话 11111111-1111-1111-1111-111111111111 与 22222222-2222-2222-2222-222222222222 都出现过；正文足够长以通过长度检查。';
const oneSession = '会话 33333333-3333-3333-3333-333333333333 出现过；正文足够长以通过长度检查。';

write('AGENTS.md', '# AGENTS\n\ngamma covered 伽马判据 核对\n');
write('memory/feedback-alpha-quasar.md', `---
name: feedback-alpha-quasar
description: 阿尔法专用判据必须完整
metadata:
  type: feedback
---
${twoSessions}
SECRET_TOKEN_ABC 仅用于证明报告不复制正文。
`);
write('memory/feedback-beta-vertex.md', `---
name: feedback-beta-vertex
description: 贝塔判据必须核对
metadata:
  type: feedback
---
${oneSession}
`);
write('memory/feedback-gamma-covered.md', `---
name: feedback-gamma-covered
description: 伽马判据必须核对
metadata:
  type: feedback
---
${oneSession}
`);
write('memory/feedback-short.md', `---
name: feedback-short
description: ""
metadata:
  type: feedback
---
太短
`);
write('memory/MEMORY.md', '- [Alpha](feedback-alpha-quasar.md) — index only\n');

const now = Date.now();
const iso = (offsetDays) => new Date(now - offsetDays * 86400000).toISOString();
write('tmp/stop-gate/violations.log', [
  `${iso(1)}|R3-ui-claim-without-evidence|sess=aaaa|hash=1|len=10`,
  `${iso(2)}|R3-ui-claim-without-evidence|sess=aaaa|hash=2|len=10`,
  `${iso(3)}|R3-ui-claim-without-evidence|sess=bbbb|hash=3|len=10`,
  `${iso(1)}|R1b-declared-next-step-without-reason|sess=cccc|hash=4|len=10`,
  `${iso(1)}|SECOND-STOP|sess=cccc|hash=5|len=10`,
].join('\n') + '\n');

const record = (name, payload) => write(path.join('evolution', 'records', name), JSON.stringify(payload));
record('a1.json', { topic: 'topic-a', scope: 'global', type: 'observation', created_at: iso(2), verified: false, evidence: { task_id: 't1', session_id: 's1', source: 'user' } });
record('a2.json', { topic: 'topic-a', scope: 'global', type: 'observation', created_at: iso(3), verified: false, evidence: { task_id: 't2', session_id: 's2', source: 'user' } });
record('a3.json', { topic: 'topic-a', scope: 'global', type: 'observation', created_at: iso(1), verified: false, evidence: { task_id: 't6', session_id: 's2', source: 'user' } });
record('single.json', { topic: 'topic-single', scope: 'global', type: 'observation', created_at: iso(1), verified: false, evidence: { task_id: 't3', source: 'user' } });
record('done.json', { topic: 'topic-done', scope: 'global', type: 'correction', created_at: iso(1), verified: true, evidence: { task_id: 't4', source: 'local-validation' } });
record('rejected.json', { topic: 'topic-rejected', scope: 'global', type: 'rejection', created_at: iso(1), verified: false, evidence: { task_id: 't5', source: 'user' } });

fs.mkdirSync(EMPTY, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

function run(args, root = ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, QODER_HOME: root, HOME: SB, USERPROFILE: SB },
  });
}

function report(args = ['--days', '30', '--json'], root = ROOT) {
  const result = run(args, root);
  let data = null;
  try { data = JSON.parse(result.stdout); } catch {}
  return { result, data };
}

const first = report();
check('① 正常扫描 → exit 0 + 合法 JSON', first.result.status === 0 && first.data !== null, `exit=${first.result.status}`);

const get = (data, id) => (data.candidates || []).find((candidate) => candidate.id === id);
const expectKind = (label, data, id, kind) => {
  const candidate = get(data, id);
  check(label, Boolean(candidate) && candidate.kind === kind, candidate ? `kind=${candidate.kind}` : 'missing');
};

expectKind('② 双会话 UUID 不证明独立任务 → promote-local', first.data, 'feedback:feedback-alpha-quasar.md', 'promote-local');
expectKind('③ 单会话未覆盖 feedback → promote-local', first.data, 'feedback:feedback-beta-vertex.md', 'promote-local');
expectKind('④ 载体已覆盖 feedback → covered', first.data, 'feedback:feedback-gamma-covered.md', 'covered');
expectKind('⑤ 空描述短正文 feedback → observe', first.data, 'feedback:feedback-short.md', 'observe');
expectKind('⑥ 高频多会话违规无任务证明 → observe', first.data, 'violation:R3-ui-claim-without-evidence', 'observe');
expectKind('⑦ 低频违规 → observe', first.data, 'violation:R1b-declared-next-step-without-reason', 'observe');
expectKind('⑧ 多任务 records → promote-global', first.data, 'record:topic-a', 'promote-global');
expectKind('⑨ 单条 records → observe', first.data, 'record:topic-single', 'observe');
expectKind('⑩ verified records → covered', first.data, 'record:topic-done', 'covered');
expectKind('⑪ rejection records → rejected', first.data, 'record:topic-rejected', 'rejected');
check('⑫ SECOND-STOP 不计入违规规则', !get(first.data, 'violation:SECOND-STOP'), '');

const alpha = get(first.data, 'feedback:feedback-alpha-quasar.md');
check('⑬ 建议落点不被 feedback 中的 db 子串误判为数据库',
  alpha && !/databases/.test(alpha.suggested_carrier), alpha ? alpha.suggested_carrier : 'missing');

const serialized = JSON.stringify(first.data);
check('⑭ 报告不复制记忆正文（敏感串零命中）', !serialized.includes('SECRET_TOKEN_ABC'), '');
check('⑮ 数据源缺失时继续并给出警告', first.data.warnings.some((w) => /初筛/.test(w)) && first.data.sources.feedback.status === 'ok', '');

// ⑯ 负对照：增减正文 UUID 不得替代独立任务证据升级全局候选。
const alphaFile = path.join(ROOT, 'memory', 'feedback-alpha-quasar.md');
const alphaText = fs.readFileSync(alphaFile, 'utf8');
fs.writeFileSync(alphaFile, alphaText.replace('22222222-2222-2222-2222-222222222222', 'SESSION-B'), 'utf8');
const downgraded = report();
expectKind('⑯ 负对照：减少正文 UUID 后仍只建议核对局部载体',
  downgraded.data, 'feedback:feedback-alpha-quasar.md', 'promote-local');
fs.writeFileSync(alphaFile, alphaText, 'utf8');

// ⑰ 负对照：从载体移除关键词 → covered 必须失效
const agentsFile = path.join(ROOT, 'AGENTS.md');
const agentsText = fs.readFileSync(agentsFile, 'utf8');
fs.writeFileSync(agentsFile, agentsText.replace('gamma covered 伽马判据 核对', '无关内容'), 'utf8');
const uncovered = report();
check('⑰ 负对照：载体不再覆盖 → covered 变为待晋升',
  (() => { const c = get(uncovered.data, 'feedback:feedback-gamma-covered.md'); return c && c.kind !== 'covered'; })(),
  (() => { const c = get(uncovered.data, 'feedback:feedback-gamma-covered.md'); return c ? c.kind : 'missing'; })());
fs.writeFileSync(agentsFile, agentsText, 'utf8');

// ⑱ 空环境 → exit 0、零候选、三源警告
const empty = report(['--days', '30', '--json'], EMPTY);
check('⑱ 空环境 → exit 0 + 零候选 + 缺失警告',
  empty.result.status === 0 && empty.data && Object.values(empty.data.counts).every((n) => n === 0)
    && empty.data.warnings.filter((w) => /缺失/.test(w)).length >= 2,
  empty.data ? JSON.stringify(empty.data.counts) : 'no json');

// ⑲ --write 生成 md + json，且摘要可读
const written = run(['--days', '30', '--write', '--out', OUT]);
const day = new Date().toISOString().slice(0, 10);
const mdFile = path.join(OUT, day + '.md');
const jsonFile = path.join(OUT, day + '.json');
const md = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
check('⑲ --write 生成 md + json 且含计数表',
  written.status === 0 && md.includes('## 计数') && fs.existsSync(jsonFile) && JSON.parse(fs.readFileSync(jsonFile, 'utf8')).counts,
  `exit=${written.status}`);

// ⑳ 参数错误 → exit 2
const badDays = run(['--days', 'abc']);
const badOut = run(['--write', '--out']);
check('⑳ 参数错误 → exit 2', badDays.status === 2 && badOut.status === 2, `days=${badDays.status} out=${badOut.status}`);

// ㉑ 只读：扫描后 fixture 载体与记忆内容不变
check('㉑ 只读扫描不改动记忆与载体', fs.readFileSync(agentsFile, 'utf8') === agentsText
  && fs.readFileSync(alphaFile, 'utf8') === alphaText, '');

// —— 第四源 inbox（Stop hook 采集）：晋升判据、载体路由、窗口、脱敏与改坏必红 ——
const ROUTE = {
  'long-term-preference': ['memory', 'rules', 'agents'],
  'explicit-sedimentation': ['memory', 'rules', 'skill'],
  'repeat-correction': ['rules', 'hook', 'memory'],
  'capability-gap': ['mcp', 'skill', 'script'],
  'repeated-failure': ['skill', 'hook', 'memory'],
  'disproven-prescription': ['skill', 'memory'],
};
const core = require('./evolution-signal-core.js');
check('㉒ inbox fixture 路由与信号核一致（防两份清单漂移）',
  Object.keys(ROUTE).every((kind) => JSON.stringify(ROUTE[kind]) === JSON.stringify(core.suggestCarriers(kind))), '');

const rec = (topic, kind, family, session, task, days, extra = {}) => ({
  schema: 1, kind, family, topic, carriers: ROUTE[kind], source: 'stop-hook',
  excerpt: extra.excerpt || topic.slice(topic.indexOf(':') + 1),
  redacted: false, evidence: extra.evidence || {}, verified: false, status: 'candidate',
  id: `${session}-${task}`.padEnd(16, '0').slice(0, 16),
  dedupKey: [session, task, kind, topic].join('|'),
  at: iso(days), session, task, cwd: `D:/work/${task}`,
});

const GLOBAL_TOPIC = 'long-term-preference:以后一律先预览命中范围';
const REPEAT_TOPIC = 'repeat-correction:又忘了先备份';
const GAP_ONE = 'capability-gap:缺少浏览器驱动';
const GAP_TWO = 'capability-gap:缺少数据库客户端';
const FAIL_TOPIC = 'repeated-failure:Bash 同一错误重复失败';
const EXP_TOPIC = 'disproven-prescription:某处方无效';
const EXPLICIT_TOPIC = 'explicit-sedimentation:记住这个口径';
const COVERED_TOPIC = 'explicit-sedimentation:伽马判据核对';

const inboxRecords = [
  rec(GLOBAL_TOPIC, 'long-term-preference', 'preference', 's1', 'dirA', 1),
  rec(GLOBAL_TOPIC, 'long-term-preference', 'preference', 's2', 'dirB', 2),
  rec(GLOBAL_TOPIC, 'long-term-preference', 'preference', 's2', 'dirB', 3),
  rec(REPEAT_TOPIC, 'repeat-correction', 'preference', 's3', 'dirA', 1),
  rec(REPEAT_TOPIC, 'repeat-correction', 'preference', 's3', 'dirC', 2),
  rec(GAP_ONE, 'capability-gap', 'problem', 's4', 'dirD', 1,
    { excerpt: '缺少浏览器驱动 token=abc123Secret 连不上 ' + '10.' + '1.2.3', evidence: { tool: 'Bash', occurrences: 1 } }),
  rec(GAP_TWO, 'capability-gap', 'problem', 's5', 'dirE', 1, { evidence: { tool: 'Bash', occurrences: 1 } }),
  rec(GAP_TWO, 'capability-gap', 'problem', 's6', 'dirF', 2, { evidence: { tool: 'Bash', occurrences: 1 } }),
  rec(FAIL_TOPIC, 'repeated-failure', 'problem', 's7', 'dirG', 1, { evidence: { tool: 'Bash', occurrences: 3 } }),
  rec(EXP_TOPIC, 'disproven-prescription', 'experience', 's8', 'dirH', 1, { excerpt: '已否证：某处方 无效' }),
  rec(EXP_TOPIC, 'disproven-prescription', 'experience', 's9', 'dirI', 2, { excerpt: '已否证：某处方 无效' }),
  rec(EXPLICIT_TOPIC, 'explicit-sedimentation', 'preference', 's10', 'dirJ', 1),
  rec(COVERED_TOPIC, 'explicit-sedimentation', 'preference', 's11', 'dirK', 1, { excerpt: '伽马判据 核对 gamma covered' }),
  rec('long-term-preference:过期口径不再采纳', 'long-term-preference', 'preference', 's12', 'dirL', 40),
];
const inboxFile = path.join(ROOT, 'evolution', 'inbox.jsonl');
const inboxText = inboxRecords.map((r) => JSON.stringify(r)).join('\n')
  + '\n这不是 JSON\n{"kind":"capability-gap"}\n{}\n';
write('evolution/inbox.jsonl', inboxText);
// 轮转归档也必须被读到，否则老候选会静默丢失。
write('evolution/inbox.archive-20261101T000000Z.jsonl',
  JSON.stringify(rec(GLOBAL_TOPIC, 'long-term-preference', 'preference', 's13', 'dirM', 4)) + '\n');

const withInbox = report();
const inboxItems = (withInbox.data.candidates || []).filter((c) => c.source === 'inbox');
check('㉓ inbox 源被读入：15 条原始记录 / 窗口内 14 / 8 个主题（坏行与窗口外不计）',
  withInbox.result.status === 0 && withInbox.data.sources.inbox.status === 'ok'
    && withInbox.data.sources.inbox.records === 15 && withInbox.data.sources.inbox.inWindow === 14
    && inboxItems.length === 8,
  JSON.stringify(withInbox.data.sources.inbox) + ` items=${inboxItems.length}`);

expectKind('㉔ 跨会话+跨目录长期要求 → promote-global', withInbox.data, 'inbox:' + GLOBAL_TOPIC, 'promote-global');
expectKind('㉕ 单会话跨目录纠正 → 仍只 promote-local', withInbox.data, 'inbox:' + REPEAT_TOPIC, 'promote-local');
expectKind('㉖ 能力缺口仅 1 会话 1 目录 → observe', withInbox.data, 'inbox:' + GAP_ONE, 'observe');
expectKind('㉗ 能力缺口跨 2 会话 → promote-local', withInbox.data, 'inbox:' + GAP_TWO, 'promote-local');
expectKind('㉘ 单轮重复失败 3 次 → observe（不算独立任务）', withInbox.data, 'inbox:' + FAIL_TOPIC, 'observe');
expectKind('㉙ 助手经验跨会话也只 promote-local（永不全局）', withInbox.data, 'inbox:' + EXP_TOPIC, 'promote-local');
expectKind('㉚ 用户明确要求沉淀 → 一次即 promote-local', withInbox.data, 'inbox:' + EXPLICIT_TOPIC, 'promote-local');
expectKind('㉛ 关键词已被载体覆盖 → covered', withInbox.data, 'inbox:' + COVERED_TOPIC, 'covered');
check('㉜ 窗口外候选不出现', !get(withInbox.data, 'inbox:long-term-preference:过期口径不再采纳'), '');

const gapTwo = get(withInbox.data, 'inbox:' + GAP_TWO);
check('㉝ 能力缺口路由到 MCP/技能/脚本并提示先跑 carrier-preflight',
  gapTwo && /MCP/.test(gapTwo.suggested_carrier) && /carrier-preflight/.test(gapTwo.suggested_carrier),
  gapTwo ? gapTwo.suggested_carrier : 'missing');
const failOne = get(withInbox.data, 'inbox:' + FAIL_TOPIC);
check('㉞ 重复失败保留单轮 occurrences 证据', failOne && failOne.evidence.occurrences === 3,
  failOne ? String(failOne.evidence.occurrences) : 'missing');
check('㉟ 每条 inbox 候选都带"目录名不等于独立任务"的核对提醒',
  inboxItems.every((c) => c.reasons.some((r) => /不等于独立任务/.test(r))), '');
check('㊱ 报告声明 inbox 一律未验证', withInbox.data.warnings.some((w) => /verified 一律 false/.test(w)), '');

const inboxSerialized = JSON.stringify(withInbox.data);
check('㊲ inbox 摘录二次脱敏（口令与内网地址零命中）',
  !inboxSerialized.includes('abc123Secret') && !inboxSerialized.includes('10.' + '1.2.3')
    && inboxSerialized.includes('[REDACTED'), '');
check('㊳ 只读扫描不改写 inbox 与归档',
  fs.readFileSync(inboxFile, 'utf8') === inboxText, '');

const inboxMd = run(['--days', '30', '--write', '--out', OUT]);
const inboxMdText = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
check('㊴ markdown 含 inbox 数据源与证据列',
  inboxMd.status === 0 && /inbox 15 条 \/ 窗口内 14（ok）/.test(inboxMdText)
    && /候选 4 条，会话 3，目录 3，覆盖 0%/.test(inboxMdText), `exit=${inboxMd.status}`);

// ㊵ 负对照：空环境没有 evolution 目录 → 采集源缺失但不致命
check('㊵ 负对照：inbox 缺失 → status=missing + 接线警告，仍 exit 0',
  empty.result.status === 0 && empty.data.sources.inbox.status === 'missing'
    && empty.data.warnings.some((w) => /inbox\.jsonl 缺失/.test(w)),
  JSON.stringify(empty.data.sources.inbox));

// ㊶ 改坏必红 + 干净副本必绿：证明上面的判据不是假绿。
const MUT = path.join(SB, 'mut');
const MUT_DEPS = ['evolution-candidates.cjs', 'client-root.js', 'evolution-signal-core.js',
  'parallel-context-redact.cjs', 'capability-roots.cjs'];
function scanWith(dir) {
  const result = spawnSync(process.execPath, [path.join(dir, 'evolution-candidates.cjs'), '--days', '30', '--json'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, QODER_HOME: ROOT, HOME: SB, USERPROFILE: SB },
  });
  let data = null;
  try { data = JSON.parse(result.stdout); } catch {}
  return { result, data };
}
function mutant(label, transform, defectVisible) {
  const dir = path.join(MUT, label);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of MUT_DEPS) {
    const src = path.join(__dirname, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  const target = path.join(dir, 'evolution-candidates.cjs');
  const original = fs.readFileSync(target, 'utf8');
  const changed = transform(original);
  if (changed === original) { check(`㊶ 变异 ${label} 命中源码`, false, '替换未生效，判据无效'); return; }
  fs.writeFileSync(target, changed, 'utf8');
  const { result, data } = scanWith(dir);
  const visible = Boolean(data) && defectVisible(data);
  check(`㊶ 改坏必红：${label}`, visible,
    visible ? '缺陷已显现（判据可失败）'
      : data ? '缺陷未显现（断言太弱）' : `exit=${result.status} ${(result.stderr || '').split('\n')[0]}`);
}
const inboxCount = (data) => (data.candidates || []).filter((c) => c.source === 'inbox').length;
mutant('drop-inbox-source', (s) => s.replace('    ...inbox.items,\n', ''), (data) => inboxCount(data) === 0);
mutant('global-threshold-neutered',
  (s) => s.replace("kind = sessions >= 2 && tasks >= 2 ? 'promote-global' : 'promote-local';",
    "kind = sessions >= 1 ? 'promote-global' : 'promote-local';"),
  (data) => (get(data, 'inbox:' + REPEAT_TOPIC) || {}).kind === 'promote-global');
mutant('gap-threshold-neutered',
  (s) => s.replace("kind = sessions >= 2 || tasks >= 2 ? 'promote-local' : 'observe';",
    "kind = 'promote-local';"),
  (data) => (get(data, 'inbox:' + GAP_ONE) || {}).kind === 'promote-local');
mutant('experience-promoted-global',
  (s) => s.replace("} else if (group.family === 'experience') {\n      kind = 'promote-local';",
    "} else if (group.family === 'experience') {\n      kind = 'promote-global';"),
  (data) => (get(data, 'inbox:' + EXP_TOPIC) || {}).kind === 'promote-global');
mutant('redaction-removed', (s) => s.replace('excerpt: redact(group.excerpt).slice(0, 120),', 'excerpt: group.excerpt.slice(0, 120),'),
  (data) => JSON.stringify(data).includes('abc123Secret'));
mutant('window-ignored',
  (s) => s.replace('total++;\n      const at = Date.parse(record.at);\n      if (!Number.isFinite(at) || at < since || at > now) continue;',
    'total++;\n      const at = Date.parse(record.at);\n      if (!Number.isFinite(at)) continue;'),
  (data) => Boolean(get(data, 'inbox:long-term-preference:过期口径不再采纳')));
mutant('archive-ignored', (s) => s.replace("return names.filter((n) => n === 'inbox.jsonl' || /^inbox\\.archive-\\d{8}T\\d{6}Z?\\.jsonl$/.test(n))",
  "return names.filter((n) => n === 'inbox.jsonl')"),
  (data) => data.sources.inbox.records === 14);

const cleanDir = path.join(MUT, 'clean-copy');
fs.mkdirSync(cleanDir, { recursive: true });
for (const name of MUT_DEPS) {
  const src = path.join(__dirname, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(cleanDir, name));
}
const clean = scanWith(cleanDir);
check('㊷ 负对照：干净副本仍绿（8 主题 / 全局与局部判据不变 / 无秘密）',
  clean.result.status === 0 && inboxCount(clean.data) === 8
    && (get(clean.data, 'inbox:' + GLOBAL_TOPIC) || {}).kind === 'promote-global'
    && (get(clean.data, 'inbox:' + REPEAT_TOPIC) || {}).kind === 'promote-local'
    && !JSON.stringify(clean.data).includes('abc123Secret'),
  `exit=${clean.result.status} items=${clean.data ? inboxCount(clean.data) : 'no json'}`);

try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exitCode = fail ? 1 : 0;
