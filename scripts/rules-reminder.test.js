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

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

const run = (input) => spawnSync(process.execPath, [SCRIPT], {
  input,
  encoding: 'utf8',
  timeout: 15000,
  env: { ...process.env, USERPROFILE: HOME, HOME },
});

const MARKERS = ['简体中文', '不随意停止', '需拍板', '验证要能失败', '先备份', '先只读预览命中范围', '明确结论', 'Vibecoding 两问', '目标模式', '过程落盘', '领域与流程纪律', '自进化采集'];
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

// ⑩⑪ 抑制提醒（2026-10-27）：门禁因滑动窗上限放行时必须让"这一段在放行"可见，且同批只提醒一次
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
check('⑩ 有抑制放行记录 → 必须提醒一次并带规则计数',
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
for (const name of ['rules-reminder.js', 'client-root.js', 'hook-crash-guard.js', 'recheck-protocol.cjs']) {
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
  env: { ...process.env, USERPROFILE: HOME, HOME },
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
for (const name of ['rules-reminder.js', 'client-root.js', 'hook-crash-guard.js', 'recheck-protocol.cjs']) {
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
  env: { ...process.env, USERPROFILE: HOME, HOME },
});
const evoPos = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '以后所有回复都用简体中文' });
const evoMutCtx = JSON.parse(runEvoMut(evoPos).stdout).hookSpecificOutput.additionalContext;
check('㉘ 变异对照：移除自进化调用后正例提示消失', !evoMutCtx.includes(EVO_MARK), '');
const evoNeg = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '修复一个按钮文案' });
const evoOrigCtx = JSON.parse(run(evoNeg).stdout).hookSpecificOutput.additionalContext;
const evoMutNegCtx = JSON.parse(runEvoMut(evoNeg).stdout).hookSpecificOutput.additionalContext;
check('㉙ 模式隔离：负例在原件与变异体逐字节一致', evoOrigCtx === evoMutNegCtx, `orig=${evoOrigCtx.length} mut=${evoMutNegCtx.length}`);

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
