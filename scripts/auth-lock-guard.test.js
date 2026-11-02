#!/usr/bin/env node
// auth-lock-guard 自测：**违规必红 + 对照必绿**
// 红：同一目标连败到阈值必须拦；锁定签名一次即拦；懒加载 mcp_call 形态必须识别目标
// 绿：不同主机+不同账号必须放行；连接被拒/超时不得计数；只读成功必须清零；非数据目标不得留台账噪声
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SB = path.join(os.tmpdir(), `auth-lock-${Date.now()}`);
const STATE = path.join(SB, 'state');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 150) : ''}`); if (!ok) fail++; };

const reset = () => { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch (e) {} fs.mkdirSync(STATE, { recursive: true }); };
// 真实状态目录快照：沙箱自测**绝不允许**写进 ~/.qoder/tmp（写进去就会污染真机门禁的判断）。
// 同时盯 state.json 与 decisions.log：只看 state.json 会漏——allow 类判定只进台账。
const REAL_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.qoder', 'tmp', 'auth-lock-guard');
const snapReal = () => {
  const g = (f) => { try { return fs.readFileSync(path.join(REAL_DIR, f), 'utf8'); } catch (e) { return '<absent>'; } };
  return g('state.json') + '@@' + g('decisions.log');
};
const REAL_BEFORE = snapReal();
// PreToolUse 半边自 2026-10-21 起挂在 risky-match-guard.js 上（判据仍是 auth-lock-core.js）：
// 所以 Pre 事件必须 spawn **那个**入口，否则测的是"已不存在的接线"，全绿也是假绿。
const POST_SCRIPT = path.join(__dirname, 'auth-lock-guard.js');
const PRE_SCRIPT = path.join(__dirname, 'risky-match-guard.js');
const RSTATE = path.join(SB, 'risky-state');
const SESS = 'algtest';
// Pre 入口现在先过"记忆优先"门禁；本套件测的是认证计数，所以给这个会话预置"已查过记忆"，
// 否则首次 execute_sql 会被 memory-first 顶掉——断言只看 blocked 就是假绿。
try { fs.mkdirSync(RSTATE, { recursive: true }); fs.writeFileSync(path.join(RSTATE, 'memory-first.json'), JSON.stringify({ [SESS]: { memSeen: true, warned: {} } })); } catch (e) {}
const spawn = (script, payload, extra) => {
  const r = spawnSync(process.execPath, [script, ...(extra || [])], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8', timeout: 15000,
    env: {
      ...process.env, AUTH_LOCK_STATE_DIR: STATE, AUTH_LOCK_CONFIG: path.join(SB, 'no-such-config.json'),
      RISKY_MATCH_STATE_DIR: path.join(SB, 'risky-state'),   // risky-match-guard 自己的台账也隔离到沙箱
    },
  });
  let d = {};
  try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
  return { code: r.status, blocked: d.decision === 'block', reason: d.reason || '', out: r.stdout || '' };
};
const pre = (payload) => spawn(PRE_SCRIPT, Object.assign({ hook_event_name: 'PreToolUse', session_id: SESS }, payload));
const post = (payload, resp) => spawn(POST_SCRIPT, Object.assign({ hook_event_name: 'PostToolUse', session_id: SESS, tool_response: resp }, payload));
const AUTHERR = 'FATAL:  password authentication failed for user "probe_appuser"';
const LOCKERR = 'Too many invalid attempts. Please contact the syssso user to unlock.';
// 只走 dbhub MCP 时，调用文本里**只有 server 别名**，主机/账号要靠返回里的报错补全
const dbhub = (srv) => ({ tool_name: 'mcp_call', tool_input: { toolName: 'mcp__dbhub__execute_sql_' + srv, arguments: { sql: 'SELECT 1' } } });
const ledger = () => { try { return fs.readFileSync(path.join(STATE, 'decisions.log'), 'utf8'); } catch (e) { return ''; } };

// —— 必须拦（红）——
reset();
check('① 第 1、2 次认证失败：只记账不拦',
  !post(dbhub('prod_a'), AUTHERR).blocked && !post(dbhub('prod_a'), AUTHERR).blocked);
const third = post(dbhub('prod_a'), AUTHERR);
check('② 第 3 次（=阈值）必须当场叫停并把"停手"送到模型眼前', third.blocked && /停手/.test(third.reason), third.reason);
const fourth = pre(dbhub('prod_a'));
check('③ 已拦后再调同一目标：合并后的 Pre 入口（risky-match-guard）硬拦',
  fourth.blocked && /^\[auth-lock\]/.test(fourth.reason), fourth.reason);
check('④ 换工具形态绕（直连限定名工具名）同一 srv：仍拦',
  pre({ tool_name: 'mcp__dbhub__execute_sql_prod_a', tool_input: { sql: 'SELECT 1' } }).blocked);
check('⑤ 换 shell 直连、但报错里出现过同一账号：按 user 维度仍拦',
  pre({ tool_name: 'Bash', tool_input: { command: 'psql -h 203.0.113.10 -U probe_appuser -c "select 1"' } }).blocked,
  '报错原文含 user "probe_appuser"，应被并入同一目标');
for (const command of [
  'ssh operator@203.0.113.9 "psql -h 203.0.113.10 -U probe_appuser -c SELECT"',
  'ssh -p 2222 -o BatchMode=yes operator@203.0.113.9 "psql -h 203.0.113.10 -U probe_appuser -c SELECT"',
  'plink -batch -P 2222 operator@203.0.113.9 "psql -h 203.0.113.10 -U probe_appuser -c SELECT"',
  'ssh operator@203.0.113.10 "psql -U probe_appuser -c SELECT"',
]) check('⑤b 远程 shell 内真实数据库入口仍使用同一认证预算',
  pre({ tool_name: 'Bash', tool_input: { command } }).blocked, command);
const beforeQuotedRemote = ledger();
check('⑤c 远程输出数据库命令文本不发起连接、不计账',
  !pre({ tool_name: 'Bash', tool_input: { command: 'ssh probe_appuser@203.0.113.10 "echo \'psql -h 203.0.113.10 -U probe_appuser\'"' } }).blocked
  && ledger() === beforeQuotedRemote);

reset();
const lock = post(dbhub('prod_b'), LOCKERR);
check('⑥ 单次即出现"锁定签名"：一次就拦（不再凑满 3 次）', lock.blocked && /锁定签名/.test(lock.reason), lock.reason);
check('⑦ 锁定后同目标再调：PreToolUse 拦', pre(dbhub('prod_b')).blocked);

reset();
check('⑧ 懒加载 mcp_call 形态能识别目标（台账按 srv 记账）',
  !post(dbhub('prod_c'), AUTHERR).blocked && /authfail\|prod_c/.test(ledger()), ledger().slice(-200));

// —— 必须放行（负对照，防"什么都拦"）——
reset();
post(dbhub('prod_d'), AUTHERR); post(dbhub('prod_d'), AUTHERR); post(dbhub('prod_d'), AUTHERR);
check('⑨ 负对照：prod_d 已拦，不同 srv/主机/账号的调用照样放行',
  !pre(dbhub('prod_e')).blocked
  && !pre({ tool_name: 'Bash', tool_input: { command: 'psql -h 203.0.113.11 -U otheruser -c "select 1"' } }).blocked);
check('⑩ 负对照：与数据库无关的普通命令一律放行',
  !pre({ tool_name: 'Bash', tool_input: { command: 'ls -la build/ && grep -rn foo src' } }).blocked);
check('⑪ 负对照：非数据目标的调用不写台账（不制造噪声）',
  !/ls -la build/.test(ledger()) && !/grep -rn/.test(ledger()));
// 回归：首跑真机发现普通命令里的 `-u 3_40`、`a@b` 片段被抽成假账号键（台账真出现过 3_40/4_47/5_50）
// → Bash 文本必须先出现数据库客户端入口才解析 host/user，否则假键撞上真账号就是误拦
reset();
check('⑪b 回归：非 DB 客户端命令里的 -u / x@y 片段不建目标、不留台账',
  !pre({ tool_name: 'Bash', tool_input: { command: 'git commit -u 3_40 && echo a@b.com' } }).blocked
  && ledger() === '', ledger());
check('⑪c 对照：同一条命令换成 psql 客户端 → 正常建目标并留台账',
  !pre({ tool_name: 'Bash', tool_input: { command: 'psql -h 203.0.113.10 -U realuser -c "select 1"' } }).blocked
  && /eval\|allow\|-\/203\.0\.113\.10\/realuser/.test(ledger()), ledger());
// 回归：真机发现 Edit/Write 的 new_string 里**引用** psql 字符串（写测试/写文档必然出现）也会建目标
reset();
check('⑪d 回归：非 shell/DB 工具（Edit）载荷里引用 psql 命令 → 不建目标、不留台账',
  !pre({ tool_name: 'Edit', tool_input: { file_path: '/x/t.test.js', new_string: 'psql -h 203.0.113.10 -U probe_appuser -c "select 1"' } }).blocked
  && ledger() === '', ledger());

reset();
post(dbhub('prod_f'), AUTHERR); post(dbhub('prod_f'), AUTHERR);
const okOnce = post(dbhub('prod_f'), '{"rows":[{"n":1}]}');
check('⑫ 一次成功返回：清零（不该把历史失败一直背着）', !okOnce.blocked);
check('⑬ 清零后再败 1 次：仍不拦（n=1 < 3）', !post(dbhub('prod_f'), AUTHERR).blocked);

reset();
const refused = post(dbhub('prod_g'), 'psql: could not connect to server: Connection refused');
const timeout = post(dbhub('prod_g'), 'java.sql.SQLRecoverableException: IO Error: The connection attempt timed out');
check('⑭ 连接被拒/超时＝中性：既不计数也不清零', !refused.blocked && !timeout.blocked && !/authfail\|prod_g/.test(ledger()), ledger());
check('⑮ 中性之后按真实认证失败计数：1、2 放行，3 拦',
  !post(dbhub('prod_g'), AUTHERR).blocked && !post(dbhub('prod_g'), AUTHERR).blocked && post(dbhub('prod_g'), AUTHERR).blocked);

reset();
post(dbhub('prod_h'), AUTHERR); post(dbhub('prod_h'), AUTHERR);
check('⑯ 普通 SQL 语法错＝凭据是通的：清零，不刷阈值',
  !post(dbhub('prod_h'), 'ERROR:  syntax error at or near "SELEC"').blocked
  && !post(dbhub('prod_h'), AUTHERR).blocked);

// —— 人工解除 ——
reset();
post(dbhub('prod_i'), LOCKERR);
check('⑰ --clear ALL 之前一直拦', pre(dbhub('prod_i')).blocked);
const cleared = spawn(POST_SCRIPT, Object.assign({ hook_event_name: 'PreToolUse' }, dbhub('prod_i')), ['--clear', 'ALL']);
check('⑱ --clear ALL 解除后可放行（--clear 自身退 0 并回报）', /"cleared":1/.test(cleared.out), cleared.out);
check('⑲ 解除后同一目标 PreToolUse 放行', !pre(dbhub('prod_i')).blocked);

// —— fail-open（守卫崩了不能卡住会话）——
const garbage = spawnSync(process.execPath, [POST_SCRIPT], { input: 'not json at all {{{', encoding: 'utf8', timeout: 15000, env: { ...process.env, AUTH_LOCK_STATE_DIR: STATE, AUTH_LOCK_CONFIG: path.join(SB, 'none.json') } });
check('⑳ 垃圾 stdin：退 0、不输出（fail-open，绝不卡会话）', garbage.status === 0 && !garbage.stdout);
// 合并的代价必须被盯住：risky-match-guard 自己 2026-10-08 那条职责不能被新入口吃掉
reset();
post(dbhub('prod_j'), LOCKERR);
const rm = pre({ tool_name: 'Bash', tool_input: { command: 'rm -rf build/*' } });
check('㉒ 合并后两条职责互不吞：已有锁定目标时，按匹配删除仍被 risky-match-guard 自己拦下',
  rm.blocked && /risky-match-guard/.test(rm.reason), rm.reason);
const sqlm = pre({ tool_name: 'mcp__dbhub__execute_sql_prod_k', tool_input: { sql: 'DELETE FROM t_config' } });
check('㉓ 合并后无 WHERE 的 DELETE 仍拦（该入口没被 auth-lock 的 allow 分支短路）',
  sqlm.blocked && /WHERE/.test(sqlm.reason), sqlm.reason);
check('㉑ 沙箱自测未污染真实状态目录（跑前跑后逐字节一致）', snapReal() === REAL_BEFORE,
  'before=' + REAL_BEFORE.slice(0, 40) + ' after=' + snapReal().slice(0, 40));

try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? `\nFAIL: ${fail} 条判据未过` : '\n全部通过（红/对照双向可失败）');
process.exit(fail ? 1 : 0);
