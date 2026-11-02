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
record('a1.json', { topic: 'topic-a', type: 'observation', created_at: iso(2), verified: false, evidence: { task_id: 't1', session_id: 's1' } });
record('a2.json', { topic: 'topic-a', type: 'observation', created_at: iso(3), verified: false, evidence: { task_id: 't2', session_id: 's2' } });
record('single.json', { topic: 'topic-single', type: 'observation', created_at: iso(1), verified: false, evidence: { task_id: 't3' } });
record('done.json', { topic: 'topic-done', type: 'correction', created_at: iso(1), verified: true, evidence: { task_id: 't4' } });
record('rejected.json', { topic: 'topic-rejected', type: 'rejection', created_at: iso(1), verified: false, evidence: { task_id: 't5' } });

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

expectKind('② 双会话未覆盖 feedback → promote-global', first.data, 'feedback:feedback-alpha-quasar.md', 'promote-global');
expectKind('③ 单会话未覆盖 feedback → promote-local', first.data, 'feedback:feedback-beta-vertex.md', 'promote-local');
expectKind('④ 载体已覆盖 feedback → covered', first.data, 'feedback:feedback-gamma-covered.md', 'covered');
expectKind('⑤ 空描述短正文 feedback → observe', first.data, 'feedback:feedback-short.md', 'observe');
expectKind('⑥ 高频多会话违规 → promote-global', first.data, 'violation:R3-ui-claim-without-evidence', 'promote-global');
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

// ⑯ 负对照：删掉第二个 UUID → 同一 feedback 必须从 promote-global 降为 promote-local
const alphaFile = path.join(ROOT, 'memory', 'feedback-alpha-quasar.md');
const alphaText = fs.readFileSync(alphaFile, 'utf8');
fs.writeFileSync(alphaFile, alphaText.replace('22222222-2222-2222-2222-222222222222', 'SESSION-B'), 'utf8');
const downgraded = report();
expectKind('⑯ 负对照：跨会话证据减少 → promote-global 降为 promote-local',
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

try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exitCode = fail ? 1 : 0;
