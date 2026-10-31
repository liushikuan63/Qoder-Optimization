#!/usr/bin/env node
// stop-gate 离线用例：每条违规都要有"植入必红 + 对照组必绿"，缺一律算失败。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GATE = path.join(__dirname, 'stop-gate.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-test-'));

function transcript(lines) {
  const f = path.join(ROOT, 't-' + Math.random().toString(36).slice(2) + '.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f.replace(/\\/g, '/');
}
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
let toolId = 0;
const tool = (name, input, result = 'ok', failed = false) => {
  const id = 'tool-' + ++toolId;
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: failed }] } },
  ].map((x) => JSON.stringify(x)).join('\n');
};
const asst = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

function run(payload, session, extraEnv = {}) {
  payload = { cwd: ROOT, task_id: 'stopgate-test', ...payload };
  const stateDir = path.join(ROOT, 'state-' + session);
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [GATE], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: ROOT, USERPROFILE: ROOT, HOOK_CRASH_LOG: path.join(ROOT, 'crash.log'), STOP_GATE_STATE_DIR: stateDir }, extraEnv),
    });
  } catch (e) {
    out = (e.stdout || '') + '';
    code = e.status === undefined ? -1 : e.status;
  }
  let decision = 'allow';
  try {
    const j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}');
    if (j.decision === 'block') decision = 'block';
  } catch (e) {
    if (out.trim()) decision = 'bad-json';
  }
  return { decision, out: out.trim(), code };
}

let n = 0;
const results = [];
function check(name, got, want) {
  n++;
  const ok = got === want;
  results.push((ok ? 'PASS ' : 'FAIL ') + name + ' [' + name.split(' ')[0] + '] got=' + got + ' want=' + want);
  return ok;
}

// R1 停手等待
const r1 = '本轮 B13 国战批次先做到这里，剩下的待办我列在文档里了。要继续下一格吗？';
check('R1 违规必须拦', run({ last_assistant_message: r1, session_id: 'a1' }, 'a1').decision, 'block');
// 旧用例写的是「stop_hook_active 就放行（防死循环）」——那正是缺陷本体：
// 被拦一次之后的所有收尾全部免检，2026-09-20 那次五格长回合就是这么停住的。
// 防死循环改由滑动窗负责（见文件末尾那两条窗口用例），所以这里必须仍是 block。
check(
  'R1 续停仍要判：防死循环交给滑动窗，不再整体免检',
  run({ last_assistant_message: r1, stop_hook_active: true, session_id: 'a2' }, 'a2').decision,
  'block',
);

// R2 裁决未弹窗
const r2 = '这里有三个口径需要裁决：皮肤出售是回收金币还是钻石，需要你拍板后我再继续。';
const trNoAsk = transcript([user('按文档继续'), tool('Edit', { file_path: 'D:/x/y.ts' }), asst(r2)]);
const trWithAsk = transcript([
  user('按文档继续'),
  tool('AskUserQuestion', { questions: [] }),
  asst('弹窗已给出，我按推荐项继续做 B14。'),
]);
check('R2 违规必须拦', run({ last_assistant_message: r2, transcript_path: trNoAsk, session_id: 'b1' }, 'b1').decision, 'block');
check('R2 对照组：本轮已弹窗则放行', run({ transcript_path: trWithAsk, session_id: 'b2' }, 'b2').decision, 'allow');
// 2026-10-27 降噪：已经给出默认处置并继续推进的，不算"停下来等裁决"
const r2resolved = '配色口径需要你确认，我先按推荐项继续推进，A 部分已经做完。';
check('R2 对照组：已按推荐项继续推进则放行', run({ last_assistant_message: r2resolved, session_id: 'b3' }, 'b3').decision, 'allow');
// 2026-10-27 收窄：高风险动作的确认仍要弹窗；内部口径（命名/文案）不该被当成裁决
check('R2 正例：确认部署窗口仍必须弹窗',
  run({ last_assistant_message: '部署窗口需要你确认一下，确认后我就推。', session_id: 'b4' }, 'b4').decision, 'block');
check('R2 对照组：变量命名确认不算裁决',
  run({ last_assistant_message: '变量命名需要你确认一下用 userCount 还是 userTotal。', session_id: 'b5' }, 'b5').decision, 'allow');

// R3 前台无证据
const r3 = '主城界面的排版已全部完成，按钮和面板显示正确，这块功能正常。';
const r3ok = '主城界面的排版已完成，真机模拟器截图见 build/art-verify/city-runtime.png，与预期比对一致。';
check('R3 违规必须拦', run({ last_assistant_message: r3, session_id: 'c1' }, 'c1').decision, 'block');
const screenshot = path.join(ROOT, 'runtime.png');
fs.writeFileSync(screenshot, Buffer.from('89504e470d0a1a0a', 'hex'));
const screenshotTools = tool('mcp_call', { toolName: 'mcp__browser-use__take_screenshot', arguments: {} }, screenshot);
check('R3 对照组：成功截图及比对证据放行', run({ last_assistant_message: r3ok, transcript_path: transcript([user('修复页面'), screenshotTools, asst(r3ok)]), session_id: 'c2' }, 'c2').decision, 'allow');
const r3backend = '后端契约测试已全部完成，全绿，接口返回符合预期。';
check('R3 对照组：纯后端完成语不拦', run({ last_assistant_message: r3backend, session_id: 'c3' }, 'c3').decision, 'allow');
// 2026-09-19 补：跨句共现误报修复——主张词与 UI 词须同句（旧逻辑会把两句拼成误报）
const r3cross = '全部完成，三重门禁通过。领域节同步：前端规则的条目更新与技能名修正。';
check('R3 对照组：跨句拼接不算前台主张', run({ last_assistant_message: r3cross, session_id: 'c4' }, 'c4').decision, 'allow');
// 2026-09-19 补：限制必须使用主张词——有 UI 词但无主张词绝不拦
const r3nounclaim = '主城界面的排版布局与按钮样式见 build 目录下的方案文档，细节都写在文档里。';
check('R3 对照组：无主张词不拦（主张词是必要条件）', run({ last_assistant_message: r3nounclaim, session_id: 'c5' }, 'c5').decision, 'allow');
// 2026-10-27 补：引用规则原文不算自己的交付主张（复盘时真实踩过；R1/R2 早已剥离引用，R3 漏了）
const r3quoted = '这次误报的根因是：旧判据只要「界面已完成」同句共现就放行，而我只复述了规则例子。';
check('R3 对照组：引号内引用规则原文不拦', run({ last_assistant_message: r3quoted, session_id: 'c6' }, 'c6').decision, 'allow');
// 2026-10-27 补：改动面驱动——本轮真改了前端文件，正文不出现界面词也要证据
const trEditVue = transcript([
  user('把登录页的按钮改一下'),
  tool('Edit', { file_path: 'D:/proj/src/Login.vue' }),
  asst('改动已完成，接口联调也过了。'),
]);
check('R3 改动面：改了前端文件且声称完成必须拦', run({ last_assistant_message: '改动已完成，接口联调也过了。', transcript_path: trEditVue, session_id: 'c7' }, 'c7').decision, 'block');
const trEditVueShot = transcript([
  user('把登录页的按钮改一下'),
  tool('Edit', { file_path: 'D:/proj/src/Login.vue' }),
  screenshotTools,
  asst('改动已完成：截图见 runtime.png，按钮样式显示正常。'),
]);
check('R3 改动面对照组：有本轮截图则放行', run({ last_assistant_message: '改动已完成：截图见 runtime.png，按钮样式显示正常。', transcript_path: trEditVueShot, session_id: 'c8' }, 'c8').decision, 'allow');

// R9 主张-证据交叉核对（2026-10-27 新增）
const r9text = '单测跑完了，测试全绿，构建成功。';
const trR9fail = transcript([user('修一下'), tool('Bash', { command: 'npm test' }, 'FAIL 3 tests', true), asst(r9text)]);
const trR9none = transcript([user('修一下'), tool('Bash', { command: 'ls src' }, 'a.ts'), asst(r9text)]);
const trR9ok = transcript([user('修一下'), tool('Bash', { command: 'npm test' }, 'PASS 42 tests'), asst(r9text)]);
check('R9 违规必须拦：只有失败的测试记录', run({ last_assistant_message: r9text, transcript_path: trR9fail, session_id: 'f1' }, 'f1').decision, 'block');
check('R9 违规必须拦：本轮没跑过测试/构建', run({ last_assistant_message: r9text, transcript_path: trR9none, session_id: 'f2' }, 'f2').decision, 'block');
check('R9 对照组：本轮成功跑过测试则放行', run({ last_assistant_message: r9text, transcript_path: trR9ok, session_id: 'f3' }, 'f3').decision, 'allow');
check('R9 对照组：纯讨论（无 Bash 调用）不拦', run({ last_assistant_message: r9text, session_id: 'f4' }, 'f4').decision, 'allow');
const r9declared = '本轮没有运行测试，历史 CI 的结果是全绿，未验证本机改动。';
const trR9declared = transcript([user('看一下'), tool('Bash', { command: 'ls' }), asst(r9declared)]);
check('R9 对照组：已显式声明未运行则放行', run({ last_assistant_message: r9declared, transcript_path: trR9declared, session_id: 'f5' }, 'f5').decision, 'allow');
// 本仓库的套件形态是 `node xxx.test.js`，不能只认 `node --test`
const trR9script = transcript([user('跑一下套件'), tool('Bash', { command: 'node ~/.qoder/scripts/stop-gate.test.js' }, '89/89 passed'), asst(r9text)]);
check('R9 对照组：node *.test.js 也算本轮的测试证据', run({ last_assistant_message: r9text, transcript_path: trR9script, session_id: 'f6' }, 'f6').decision, 'allow');
for (const [index, command] of [
  '"C:/Program Files/nodejs/node.exe" --test scripts/verification-session.test.js',
  "'C:/Program Files/nodejs/node.exe' 'D:/test suite/example.test.cjs'",
  '"C:\\Program Files\\nodejs\\node.exe" --test scripts/verification-session.test.js',
  'node.exe --test scripts/verification-session.test.js',
  'node .github/run-tests.js',
  '"C:/Program Files/nodejs/node.exe" .github/run-tests.js',
  "TEMP='D:/temp path' TMP='D:/temp path' \"C:/Program Files/nodejs/node.exe\" .github/run-tests.js > logs.txt 2>&1; result=$?; exit \"$result\"",
  'env NO_COLOR=1 /usr/bin/node /work/.github/run-tests.js',
  'true && "C:/Program Files/nodejs/node.exe" .github/run-tests.js',
  'node --test scripts/example.test.js && node --version',
  'node --test scripts/example.test.js > "log;name.txt" 2>&1; status=$?; exit "$status"',
].entries()) {
  const id = 'r9-node-' + index;
  const accepted = transcript([user('执行回归'), tool('Bash', { command }, 'TEST_EXIT=0'), asst(r9text)]);
  const rejected = transcript([user('执行回归'), tool('Bash', { command }, 'Exit code 1\nTEST_EXIT=1', true), asst(r9text)]);
  check('R9 Node命令成功可识别 ' + index, run({ transcript_path: accepted, session_id: id + '-ok' }, id + '-ok').decision, 'allow');
  check('R9 Node命令失败不放行 ' + index, run({ transcript_path: rejected, session_id: id + '-fail' }, id + '-fail').decision, 'block');
}
for (const [index, command] of [
  'echo "node --test scripts/example.test.js"',
  "printf '%s' 'node .github/run-tests.js'",
  'node --eval "console.log(\'node --test example.test.js\')"',
  'node --check scripts/verification-session.cjs',
  'node --test --help',
  "cat <<'EOF'\nnode --test scripts/example.test.js\nEOF",
  'true || node --test scripts/example.test.js',
  'false && node .github/run-tests.js; true',
  'node --test scripts/example.test.js || true',
  'node .github/run-tests.js; true',
  'exit 0; node --test scripts/example.test.js',
  'exit 0 && node --test scripts/example.test.js',
  'if false; then node --test scripts/example.test.js; fi',
  'node --test scripts/example.test.js &',
  'node --test scripts/example.test.js | true',
  'node .github/run-tests.js <<END || true\nEND',
].entries()) {
  const id = 'r9-node-no-run-' + index;
  const file = transcript([user('执行回归'), tool('Bash', { command }, 'command exited 0'), asst(r9text)]);
  check('R9 未执行的Node测试文本不放行 ' + index, run({ transcript_path: file, session_id: id }, id).decision, 'block');
}
for (const [index, command] of [
  'true # && "C:/Program Files/nodejs/node.exe" --test scripts/example.test.js',
  ": 'npm test'",
  'true || npm test',
  'npm test || true',
  'node --test scripts/jest.test.js || true',
  'printf "%s" "pytest"',
  "cat <<'EOF'\nnpm test\nEOF",
  'exit 0 && npm test',
  'echo ready && exit 0 && npm test',
  "e''xit 0 && node scripts/example.test.js",
  'ex"it" 0 && node scripts/example.test.js',
  'node --test --help=1 scripts/example.test.js',
  'node --test --version=1 scripts/example.test.js',
  'set -n && node --test scripts/example.test.js',
  'command exit 0 && node --test scripts/example.test.js',
  'mvn test -v',
  'tsc -v',
  'npm ci',
  'mvn clean',
  'true # && mvn test',
  'npm test &',
  'mvn test | true',
].entries()) {
  const id = 'r9-command-boundary-' + index;
  const file = transcript([user('执行回归'), tool('Bash', { command }, 'command exited 0'), asst(r9text)]);
  check('R9 注释与旁路文本不作证据 ' + index, run({ transcript_path: file, session_id: id }, id).decision, 'block');
}
for (const [index, command] of [
  'npm test # && ignored',
  'node --test scripts/example.test.js # trailing comment',
  'env NO_COLOR=1 npm test',
  'true && npm test',
  'npm test && node --version',
  'npm test > "test;log.txt" 2>&1; status=$?; exit "$status"',
  '"C:/tools/npm.cmd" run build',
  'mvn --batch-mode verify',
  'mvn clean compile',
  './gradlew check',
  'python -m pytest',
  'go test ./...',
  'go test -v ./...',
  'pytest -v',
  'python -m pytest -v',
  'cargo test',
  'cargo test -v',
  'dotnet build',
  'dotnet build -v minimal',
].entries()) {
  const id = 'r9-valid-command-' + index;
  for (const failed of [false, true]) {
    const file = transcript([user('执行回归'), tool('Bash', { command }, failed ? 'Exit code 1' : 'command exited 0', failed), asst(r9text)]);
    check('R9 合法命令按结果判定 ' + index + '/' + failed, run({ transcript_path: file, session_id: id + failed }, id + failed).decision, failed ? 'block' : 'allow');
  }
}

for (const claim of ['测试通过。', '测试全绿']) {
  for (const [command, expected] of [['node --test scripts/example.test.js', 'allow'], ['true # && node --test scripts/example.test.js', 'block']]) {
    const id = 'r9-short-' + ++toolId;
    const file = transcript([user('执行回归'), tool('Bash', { command }, 'command exited 0'), asst(claim)]);
    check('R9 短回复也按证据核验 ' + id, run({ transcript_path: file, session_id: id }, id).decision, expected);
  }
}
check('R3 短界面完成主张仍需证据', run({ last_assistant_message: 'UI已完成', session_id: 'short-ui' }, 'short-ui').decision, 'block');
check('R5 短踢皮球回复仍须主张', run({ last_assistant_message: '都行', session_id: 'short-stance' }, 'short-stance').decision, 'block');
for (const [claim, expected] of [['测试没通过。', 'allow'], ['测试没通过，但构建成功。', 'block']]) {
  const id = 'r9-failure-' + ++toolId;
  const file = transcript([user('执行回归'), tool('Bash', { command: 'npm test' }, 'FAIL', true), asst(claim)]);
  check('R9 失败表述不误作成功 ' + id, run({ transcript_path: file, session_id: id }, id).decision, expected);
}
for (const [claim, expected] of [
  ['测试没有不通过的。', 'block'], ['测试无一不通过。', 'block'], ['测试并非没通过。', 'block'], ['测试不是没通过。', 'block'], ['没有任何测试不通过。', 'block'], ['构建没有不成功的。', 'block'],
  ['测试不是通过了吗？', 'block'], ['难道测试没通过', 'block'],
  ['测试不是全部通过。', 'allow'], ['测试没有完全通过。', 'allow'], ['测试无法通过。', 'allow'], ['测试未完全通过。', 'allow'], ['测试不全是通过的。', 'allow'], ['测试都没通过，构建不成功。', 'allow'],
]) {
  const id = 'r9-negation-' + ++toolId;
  const file = transcript([user('执行回归'), tool('Bash', { command: 'npm test' }, 'FAIL', true), asst(claim)]);
  check('R9 双重否定仍是成功主张、失败说法不误拦 ' + id + ' ' + claim, run({ transcript_path: file, session_id: id }, id).decision, expected);
}
for (const [claim, expected] of [
  ['无头测试没通过。', 'allow'],
  ['非阻塞测试未通过。', 'allow'],
  ['不稳定测试没有通过。', 'allow'],
  ['未缓存的构建不成功。', 'allow'],
  ['测试没通过、构建不成功。', 'allow'],
  ['测试没有通过且构建不成功。', 'allow'],
  ['无头测试没有不通过的。', 'block'],
  ['没有任何无头测试不通过。', 'block'],
  ['测试没通过、构建成功。', 'block'],
  ['测试没有通过、构建不是没成功。', 'block'],
]) {
  const id = 'r9-negation-scope-' + ++toolId;
  const file = transcript([user('执行回归'), tool('Bash', { command: 'npm test' }, 'FAIL', true), asst(claim)]);
  const result = run({ transcript_path: file, session_id: id }, id);
  check('R9 否定作用域入口正常退出 ' + id, result.code, 0);
  check('R9 修饰词与并列结果 ' + id + ' ' + claim, result.decision, expected);
  if (expected === 'block') check('R9 否定作用域由R9拦截 ' + id, result.out.includes('R9-claim-without-run'), true);
}

// R4 用户纠偏未落记忆
const corr = '又停了？跟你说过不要停止任务，直接给弹窗让我选。';
const r4 = '上面两个点等你确认后我再动手，这里先收尾。';
const trR4bad = transcript([user(corr), tool('Bash', { command: 'ls' }), asst(r4)]);
const r4okText = '你这条要求已经写进记忆和规则了，我接着做上一格没做完的部分。';
const trR4ok = transcript([
  user(corr),
  tool('Write', { file_path: '<用户目录>/x/.qoder/memory/feedback-x.md' }),
  asst(r4okText),
]);
check('R4 违规必须拦', run({ last_assistant_message: r4, transcript_path: trR4bad, session_id: 'd1' }, 'd1').decision, 'block');
check('R4 对照组：本轮已写记忆则放行', run({ transcript_path: trR4ok, session_id: 'd2' }, 'd2').decision, 'allow');

// R5 无主张踢皮球（窄条件：踢皮球句式 + 无主张词）
const r5a = '两个方案各有优劣，看你要哪个。';
const r5b = 'A 和 B 的实现都写在附件里了，您决定。';
const r5ok1 = '我的判断是用方案 A（成本低、回退快）；B 留作备选，你确认下就行。';
const r5ok2 = '两条路都行，但我建议先走 A，理由见上。';
check('R5 违规必须拦：踢皮球且无主张', run({ last_assistant_message: r5a, session_id: 'e1' }, 'e1').decision, 'block');
check('R5 违规必须拦：您决定且无主张', run({ last_assistant_message: r5b, session_id: 'e2' }, 'e2').decision, 'block');
check('R5 对照组：有主张词则放行', run({ last_assistant_message: r5ok1, session_id: 'e3' }, 'e3').decision, 'allow');
check('R5 对照组：给了建议则放行（都行+我建议）', run({ last_assistant_message: r5ok2, session_id: 'e4' }, 'e4').decision, 'allow');

// 历史真实违规原文回放（tieshi 会话 line 11028，用户随后投诉"不应该弹窗提问不停止吗"）
const real11028 =
  '## 顺带推进的两格\n\n- A16 内城构图已提交推送。\n- CI 现在是红的，不是我这两格造成的。\n\n下一步待你定：**这条 CI 红要我接手修，还是留给并行那条线收口？** 不接的话我继续 A17。';
check(
  '真实历史违规文本必须拦',
  run({ last_assistant_message: real11028, transcript_path: transcript([user('继续'), tool('Bash', { command: 'mvn test' })]), session_id: 'g1' }, 'g1').decision,
  'block',
);

// 本轮真实误拦复刻：报告**正文里引用**历史违规原文当示例，结尾并没有抛回决策
const quotedExample =
  '门禁验证证据：' +
  '含**你投诉过的那句真实原文**回放（"下一步待你定：…还是留给并行那条线收口？"→ 拦）；' +
  '每类每会话拦 2 次后自动放行，异常一律 fail-open。' +
  '\n\n这一格四件套齐：测试 14/14 绿、文档已更、记忆已写、临时件已清，B 组体检脚本零输出。';
check(
  '引用示例不算收尾提问（真实误拦复刻）',
  run({ last_assistant_message: quotedExample, session_id: 'h1' }, 'h1').decision,
  'allow',
);
check(
  '同一短语落在结尾未引用仍要拦',
  run({ last_assistant_message: '这一格做完了。剩下的下一步待你定：要我接手还是留给另一条线？', session_id: 'h2' }, 'h2').decision,
  'block',
);

// 正常收尾 / 兜底
check(
  '正常收尾放行',
  run({ last_assistant_message: 'B13 批次全部做完：验证四件齐（测试全绿、启动 HTTP 验收、文档已更、记忆已写），本轮到此结束。', session_id: 'e1' }, 'e1').decision,
  'allow',
);
check('空 stdin 必须 exit 0 且不拦', run({}, 'e2').code, 0);
check('无 transcript 且无文本时放行', run({ transcript_path: ROOT + '/nope.jsonl', session_id: 'e3' }, 'e3').decision, 'allow');

// 同一会话同一规则最多拦 2 次
const s = 'f1';
const p = { last_assistant_message: r1, session_id: s };
const first = run(p, s).decision;
const second = run(p, s).decision;
const third = run(p, s).decision;
check('同类违规拦两次后放行（防死循环）', first + '/' + second + '/' + third, 'block/block/allow');

function runReport(session, days) {
  const stateDir = path.join(ROOT, 'state-' + session);
  try {
    return execFileSync(process.execPath, [GATE, '--report', String(days || 7)], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HOME: ROOT, USERPROFILE: ROOT, HOOK_CRASH_LOG: path.join(ROOT, 'crash.log'), STOP_GATE_STATE_DIR: stateDir }),
    });
  } catch (e) {
    return 'ERROR:' + (e.stdout || e.message);
  }
}
function ledgerLines(session) {
  try {
    return fs
      .readFileSync(path.join(ROOT, 'state-' + session, 'violations.log'), 'utf8')
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// 台账：命中要落行、放行不能落行、--report 汇总数要与行数一致
const led = 'ledger1';
run({ last_assistant_message: r1, session_id: led }, led);
run({ last_assistant_message: r3, session_id: led }, led);
// 第三条夹具必须是**真的干净收尾**：不含「下一步/下一格/接下来」这类"声明了却没做"的措辞，
// 也不指向未完成的工作。原来的夹具写的正是「我接着开下一格」—— 那是 R1b 该拦的形状，
// 所以那条期望（放行、台账只 2 行）在 R1b 上线当天就已经过期，而这份自测红了没人看见：
// 门禁自己的假绿比门禁不干活更危险（会把"守卫生效了"的信心建在错的证据上）。
run({
  last_assistant_message: '本批次已全部收完：验证、文档、提交、记忆四件套齐，记录都在台账里。',
  session_id: led,
}, led);
const lines = ledgerLines(led);
check('台账行数 = 命中次数（放行不落行）', lines.length, 2);
// 规则号形状：R1 / R1b / R6 / R7 都要认。原来写死的 `R\d-` 匹配不到 `R1b-…`，
// 于是这条判据在 R1b 上线那天就红了 —— 又被当成"门禁在跑"的证据看过很多轮。
check(
  '台账行字段自描述可解析',
  lines.every((l) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|R\d[a-z]?-[\w-]+\|sess=\w{1,8}\|hash=[0-9a-f]{8}\|len=\d+$/.test(l)),
  true,
);
check('台账不落的原文（只落哈希）', lines.every((l) => !l.includes('继续') && !l.includes('界面')), true);
// 第一条夹具（「要继续下一格吗？」）现在由 R1b 命中而不是 R1：R1b 在规则表里更靠前，
// 而它描述的正是这条文本的形状（声明了下一格却没做）。两者都拦，判据要跟上实际。
check('--report 汇总与行数一致',
  /近 7 天 2 条/.test(runReport(led)) && /1  R1b-declared-next-step-without-reason/.test(runReport(led)), true);
check('--report 台账缺失时有显式说明', /台账不存在|零命中|R\d-/.test(runReport('no-such-session')), true);

// —— 上限口径：从"每会话累计"改成"滑动时间窗"（2026-09-19）——
// 背景：本机一次"会话"能横跨几十个回合、好几天，累计上限（规则 2 / 会话 3）一打满，
// 门禁对剩下的回合**全部静默放行** —— 「声明下一步却没开工」连过好几轮没人拦就是这么来的。
const stepPayload = (sess) => ({
  hook_event_name: 'Stop',
  session_id: sess,
  last_assistant_message: '下一步：把 /equip/instances 接上，再写视图。',
});
check('旧口径的累计计数不再让门禁永久失效（滑动窗修复）', (() => {
  const sess = 'legacy-caps';
  const dir = path.join(ROOT, 'state-' + sess);
  fs.mkdirSync(dir, { recursive: true });
  // 旧状态：累计计数已打满，但没有时间戳 —— 修复后这些数字只作统计，不参与放行判定
  fs.writeFileSync(path.join(dir, sess + '.json'),
    JSON.stringify({ rules: { 'R1b-declared-next-step-without-reason': 2 }, total: 3 }));
  return run(stepPayload(sess), sess).decision;
})(), 'block');
check('窗口内的重复命中仍被压住，且停用会落一条 -SUPPRESSED 台账', (() => {
  const sess = 'window-cap';
  const first = run(stepPayload(sess), sess).decision;
  const second = run(stepPayload(sess), sess).decision;
  const third = run(stepPayload(sess), sess).decision;
  const ledgerText = fs.readFileSync(path.join(ROOT, 'state-' + sess, 'violations.log'), 'utf8');
  return [first, second, third, /-SUPPRESSED/.test(ledgerText)].join(',');
})(), 'block,block,allow,true');

// 输出挪到文件末尾（原来印在这里 ⇒ 后面新增的用例只被计数、看不见，红了也找不到是哪条）

// ---------- R6：工作队列（2026-09-20 之前这条**零覆盖**，于是它能静默失效一整晚）----------
// 队列文件是外部状态：判据不读我写的措辞，所以用例要自己造目录与文件。
function runWithCwd(payload, session, cwd) {
  payload = { task_id: 'stopgate-test', ...payload };
  const stateDir = path.join(ROOT, 'state-' + session);
  let out = '';
  try {
    out = execFileSync(process.execPath, [GATE], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd,
      env: Object.assign({}, process.env, { HOME: ROOT, USERPROFILE: ROOT, HOOK_CRASH_LOG: path.join(ROOT, 'crash.log'), STOP_GATE_STATE_DIR: stateDir }),
    });
  } catch (e) {
    out = (e.stdout || '') + '';
  }
  return out.trim();
}

const qDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-queue-'));
const qFile = path.join(qDir, '.qoder-work-queue.md');
const qEmptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-noqueue-'));
const DONE_TEXT = '结论：本轮五格已交付并逐格验证。';

function writeQueue(body) {
  fs.writeFileSync(qFile, '任务ID：stopgate-test\n' + body);
}

writeQueue('- [ ] 【本线】下一格：某条待办\n');
check('R6 违规必须拦（队列里有 - [ ]）',
  runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qDir, session_id: 'q1' }, 'q1')
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'block');

writeQueue('- [x] 【本线】某条待办已完成\n');
check('R6 对照组：全部划掉则放行',
  runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qDir, session_id: 'q2' }, 'q2')
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'allow');

writeQueue('- [~] 【本线】某条待办 —— 阻塞：等外部材料\n');
check('R6 对照组：标了"阻塞：理由"则放行',
  runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qDir, session_id: 'q3' }, 'q3')
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'allow');

writeQueue('- [~] 【本线】某条待办（没写为什么挡住）\n');
check('R6 违规必须拦：- [~] 却不写阻塞理由',
  runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qDir, session_id: 'q4' }, 'q4')
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'block');

// 本次修复①：stop_hook_active=true 以前**直接 return**，于是"被拦一次之后的所有收尾全部免检"
// —— 2026-09-20 那次五格长回合就是这么停住的。现在防死循环交给滑动窗上限。
writeQueue('- [ ] 【本线】下一格：某条待办\n');
check('续停不免检：stop_hook_active=true 且有未完成项仍要拦',
  runWithCwd({ hook_event_name: 'Stop', stop_hook_active: true,
    last_assistant_message: DONE_TEXT, cwd: qDir, session_id: 'q5' }, 'q5')
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'block');

// ---------- R6b：阻塞过期复核 ----------
// 2026-09-20 同一会话两次把能做的格子写成"等它干净"，而 `AppRoot.ts` 早在两小时前就被并行会话提交释放了。
// R6 只查"有没有写阻塞"，查不出"这条阻塞已经过期" —— 这一条补的就是那半截。
const rbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopgate-blocker-'));
function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: rbDir, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}
const rbGit = gitOk(['init', '-q']) && gitOk(['config', 'user.email', 't@example.invalid']) && gitOk(['config', 'user.name', 't']);
fs.mkdirSync(path.join(rbDir, 'client'), { recursive: true });
fs.writeFileSync(path.join(rbDir, 'client', 'Held.ts'), 'export const a = 1\n');
fs.writeFileSync(path.join(rbDir, 'client', 'Free.ts'), 'export const b = 1\n');
fs.writeFileSync(path.join(rbDir, '.qoder-work-queue.md'), '');
gitOk(['add', '-A']);
gitOk(['commit', '-q', '-m', 'base']);
fs.writeFileSync(path.join(rbDir, 'client', 'Held.ts'), 'export const a = 1\n// 并行会话正在写\n');

function rbVerdict(item, session) {
  fs.writeFileSync(path.join(rbDir, '.qoder-work-queue.md'), '任务ID：stopgate-test\n' + item);
  return runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: rbDir, session_id: session }, session)
    .includes('R6b-blocker-expired') ? 'block' : 'allow';
}

if (!rbGit) {
  console.log('SKIP  R6b 三条：这台机器上 git init 不可用，判据无法复核（跳过不等于通过）');
} else {
  check('R6b 必须拦：阻塞引用的文件其实干净（阻塞已过期）',
    rbVerdict('- [~] 【本线】某格 阻塞：另一会话正持有 client/Free.ts\n', 'rb1'), 'block');
  check('R6b 对照组①：引用的文件确实脏 ⇒ 放行',
    rbVerdict('- [~] 【本线】某格 阻塞：另一会话正持有 client/Held.ts\n', 'rb2'), 'allow');
  check('R6b 对照组②：还提到 git 查不了的条件（凭据）⇒ 不判、放行（宁可漏不误伤）',
    rbVerdict('- [~] 【本线】某格 阻塞：`client/Free.ts` 正被并行会话持有，且还要 ops 凭据\n', 'rb3'), 'allow');
  check('R6b 对照组③：路径紧贴全角冒号也要取得出来（否则判据静默失效）',
    rbVerdict('- [~] 【本线】某格 阻塞：另一会话持有 client/Free.ts\n', 'rb4'), 'block');
  check('R6b 必须拦：路径写在阻塞的下一行、且用裸名也要复核到（真实队列就是这个形状）',
    rbVerdict('- [~] 【本线】某格 阻塞：另一会话正持有该文件\n  详见 `client/Free.ts` 与 `Free.ts`\n', 'rb5'), 'block');
  check('R6b 对照组④：裸名指向的文件其实脏着 ⇒ 放行（这就是当初那条误伤的正解）',
    rbVerdict('- [~] 【本线】某格 阻塞：入口方案要动的 `Held.ts` 正被并行会话持有\n', 'rb6'), 'allow');
  check('R6b 对照组⑤：提到的文件在版本清单里找不到 ⇒ 整条不判（不许拿"查不到"当"已过期"）',
    rbVerdict('- [~] 【本线】某格 阻塞：另一会话正持有 client/DoesNotExist.ts\n', 'rb7'), 'allow');
  check('R6b 对照组⑥：阻塞与文件脏态无关（等数据产出）⇒ 不判、放行',
    rbVerdict('- [~] 【本线】某格 阻塞：新号没有装备实例，要跑通关卡才产出，见 `client/Free.ts`\n', 'rb8'), 'allow');
}

// ---------- R6 的"别人持有"豁免（一个 worktree 三条会话共用一份队列）----------
function r6Verdict(item, session) {
  writeQueue(item);
  return runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qDir, session_id: session }, session)
    .includes('R6-open-work-queue') ? 'block' : 'allow';
}

check('R6 豁免要认账：条目首行带 `【…持有】` 时不算本会话停手（别人正在写的活）',
  r6Verdict('- [ ] 【B26】**下一格** 【社交线会话持有 c81ebff+在途】：正在写申请名单\n', 'h1'), 'allow');
check('R6 对照组①：没有标记的 - [ ] 仍要拦（不许拿"不归我"当免检）',
  r6Verdict('- [ ] 【B26】下一格：这活不归我\n', 'h2'), 'block');
check('R6 对照组②：括号段里没有"会话"二字 ⇒ 不豁免（凭据必须点名是哪条会话）',
  r6Verdict('- [ ] 【B26】下一格 【别人持有 c81ebff】缺会话字样\n', 'h3'), 'block');
check('R6 对照组③：正文里提一句"持有"也不该把门关掉（只有条目首行的成对标记算数）',
  r6Verdict('- [ ] 【B26】下一格：这个文件对方正持有中，我去接\n', 'h4'), 'block');

// 本次修复②：hook 报的 cwd 不是项目根时，以前找不到队列就"返回 null = 放行"（假绿）。
// 现在按候选目录探测：input.cwd 没有、进程 cwd 有 ⇒ 仍要拦。
check('cwd 报错也拦得住：input.cwd 无队列但进程 cwd 有',
  runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qEmptyDir, session_id: 'q6' }, 'q6', qDir)
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'block');

check('R6 对照组：两处都没有队列才算"本项目无待办"',
  runWithCwd({ hook_event_name: 'Stop', last_assistant_message: DONE_TEXT, cwd: qEmptyDir, session_id: 'q7' }, 'q7', qEmptyDir)
    .includes('R6-open-work-queue') ? 'block' : 'allow', 'allow');

// 2026-10-27：没有队列文件的会话不能整条空转——本轮 TaskCreate 了却没 TaskUpdate 关掉的条目同样算待办。
const tlOpen = transcript([
  user('做两个修复'),
  tool('TaskCreate', { subject: '修 A' }),
  tool('TaskCreate', { subject: '修 B' }),
  asst('本轮就到这里。'),
]);
check('R6 队列兜底：本轮建了任务却没关掉必须拦',
  run({ last_assistant_message: '本轮就到这里。', transcript_path: tlOpen, session_id: 'q8', cwd: qEmptyDir }, 'q8').decision, 'block');
const tlDone = transcript([
  user('做两个修复'),
  tool('TaskCreate', { subject: '修 A' }),
  tool('TaskUpdate', { taskId: '1', status: 'completed' }),
  asst('两个都做完了。'),
]);
check('R6 队列兜底对照组：任务全部关闭则放行',
  run({ last_assistant_message: '两个都做完了。', transcript_path: tlDone, session_id: 'q9', cwd: qEmptyDir }, 'q9').decision, 'allow');
const tlReadonly = transcript([
  user('只读审阅当前规则，不要修改任何文件'),
  tool('TaskCreate', { subject: '读三份规则' }),
  asst('审阅结论：存在两处冲突。'),
]);
check('R6 队列兜底对照组：只读任务不因任务清单催办',
  run({ last_assistant_message: '审阅结论：存在两处冲突。', transcript_path: tlReadonly, session_id: 'q10', cwd: qEmptyDir }, 'q10').decision, 'allow');

const memoryDir = path.join(ROOT, '.qoder', 'memory');
fs.mkdirSync(memoryDir, { recursive: true });
const memoryFile = path.join(memoryDir, 'feedback-test.md');
fs.writeFileSync(memoryFile, '长期偏好');
fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- [偏好](feedback-test.md)\n');
function replay(label, prompt, answer, expected, tools = [], extra = {}) {
  const session = 'audit-' + n;
  check(label, run({ transcript_path: transcript([user(prompt), ...tools, asst(answer)]), session_id: session, ...extra }, session).decision, expected);
}
replay('R8 临时纠正不强制记忆', '这个方案不对，别这样做', '结论：采用另一方案。', 'allow');
replay('R8 普通重试不强制记忆', '请重新运行测试，不要写入记忆', '结论：测试通过。', 'allow');
replay('R8 只读审阅不强制记忆', '只读检查规则矛盾，不修改任何文件', '结论：存在机制缺陷，报告已交付。', 'allow');
replay('R8 明确保存请求缺记录必须拦', '请记住这个长期偏好', '结论：已处理。', 'block');
replay('R8 助手虚假记忆完成主张必须拦', '检查规则', '结论：已写入记忆。', 'block');
replay('R8 成功写入并被索引覆盖放行', '请记住这个长期偏好', '结论：已写入记忆。', 'allow', [tool('Write', { file_path: memoryFile }, 'ok')]);
replay('R8 写入失败不算成功', '请记住这个长期偏好', '结论：已写入记忆。', 'block', [tool('Write', { file_path: memoryFile }, 'permission denied', true)]);
replay('R8 正文中有memory路径不算保存', '请记住这个长期偏好', '结论：已处理。', 'block', [tool('Write', { file_path: path.join(ROOT, 'report.txt'), content: 'memory/feedback-test.md' })]);
replay('R8 缺目标文件不算保存', '请记住这个长期偏好', '结论：已处理。', 'block', [tool('Write', { file_path: path.join(memoryDir, 'missing.md') })]);
const orphan = path.join(memoryDir, 'orphan.md'); fs.writeFileSync(orphan, '未索引');
replay('R8 缺索引不算保存', '请记住这个长期偏好', '结论：已处理。', 'block', [tool('Write', { file_path: orphan })]);
replay('R1b 审阅建议不等于实施承诺', '只读审阅，提出修改建议，不实施', '结论：建议下一步先修改规则，当前仅提供审阅意见。', 'allow');
replay('R6 只读任务不接手旧队列', '只读审阅当前规则，不接手旧任务', '结论：审阅已完成。', 'allow', [], { cwd: qDir });
replay('R6 不同任务标识不接手旧队列', '实现当前模块', '结论：当前模块完成。', 'allow', [], { cwd: qDir, task_id: 'different-task' });
check('R6 本会话持有不是他人豁免', r6Verdict('- [ ] 【本会话持有 own】 尚未实现的功能\n', 'own'), 'block');
check('R6 同ID持有仍必须完成', r6Verdict('- [ ] 【会话持有 own-id】 尚未实现的功能\n', 'own-id'), 'block');
replay('R3 截图待补不能充当证据', '修复页面', '结论：页面已修复，截图待补。', 'block');
replay('R3 DOM断言不替代截图', '修复页面', '结论：页面已修复，DOM 断言通过并符合预期。', 'block');
replay('R3 截图失败不算证据', '修复页面', '结论：页面已修复，与预期比对一致。', 'block', [tool('mcp_call', {toolName:'mcp__browser-use__take_screenshot'}, 'failed', true)]);
replay('R3 未验证不声称完成可正常汇报', '修复页面', '结论：页面改动未验证，原因是缺少图形环境。', 'allow');
const ignoredHook = user('[stop-gate R8-memory-not-written] 必须写入记忆');
replay('R8 自动hook不覆盖真实只读请求', '只读审阅，不修改任何文件', '结论：审阅已完成，不写文件。', 'allow', [ignoredHook]);
replay('R7 用户仅要交接不继续实现', '只给我开工提示词，我自己新开会话', '结论：交接提示词已交付。', 'allow');
replay('R8 权限拒绝且如实报告不催绕过', '请记住这个长期偏好', '结论：未保存记忆，因平台权限拒绝。', 'allow', [tool('Write', {file_path:memoryFile}, 'permission denied', true)]);
const handoffFile = path.join(ROOT, '.qoder-work-queue.md');
fs.writeFileSync(handoffFile, '# 交接\n## 当前状态\n已完成当前检查，尚未实施剩余改造。\n## 下一步\n读取审阅意见并核对原始任务的批准范围，然后完成获准的工作。\n## 阻塞点\n无。\n## 关键入口\n代码入口与验证命令已经列在任务卡。\n');
const oversizedPrompt = '继续执行本轮任务。' + '输入上下文。'.repeat(50);
check('R7 超阈值无交接必须提醒', run({session_id:'large-missing', transcript_path:transcript([user(oversizedPrompt), asst('结论：当前阶段已结束。')])}, 'large-missing', {STOP_GATE_SESSION_MB:'0.0001'}).decision, 'block');
check('R7 已成功交接不重复阻断', run({session_id:'large-done', transcript_path:transcript([user(oversizedPrompt), tool('Write',{file_path:handoffFile}), asst('结论：交接已完成。')])}, 'large-done', {STOP_GATE_SESSION_MB:'0.0001'}).decision, 'allow');

const mixedResult = JSON.stringify({message:{role:'user',content:[{type:'tool_result',tool_use_id:'unknown',content:'read-only result'},{type:'text',text:'请记住这些规则缺陷'}]}});
replay('混合工具回注不覆盖只读用户请求', '只读审阅，不修改任何文件', '结论：建议下一步先修规则，当前只给建议。', 'allow', [mixedResult]);
replay('权限失败另一种表述不重复催写', '请记住这个长期偏好', '结论：记忆写入失败：权限拒绝。', 'allow', [tool('Write',{file_path:memoryFile},'permission denied',true)]);
replay('已有截图但明确未比对仍不通过', '修复页面', '结论：页面已修复，尚未比对、截图待补。', 'block', [screenshotTools]);
fs.writeFileSync(path.join(memoryDir,'MEMORY.md'),'- [一级](first-index.md)\n');
fs.writeFileSync(path.join(memoryDir,'first-index.md'),'- [二级](second-index.md)\n');
fs.writeFileSync(path.join(memoryDir,'second-index.md'),'- [偏好](feedback-test.md)\n');
replay('多层索引成功记忆不误拦', '请记住这个长期偏好', '结论：已写入记忆。', 'allow', [tool('Write',{file_path:memoryFile})]);
fs.writeFileSync(qFile,'责任会话：old-session\n- [ ] 需要接续的未完成实施项\n');
replay('明确接续可以承接旧责任会话队列', '按工作队列继续', '结论：这一项尚未处理。', 'block', [], {cwd:qDir,task_id:null});

console.log(results.join('\n'));

const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(`\n${n - failed}/${n} passed; cases=${n}`);
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (e) {}
process.exit(failed ? 1 : 0);
