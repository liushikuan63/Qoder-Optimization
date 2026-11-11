#!/usr/bin/env node
// PreToolUse 门禁：**按匹配做的风险操作，先预览命中范围再执行**（用户 2026-10-08 全局要求）。
// 2026-10-21 起还兼作**认证锁库门禁的 PreToolUse 入口**（判据在 auth-lock-core.js，见文件末尾委托）。
//
// 为什么只拦这几类：守卫噪声多就会被忽略（本项目实测教训），所以判据**宁窄勿宽**——
// 只拦"一次错就把正常内容一起带走"的形态，且每条都给出"先跑什么、再怎么做"的可执行改法：
//   ① rm -r/-rf 带通配或目录通配（rm -rf dir/*  ← 范围失控的经典形态）
//   ② find … -delete / -exec rm（删除前连命中清单都没看）
//   ③ pkill -f / killall / taskkill /IM（按模式杀进程，模式一宽全机遭殃）
//   ④ SQL DELETE/UPDATE 没有 WHERE（或 WHERE 恒真）——经数据库 MCP 执行时
// 放行：不带通配的定点删除（rm file / rm -rf ./build）、带 WHERE 的 SQL、pgrep 这类只读预览。
// 关闭：~/.qoder/risky-match-guard.json 写 {"disabled":true}
// 台账：~/.qoder/tmp/risky-match-guard/decisions.log
'use strict';
require('./hook-crash-guard.js').install('risky-match-guard');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG = path.join(CLIENT_ROOT, 'risky-match-guard.json');
const STATE_DIR = process.env.RISKY_MATCH_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'risky-match-guard');
try { if (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).disabled) process.exit(0); } catch {}

const ledger = (row) => {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(STATE_DIR, 'decisions.log'), new Date().toISOString() + '|' + row + '\n'); } catch {}
};

const PREVIEW = '先只读预览命中范围：列出会被影响的清单（`ls`/`pgrep -af`/`SELECT`），核对数量与边界——'
  + '再带一条**负对照**（本该不被命中的样例确实不在清单里），确认无误后才执行。';

function checkBash(cmd) {
  const c = String(cmd || '');
  // ① rm **递归**删除带通配（rm -rf dir/* / rm -r *）。判据刻意收窄到"递归"：
  //    非递归的 `rm -f *.tar.gz` 是常规清理，拦它会变成噪声（本项目实测教训：噪声多就被忽略）。
  //    首跑实测：真机上它拦下了我自己的一条 `rm -f <包目录>/*.tar.gz`，说明接线生效——同时也说明判据偏宽，故收窄。
  if (/\brm\b[^|;&]*\s-[a-zA-Z]*(r|R)[a-zA-Z]*\b[^|;&]*[*?]/.test(c)
      || /\brm\b[^|;&]*\s-[a-zA-Z]*(r|R)[a-zA-Z]*\s+[^\s|;&]*[*?]/.test(c)
      // 长选项与短选项语义等价：`rm --recursive --force dir/*` 旧实现漏网（实测 ALLOW）。
      || /\brm\b[^|;&]*\s--recursive\b[^|;&]*[*?]/.test(c)
      || /\brm\b[^|;&]*\s--recursive\s+[^\s|;&]*[*?]/.test(c)) {
    return '检测到 **递归** `rm -r/-rf` 带通配（匹配范围可能远超预期）。' + PREVIEW + '改法：先 `ls <通配>` 看清单 → 再把命令换成显式路径列表（或先 `mkdir` 出待删目录再按目录删）。';
  }
  // ② find -delete / -exec rm
  if (/\bfind\b[^|;&]*(?:-delete|-exec\s+rm\b)/.test(c)) {
    return '检测到 `find … -delete` / `-exec rm`（按匹配删）。' + PREVIEW + '改法：先跑**不带** `-delete` 的同一条 find 看命中数与样例，再把结果落成显式清单执行。';
  }
  // ③ 按模式杀进程
  if (/\b(pkill|killall)\b/.test(c) || /\btaskkill\b[^|;&]*\/IM\b/i.test(c)) {
    return '检测到按模式/镜像名杀进程（模式一宽会连正常服务一起杀）。' + PREVIEW + '改法：先 `pgrep -af <模式>`（或 `tasklist | grep`）看命中 PID 与命令行，再按**精确 PID** 逐个 kill；涉及共享服务先给用户确认。';
  }
  // ④ 命令行客户端里的 SQL（2026-10-26 借鉴 DSH sql-risk 的逐段检查）：
  //    MCP 的 execute_sql 已被 checkSql 覆盖，但从 Bash 走 psql/mysql -c 会绕过它。
  //    判据仍宁窄勿宽：只解析客户端 + -c/-e/--command/--execute 的引号负载，不对整条命令做关键词匹配。
  if (SQL_CLIENT.test(c)) {
    for (const payload of shellSqlPayloads(c)) {
      const v = sqlVerdict(payload);
      if (v) return '命令行客户端将执行风险 SQL（' + SQL_CLIENT.exec(c)[0] + '）：' + v;
    }
  }
  return null;
}

const SQL_CLIENT = /\b(psql|mysql|mariadb|sqlcmd|sqlite3|duckdb)\b/i;
function shellSqlPayloads(cmd) {
  const out = [];
  const re = /(?:-c|-e|--command|--execute)\s+(['"])([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[2]);
  if (/\bsqlite3\b/i.test(cmd)) {
    const re2 = /\bsqlite3\b[^\n]*?\s+(['"])((?:(?!\1)[\s\S])*)\1/g;
    while ((m = re2.exec(cmd))) out.push(m[2]);
  }
  return out;
}

function sqlVerdict(sql) {
  // 先剥注释再判定：`DELETE /*c*/ FROM t` 与 `DELETE FROM t` 语义相同，
  // 旧实现被注释插入绕过（实测 ALLOW），而该语句会删全表。
  const up = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').toUpperCase();
  if (!up.trim()) return null;
  if (/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+(TABLE\s+)?)\b/.test(up)) {
    return '检测到 DROP / TRUNCATE（结构破坏不可逆）。' + PREVIEW
      + '改法：先确认目标库与表、备份或导出（给回滚方式），再按**显式表名**执行；生产库与共享库须先经用户确认。';
  }
  const noWhere = /\b(DELETE\s+FROM|UPDATE)\b/.test(up) && !/\bWHERE\b/.test(up);
  const alwaysTrue = /\bWHERE\b\s*(1\s*=\s*1|TRUE)\b/.test(up);
  if (noWhere || alwaysTrue) {
    return '检测到**没有有效 WHERE** 的 DELETE/UPDATE' + (alwaysTrue ? '（WHERE 恒真）' : '') + '。' + PREVIEW
      + '改法：先把同条件的 `SELECT count(*)`/`SELECT *` 跑一遍核对影响面（含"应不在范围内"的负例），再带**明确的 WHERE 或主键列表**执行；本机数据库工具是只读的，真执行前先备份并给回滚方案。';
  }
  return null;
}

function checkSql(toolName, input) {
  const name = String(toolName || '');
  if (!/execute_sql/.test(name)) return null;
  const sql = String((input && (input.sql || input.query || input.statement)) || '');
  if (!sql) return null;
  return sqlVerdict(sql);
}

// ---- 记忆优先门禁（2026-10-21 用户全局要求：一切操作优先看记忆，记忆有的先用记忆试；无命中/不可用再自行推理）----
// 为什么做成 hook 而不是只写规则：`AGENTS 工具选用`那条"先查已有"讲的是**工具**，
// "先查记忆"此前只活在记忆自己里（`feedback-check-memory-first`）——需要它的人恰恰是没去读它的人，
// 提示词在这里是自指失效的。机制只堵"本会话一次记忆都没读过就要动风险目标"这一格，
// **每类只提醒一次**（噪声多就被忽略，见本文件头），读过记忆或已提醒过即放行。
// 关掉：~/.qoder/risky-match-guard.json 写 {"memoryFirst":false}
const MF_STATE = path.join(STATE_DIR, 'memory-first.json');
// 记忆读取的证据面：只有真的打开记忆条目/索引才算"查过"（SearchKnowledge 也算）
const MF_READ_TOOL = /^(Read|Grep|Glob|SearchKnowledge|read_chat_session)$/i;
const MF_MEM_PATH = /[\\/]memory[\\/]|MEMORY\.md|SearchKnowledge/i;
// 风险目标分类（宁窄勿宽：只列"记忆里通常有现成口径、猜错代价大"的形态）
const MF_RISK = [
  ['远程登录与拷贝', /\b(ssh|scp|sftp|plink|pscp|telnet)\b|10\.\d+\.\d+\.\d+/i],
  ['数据库与中间件连接', /\b(psql|mysql|mariadb|sqlplus|sqlcl|sqlcmd|gsql|beeline|sqlline|redis-cli|mongo(?:sh)?)\b|jdbc:|execute_sql/i],
  ['服务启停与进程', /\b(systemctl|service|supervisorctl|taskkill|killall)\b|\bnet\s+start\b|\bsc\s+(start|stop)\b|\bpkill\b/i],
  // curl 只算"状态变更"的对外动作：只读 GET 是日常（查公开页、健康检查），
  // 用 curl 的**存在**当风险会天天误拦（2026-10-26 实测：查公开活动页被拦）。
  ['对外与部署动作', /\bgit\s+push\b|\bsvn\s+commit\b|\bsvn\s+(update|checkout)\b|Invoke-WebRequest[^|;&]*-(?:Method|Body|InFile)\b/i],
];
const MF_CURL_WRITE = /\bcurl\b[^|;&]*?(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s-d\b|\s--data(?:-\w+)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b)/i;
// 只看"能真正执行到"的那段文本：剥掉 heredoc 正文和引号里的字面量。
// 2026-10-27 实测：`cat >> README <<'EOF'` 的文档正文里提到 curl，被当成"要发请求"拦下。
function executableText(cmd) {
  const c = String(cmd || '');
  const head = c.split(/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/)[0];
  const target = c.includes('<<') ? head : c;
  return target.replace(/"[^"\n]*"|'[^'\n]*'/g, ' ');
}
function mfLoad() { try { return JSON.parse(fs.readFileSync(MF_STATE, 'utf8')); } catch { return {}; } }
function mfSave(s) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(MF_STATE, JSON.stringify(s)); } catch {} }
function checkMemoryFirst(sess, tool, ti) {
  // 本文件没有 cfg() 助手（配置只在第 23 行内联读一次），这里同样直接读，别凭空调不存在的函数
  // ——那会让整个守卫抛错走 fail-open，连"拦 rm -rf"的既有职责一起失效。
  try { if (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).memoryFirst === false) return null; } catch {}
  const st = mfLoad();
  const k = String(sess || 'nosess').slice(0, 16);
  const s = st[k] || (st[k] = { memSeen: false, warned: {} });
  const t = String(tool || '');
  const blob = t + ' ' + JSON.stringify(ti || {});
  // ① 先认"查过记忆"的证据（必须在工具面收窄之前：Read/Grep 本身不是 actor，否则永远标不上）
  if (MF_READ_TOOL.test(t) && MF_MEM_PATH.test(blob)) {
    if (!s.memSeen) { s.memSeen = true; mfSave(st); ledger('memory-first|seen|' + k); }
    return null;
  }
  // ② **只算"真的动手"的工具面**：Bash/Shell 与 MCP 调用。接线后首跑实测：Edit 的 new_string 里
  // 只要出现 `execute_sql` / `ssh` 这类关键词就被拦（我改这个文件时自己撞上了）——
  // "引用一段字符串"不等于"要连库/要上服务器"，与 auth-lock 修过的假目标键同一类问题。
  const isActor = /^(bash|shell|cmd|powershell|terminal|zsh)$/i.test(t)
    || /^mcp_call$/i.test(t) || /execute_sql|dbhub|workflow_ops|sqlplus|psql|mysql/i.test(t);
  if (!isActor || s.memSeen) return null;
  // ③ 取"动作本体"再匹配：Bash 只看可执行段（剥 heredoc/引号），mcp_call 看真工具名+参数
  const isShell = /^(bash|shell|cmd|powershell|terminal|zsh)$/i.test(t);
  const act = isShell ? executableText(ti.command) : blob;
  let hit = null;
  for (const [name, re] of MF_RISK) { const m = act.match(re); if (m) { hit = { name, frag: String(m[0]).slice(0, 30) }; break; } }
  if (!hit && isShell && MF_CURL_WRITE.test(act)) hit = { name: '对外与部署动作', frag: 'curl 写请求' };
  if (!hit) return null;
  if (s.warned[hit.name]) return null;   // 同类只提醒一次，不唠叨
  s.warned[hit.name] = true;
  mfSave(st);
  ledger('memory-first|warn|' + hit.name + '|' + k);
  return '**本会话还没读过任何记忆条目**，就要做「' + hit.name + '」类操作（命中片段 `' + hit.frag + '`）。'
    + '按用户全局要求：**一切操作优先看记忆，记忆有的先用记忆试**——先在 `~/.qoder/memory/MEMORY.md`（及项目 `memory/`）按目标找条目并 `Read` 它：'
    + '服务器地址 / 端口 / 路径 / 凭据文件位置 / 启动脚本 / 现役配置口径 / 已知坑 / 编号规则。'
    + '**命中** → 照条目做，不要重新猜或重新探测；**无命中或记忆不可用** → 再自行检索推理，并在汇报里标注「记忆无此项」。'
    + '同类本会话只提醒这一次；读过一次记忆后即静默放行。关闭：`~/.qoder/risky-match-guard.json` 写 `{"memoryFirst":false}`。';
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let input = {};
try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
const tool = input.tool_name || input.toolName || '';
const ti = input.tool_input || input.toolInput || {};
// 认证锁库门禁的 PreToolUse 半边（2026-10-21 按用户要求并入，避免为"失败计数"再单挂一个 hook）。
// 判据与状态**全在 auth-lock-core.js**，这里只是多一个入口；开关也各自独立（auth-lock-guard.json 的 disabled）。
// 顺序：auth-lock 在前——它拦的是"对已锁目标再发一次连接"，属于**硬停**；记忆门禁是一次性提醒，
// 谁先出声就只能给一条理由，硬停必须赢（实测：反过来会让变异验证拿到 [memory-first] 的假结果）。
try {
  const al = require('./auth-lock-core.js').preCheck(input);
  if (al && al.reason) {
    ledger('block|auth-lock|' + String(al.key || '').slice(0, 60));
    console.log(JSON.stringify({ decision: 'block', reason: al.reason }));
    process.exit(0);
  }
} catch (e) {
  // fail-open：本守卫的既有职责不因新入口而中断。但**崩了必须留痕**——静默 catch 会让 Pre 半边
  // 悄悄失效（"看着没事"就是假绿）。台账写在自己的 decisions.log 里（不能用 core 的 ledger：
  // core 文件缺失正是这里最常见的一种崩法，拿它记日志会连日志一起抛掉）。
  try { ledger('auth-lock-pre-error|' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 140)); } catch (e2) {}
}
// 连败计数器（2026-10-27）：构建 / 测试 / 部署同类连败达到阈值后，下一次同类调用直接拦。
// 判据在 attempt-lock-core.js；PostToolUse 半边在 attempt-lock-guard.js（看返回记账）。
// 顺序与 auth-lock 相同：硬停优先于提醒类守卫。
try {
  const att = require('./attempt-lock-core.js').preCheck(input);
  if (att && att.reason) {
    ledger('block|attempt-lock|' + String(att.key || '').slice(0, 60));
    console.log(JSON.stringify({ decision: 'block', reason: att.reason }));
    process.exit(0);
  }
} catch (e) {
  try { ledger('attempt-lock-pre-error|' + String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 140)); } catch (e2) {}
}
// 记忆优先门禁（2026-10-21 用户全局要求）：在硬停之后、按匹配删除判据之前
const mfVerdict = checkMemoryFirst(input.session_id || input.sessionId || '', tool, ti);
if (mfVerdict) {
  ledger('block|memory-first|' + String(ti.command || '').slice(0, 60));
  console.log(JSON.stringify({ decision: 'block', reason: '[memory-first] ' + mfVerdict }));
  process.exit(0);
}
const verdict = /bash/i.test(tool) ? checkBash(ti.command) : checkSql(tool, ti);
if (!verdict) { ledger('allow|' + tool); process.exit(0); }
ledger('block|' + tool + '|' + String(ti.command || ti.sql || '').slice(0, 80));
console.log(JSON.stringify({
  decision: 'block',
  reason: '[risky-match-guard] ' + verdict,
}));
process.exit(0);
