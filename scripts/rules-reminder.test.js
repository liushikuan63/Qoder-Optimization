#!/usr/bin/env node
// rules-reminder.js 的自测：每轮提醒是"最易被忽略的纪律"的唯一兜底，它自己坏了不该没人知道。
// 判据（任一不成立即 exit 1）：
//   ① 合法 UserPromptSubmit 载荷 → 退出码 0、stdout 是合法 JSON、形状为 hookSpecificOutput.additionalContext
//   ② 提醒正文含 10 条要素与两条**本轮强化的判据**（声明下一步就当场做 / 裁决先弹窗）
//   ③ 空 stdin（宿主异常）也必须照样注入——注入不能依赖载荷内容
//   ④ 心跳日志追加了一行（"机制在跑"的可观测证据）
//   ⑤ 对照组：删掉一条要素的"假提醒"必须被判红（证明 ② 的断言真能失败）
//   ⑥⑦⑧ 请求原文回注：有 prompt 必须在注入块末尾带回原文；无 prompt 只许印"未取到"（不许印"用户没提问"）；超长必须截断
// 用法: node rules-reminder.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'rules-reminder.js');
const SB = path.join(os.tmpdir(), `reminder-sb-${Date.now()}`);
const HOME = path.join(SB, 'home');
fs.mkdirSync(path.join(HOME, '.qoder', 'scripts'), { recursive: true });
// 宿主（Qoder 会话）会注入 QODER_HOME，优先级高于 HOME；不剥掉会把沙箱指回真实客户端，造成假失败。
const CHILD_ENV = { ...process.env, USERPROFILE: HOME, HOME };
delete CHILD_ENV.QODER_HOME;

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

const run = (input) => spawnSync(process.execPath, [SCRIPT], {
  input,
  encoding: 'utf8',
  timeout: 15000,
  env: CHILD_ENV,
});

const MARKERS = ['简体中文', '不随意停止', '需拍板', '验证要能失败', '先备份', '先只读预览命中范围', '明确结论', 'Vibecoding 两问', '目标模式', '开工先判定', '含混自检', '能力自检', '开工确认', '审查+成文', '过程落盘', '领域与流程纪律', '自进化采集', '确认理解一次'];
const STRENGTHENED = ['只读', '不重复确认', '不得通过换工具', '零文件写入', '不适用记 N/A'];
const checkText = (text, expected) => MARKERS.concat(STRENGTHENED).every((k) => expected ? text.includes(k) : true);

// ① 合法载荷
const r1 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sid-1', cwd: 'X:/x' }));
let ctx = '';
try { ctx = JSON.parse(r1.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('① 合法载荷 → exit 0 + 合法 JSON + 形状正确',
  r1.status === 0 && /hookSpecificOutput/.test(r1.stdout) && ctx.length > 100, `exit=${r1.status}`);

// ② 要素完整（含本轮强化的两条）
const missing = MARKERS.concat(STRENGTHENED).filter((k) => !ctx.includes(k));
check('② 11 条要素 + 2 条强化判据齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : '');

// ③ 空 stdin 也要注入
const r3 = run('');
let ctx3 = '';
try { ctx3 = JSON.parse(r3.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('③ 空 stdin → 仍注入且 exit 0', r3.status === 0 && ctx3 === ctx, `exit=${r3.status}`);

// ④ 心跳日志
const LOG = path.join(HOME, '.qoder', 'scripts', 'rules-reminder.log');
const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : [];
check('④ 心跳日志追加了带 ok 的行', lines.length >= 2 && /\d{4}-\d{2}-\d{2}T.*ok/.test(lines[lines.length - 1]), `行数=${lines.length}`);

// ⑤ 对照组：把"声明下一步"那条从文本里拿掉，② 的断言必须能红
check('⑤ 对照组：缺一条要素时必须能判红', !checkText(ctx.replace('零文件写入', ''), true), '（断言可失败性）');
check('⑤-补 对照组：删掉常驻理解确认句必须能判红', !checkText(ctx.replace('确认理解一次', ''), true), '（断言可失败性）');

// ⑥ 请求原文回注（缺陷来源：2026-09-24 会话 19586a9b，正文已在请求内、模型却判成"正文是空的"）
const P6 = '帮我检查一下，为什么我的edge动不动就无法访问网页了';
const r6 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P6 }));
let ctx6 = '';
try { ctx6 = JSON.parse(r6.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑥ 有 prompt → 注入块末尾回注请求原文',
  r6.status === 0 && ctx6.includes('【本轮请求摘要 · 可能截断，完整用户消息为准】' + P6) && !ctx6.includes('以此为准'), `exit=${r6.status}`);

// ⑦ 两个方向都要钉住：取不到才印"未取到"，取到就不许印；且回注行必须真的来自载荷
check('⑦ 对照组：无 prompt 印"未取到" / 有 prompt 不得印，且两者输出确有差异',
  ctx.includes('未取到 prompt 字段') && !ctx6.includes('未取到 prompt 字段') && ctx6 !== ctx, '');

// ⑧ 超长载荷截断（防注入块被一次大粘贴撑爆）——断言回注片段本身被截断，不依赖提醒正文长度
const r8 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'A'.repeat(500) }));
let ctx8 = '';
try { ctx8 = JSON.parse(r8.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
const echo8 = (ctx8.split('【本轮请求摘要 · 可能截断，完整用户消息为准】')[1] || '').split('\n')[0];
check('⑧ prompt 超 300 字 → 回注片段被截断加省略号',
  echo8.length > 0 && echo8.length <= 302 && echo8.endsWith('…') && ctx8.length < ctx.length + 400,
  `回注片段=${echo8.length}B 注入块=${ctx8.length}B`);

const restricted = run(JSON.stringify({ prompt: 'A'.repeat(420) + '不得修改任何文件。' }));
const restrictedCtx = JSON.parse(restricted.stdout).hookSpecificOutput.additionalContext;
check('⑨ 长请求摘要不冒充完整授权', !restrictedCtx.includes('以此为准') && restrictedCtx.includes('完整用户消息为准') && restrictedCtx.includes('禁止项和批准条件'));

const goalPrompt = '开始代码实现，完成前后端联调，部署线上验证通过后提交SVN';
const goalRun = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: goalPrompt }));
const goalCtx = JSON.parse(goalRun.stdout).hookSpecificOutput.additionalContext;
check('⑩ 长任务候选 → 同轮提醒Goal与Vibecoding两问',
  goalCtx.includes('目标候选') && goalCtx.includes('AskUserQuestion') && goalCtx.includes('创建或更新 Vibecoding 四层文档'));
const smallRun = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '修复一个按钮文案并提交' }));
const smallCtx = JSON.parse(smallRun.stdout).hookSpecificOutput.additionalContext;
check('⑪ 单点小修复负对照 → 不注入目标候选', !smallCtx.includes('【目标候选'));
const reviewRun = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '只读审查方案并给建议，不要修改文件' }));
const reviewCtx = JSON.parse(reviewRun.stdout).hookSpecificOutput.additionalContext;
check('⑫ 只读审阅负对照 → 不注入目标候选', !reviewCtx.includes('【目标候选'));
const reviewDocRun = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '审查项目，列缺陷项修复方案，形成vibecoding文档' }));
const reviewDocCtx = JSON.parse(reviewDocRun.stdout).hookSpecificOutput.additionalContext;
check('⑫-补 审查+成文长任务 → 注入目标候选', reviewDocRun.status === 0 && reviewDocCtx.includes('【目标候选') && reviewDocCtx.includes('审查+成文'));

// ⑬⑭ 抑制提醒（2026-10-27）：门禁因滑动窗上限放行时必须让"这一段在放行"可见，且同批只提醒一次
const gateDir = path.join(HOME, '.qoder', 'tmp', 'stop-gate');
fs.mkdirSync(gateDir, { recursive: true });
const nowIso = new Date().toISOString();
fs.writeFileSync(path.join(gateDir, 'violations.log'), [
  nowIso + '|R2-decision-without-popup-SUPPRESSED|sess=abcd|hash=1|len=100',
  nowIso + '|R3-ui-claim-without-evidence-SUPPRESSED|sess=abcd|hash=2|len=100',
].join('\n') + '\n');
const r10 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '继续' }));
let ctx10 = '';
try { ctx10 = JSON.parse(r10.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑬ 有抑制放行记录 → 必须提醒一次并带规则计数',
  r10.status === 0 && ctx10.includes('抑制提醒') && ctx10.includes('R2-decision-without-popup×1'), `exit=${r10.status}`);
const r11 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '继续' }));
let ctx11 = '';
try { ctx11 = JSON.parse(r11.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑪ 对照组：同一批抑制不重复提醒', r11.status === 0 && !ctx11.includes('抑制提醒'), '');


// ⑫⑬⑭ 复核模式：触发词追加协议；首次检查与否定句不追加
const P12 = '再次检查这个修复';
const r12 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P12 }));
let ctx12 = '';
try { ctx12 = JSON.parse(r12.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑫ 复核触发词 → 追加复核协议摘要',
  r12.status === 0 && ctx12.includes('【复核模式 · 已触发】') && ctx12.includes('历史资料分三类') && ctx12.includes(P12), `exit=${r12.status}`);

const P13 = '检查一下这个文件';
const r13 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P13 }));
let ctx13 = '';
try { ctx13 = JSON.parse(r13.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑬ 对照组：首次检查不追加复核协议',
  r13.status === 0 && !ctx13.includes('【复核模式 · 已触发】') && ctx13.includes('【本轮请求摘要'), `exit=${r13.status}`);

const P14 = '不用再次检查';
const r14 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P14 }));
let ctx14 = '';
try { ctx14 = JSON.parse(r14.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑭ 否定句不触发复核模式', r14.status === 0 && !ctx14.includes('【复核模式 · 已触发】'), `exit=${r14.status}`);

// ⑮⑯ 变异对照：摘掉复核调用后触发提示必须消失；非触发轮输出必须与变异体逐字节一致
const MUT_DIR = path.join(SB, 'mutated');
fs.mkdirSync(MUT_DIR, { recursive: true });
for (const name of ['rules-reminder.js', 'client-root.js', 'hook-crash-guard.js', 'goal-candidate-core.js', 'recheck-protocol.cjs', 'verification-trigger-core.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(MUT_DIR, name));
}
const mutFile = path.join(MUT_DIR, 'rules-reminder.js');
const mutSource = fs.readFileSync(mutFile, 'utf8');
const mutText = mutSource.replace('+ recheckNoteFor(prompt)', "+ ''");
const mutationApplied = mutText !== mutSource;
if (mutationApplied) fs.writeFileSync(mutFile, mutText);
check('⑮ 变异体已移除复核调用', mutationApplied, mutationApplied ? '' : '未找到可替换的调用点');
const runMut = (input) => spawnSync(process.execPath, [mutFile], {
  input,
  encoding: 'utf8',
  timeout: 15000,
  env: CHILD_ENV,
});
const r15 = runMut(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P12 }));
let ctx15 = '';
try { ctx15 = JSON.parse(r15.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑮ 变异对照：移除复核调用后触发提示必须消失', r15.status === 0 && !ctx15.includes('【复核模式 · 已触发】'), `exit=${r15.status}`);

const r16 = runMut(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P13 }));
const r17 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P13 }));
let ctx16 = '';
let ctx17 = '';
try { ctx16 = JSON.parse(r16.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
try { ctx17 = JSON.parse(r17.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑯ 模式隔离：非触发轮与变异体输出逐字节一致',
  r16.status === 0 && r17.status === 0 && ctx16 === ctx17, `mut=${ctx16.length} orig=${ctx17.length}`);

const P18 = '当我说“再次检查”时应该怎么处理';
const r18 = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: P18 }));
let ctx18 = '';
try { ctx18 = JSON.parse(r18.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('⑱ 元提及 / 教学问句不触发', r18.status === 0 && !ctx18.includes('【复核模式 · 已触发】'), `exit=${r18.status}`);

// ⑲–㉖ 自进化采集触发（2026-11-02）：只提醒不拦截；正例三族，负例四类
const EVO_MARK = '【自进化采集 · 本轮疑似纠正/长期偏好】';
const evoCase = (label, prompt, expected) => {
  const r = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
  let c = '';
  try { c = JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
  check(label, r.status === 0 && c.includes(EVO_MARK) === expected, `exit=${r.status} 命中=${c.includes(EVO_MARK)}`);
  return c;
};
evoCase('⑲ 长期偏好正例 → 追加自进化采集段', '以后所有回复都用简体中文', true);
evoCase('⑳ 重复纠正正例 → 追加自进化采集段', '你又没跑测试就宣布完成', true);
evoCase('㉑ 显式沉淀正例 → 追加自进化采集段', '把这条写进记忆：以后先跑测试再汇报', true);
evoCase('㉒ 单次任务约束负例 → 不追加', '不要修改任何文件，只读审阅后给建议', false);
evoCase('㉓ 普通请求负例 → 不追加', '修复一个按钮文案', false);
evoCase('㉔ 元提及负例 → 不追加', '当我说以后都别用缓存时你怎么处理', false);
evoCase('㉕ 引用规则原文负例 → 不追加', '规则里写着以后不要修改文件', false);
check('㉖ 空 stdin 静态第 10 条仍注入', ctx.includes('自进化采集') && ctx.includes('证据门槛'), '');

// ㉗–㉙ 变异对照：移除 evolutionNote 调用后正例提示必须消失；负例与原件逐字节一致
const EVO_MUT_DIR = path.join(SB, 'mutated-evolution');
fs.mkdirSync(EVO_MUT_DIR, { recursive: true });
for (const name of ['rules-reminder.js', 'client-root.js', 'hook-crash-guard.js', 'goal-candidate-core.js', 'recheck-protocol.cjs', 'verification-trigger-core.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(EVO_MUT_DIR, name));
}
const evoMutFile = path.join(EVO_MUT_DIR, 'rules-reminder.js');
const evoSource = fs.readFileSync(evoMutFile, 'utf8');
const evoMutated = evoSource.replace(' + evolutionNote(prompt)', '');
if (evoMutated !== evoSource) fs.writeFileSync(evoMutFile, evoMutated);
check('㉗ 变异体已移除自进化调用', evoMutated !== evoSource, evoMutated === evoSource ? '未找到可替换的调用点' : '');
const runEvoMut = (input) => spawnSync(process.execPath, [evoMutFile], {
  input,
  encoding: 'utf8',
  timeout: 15000,
  env: CHILD_ENV,
});
const evoPos = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '以后所有回复都用简体中文' });
const evoMutCtx = JSON.parse(runEvoMut(evoPos).stdout).hookSpecificOutput.additionalContext;
check('㉘ 变异对照：移除自进化调用后正例提示消失', !evoMutCtx.includes(EVO_MARK), '');
const evoNeg = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '修复一个按钮文案' });
const evoOrigCtx = JSON.parse(run(evoNeg).stdout).hookSpecificOutput.additionalContext;
const evoMutNegCtx = JSON.parse(runEvoMut(evoNeg).stdout).hookSpecificOutput.additionalContext;
check('㉙ 模式隔离：负例在原件与变异体逐字节一致', evoOrigCtx === evoMutNegCtx, `orig=${evoOrigCtx.length} mut=${evoMutNegCtx.length}`);

// ㉚–㉞ B05 自动选档触发（2026-11-03 并入 rules-reminder）
const B05_MARK = '【B05 自动选档 · 已触发】';
const b05Case = (label, prompt, expected) => {
  const r = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
  let c = '';
  try { c = JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
  check(label, r.status === 0 && c.includes(B05_MARK) === expected, `exit=${r.status} 命中=${c.includes(B05_MARK)}`);
  return c;
};
b05Case('㉚ 可执行任务 → 追加 B05 选档提示', '实现用户导出功能', true);
b05Case('㉛ 状态问句 → 不追加', '现在多段检测机制，是否已经在本机生效', false);
b05Case('㉜ 请求式问句 → 追加', '是否可以给 B05 加个开关', true);
b05Case('㉝ 琐碎小改 → 不追加', '修复一个按钮文案并提交', false);
const vCfg = path.join(HOME, '.qoder', 'verification-trigger.json');
fs.mkdirSync(path.dirname(vCfg), { recursive: true });
fs.writeFileSync(vCfg, JSON.stringify({ enabled: false }));
b05Case('㉞ 开关关闭 → 不追加', '实现用户导出功能', false);
fs.rmSync(vCfg);
const vLog = path.join(HOME, '.qoder', 'tmp', 'verification-trigger', 'decisions.log');
const vLogText = fs.existsSync(vLog) ? fs.readFileSync(vLog, 'utf8') : '';
check('㉟ 决策日志记录判定且不含请求原文', /\|TRIGGER\|/.test(vLogText) && !vLogText.includes('用户导出'), `exists=${fs.existsSync(vLog)}`);

// ㊱–㊳ B05 变异对照：移除 verificationNote 调用后正例提示消失；负例与原件逐字节一致
const B05_MUT_DIR = path.join(SB, 'mutated-b05');
fs.mkdirSync(B05_MUT_DIR, { recursive: true });
for (const name of ['rules-reminder.js', 'client-root.js', 'hook-crash-guard.js', 'goal-candidate-core.js', 'recheck-protocol.cjs', 'verification-trigger-core.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(B05_MUT_DIR, name));
}
const b05MutFile = path.join(B05_MUT_DIR, 'rules-reminder.js');
const b05Source = fs.readFileSync(b05MutFile, 'utf8');
const b05Mutated = b05Source.replace(' + verificationNote(prompt)', '');
if (b05Mutated !== b05Source) fs.writeFileSync(b05MutFile, b05Mutated);
check('㊱ 变异体已移除 B05 调用', b05Mutated !== b05Source, b05Mutated === b05Source ? '未找到可替换的调用点' : '');
const runB05Mut = (input) => spawnSync(process.execPath, [b05MutFile], {
  input,
  encoding: 'utf8',
  timeout: 15000,
  env: CHILD_ENV,
});
const b05Pos = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '实现用户导出功能' });
const b05MutCtx = JSON.parse(runB05Mut(b05Pos).stdout).hookSpecificOutput.additionalContext;
check('㊲ 变异对照：移除 B05 调用后正例提示消失', !b05MutCtx.includes(B05_MARK), '');
const b05Neg = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '现在多段检测机制，是否已经在本机生效' });
const b05OrigCtx = JSON.parse(run(b05Neg).stdout).hookSpecificOutput.additionalContext;
const b05MutNegCtx = JSON.parse(runB05Mut(b05Neg).stdout).hookSpecificOutput.additionalContext;
check('㊳ 模式隔离：B05 负例在原件与变异体逐字节一致', b05OrigCtx === b05MutNegCtx, `orig=${b05OrigCtx.length} mut=${b05MutNegCtx.length}`);

const TOOL_RESEARCH_MARK = '【主动联网查证】';
const TOOL_ACQUIRE_MARK = '【工具获取 · 安装先询问】';
// ㊱–㊳ 开工确认：执行任务注入绑定与台账；纯问答/显式跳过不注入
const kickoffPrompt = '修复登录按钮的文案';
const kickoffRun = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'kickoff-sid', cwd: process.cwd(), prompt: kickoffPrompt }));
const kickoffCtx = JSON.parse(kickoffRun.stdout).hookSpecificOutput.additionalContext;
check('㊱ 执行任务注入开工确认块与台账绑定',
  kickoffCtx.includes('KICKOFF_BINDING') && kickoffCtx.includes('KICKOFF_COMPOSE_COMMAND') && kickoffCtx.includes('开工确认'),
  '');
check('㊱b 注入块要求收尾前完成出卡与 record 闭环',
  kickoffCtx.includes('收尾前完成') && kickoffCtx.includes('record') && kickoffCtx.includes('未确认前不写入'),
  '');
const kickoffFile = path.join(HOME, '.qoder', 'tmp', 'kickoff', 'pending-kickoff-sid.json');
check('㊲ 开工确认台账已创建且不存原文',
  fs.existsSync(kickoffFile) && !fs.readFileSync(kickoffFile, 'utf8').includes(kickoffPrompt),
  '');
const kickoffQuestion = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'kickoff-q', cwd: process.cwd(), prompt: '这个函数是做什么的？' }));
const kickoffQuestionCtx = JSON.parse(kickoffQuestion.stdout).hookSpecificOutput.additionalContext;
check('㊳ 纯问答不注入开工确认块', !kickoffQuestionCtx.includes('KICKOFF_BINDING'), '');
const kickoffSkip = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'kickoff-skip', cwd: process.cwd(), prompt: '直接做，不用确认，改个文案' }));
const kickoffSkipCtx = JSON.parse(kickoffSkip.stdout).hookSpecificOutput.additionalContext;
check('㊴ 用户显式跳过确认不注入绑定', !kickoffSkipCtx.includes('KICKOFF_BINDING'), '');
// 分享包安装时选择"不常驻"：自动注入停用，但提醒本体保持原样
const kickoffPref = path.join(HOME, '.qoder', 'kickoff-preference.json');
fs.writeFileSync(kickoffPref, JSON.stringify({ schema: 1, resident: false }));
const kickoffDisabled = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'kickoff-disabled', cwd: process.cwd(), prompt: kickoffPrompt }));
let kickoffDisabledCtx = '';
try { kickoffDisabledCtx = JSON.parse(kickoffDisabled.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('㊵ 安装选择不常驻后不再自动注入开工确认',
  kickoffDisabled.status === 0 && !kickoffDisabledCtx.includes('KICKOFF_BINDING') && kickoffDisabledCtx.includes('简体中文'),
  `exit=${kickoffDisabled.status}`);
fs.unlinkSync(kickoffPref);

const toolingCase = (label, prompt, expected) => {
  const result = run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
  let context = '';
  try { context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
  const instructions = context.split('\n【本轮请求摘要 · 可能截断，完整用户消息为准】')[0];
  check(label, result.status === 0 && instructions.includes(TOOL_RESEARCH_MARK) === expected, `exit=${result.status}`);
  return instructions;
};
const toolingContext = toolingCase('联网查证：主动搜索与工具获取正例', '主动联网搜索官方资料，核对下载工具的来源', true);
for (const prompt of [
  '查询框架最新稳定版本及版本兼容',
  '缺少代码格式化工具，寻找可用工具',
  '请查官方文档解释发布资产校验',
  'command not found, find the official docs',
]) toolingCase('联网查证正例：' + prompt, prompt, true);
for (const prompt of [
  '修复一个按钮文案',
  '修复文件下载按钮的文案',
  '当我说联网搜索时你如何处理',
  '规则里要求联网搜索官方资料',
  '把“下载工具”替换为“获取助手”',
  '把“【主动联网查证】”几个字删掉',
  '只用本地资料核对官方文档，不要联网',
  'offline only: check official docs',
  '解释这段日志：\n```text\ncommand not found\n```',
]) toolingCase('联网查证负例：' + prompt, prompt, false);
const readOnlyResearch = toolingCase('只读查证不追加下载建议', '只读联网查官方文档，不下载任何工具', true);
check('只读查证保持零下载边界', !readOnlyResearch.includes(TOOL_ACQUIRE_MARK));
const noDownloadResearch = toolingCase('禁止下载仍可执行获准查证', '联网查询工具缺口，但不要下载工具', true);
check('禁止下载不追加工具获取建议', !noDownloadResearch.includes(TOOL_ACQUIRE_MARK));
const toolingBoundaries = ['下载不等于执行授权', 'AskUserQuestion', '长期复用获准后', '不改变平台权限'];
check('工具获取提示包含安装询问、长期留存与平台边界', toolingBoundaries.every(value => toolingContext.includes(value)));
check('工具获取边界断言可失败', !toolingBoundaries.every(value => toolingContext.replace('下载不等于执行授权', '').includes(value)));

const TOOL_MUT_DIR = path.join(SB, 'mutated-tooling');
fs.mkdirSync(TOOL_MUT_DIR, { recursive: true });
for (const name of ['rules-reminder.js', 'client-root.js', 'hook-crash-guard.js', 'goal-candidate-core.js', 'recheck-protocol.cjs', 'verification-trigger-core.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(TOOL_MUT_DIR, name));
}
const toolMutFile = path.join(TOOL_MUT_DIR, 'rules-reminder.js');
const toolSource = fs.readFileSync(toolMutFile, 'utf8');
const toolMutated = toolSource.replace(' + toolResearchNote(prompt)', '');
if (toolMutated !== toolSource) fs.writeFileSync(toolMutFile, toolMutated);
check('联网查证变异体已移除实际调用', toolMutated !== toolSource);
const runToolMut = input => spawnSync(process.execPath, [toolMutFile], {
  input, encoding: 'utf8', timeout: 15000,
  env: CHILD_ENV,
});
const toolPositive = JSON.stringify({ prompt: '主动联网搜索官方资料，核对下载工具的来源' });
const toolMutResult = runToolMut(toolPositive);
let toolMutContext = '';
try { toolMutContext = JSON.parse(toolMutResult.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('移除联网查证调用后正例提示必须消失', toolMutResult.status === 0 && !toolMutContext.includes(TOOL_RESEARCH_MARK));
const toolNegative = JSON.stringify({ prompt: '修复一个按钮文案' });
const toolOriginalNegative = run(toolNegative), toolMutatedNegative = runToolMut(toolNegative);
check('联网查证非触发轮与变异体逐字节一致', toolOriginalNegative.status === 0 && toolMutatedNegative.status === 0 && toolOriginalNegative.stdout === toolMutatedNegative.stdout);

// 含混请求的确定性注入：命中必须点名并要求给备选，明确请求必须不命中（同批负对照）。
const ambiguous = run(JSON.stringify({ prompt: '帮我优化一下' }));
let ambiguousCtx = '';
try { ambiguousCtx = JSON.parse(ambiguous.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('含混请求 → 注入规则初筛并要求模型判别与备选',
  ambiguous.status === 0 && ambiguousCtx.includes('【需求含混 · 规则初筛命中（高）】') && ambiguousCtx.includes('模型判别') && ambiguousCtx.includes('AskUserQuestion') && ambiguousCtx.includes('2–4 个真实备选') && ambiguousCtx.includes('提示词纠正') && ambiguousCtx.includes('/clarify'));
const selfUnclearReq = run(JSON.stringify({ prompt: '恢复用户指令不清，提示词纠正提示推荐能力' }));
let selfUnclearCtx = '';
try { selfUnclearCtx = JSON.parse(selfUnclearReq.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('显式指令不清 → 注入提示词纠正推荐且不构成执行授权',
  selfUnclearReq.status === 0 && selfUnclearCtx.includes('【需求含混 · 规则初筛命中（高）】') && selfUnclearCtx.includes('显式指令不清') && selfUnclearCtx.includes('提示词纠正') && selfUnclearCtx.includes('不构成执行授权'));
const clearReq = run(JSON.stringify({ prompt: '把 src/auth.ts 的 login 改成返回 401' }));
let clearCtx = '';
try { clearCtx = JSON.parse(clearReq.stdout).hookSpecificOutput.additionalContext || ''; } catch {}
check('明确请求 → 不注入含混提示', clearReq.status === 0 && !clearCtx.includes('【需求含混'));

function runChunked(input, split) {
  return new Promise(resolve => {
    const source = `process.stdin.once('data', () => process.stderr.write('CHUNK_READY')); require(${JSON.stringify(SCRIPT)});`;
    const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, USERPROFILE: HOME, HOME } });
    let stdout = '', stderr = '', error = null, sent = false;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (!sent && stderr.includes('CHUNK_READY')) {
        sent = true;
        child.stdin.end(input.subarray(split));
      }
    });
    child.on('error', value => { error = value.message; });
    child.stdin.on('error', value => { error = value.message; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, error, sent });
    });
    child.stdin.write(input.subarray(0, split));
  });
}

(async () => {
  try {
    for (const field of ['prompt', 'user_prompt']) {
      const prompt = '请再次检查是否有遗漏';
      const input = Buffer.from(JSON.stringify({ [field]: prompt }));
      const whole = run(input);
      for (const bytes of [1, 2]) {
        const split = input.indexOf(Buffer.from('再')) + bytes;
        const chunked = await runChunked(input, split);
        check(`UTF-8分块 ${field} 首字${bytes}字节后断开`,
          whole.status === 0 && chunked.status === 0 && !chunked.signal && !chunked.error && chunked.sent &&
          chunked.stdout === whole.stdout && chunked.stdout.includes('【复核模式 · 已触发】') && chunked.stdout.includes(prompt),
          `whole=${whole.status} chunked=${chunked.status} signal=${chunked.signal} error=${chunked.error}`);
      }
    }
  } finally {
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  }
  console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
