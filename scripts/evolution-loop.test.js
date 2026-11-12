#!/usr/bin/env node
// 自进化收尾闭环的**链路**自测：把两个真实 hook 串起来跑，证明用户 2026-11-12 的要求真的成立——
// 「每轮对话收尾，将自进化建议通过弹窗形式给出推荐，由用户决定是否新增/更改」。
//
// 单测各自绿不代表链路通：采集写了 pending 但门禁读不到、门禁拦了但弹窗后仍不放行，
// 都只有把两个脚本按真实 Stop 顺序串起来才暴露。这里按宿主顺序跑 evolution-capture → stop-gate。
//
// 用法: node scripts/evolution-loop.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CAPTURE = path.join(__dirname, 'evolution-capture.cjs');
const GATE = path.join(__dirname, 'stop-gate.js');
const DEPS = ['evolution-capture.cjs', 'stop-gate.js', 'stop-gate-text.js', 'evolution-signal-core.js',
  'client-root.js', 'hook-crash-guard.js', 'parallel-context-redact.cjs', 'kickoff-core.cjs', 'capability-roots.cjs'];
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-loop-'));
const HOME = path.join(SB, 'home');
const CLIENT = path.join(HOME, '.qoder');
const INBOX = path.join(CLIENT, 'evolution', 'inbox.jsonl');
const CONTROL = path.join(CLIENT, 'evolution', 'control.json');
const CAP_STATE = path.join(SB, 'capture-state');
const GATE_STATE = path.join(SB, 'gate-state');

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!ok) fail++;
};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const inboxCount = () => { try { return fs.readFileSync(INBOX, 'utf8').split('\n').filter(x => x.trim()).length; } catch { return 0; } };

const ENV = {
  ...process.env, HOME, USERPROFILE: HOME,
  EVOLUTION_CAPTURE_STATE_DIR: CAP_STATE, STOP_GATE_STATE_DIR: GATE_STATE,
  HOOK_CRASH_LOG: path.join(SB, 'crash.log'),
  TEMP: path.join(SB, 'temp'), TMP: path.join(SB, 'temp'), TMPDIR: path.join(SB, 'temp'),
  LOCALAPPDATA: path.join(SB, 'la'),
};
delete ENV.QODER_HOME;

const userLine = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asstLine = text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const useLine = (id, name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultLine = (id, content, isError) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
let seq = 0;
function transcript(lines) {
  const file = path.join(SB, `turn-${++seq}.jsonl`);
  write(file, lines.join('\n') + '\n');
  return file;
}
const CARD = { questions: [{ question: '这条自进化候选要不要采纳并落到 rules？', header: '自进化', options: [{ label: '采纳并落到推荐载体（推荐）' }, { label: '改写后采纳' }, { label: '本轮跳过' }] }] };
const CLEAN_CARD = { questions: [{ question: '本轮临时文件清理范围？', header: '临时清理', options: [{ label: '清理本轮产物' }, { label: '保留' }] }] };
const WRAP = '这一格按你说的口径改好了，细节都在上面的 diff 里。';
const SESSION = 'loop0001-1111-2222-3333-444444444444';
const PENDING = path.join(CAP_STATE, 'pending-loop0001.json');

function reset() {
  fs.rmSync(path.join(CLIENT, 'evolution'), { recursive: true, force: true });
  fs.rmSync(CAP_STATE, { recursive: true, force: true });
  fs.rmSync(GATE_STATE, { recursive: true, force: true });
  fs.mkdirSync(CLIENT, { recursive: true });
}
// 宿主 Stop 顺序：先采集（永不拦截），再门禁（可拦）。两个都是真实脚本、同一份环境。
function stop(turnFile, opts = {}) {
  const payload = JSON.stringify({
    hook_event_name: 'Stop', session_id: opts.session || SESSION,
    transcript_path: turnFile, cwd: path.join(SB, 'project-alpha'),
    last_assistant_message: opts.text || WRAP,
  });
  const capture = spawnSync(process.execPath, [opts.capture || CAPTURE], { input: payload, encoding: 'utf8', timeout: 20000, env: ENV });
  const gate = spawnSync(process.execPath, [opts.gate || GATE], { input: payload, encoding: 'utf8', timeout: 20000, env: ENV });
  let decision = 'allow';
  let reason = '';
  try {
    const parsed = JSON.parse((gate.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
    if (parsed.decision === 'block') { decision = 'block'; reason = String(parsed.reason || ''); }
  } catch {}
  return { capture, gate, decision, reason };
}

// 载体夹具：整条链路跑完必须逐字节不变（弹窗建议 ≠ 自动改载体）。
function seedCarriers() {
  write(path.join(CLIENT, 'AGENTS.md'), '# 全局规则\n以后一律用中文。\n');
  write(path.join(CLIENT, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }, null, 2));
  write(path.join(CLIENT, 'rules', 'long-task.md'), '# 长任务\n');
  write(path.join(CLIENT, 'skills', 'self-evolution', 'SKILL.md'), '---\nname: self-evolution\n---\n正文\n');
  write(path.join(CLIENT, 'memory', 'MEMORY.md'), '# 索引\n');
}
const CARRIERS = ['AGENTS.md', 'settings.json', path.join('rules', 'long-task.md'), path.join('skills', 'self-evolution', 'SKILL.md'), path.join('memory', 'MEMORY.md')];
const snapshot = () => CARRIERS.map(rel => (fs.existsSync(path.join(CLIENT, rel)) ? sha(path.join(CLIENT, rel)) : 'MISSING')).join('|');

const PREFERENCE_TURN = [
  userLine('以后一律用简体中文回复。还有，找不到对应的 MCP 工具。'),
  useLine('t1', 'Bash', { command: 'pwsh -v' }),
  resultLine('t1', 'command not found: pwsh', true),
  useLine('t2', 'Bash', { command: 'pwsh -v' }),
  resultLine('t2', 'command not found: pwsh', true),
  asstLine('已否证：改执行策略 × 本机 A/B 对照无效'),
];

// ① 有新候选 → 采集写 inbox + pending，门禁必须拦下并要求弹窗
reset(); seedCarriers();
const carriersBefore = snapshot();
const step1 = stop(transcript(PREFERENCE_TURN));
check('① 采集 exit 0 且永不拦截', step1.capture.status === 0 && !/decision/.test(step1.capture.stdout || ''), `exit=${step1.capture.status}`);
check('① 候选入 inbox', inboxCount() >= 4, `inbox=${inboxCount()}`);
const pending1 = readJson(PENDING);
check('① 采集写下收尾建议 pending', !!pending1 && pending1.items.length >= 2, JSON.stringify(pending1 && pending1.items.map(i => i.topic)));
check('① 门禁拦下未弹窗的收尾', step1.decision === 'block', step1.decision);
check('① 归因是 R19', step1.reason.includes('R19-evolution-suggestion-not-asked'), step1.reason.slice(0, 90));
check('① 拦截理由带推荐落点', /rules|记忆|技能/.test(step1.reason) && step1.reason.includes('AskUserQuestion'));
check('① 拦截理由带拒绝登记入口', step1.reason.includes('--decline'));

// ② 续跑弹窗（真实 AskUserQuestion 台账）→ 采集消费 pending，门禁放行
const step2 = stop(transcript([...PREFERENCE_TURN, useLine('a1', 'AskUserQuestion', CARD), resultLine('a1', '{"answers":{"选":"采纳并落到推荐载体（推荐）"}}')]));
check('② 弹窗后 pending 被消费', !fs.existsSync(PENDING));
check('② 弹窗后门禁放行（闭环收敛）', step2.decision === 'allow', step2.reason.slice(0, 120));
check('② 弹窗轮不重复写候选', inboxCount() >= 4 && /dup=[1-9]/.test(fs.readFileSync(path.join(CAP_STATE, 'heartbeat.log'), 'utf8')));

// ③ 清理卡 / 开工卡不冒充建议弹窗 → 仍要拦
reset();
const step3 = stop(transcript([...PREFERENCE_TURN, useLine('a2', 'AskUserQuestion', CLEAN_CARD), resultLine('a2', '{"answers":{"选":"保留"}}')]));
check('③ 清理卡不算已问建议，仍拦', step3.decision === 'block' && !!readJson(PENDING), step3.decision);

// ④ 无新证据 / 只有助手经验 / 只读 / 暂停：零打扰，门禁不拦
reset();
const plain = stop(transcript([userLine('帮我看看这个函数是做什么的'), asstLine('这个函数把入参归一化后返回。')]));
check('④ 普通轮零候选零建议零拦截', inboxCount() === 0 && !fs.existsSync(PENDING) && plain.decision === 'allow');
reset();
const experience = stop(transcript([userLine('跑一下这个脚本'), asstLine('已否证：改执行策略 × 本机 A/B 对照无效\n验证结论：node --test 12/12 通过')]));
check('④ 只有助手经验时进 inbox 但不弹窗', inboxCount() >= 1 && !fs.existsSync(PENDING) && experience.decision === 'allow', `inbox=${inboxCount()}`);
reset();
const readOnly = stop(transcript([userLine('只读审阅这个方案，不要修改任何文件'), ...PREFERENCE_TURN.slice(1)]));
check('④ 只读轮零候选零建议零拦截', inboxCount() === 0 && !fs.existsSync(PENDING) && readOnly.decision === 'allow');
reset(); write(CONTROL, JSON.stringify({ enabled: false }));
const paused = stop(transcript(PREFERENCE_TURN));
check('④ 暂停时零候选零建议零拦截', inboxCount() === 0 && !fs.existsSync(PENDING) && paused.decision === 'allow');

// ⑤ 用户选跳过 → --decline 登记后门禁不再为同一建议拦人
reset();
stop(transcript(PREFERENCE_TURN));
const declinedTopics = readJson(PENDING).items.map(i => i.topic);
const declineArgs = declinedTopics.flatMap(topic => ['--decline', topic]);
const decline = spawnSync(process.execPath, [CAPTURE, ...declineArgs], { encoding: 'utf8', timeout: 20000, env: ENV });
check('⑤ --decline 登记成功', decline.status === 0 && new RegExp('declined=' + declinedTopics.length).test(decline.stdout || ''), (decline.stdout || decline.stderr || '').trim().slice(0, 100));
check('⑤ 全部拒绝后 pending 撤空', !fs.existsSync(PENDING));
const afterDecline = stop(transcript(PREFERENCE_TURN));
check('⑤ 拒绝后同轮收尾放行', afterDecline.decision === 'allow', afterDecline.reason.slice(0, 120));
check('⑤ 拒绝只影响弹窗，证据仍在 inbox', inboxCount() >= 4, `inbox=${inboxCount()}`);

// ⑥ 全链路结束后载体逐字节未变（建议只是建议，不自动新增/更改）
check('⑥ 载体逐字节未变（不自动改规则/技能/记忆/settings）', snapshot() === carriersBefore);

// ⑦ 变异对照：把采集写 pending 的那一步改坏，门禁就必须放行——证明①的拦不是恒拦
const MUT = path.join(SB, 'mutant');
fs.mkdirSync(MUT, { recursive: true });
for (const name of DEPS) {
  const src = path.join(__dirname, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(MUT, name));
}
const mutCapture = path.join(MUT, 'evolution-capture.cjs');
const mutSource = fs.readFileSync(mutCapture, 'utf8');
const ANCHOR = 'const suggestion = result.written && !turn.askedEvolution ? writePending(ctx.session, ctx, result.fresh, result.sessions) : { pending: 0 };';
if (!mutSource.includes(ANCHOR)) check('⑦ 变异体可构造', false, '锚点未命中');
else {
  fs.writeFileSync(mutCapture, mutSource.replace(ANCHOR, 'const suggestion = { pending: 0 };'), 'utf8');
  reset();
  const broken = stop(transcript(PREFERENCE_TURN), { capture: mutCapture });
  check('⑦ 改坏采集→门禁放行（链路断言能失败）', inboxCount() >= 4 && !fs.existsSync(PENDING) && broken.decision === 'allow', broken.decision);
  fs.writeFileSync(mutCapture, mutSource, 'utf8');
  reset();
  const clean = stop(transcript(PREFERENCE_TURN), { capture: mutCapture });
  check('⑦ 未改动副本仍拦（harness 负对照）', clean.decision === 'block' && !!readJson(PENDING), clean.decision);
}

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);