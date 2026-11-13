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
      env: Object.assign({}, process.env, {
        HOME: ROOT, USERPROFILE: ROOT, HOOK_CRASH_LOG: path.join(ROOT, 'crash.log'), STOP_GATE_STATE_DIR: stateDir,
        TEMP: path.join(ROOT, 'temp'), TMP: path.join(ROOT, 'temp'), TMPDIR: path.join(ROOT, 'temp'),
        LOCALAPPDATA: path.join(ROOT, 'la'),
      }, extraEnv),
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
  ['无法联网导致测试没通过。', 'allow'],
  ['无法安装依赖造成构建不成功。', 'allow'],
  ['未能安装依赖因此构建没有成功。', 'allow'],
  ['没能启动服务使得测试不通过。', 'allow'],
  ['无法联网所以测试没通过。', 'allow'],
  ['无法联网导致测试不是没通过。', 'block'],
  ['无法联网导致测试没通过，但构建成功。', 'block'],
  ['没有导致测试不通过。', 'block'],
  ['没有造成测试不通过。', 'block'],
  ['没有任何变更导致测试不通过。', 'block'],
  ['未有任何变更导致测试不通过。', 'block'],
  ['未曾有任何变更造成测试不通过。', 'block'],
  ['没有再次导致测试不通过。', 'block'],
  ['没有直接导致测试不通过。', 'block'],
  ['没有间接造成测试不通过。', 'block'],
  ['没有实际导致测试不通过。', 'block'],
  ['没有真正造成测试不通过。', 'block'],
  ['没有最终导致测试不通过。', 'block'],
  ['不会再次导致测试不通过。', 'block'],
  ['没能继续造成测试不通过。', 'block'],
  ['没有实际联网导致测试没通过。', 'allow'],
  ['无法直接联网因此测试没有通过。', 'allow'],
  ['测试没通过、构建不成功。', 'allow'],
  ['测试没有通过且构建不成功。', 'allow'],
  ['无头测试没有不通过的。', 'block'],
  ['没有任何无头测试不通过。', 'block'],
  ['没一个测试不通过。', 'block'],
  ['没一项回归不通过。', 'block'],
  ['没任何测试不通过。', 'block'],
  ['未有任何测试不通过。', 'block'],
  ['不可能有测试不通过。', 'block'],
  ['没法找出测试不通过的情况。', 'block'],
  ['未能发现测试不通过的情况。', 'block'],
  ['测试不是通过了、也没报错吗？', 'block'],
  ['测试不是全部通过、构建也没成功。', 'allow'],
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
// 对照组必须给**真实存在**的落盘证据：占位路径既证不了记忆写入，也证不了载体写入（R18 会判红）。
const r4MemoryFile = path.join(ROOT, 'r4', 'memory', 'feedback-x.md');
fs.mkdirSync(path.dirname(r4MemoryFile), { recursive: true });
fs.writeFileSync(r4MemoryFile, '# feedback-x\n\n这条要求已落盘，供 R4 / R18 对照组取证。\n', 'utf8');
const trR4ok = transcript([
  user(corr),
  tool('Write', { file_path: r4MemoryFile.replace(/\\/g, '/') }),
  asst(r4okText),
]);
check('R4 违规必须拦', run({ last_assistant_message: r4, transcript_path: trR4bad, session_id: 'd1' }, 'd1').decision, 'block');
check('R4 对照组：本轮已写记忆则放行', run({ transcript_path: trR4ok, session_id: 'd2' }, 'd2').decision, 'allow');

// R18 声称已沉淀载体但零写入证据（自进化假绿）。窄条件：完成态主张 + 载体名词 + 本轮无载体落盘。
const r18claim = '这条判据已沉淀为规则，后续会自动生效，本轮到此结束。';
const r18claim2 = '我已经把这个流程落成技能，下次直接调用即可。';
const r18ruleFile = path.join(ROOT, 'r18', 'rules', 'agent-engineering.md');
const r18skillFile = path.join(ROOT, 'r18', 'skills', 'demo-flow', 'SKILL.md');
const r18plainFile = path.join(ROOT, 'r18', 'src', 'app.ts');
for (const f of [r18ruleFile, r18skillFile, r18plainFile]) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '# 载体正文\n\n判据与反例都已写在这里，非空文件。\n', 'utf8');
}
const r18pos = (tools) => transcript([user('把这条判据沉淀下来'), ...tools, asst(r18claim)]);
const r18run = (label, tr, want, session) => {
  const got = run({ transcript_path: tr, session_id: session }, session);
  check(label, got.decision, want);
  return got;
};
const r18bad = r18run('R18 违规必须拦：声称沉淀为规则但零写入', r18pos([tool('Bash', { command: 'ls' })]), 'block', 'r18a');
check('R18 归因必须是 R18（不被其他规则顶包）',
  r18bad.out.includes('R18-sedimentation-claim-without-evidence') ? 'yes' : 'no', 'yes');
r18run('R18 违规必须拦：声称落成技能但只跑了无关命令',
  transcript([user('整理成技能'), tool('Bash', { command: 'git status' }), asst(r18claim2)]), 'block', 'r18b');
r18run('R18 对照组：真写 rules 文件则放行',
  r18pos([tool('Write', { file_path: r18ruleFile.replace(/\\/g, '/') })]), 'allow', 'r18c');
r18run('R18 对照组：真写 skills/SKILL.md 则放行',
  r18pos([tool('Edit', { file_path: r18skillFile.replace(/\\/g, '/') })]), 'allow', 'r18d');
r18run('R18 对照组：真跑 evolution.js record 则放行',
  r18pos([tool('Bash', { command: 'node ~/.qoder/skills/self-evolution/scripts/evolution.js record --json "{}"' }, '{"ok":true}')]), 'allow', 'r18e');
r18run('R18 写盘失败不算证据',
  r18pos([tool('Write', { file_path: r18ruleFile.replace(/\\/g, '/') }, 'permission denied', true)]), 'block', 'r18f');
r18run('R18 只写普通源码不算载体证据',
  r18pos([tool('Write', { file_path: r18plainFile.replace(/\\/g, '/') })]), 'block', 'r18g');
r18run('R18 空文件不算证据', (() => {
  const empty = path.join(ROOT, 'r18', 'rules', 'empty.md');
  fs.writeFileSync(empty, '', 'utf8');
  return r18pos([tool('Write', { file_path: empty.replace(/\\/g, '/') })]);
})(), 'block', 'r18h');
// 负对照：只读 / 禁止记忆 / 否定前缀 / 待授权 / 权限被拒 / 无载体名词 / 候选措辞，一律放行。
r18run('R18 负对照：只读任务不要求写入',
  transcript([user('只读审阅，不要修改任何文件'), tool('Bash', { command: 'ls' }), asst(r18claim)]), 'allow', 'r18i');
r18run('R18 负对照：禁止记忆时不要求写入',
  transcript([user('不要写入记忆，只给结论'), tool('Bash', { command: 'ls' }), asst(r18claim)]), 'allow', 'r18j');
r18run('R18 负对照：尚未写入不算主张',
  transcript([user('沉淀一下'), tool('Bash', { command: 'ls' }), asst('这条判据尚未写入规则，等授权后再落盘。')]), 'allow', 'r18k');
r18run('R18 负对照：待授权不算主张',
  transcript([user('沉淀一下'), tool('Bash', { command: 'ls' }), asst('待授权后沉淀为技能，本轮只给方案。')]), 'allow', 'r18l');
r18run('R18 负对照：权限被拒且如实报告',
  transcript([user('沉淀一下'), tool('Write', { file_path: r18ruleFile.replace(/\\/g, '/') }, 'permission denied', true),
    asst('已尝试写入规则但被权限拒绝，未沉淀，需要你批准后才能落盘。')]), 'allow', 'r18m');
r18run('R18 负对照：无载体名词的口头承诺不拦（宁窄勿滥）',
  transcript([user('记住'), tool('Bash', { command: 'ls' }), asst('已记住这个偏好，本轮继续推进。')]), 'allow', 'r18n');
r18run('R18 负对照：只说记录候选不算沉淀载体',
  transcript([user('记录一下'), tool('Bash', { command: 'ls' }), asst('已记录候选到 inbox，待授权晋升，本轮不改载体。')]), 'allow', 'r18o');
// 改坏必红：摘掉 R18 判据 → 上面的违规必须变放行；抹掉证据检查 → 对照组必须变拦。
const R18_MUT = path.join(ROOT, 'r18-mut');
const R18_DEPS = ['stop-gate.js', 'stop-gate-text.js', 'client-root.js', 'hook-crash-guard.js', 'kickoff-core.cjs', 'capability-roots.cjs'];
function r18Mutant(label, from, to, tr, want) {
  const dir = path.join(R18_MUT, label);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of R18_DEPS) {
    const src = path.join(__dirname, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  const target = path.join(dir, 'stop-gate.js');
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(from)) { check('R18 变异 ' + label + ' 命中源码', 'miss', 'hit'); return; }
  fs.writeFileSync(target, original.replace(from, to), 'utf8');
  const session = 'r18mut-' + label;
  let out = '';
  try {
    out = execFileSync(process.execPath, [target], {
      input: JSON.stringify({ cwd: ROOT, task_id: 'stopgate-test', transcript_path: tr, session_id: session }),
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        HOME: ROOT, USERPROFILE: ROOT, HOOK_CRASH_LOG: path.join(ROOT, 'crash.log'),
        STOP_GATE_STATE_DIR: path.join(ROOT, 'state-' + session),
        TEMP: path.join(ROOT, 'temp'), TMP: path.join(ROOT, 'temp'), TMPDIR: path.join(ROOT, 'temp'),
        LOCALAPPDATA: path.join(ROOT, 'la'),
      }),
    });
  } catch (e) { out = (e.stdout || '') + ''; }
  let decision = 'allow';
  try { if (JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}').decision === 'block') decision = 'block'; } catch {}
  check('R18 改坏必红：' + label, decision, want);
}
r18Mutant('claim-neutered', 'if (!SEDIMENT_CLAIM.test(text)) return false;', 'if (true) return false;',
  r18pos([tool('Bash', { command: 'ls' })]), 'allow');
r18Mutant('evidence-ignored', 'return !carrierWritten(ctx) && !memoryWritten(ctx);', 'return true;',
  r18pos([tool('Write', { file_path: r18ruleFile.replace(/\\/g, '/') })]), 'block');

// R19 收尾自进化建议未弹窗（用户 2026-11-12 明确要求：每轮收尾把建议弹窗给用户拍板）。
// 采集 hook 只写 pending 且永不拦截，"一定会弹"由本规则保证；这里证明它既能拦、也不误拦。
const R19_STATE = path.join(ROOT, 'r19-capture-state');
const r19Text = '这一格按你说的口径改好了，细节都在上面的 diff 里。';
const r19Items = [
  { kind: 'long-term-preference', topic: 'long-term-preference:以后一律用中文', carriers: ['memory', 'rules', 'agents'], excerpt: '以后一律用简体中文回复', evidence: {} },
  { kind: 'capability-gap', topic: 'capability-gap:command-not-found', carriers: ['mcp', 'skill', 'script'], excerpt: 'command not found: pwsh', evidence: { tool: 'Bash', occurrences: 2 } },
];
const R19_EVOLUTION_CARD = { questions: [{ question: '这条自进化候选要不要采纳并落到 rules？', header: '自进化', options: [{ label: '采纳并落到推荐载体（推荐）' }, { label: '本轮跳过' }] }] };
const R19_KICKOFF_CARD = { questions: [{ question: '开工确认：理解 / 步骤 / 并行是否合适？', header: '开工确认', options: [{ label: '按此执行' }, { label: '调整' }] }] };
// 清理卡用**真实卡面**：正文含「可清理候选 N 项」。旧判据 /候选|载体|采纳/ 会把它当成已问过建议，
// 而原来这张卡面没有「候选」二字 → 负对照恒绿（假绿）。2026-11-12 第二轮对抗审查实测。
const R19_CLEAN_CARD = { questions: [{ question: '本轮临时产物清理范围？可清理候选 142 项（含日志与探针），保留已登记证据 104 项', header: '临时清理', options: [{ label: '清理本轮产物' }, { label: '保留' }] }] };
// 压缩续接摘要：宿主注入的 user 角色消息（isCompactSummary），不是本轮指令。
// 2026-11-12 实测：8 条真实摘要里有 1 条被 kickoffCore.isReadOnlyRequest 判成只读（摘要引用了规则原文
// "先只读预览命中范围"）→ taskScope.readOnly=true → R19 整轮静默失效，用户要求的收尾弹窗再也不弹。
const R19_COMPACT_TEXT = 'Summary: 授权边界：按匹配定位的风险操作先只读预览命中范围、做负对照；只读审阅零写入。';
const compactSummary = (text, onMessage) => JSON.stringify(onMessage
  ? { type: 'user', message: { role: 'user', isCompactSummary: true, content: text } }
  : { type: 'user', isCompactSummary: true, message: { role: 'user', content: text } });
// 子代理（sidechain）正文：与 continuity.cjs selected() 同口径整条排除。真实 transcript 未出现该形态
// （8810 行实测 sidechainUser=0），属防御性对齐；判据由合成夹具的正例/负对照保证能失败。
const sidechainUser = (text, onMessage) => JSON.stringify(onMessage
  ? { type: 'user', message: { role: 'user', isSidechain: true, content: text } }
  : { type: 'user', isSidechain: true, message: { role: 'user', content: text } });
let r19Seq = 0;
// 运行中插话：宿主写成 attachment/queued_command(commandMode=prompt)，没有 role=user 条目。
// 形态照抄 2026-11-12 现役实测（本会话第 1698 行）；同形态的 task-notification 是系统通知。
const queuedPrompt = (text, mode = 'prompt') => JSON.stringify({
  type: 'attachment', uuid: 'q-' + (++r19Seq), timestamp: new Date().toISOString(),
  attachment: mode === 'prompt'
    ? { type: 'queued_command', commandMode: mode, prompt: [{ type: 'text', text }], source_uuid: 'src', origin: { kind: 'bridge' } }
    : { type: 'queued_command', commandMode: mode, prompt: text },
});
function r19Setup(opts = {}) {
  const id = 'r19c' + String(++r19Seq).padStart(4, '0');
  const session = id + '-1111-2222-3333-444444444444';
  fs.mkdirSync(R19_STATE, { recursive: true });
  if (opts.items !== null) {
    fs.writeFileSync(path.join(R19_STATE, `pending-${id}.json`), JSON.stringify({
      schema: 1, session, task: 'project-alpha', cwd: ROOT,
      at: opts.at || new Date().toISOString(), askKey: 'fixture', items: opts.items || r19Items,
    }), 'utf8');
  }
  if (opts.foreign) {
    fs.writeFileSync(path.join(R19_STATE, 'pending-zzzzzzzz.json'), JSON.stringify({
      schema: 1, session: 'zzzzzzzz-1111', task: 'other', cwd: ROOT, at: new Date().toISOString(), askKey: 'foreign', items: r19Items,
    }), 'utf8');
  }
  const tr = transcript([...(opts.noUser ? [] : [user(opts.userText || '以后一律用简体中文回复')]), ...(opts.compact ? [compactSummary(opts.compact, opts.compactOnMessage)] : []), ...(opts.sidechain ? [sidechainUser(opts.sidechain, opts.sidechainOnMessage)] : []), ...(opts.queued ? [queuedPrompt(opts.queued, opts.queuedMode)] : []), ...(opts.tools || [tool('Bash', { command: 'ls' })]), asst(opts.text || r19Text)]);
  const got = run({ transcript_path: tr, session_id: session, last_assistant_message: opts.text || r19Text }, session, { EVOLUTION_CAPTURE_STATE_DIR: R19_STATE });
  return { got, session, id };
}
const r19check = (label, opts, want) => { const r = r19Setup(opts); check(label, r.got.decision, want); return r; };
const r19bad = r19check('R19 违规必须拦：有收尾建议但没弹窗', {}, 'block');
check('R19 归因必须是 R19（不被其他规则顶包）', r19bad.got.out.includes('R19-evolution-suggestion-not-asked') ? 'yes' : 'no', 'yes');
check('R19 拦截理由给出推荐落点与主题',
  r19bad.got.out.includes('rules') && r19bad.got.out.includes('long-term-preference') ? 'yes' : 'no', 'yes');
check('R19 拦截理由给出拒绝登记命令', r19bad.got.out.includes('--decline') ? 'yes' : 'no', 'yes');
r19check('R19 对照组：本轮已弹自进化建议卡则放行', { tools: [tool('AskUserQuestion', R19_EVOLUTION_CARD, '{"answers":{"选":"采纳"}}')] }, 'allow');
r19check('R19 对照组：弹窗后真写载体也放行', { tools: [tool('AskUserQuestion', R19_EVOLUTION_CARD, '{"answers":{"选":"采纳"}}'), tool('Write', { file_path: r18ruleFile.replace(/\\/g, '/') })] }, 'allow');
r19check('R19 负对照：开工确认卡不冒充建议弹窗', { tools: [tool('AskUserQuestion', R19_KICKOFF_CARD, '{"answers":{"选":"按此执行"}}')] }, 'block');
r19check('R19 负对照：临时清理卡不冒充建议弹窗', { tools: [tool('AskUserQuestion', R19_CLEAN_CARD, '{"answers":{"选":"保留"}}')] }, 'block');
r19check('R19 负对照：弹窗失败不算已问', { tools: [tool('AskUserQuestion', R19_EVOLUTION_CARD, 'permission denied', true)] }, 'block');
r19check('R19 负对照：没有 pending 就不拦', { items: null }, 'allow');
r19check('R19 负对照：pending  items 为空不拦', { items: [] }, 'allow');
r19check('R19 负对照：超过 24 小时的陈年建议不拦', { at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, 'allow');
r19check('R19 负对照：只读轮不要求弹窗', { userText: '只读审阅这个方案，不要修改任何文件' }, 'allow');
// A30（2026-11-13 用户采纳）：英文暂停轮同样不要求弹窗；旧版只认中文，英文只读轮会被误拦。
r19check('R19 负对照：英文只读轮不要求弹窗', { userText: 'Please review this read-only. Do not modify any files.' }, 'allow');
r19check('R19 负对照：英文只读轮不要求弹窗（纯 read-only 短语）', { userText: 'This round is read-only.' }, 'allow');
r19check('R19 负对照：英文仅交接轮不要求弹窗', { userText: 'Handoff only: just give me a kickoff prompt.' }, 'allow');
r19check('R19 负对照：英文禁记忆轮不要求弹窗', { userText: 'Do not write to memory this round.' }, 'allow');
r19check('R19 英文普通实施轮仍要求弹窗（不是把守卫关掉）', { userText: 'Please add a retry to the uploader and run the tests.' }, 'block');
// A34（2026-11-13 用户采纳）：超窗降级采集的候选范围未知，仍必须弹窗，且理由要求先人工确认本轮范围。
const r19ScopeUnknown = r19check('R19 范围未知候选仍要求弹窗', { items: r19Items.map(i => ({ ...i, scopeUnknown: true })) }, 'block');
check('R19 范围未知候选的理由点名标记并要求人工确认本轮范围',
  r19ScopeUnknown.got.out.includes('范围未知') && r19ScopeUnknown.got.out.includes('人工确认本轮范围') ? 'yes' : 'no', 'yes');
check('R19 范围未知候选的理由写明不得直接落载体',
  r19ScopeUnknown.got.out.includes('不得直接落载体') ? 'yes' : 'no', 'yes');
const r19PlainPending = r19check('R19 负对照：普通候选仍要求弹窗', {}, 'block');
check('R19 负对照：普通候选的理由不含范围未知警告（判据非恒真）',
  !r19PlainPending.got.out.includes('范围未知') && !r19PlainPending.got.out.includes('人工确认本轮范围') ? 'yes' : 'no', 'yes');
r19check('R19 负对照：仅交接轮不要求弹窗', { userText: '只给我开工提示词，我自己新开会话' }, 'allow');
r19check('R19 负对照：禁记忆轮不要求弹窗', { userText: '本轮不要写入记忆，只给结论' }, 'allow');
r19check('R19 负对照：别的会话的建议不影响本会话', { items: null, foreign: true }, 'allow');
// 压缩续接摘要不是本轮指令：摘要引用规则原文里的"只读"会把整轮判成只读，R19 静默失效（现役实测缺陷）。
const r19Compact = r19check('R19 压缩摘要不算指令：仍按真实指令拦截', { compact: R19_COMPACT_TEXT }, 'block');
check('R19 压缩摘要场景归因仍是 R19', r19Compact.got.out.includes('R19-evolution-suggestion-not-asked') ? 'yes' : 'no', 'yes');
r19check('R19 摘要标记打在 message 上同样排除', { compact: R19_COMPACT_TEXT, compactOnMessage: true }, 'block');
r19check('R19 负对照：真实只读指令优先于不含只读标记的摘要', { userText: '只读审阅这个方案，不要修改任何文件', compact: 'Summary: 本轮继续推进实施。' }, 'allow');
const r19OnlyCompact = r19check('R19 尾窗只有摘要时不臆造只读范围（有 pending 仍要求弹窗）', { noUser: true, compact: R19_COMPACT_TEXT }, 'block');
check('R19 只有摘要场景归因仍是 R19', r19OnlyCompact.got.out.includes('R19-evolution-suggestion-not-asked') ? 'yes' : 'no', 'yes');
// 子代理（sidechain）正文不是本轮指令：与 evolution-capture / continuity 同口径整条排除。
const R19_SIDECHAIN_RO = '只读审阅这个方案，不要修改任何文件';
const r19Sidechain = r19check('R19 子代理只读提示词不算指令：仍按真实指令拦截', { sidechain: R19_SIDECHAIN_RO }, 'block');
check('R19 子代理场景归因仍是 R19', r19Sidechain.got.out.includes('R19-evolution-suggestion-not-asked') ? 'yes' : 'no', 'yes');
r19check('R19 sidechain 标记打在 message 上同样排除', { sidechain: R19_SIDECHAIN_RO, sidechainOnMessage: true }, 'block');
r19check('R19 负对照：真实只读指令仍放行（不是把只读守卫关掉）', { userText: R19_SIDECHAIN_RO, sidechain: '本轮继续推进实施，以后一律用中文。' }, 'allow');
// 运行中插话（attachment/queued_command）同样是本轮指令：漏认它 → scope 停在旧指令上，
// R19 该拦不拦、不该拦乱拦（2026-11-12 现役实测：采集侧因此整轮零候选）。
const R19_RO = '只读审阅这个方案，不要修改任何文件';
const R19_IMPL = '继续实施，按方案改代码并跑测试';
r19check('R19 插话的只读口径生效（旧指令是实施轮）', { queued: R19_RO }, 'allow');
r19check('R19 插话把只读轮翻成实施轮 → 仍要求弹窗', { userText: R19_RO, queued: R19_IMPL }, 'block');
r19check('R19 负对照：task-notification 不改 scope（只读轮保持只读）',
  { userText: R19_RO, queued: '后台任务已完成，请继续实施并修改文件', queuedMode: 'task-notification' }, 'allow');
r19check('R19 尾窗只有插话时按插话判 scope（只读）', { noUser: true, queued: R19_RO }, 'allow');
const r19QueuedOnly = r19check('R19 尾窗只有插话时按插话判 scope（实施）', { noUser: true, queued: R19_IMPL }, 'block');
check('R19 只有插话场景归因仍是 R19', r19QueuedOnly.got.out.includes('R19-evolution-suggestion-not-asked') ? 'yes' : 'no', 'yes');
// 滑动窗上限：同会话同规则最多拦 2 次，超限**可见**放行并落 -SUPPRESSED 台账。
const r19CapSession = 'r19cap01-1111-2222-3333-444444444444';
fs.writeFileSync(path.join(R19_STATE, 'pending-r19cap01.json'), JSON.stringify({
  schema: 1, session: r19CapSession, task: 'project-alpha', cwd: ROOT, at: new Date().toISOString(), askKey: 'cap', items: r19Items,
}), 'utf8');
const r19CapTr = transcript([user('以后一律用简体中文回复'), tool('Bash', { command: 'ls' }), asst(r19Text)]);
const r19CapDecisions = [1, 2, 3].map(() => run({ transcript_path: r19CapTr, session_id: r19CapSession, last_assistant_message: r19Text }, r19CapSession, { EVOLUTION_CAPTURE_STATE_DIR: R19_STATE }).decision);
check('R19 滑动窗：同会话前两次拦', JSON.stringify(r19CapDecisions.slice(0, 2)), '["block","block"]');
check('R19 滑动窗：第三次放行（防死循环）', r19CapDecisions[2], 'allow');
check('R19 超限放行必须留痕',
  fs.readFileSync(path.join(ROOT, 'state-' + r19CapSession, 'violations.log'), 'utf8').includes('R19-evolution-suggestion-not-asked-SUPPRESSED') ? 'yes' : 'no', 'yes');
// 改坏必红：摘掉 pending 判据 / 抹掉已弹窗检查 / 忽略有效期 / 忽略只读范围，对应场景必须变样。
const R19_MUT = path.join(ROOT, 'r19-mut');
const R19_DEPS = R18_DEPS.concat(['evolution-signal-core.js']);
let r19MutSeq = 0;
function r19Mutant(label, from, to, opts, want) {
  const dir = path.join(R19_MUT, label);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of R19_DEPS) {
    const src = path.join(__dirname, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  const target = path.join(dir, 'stop-gate.js');
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(from)) { check('R19 变异 ' + label + ' 命中源码', 'miss', 'hit'); return; }
  fs.writeFileSync(target, original.replace(from, to), 'utf8');
  const id = 'r19m' + String(++r19MutSeq).padStart(4, '0');
  const session = id + '-1111-2222-3333-444444444444';
  fs.mkdirSync(R19_STATE, { recursive: true });
  fs.writeFileSync(path.join(R19_STATE, `pending-${id}.json`), JSON.stringify({
    schema: 1, session, task: 'project-alpha', cwd: ROOT, at: opts.at || new Date().toISOString(), askKey: 'mut', items: opts.items || r19Items,
  }), 'utf8');
  const tr = transcript([...(opts.noUser ? [] : [user(opts.userText || '以后一律用简体中文回复')]), ...(opts.compact ? [compactSummary(opts.compact, opts.compactOnMessage)] : []), ...(opts.sidechain ? [sidechainUser(opts.sidechain, opts.sidechainOnMessage)] : []), ...(opts.queued ? [queuedPrompt(opts.queued, opts.queuedMode)] : []), ...(opts.tools || [tool('Bash', { command: 'ls' })]), asst(r19Text)]);
  let out = '';
  try {
    out = execFileSync(process.execPath, [target], {
      input: JSON.stringify({ cwd: ROOT, task_id: 'stopgate-test', transcript_path: tr, session_id: session, last_assistant_message: r19Text }),
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        HOME: ROOT, USERPROFILE: ROOT, HOOK_CRASH_LOG: path.join(ROOT, 'crash.log'),
        STOP_GATE_STATE_DIR: path.join(ROOT, 'state-' + session), EVOLUTION_CAPTURE_STATE_DIR: R19_STATE,
        TEMP: path.join(ROOT, 'temp'), TMP: path.join(ROOT, 'temp'), TMPDIR: path.join(ROOT, 'temp'),
        LOCALAPPDATA: path.join(ROOT, 'la'),
      }),
    });
  } catch (e) { out = (e.stdout || '') + ''; }
  let decision = 'allow';
  try { if (JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}').decision === 'block') decision = 'block'; } catch {}
  check('R19 改坏必红：' + label, decision, want);
}
r19Mutant('pending-ignored', 'if (!pendingSuggestion(ctx)) return false;', 'if (true) return false;', {}, 'allow');
r19Mutant('asked-check-neutered', 'return !askedAbout(ctx, evolutionSignal.EVOLUTION_ASK);', 'return true;',
  { tools: [tool('AskUserQuestion', R19_EVOLUTION_CARD, '{"answers":{"选":"采纳"}}')] }, 'block');
r19Mutant('ttl-ignored', 'if (!Number.isFinite(at) || Date.now() - at > PENDING_TTL_MS) return null;', 'if (!Number.isFinite(at)) return null;',
  { at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }, 'block');
r19Mutant('scope-ignored', 'if (ctx.scope.readOnly || ctx.scope.handoffOnly || ctx.scope.noMemory) return false;\n      if (!evolutionSignal) return false;', 'if (false) return false;\n      if (!evolutionSignal) return false;',
  { userText: '只读审阅这个方案，不要修改任何文件' }, 'block');
r19Mutant('compact-summary-accepted', '!j.isCompactSummary && !msg.isCompactSummary && ', '',
  { compact: R19_COMPACT_TEXT }, 'allow');
r19Mutant('sidechain-accepted', '      if (j.isSidechain === true || msg.isSidechain === true) continue;\n', '',
  { sidechain: R19_SIDECHAIN_RO }, 'allow');
r19Mutant('queued-prompt-ignored', '        const qtxt = queuedUserText(j);', "        const qtxt = '';",
  { userText: R19_RO, queued: R19_IMPL }, 'allow');

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

// R10 分享包安装/更新提示必须转成真实询问
const nextAction = 'NEXT_ACTION: ASK_INSTALL_OR_UPDATE — 2 条可安装或可更新；必须用 AskUserQuestion 询问用户，未获明确选择不得执行安装或更新。';
const askedInstall = tool('AskUserQuestion', { questions: [{ question: '是否安装/更新这些技能与脚本？', options: ['更新', '保持现状'] }] });
replay('R10 NEXT_ACTION 未询问必须拦', '检索可安装技能并处理', '结论：已检索。', 'block', [tool('Bash', { command: 'node pkg-catalog.cjs search ui' }, nextAction)]);
replay('R10 已询问安装更新放行', '检索可安装技能并处理', '结论：已询问用户。', 'allow', [tool('Bash', { command: 'node pkg-catalog.cjs search ui' }, nextAction), askedInstall]);
replay('R10 用户明确不更新放行', '只检索，不安装也不更新', '结论：已检索。', 'allow', [tool('Bash', { command: 'node pkg-catalog.cjs search ui' }, nextAction)]);
replay('R10 普通检索无 NEXT_ACTION 不拦', '检索技能', '结论：已检索。', 'allow', [tool('Bash', { command: 'node pkg-catalog.cjs search ui' }, '未找到可安装条目')]);
replay('R10 源码检索 NEXT_ACTION 字样不误拦', '检查安装提示实现', '结论：已检查。', 'allow', [tool('Bash', { command: 'grep -n "NEXT_ACTION" scripts/pkg-catalog.cjs' }, nextAction)]);
replay('R10 node -e 打印源码字样不误拦', '检查安装提示实现', '结论：已检查。', 'allow', [tool('Bash', { command: 'node -e "console.log(\'pkg-catalog.cjs\')"' }, nextAction)]);

// R11 发布完成必须询问部署
const askedDeploy = tool('AskUserQuestion', { questions: [{ question: '发布完成，是否部署到现役？', options: ['部署', '暂不部署'] }] });
replay('R11 发布后未询问部署必须拦', '发布新版本', '结论：已发布。', 'block', [tool('Bash', { command: 'gh release create v0.0.19 --title 0.0.19' }, 'released')]);
replay('R11 已询问部署放行', '发布新版本', '结论：已询问用户。', 'allow', [tool('Bash', { command: 'gh release create v0.0.19 --title 0.0.19' }, 'released'), askedDeploy]);
replay('R11 用户明确只发布不部署放行', '只发布，不部署到现役', '结论：已发布。', 'allow', [tool('Bash', { command: 'gh release create v0.0.19 --title 0.0.19' }, 'released')]);
replay('R11 发布失败不追问部署', '发布新版本', '结论：发布失败，CI 未通过。', 'allow', [tool('Bash', { command: 'gh release create v0.0.19 --title 0.0.19' }, 'released')]);
replay('R11 普通推送不误判为发布', '推送主分支', '结论：已推送。', 'allow', [tool('Bash', { command: 'git push origin main' }, 'pushed')]);
replay('R11 推送版本 tag 未询问必须拦', '推送版本标签', '结论：已推送。', 'block', [tool('Bash', { command: 'git push origin v0.0.19' }, 'pushed')]);
replay('R11 publish-release 未询问必须拦', '发布新版本', '结论：已发布。', 'block', [tool('Bash', { command: 'node .github/publish-release.js v0.0.19' }, 'released')]);
replay('R11 grep 源码发布字样不误拦', '检查发布脚本', '结论：已检查。', 'allow', [tool('Bash', { command: 'grep -n "gh release create" .github/publish-release.js' }, 'gh release create found')]);
replay('R11 node -e 打印发布字样不误拦', '检查发布脚本', '结论：已检查。', 'allow', [tool('Bash', { command: 'node -e "console.log(\'release.yml\')"' }, 'release.yml')]);

// R13 分享包更新/合并必须先做逐文件文案审阅并逐条询问
const mergeReview = 'MERGE_REVIEW inbound=D:/pkg --local ~/.qoder --baseline D:/old\nMERGE_DECISIONS\n  - [BOTH-CHANGED] rules/a.md — 保留本地 / 采纳包内 / 手工合并 / 跳过\nNEXT_ACTION: ASK_MERGE_DECISION — 1 个文件需要逐条确认';
const askedMerge = tool('AskUserQuestion', { questions: [{ question: 'rules/a.md 本地与包内都改了，如何合并？', options: ['保留本地', '采纳包内', '手工合并', '跳过'] }] });
const reviewCmd = tool('Bash', { command: 'node skills/merge-inbound-qoder-package/scripts/pkg-diff.cjs review --inbound D:/pkg --local ~/.qoder --baseline D:/old' }, mergeReview);
replay('R13 强制覆盖未审阅必须拦', '更新分享包技能', '结论：已更新。', 'block', [tool('Bash', { command: 'node pkg-catalog.cjs install skill:x --apply --force' }, 'applied')]);
replay('R13 已逐文件审阅并逐条询问放行', '更新分享包技能', '结论：已按选择合并。', 'allow', [reviewCmd, tool('Bash', { command: 'node pkg-catalog.cjs install skill:x --apply --force' }, 'applied'), askedMerge]);
replay('R13 只问是否更新不算', '更新分享包技能', '结论：已更新。', 'block', [tool('Bash', { command: 'node pkg-catalog.cjs install skill:x --apply --force' }, 'applied'), tool('AskUserQuestion', { questions: [{ question: '是否更新？', options: ['更新', '保持现状'] }] })]);
replay('R13 新装无冲突不误拦', '安装新技能', '结论：已安装。', 'allow', [tool('Bash', { command: 'node pkg-catalog.cjs install skill:new --apply' }, 'installed')]);
replay('R13 安装器有 REVIEW_UPDATE 未审阅必须拦', '更新分享包基础能力', '结论：已更新。', 'block', [tool('Bash', { command: 'node install-package.cjs --yes' }, 'REVIEW_UPDATE: 2')]);
replay('R13 安装器有 UPDATE 未审阅必须拦', '更新分享包基础能力', '结论：已更新。', 'block', [tool('Bash', { command: 'node install-package.cjs --yes' }, 'UPDATE: 3')]);
replay('R13 审阅命令本身不拦', '查看分享包差异', '结论：已给出差异。', 'allow', [reviewCmd]);
replay('R13 用户明确直接更新放行', '直接更新，不用逐条对比', '结论：已更新。', 'allow', [tool('Bash', { command: 'node pkg-catalog.cjs install skill:x --apply --force' }, 'applied')]);

// R12 含混判别门禁：高置信初筛 + 写入 + 无判别记录才拦
const ambDir = path.join(ROOT, 'ambiguity');
fs.mkdirSync(ambDir, { recursive: true });
function r12Case(label, { prompt = '帮我优化一下', tools = [], level = 'high', resolved = null, expected, reason = 'R12-ambiguity-decision-missing' }) {
  const session = 'amb-' + (++n);
  const decisionId = 'd-' + session;
  fs.writeFileSync(path.join(ambDir, 'pending-' + session + '.json'), JSON.stringify({
    schema: 1, decisionId, sessionId: session, level, signals: ['光杆动作'], binding: 'b-' + session, at: new Date().toISOString(),
  }));
  if (resolved) fs.writeFileSync(path.join(ambDir, 'resolved-' + session + '.json'), JSON.stringify({ schema: 1, decisionId, verdict: resolved, at: new Date().toISOString() }));
  const result = run({ transcript_path: transcript([user(prompt), ...tools, asst('处理完毕。')]), session_id: session }, session, { AMBIGUITY_STATE_DIR: ambDir });
  check(label, result.decision, expected);
  if (expected === 'block') check(label + '（原因确为 ' + reason + '）', result.out.includes(reason), true);
  return result;
}
r12Case('R12 高置信含混未判别就写入必须拦', { tools: [tool('Edit', { file_path: 'D:/x/a.ts' })], expected: 'block' });
r12Case('R12 已有判别记录放行', { tools: [tool('Edit', { file_path: 'D:/x/a.ts' })], resolved: 'clear', expected: 'allow' });
r12Case('R12 纯讨论无写入放行', { expected: 'allow' });
r12Case('R12 已弹窗放行', { tools: [tool('AskUserQuestion', { questions: [] }), tool('Edit', { file_path: 'D:/x/a.ts' })], expected: 'allow' });
r12Case('R12 中置信不拦', { level: 'medium', tools: [tool('Edit', { file_path: 'D:/x/a.ts' })], expected: 'allow' });
const r12ReadOnly = r12Case('R12 只读任务不触发 R12（写入由 R16 只读守卫接管）', { prompt: '只读审阅，不修改任何文件', tools: [tool('Edit', { file_path: 'D:/x/a.ts' })], expected: 'block', reason: 'R16-kickoff-confirmation-missing' });
check('R16 只读轮写入的拦截原因指向只读授权', r12ReadOnly.out.includes('用户要求只读审阅'), true);
r12Case('R12 clarify 未弹窗仍要拦', { tools: [tool('Edit', { file_path: 'D:/x/a.ts' })], resolved: 'clarify', expected: 'block' });
r12Case('R12 clarify 已弹窗放行', { tools: [tool('AskUserQuestion', { questions: [] }), tool('Edit', { file_path: 'D:/x/a.ts' })], resolved: 'clarify', expected: 'allow' });

// R16 开工确认：除简单纯问答外的任务，写入/副作用命令前必须有绑定到本轮请求的确认台账
const kickoffDir = path.join(ROOT, 'kickoff');
fs.mkdirSync(kickoffDir, { recursive: true });
process.env.KICKOFF_STATE_DIR = kickoffDir;
const kickoff = require('./kickoff-core.cjs');
function kickoffContext(session, prompt) {
  return kickoff.createKickoffContext({ sessionId: session, prompt, cwd: ROOT, requestMessageId: 'm-' + session });
}
function kickoffCard(context) {
  return {
    schema: 1,
    bindingDigest: context.binding,
    taskId: 'task-' + context.sessionId,
    profile: 'simple',
    understanding: { goal: '修复按钮文案', object: '登录页按钮', scope: '只改文案', acceptance: '页面显示正确', prohibitions: ['不改样式'] },
    steps: ['定位文案', '修改文案', '复跑测试'],
    parallel: { mode: 'serial', reason: '单文件小改动' },
  };
}
function kickoffConfirm(context, choice = 'proceed') {
  const composed = kickoff.composeCard({ schema: 1, context, card: kickoffCard(context) }, context.binding);
  return kickoff.recordConfirmation({ schema: 1, context, cardDigest: composed.cardDigest, choice }, context.binding);
}
function r16Case(label, session, prompt, tools, expected, setup) {
  if (setup) setup();
  const result = run({ transcript_path: transcript([user(prompt), ...tools, asst('处理完毕。')]), session_id: session }, session, { KICKOFF_STATE_DIR: kickoffDir });
  check(label, result.decision, expected);
  if (expected === 'block') check(label + '（原因确为 R16）', result.out.includes('R16-kickoff-confirmation-missing'), true);
  return result;
}
const r16Prompt = '修复登录按钮的文案';
const r16Write = tool('Write', { file_path: 'D:/x/a.ts' });
const r16Ask = tool('AskUserQuestion', { questions: [{ question: '是否按此计划开工？', options: ['按此执行', '调整'] }] });
r16Case('R16 未确认就写入必须拦', 'kickoff-a', r16Prompt, [r16Write], 'block', () => kickoff.writePending(kickoffContext('kickoff-a', r16Prompt)));
kickoff.writePending(kickoffContext('kickoff-b', r16Prompt));
const r17ReadOnly = run({ transcript_path: transcript([user(r16Prompt), tool('Bash', { command: 'git status --short' }), asst('处理完毕。')]), session_id: 'kickoff-b' }, 'kickoff-b', { KICKOFF_STATE_DIR: kickoffDir });
check('R17 只读检查但未出卡不许收尾', r17ReadOnly.decision, 'block');
check('R17 只读检查的拦截原因指向未出卡', r17ReadOnly.out.includes('R17-kickoff-card-not-confirmed') && r17ReadOnly.out.includes('不能不出卡就结束'), true);
r16Case('R16 副作用命令未确认必须拦', 'kickoff-c', r16Prompt, [tool('Bash', { command: 'git commit -m "fix"' })], 'block', () => kickoff.writePending(kickoffContext('kickoff-c', r16Prompt)));
r16Case('R16 已弹窗但未记录确认仍要拦', 'kickoff-d', r16Prompt, [r16Ask, r16Write], 'block', () => kickoff.writePending(kickoffContext('kickoff-d', r16Prompt)));
const r16ProceedContext = kickoffContext('kickoff-e', r16Prompt);
r16Case('R16 已弹窗并 record proceed 放行', 'kickoff-e', r16Prompt, [r16Ask, r16Write], 'allow', () => { kickoff.writePending(r16ProceedContext); kickoffConfirm(r16ProceedContext, 'proceed'); });
const r16NoAskContext = kickoffContext('kickoff-f', r16Prompt);
const r16NoAsk = r16Case('R16 有 proceed 但无弹窗证据必须拦', 'kickoff-f', r16Prompt, [r16Write], 'block', () => { kickoff.writePending(r16NoAskContext); kickoffConfirm(r16NoAskContext, 'proceed'); });
check('R16 无弹窗证据的拦截原因可读', r16NoAsk.out.includes('没有 AskUserQuestion 弹窗证据'), true);
const r16CancelContext = kickoffContext('kickoff-g', r16Prompt);
const r16Cancel = r16Case('R16 用户取消后仍写入必须拦', 'kickoff-g', r16Prompt, [r16Write], 'block', () => { kickoff.writePending(r16CancelContext); kickoffConfirm(r16CancelContext, 'cancel'); });
check('R16 取消后的拦截原因可读', r16Cancel.out.includes('用户已取消本轮开工确认'), true);
r16Case('R16 上一轮 pending 不误伤新请求', 'kickoff-h', '把 README 的版本号改成 0.1.6', [r16Write], 'allow', () => kickoff.writePending(kickoffContext('kickoff-h', r16Prompt)));

// R17 收尾门禁：允许先只读检查，但本轮结束前必须出卡 + AskUserQuestion + record
function r17Case(label, session, prompt, tools, expected, setup, text = '处理完毕。') {
  if (setup) setup();
  const result = run({ transcript_path: transcript([user(prompt), ...tools, asst(text)]), session_id: session }, session, { KICKOFF_STATE_DIR: kickoffDir });
  check(label, result.decision, expected);
  if (expected === 'block') check(label + '（原因确为 R17）', result.out.includes('R17-kickoff-card-not-confirmed'), true);
  return result;
}
const r17Prompt = '优化导出功能的筛选条件';
r17Case('R17 只读检查后直接收尾必须拦', 'kickoff-i', r17Prompt, [tool('Bash', { command: 'ls src' }), tool('Read', { file_path: 'D:/x/a.ts' })], 'block', () => kickoff.writePending(kickoffContext('kickoff-i', r17Prompt)));
const r17AskedOnlyContext = kickoffContext('kickoff-j', r17Prompt);
r17Case('R17 已弹窗但未 record 不许收尾', 'kickoff-j', r17Prompt, [r16Ask], 'block', () => kickoff.writePending(r17AskedOnlyContext));
const r17ProceedContext = kickoffContext('kickoff-k', r17Prompt);
r17Case('R17 弹窗并 record proceed 放行', 'kickoff-k', r17Prompt, [r16Ask, tool('Bash', { command: 'git status --short' })], 'allow', () => { kickoff.writePending(r17ProceedContext); kickoffConfirm(r17ProceedContext, 'proceed'); });
const r17CancelContext = kickoffContext('kickoff-l', r17Prompt);
r17Case('R17 用户取消后允许收尾', 'kickoff-l', r17Prompt, [], 'allow', () => { kickoff.writePending(r17CancelContext); kickoffConfirm(r17CancelContext, 'cancel'); });
const r17AdjustContext = kickoffContext('kickoff-m', r17Prompt);
const r17Adjust = r17Case('R17 用户选调整后必须重新出卡', 'kickoff-m', r17Prompt, [r16Ask], 'block', () => { kickoff.writePending(r17AdjustContext); kickoffConfirm(r17AdjustContext, 'adjust'); });
check('R17 调整后的拦截原因可读', r17Adjust.out.includes('调整'), true);
r17Case('R17 纯问答不误拦', 'kickoff-n', '什么是闭包？', [], 'allow');
r17Case('R17 上一轮 pending 不误伤新请求', 'kickoff-o', '把 README 的版本号改成 0.1.6', [], 'allow', () => kickoff.writePending(kickoffContext('kickoff-o', r17Prompt)));
r17Case('R17 文本收尾也要先出卡', 'kickoff-p', r17Prompt, [], 'block', () => kickoff.writePending(kickoffContext('kickoff-p', r17Prompt)), '现状已核实，需要你先定口径。');

// P0-1 只读快速通道：纯审阅请求不要求开工卡，但同一轮出现写入仍要拦
const reviewPrompt = '审阅之前的实现，按你的理解，相关方案是否可以更优，请给出更优的建议';
kickoff.writePending(kickoffContext('kickoff-review', reviewPrompt));
const reviewOnly = run({ transcript_path: transcript([user(reviewPrompt), tool('Read', { file_path: 'D:/x/a.ts' }), asst('结论：建议先改 A。')]), session_id: 'kickoff-review' }, 'kickoff-review', { KICKOFF_STATE_DIR: kickoffDir });
check('R17 纯审阅请求不要求开工卡', reviewOnly.decision, 'allow');
const reviewWrite = run({ transcript_path: transcript([user(reviewPrompt), r16Write, asst('已修改。')]), session_id: 'kickoff-review2' }, 'kickoff-review2', { KICKOFF_STATE_DIR: kickoffDir });
check('R16 只读审阅轮出现写入必须拦', reviewWrite.decision, 'block');
check('R16 只读轮拦截原因指向只读授权', reviewWrite.out.includes('用户要求只读审阅'), true);

// 安装时选择"不常驻"：开工提示卡不注入，R16/R17 一并停用；其他规则不受影响
const kickoffDisabledPref = path.join(ROOT, 'kickoff-disabled.json');
fs.writeFileSync(kickoffDisabledPref, JSON.stringify({ schema: 1, resident: false }));
kickoff.writePending(kickoffContext('kickoff-q', r16Prompt));
const disabledWrite = run({ transcript_path: transcript([user(r16Prompt), r16Write, asst('处理完毕。')]), session_id: 'kickoff-q' }, 'kickoff-q', { KICKOFF_STATE_DIR: kickoffDir, KICKOFF_PREFERENCE_FILE: kickoffDisabledPref });
check('安装选择不常驻后 R16 不拦写入', disabledWrite.decision, 'allow');
kickoff.writePending(kickoffContext('kickoff-r', r17Prompt));
const disabledEnd = run({ transcript_path: transcript([user(r17Prompt), tool('Bash', { command: 'ls src' }), asst('处理完毕。')]), session_id: 'kickoff-r' }, 'kickoff-r', { KICKOFF_STATE_DIR: kickoffDir, KICKOFF_PREFERENCE_FILE: kickoffDisabledPref });
check('安装选择不常驻后 R17 不拦收尾', disabledEnd.decision, 'allow');

// ---------- R14：任务结束必须就"本任务临时文件"给出清理范围并询问（2026-11-09）----------
// 背景：临时清理器此前只能人工触发，超期件长期堆积；收尾必须主动列出本任务产物并弹窗确认。
const TMPROOT = path.join(ROOT, 'temp', 'qoder-work');
fs.mkdirSync(TMPROOT, { recursive: true });
const tempShot = path.join(TMPROOT, 'task-shot.png');
fs.writeFileSync(tempShot, 'x');
const userAt = (text, ms) => JSON.stringify({ type: 'user', timestamp: new Date(ms).toISOString(), message: { role: 'user', content: text } });
const turnStart = Date.now() - 60000;
const r14 = (sess, tools, text = '任务处理完毕。') => run({ transcript_path: transcript([userAt('请处理这个任务', turnStart), ...tools, asst(text)]), session_id: sess }, sess);

const r14a = r14('r14-a', []);
check('R14 本任务产生临时文件未处理必须拦', r14a.decision, 'block');
check('R14 拦截原因给出清理范围与文件', r14a.out.includes('R14-temp-artifacts-unhandled') && r14a.out.includes('清理范围') && r14a.out.includes('task-shot.png'), true);
check('R14 已弹窗询问清理范围并反馈放行', r14('r14-b', [tool('AskUserQuestion', { questions: [{ question: '本任务临时文件清理范围？', options: ['全部清理', '保留'] }] })], '已清理本轮临时产物 1 项。').decision, 'allow');
check('R14 仅 tmp-sweeper --apply 不能覆盖本轮新建产物', r14('r14-c', [tool('Bash', { command: 'node ~/.qoder/scripts/tmp-sweeper.js --apply' }, 'deleted 1')], '已清理本轮临时产物 1 项。').decision, 'block');
const roundJson = JSON.stringify({ root: TMPROOT, since: new Date(turnStart).toISOString(), apply: true,
  entries: [{ name: 'task-shot.png', path: tempShot }], deleted: [tempShot], failed: [], protected: [],
  recommended: { clean: [tempShot], preserve: [] } });
const roundApplyTool = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + turnStart + ' --apply --json' }, roundJson);
check('R14 已执行 tmp-round-scan --apply --json 并反馈放行', r14('r14-c2', [roundApplyTool], '已清理本轮临时产物 1 项。').decision, 'allow');
check('R14 清理后未反馈必须拦', r14('r14-c3', [roundApplyTool], '任务处理完毕。').decision, 'block');

const oldT = new Date(turnStart - 3600000);
fs.utimesSync(tempShot, oldT, oldT);
check('R14 文件早于本轮开始不拦', r14('r14-d', []).decision, 'allow');
fs.writeFileSync(tempShot, 'x');
check('R14 只读任务不拦', run({ transcript_path: transcript([userAt('只读审阅，不修改任何文件', turnStart), asst('审阅完毕。')]), session_id: 'r14-e' }, 'r14-e').decision, 'allow');
check('R14 无时间戳（判不了）不拦', run({ transcript_path: transcript([user('请处理这个任务'), asst('任务处理完毕。')]), session_id: 'r14-f' }, 'r14-f').decision, 'allow');

// 本地授权自动清理：autoClean.enabled=true（本机配置）
const autoCfgPath = path.join(ROOT, '.qoder', 'tmp-sweeper.json');
fs.mkdirSync(path.dirname(autoCfgPath), { recursive: true });
fs.writeFileSync(autoCfgPath, JSON.stringify({ canonicalRoot: TMPROOT, autoClean: { enabled: true, sharePackage: false } }));
const autoBlock = r14('r14-g', []);
check('R14 自动清理未执行必须拦', autoBlock.decision, 'block');
check('R14 拦截原因指向自动清理', autoBlock.out.includes('自动清理') && autoBlock.out.includes('--apply'), true);
check('R14 自动清理执行并反馈放行', r14('r14-h', [roundApplyTool], '已清理本轮临时产物 1 项。').decision, 'allow');
check('R14 自动清理后未反馈必须拦', r14('r14-i', [roundApplyTool], '任务处理完毕。').decision, 'block');
const futureApply = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + (Date.now() + 3600000) + ' --apply --json' }, roundJson);
check('R14 未来 since 不算闭环', r14('r14-k', [futureApply], '已清理本轮临时产物 1 项。').decision, 'block');
const oldApply = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + (turnStart - 11 * 60000) + ' --apply --json' }, roundJson);
check('R14 since 偏离本轮超过容差不算闭环', r14('r14-l', [oldApply], '已清理本轮临时产物 1 项。').decision, 'block');
const failedJson = JSON.stringify({ entries: [{ name: 'task-shot.png', path: tempShot }], deleted: [],
  failed: [{ path: tempShot, error: 'locked' }], protected: [], recommended: { clean: [tempShot], preserve: [] } });
const failedApply = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + turnStart + ' --apply --json' }, failedJson);
check('R14 清理失败不算闭环', r14('r14-m', [failedApply], '已清理本轮临时产物 1 项。').decision, 'block');
const uncoveredJson = JSON.stringify({ entries: [], deleted: [], failed: [], protected: [], recommended: { clean: [], preserve: [] } });
const uncoveredApply = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + turnStart + ' --apply --json' }, uncoveredJson);
check('R14 结果未覆盖探测条目不算闭环', r14('r14-n', [uncoveredApply], '已清理本轮临时产物 1 项。').decision, 'block');
const r14Share = r14('r14-j', [tool('Bash', { command: 'node scripts/install-package.cjs --yes' }, 'ok')]);
check('R14 分享包轮次交给 R15', r14Share.out.includes('R15-share-package-temp-scan-missing') && !r14Share.out.includes('R14-temp-artifacts-unhandled'), true);

// ---------- R15：使用分享包后默认每轮询问；授权时可自动清理，但都必须反馈（2026-11-09）----------
const r15 = (sess, tools, text = '分享包处理完毕。', prompt = '应用这个分享包') => run({ transcript_path: transcript([user(prompt), ...tools, asst(text)]), session_id: sess }, sess);
const pkgOp = tool('Bash', { command: 'node scripts/install-package.cjs --yes' }, 'ok');
const pkgScan = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --json' }, '{}');
const pkgAsk = tool('AskUserQuestion', { questions: [{ question: '本轮包产物的临时文件清理范围？', options: ['全部清理', '保留'] }] });
const pkgApply = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + turnStart + ' --apply --json' }, roundJson);
const pkgShareJson = JSON.stringify({ entries: [], deleted: [], failed: [], protected: [], recommended: { clean: [], preserve: [] } });
const pkgApplyShare = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + turnStart + ' --apply --include-share-package --json' }, pkgShareJson);
const pkgApplyShareNoSince = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --apply --include-share-package' }, 'deleted 2');
const shareReport = '已清理本轮包产物 2 项，保留回滚点 1 项。';
check('R15 分享包操作后未扫描未询问必须拦', r15('r15-a', [pkgOp]).decision, 'block');
check('R15 只扫描未询问仍拦', r15('r15-b', [pkgOp, pkgScan]).decision, 'block');
check('R15 只询问未扫描仍拦', r15('r15-c', [pkgOp, pkgAsk]).decision, 'block');
check('R15 已扫描并询问且反馈放行', r15('r15-d', [pkgOp, pkgScan, pkgAsk], shareReport).decision, 'allow');
check('R15 已询问但未反馈清理结果仍拦', r15('r15-f', [pkgOp, pkgScan, pkgAsk]).decision, 'block');
check('R15 未授权时自动清理不能代替询问', r15('r15-g', [pkgOp, pkgApplyShare], shareReport).decision, 'block');
check('R15 明确授权后自动清理并反馈放行', r15('r15-h', [pkgOp, pkgApplyShare], shareReport, '应用这个分享包，本轮授权自动清理，不用询问').decision, 'allow');
check('R15 授权模式必须清理包产物', r15('r15-i', [pkgOp, pkgApply], shareReport, '应用这个分享包，本轮授权自动清理，不用询问').decision, 'block');
check('R15 授权模式不能拆分两条命令凑条件', r15('r15-l', [pkgOp, pkgApplyShareNoSince, pkgApply], shareReport, '应用这个分享包，本轮授权自动清理，不用询问').decision, 'block');
check('R15 授权自动清理后未反馈仍拦', r15('r15-j', [pkgOp, pkgApplyShare], '分享包处理完毕。', '应用这个分享包，本轮授权自动清理，不用询问').decision, 'block');
check('R15 未用分享包不拦', r15('r15-e', [tool('Bash', { command: 'ls scripts' }, 'ok')]).decision, 'allow');
check('R15 否定授权不得跳过询问', r15('r15-m', [pkgOp, pkgApplyShare], shareReport, '应用这个分享包，不要自动清理，先问我').decision, 'block');
check('R15 “不用询问直接清理”仍是授权', r15('r15-n', [pkgOp, pkgApplyShare], shareReport, '应用这个分享包，不用询问，直接清理').decision, 'allow');
check('R15 “无需询问，直接清理”仍是授权', r15('r15-o', [pkgOp, pkgApplyShare], shareReport, '应用这个分享包，无需询问，直接清理').decision, 'allow');
// 有时间戳时，自动清理结果必须覆盖本轮探测到的条目（含普通产物），否则不算闭环
const r15At = (sess, tools, text) => run({ transcript_path: transcript([userAt('应用这个分享包，本轮授权自动清理，不用询问', turnStart), ...tools, asst(text)]), session_id: sess }, sess);
const pkgShareCoveredJson = JSON.stringify({ entries: [{ name: 'task-shot.png', path: tempShot }],
  deleted: [tempShot], failed: [], protected: [], recommended: { clean: [tempShot], preserve: [] } });
const pkgApplyShareCovered = tool('Bash', { command: 'node ~/.qoder/scripts/tmp-round-scan.cjs --since ' + turnStart + ' --apply --include-share-package --json' }, pkgShareCoveredJson);
check('R15 有时间戳：覆盖本轮条目才放行', r15At('r15-p', [pkgOp, pkgApplyShareCovered], shareReport).decision, 'allow');
check('R15 有时间戳：未覆盖本轮条目仍拦', r15At('r15-q', [pkgOp, pkgApplyShare], shareReport).decision, 'block');

// —— T-17 / C2：文档交付承认校验器为有效运行证据；改了源码仍必须有测试/构建 ——
const docValidator = tool('Bash', { command: 'node C:/Users/x/.qoder/skills/vibecoding-doc/scripts/check-vibecoding-doc.js docs/pkg' }, '结果：通过（0 个问题）');
const docWrite = tool('Write', { file_path: 'D:/proj/docs/pkg/spec.md', content: '# spec' });
const codeWrite = tool('Write', { file_path: 'D:/proj/scripts/foo.js', content: 'x' });
const r9run = (sess, tools, text = r9text) => run({ last_assistant_message: text, transcript_path: transcript([user('做文档'), ...tools, asst(text)]), session_id: sess }, sess);
check('C2 只改文档且跑过校验器则放行', r9run('c2-a', [docWrite, docValidator]).decision, 'allow');
check('C2 负对照：改了源码只跑校验器仍拦', r9run('c2-b', [codeWrite, docValidator]).decision, 'block');
check('C2 负对照：只改文档但没跑任何校验/测试仍拦', r9run('c2-c', [docWrite, tool('Bash', { command: 'ls docs' }, 'x')]).decision, 'block');
check('C2 负对照：校验器失败不算证据', r9run('c2-d', [docWrite, tool('Bash', { command: 'node check-vibecoding-doc.js docs/pkg' }, '结果：3 个问题', true)]).decision, 'block');

// —— T-17 / C3：只读提及 install-package.cjs 不是包操作；真实构建/发布调用是 ——
check('C3 grep 只读检查 install-package.cjs 不触发 R15', r15('c3-a', [tool('Bash', { command: 'grep -n "copy-script" scripts/install-package.cjs' }, '12: x')]).decision, 'allow');
check('C3 sed 只读查看 install-package.cjs 不触发 R15', r15('c3-b', [tool('Bash', { command: 'sed -n "1,20p" scripts/install-package.cjs' }, 'x')]).decision, 'allow');
check('C3 负对照：真实调用 install-package.cjs 仍触发', r15('c3-c', [pkgOp]).decision, 'block');
check('C3 负对照：真实调用 build-release.js 仍触发', r15('c3-d', [tool('Bash', { command: 'node .github/build-release.js v0.1.6 D:/out HEAD' }, 'BUILT')]).decision, 'block');
check('C3 负对照：真实调用 publish-release.js 仍触发', r15('c3-e', [tool('Bash', { command: 'node .github/publish-release.js v0.1.6 D:/out' }, 'PUBLISHED')]).decision, 'block');

console.log(results.join('\n'));

const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(`\n${n - failed}/${n} passed; cases=${n}`);
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch (e) {}
process.exit(failed ? 1 : 0);
