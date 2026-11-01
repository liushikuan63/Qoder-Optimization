#!/usr/bin/env node
// auth-lock-guard.js —— **PostToolUse 半边入口：认证失败累计到阈值即硬拦，防止"重试到把账号锁死"**
// （判据真源在 `auth-lock-core.js`；PreToolUse 半边 2026-10-21 按用户要求并入 `risky-match-guard.js`，
//  不再单独挂第 7 个 hook。本文件只做：读 stdin → 调 core.postRecord → 需要时出声；外加人工 CLI。）
//
// 事故背景（为什么非做不可）：部署前从 `application-prod.yml` 提取生产库密码，该文件 99 行 CRLF，
// 按行截取的值带尾部 `\r`，连发 **10 次**"错密码"把账号锁到 `Too many invalid attempts ... syssso user to unlock`
// ——解锁只能由 sysso/DBA 手工做。规则里早就有"同类修复连败三次即停"，但它是**纯提示词**：
// 全仓 grep `三次|连败|consecutive|failCount` 在所有 hook 里命中 0 条，没有任何失败计数器。
//
// 判据（宁窄勿宽：守卫噪声多就会被忽略）：
//   ① 只对"明显在连某个数据目标"的调用建账：dbhub execute_sql_* / jdbc / psql / mysql / sqlplus / redis-cli；
//   ② 认证/锁定类签名才计数；连接被拒/超时＝中性（不计数也不清零）；普通 SQL 语法错＝凭据是通的 → 清零；
//   ③ 同一目标累计 threshold（默认 3）次即拦，直到人工 `--clear`；出现锁定签名一次即拦；
//   ④ 目标同一性 = srv / host / user 任一维度相同（宁可多拦一次问用户，也不能再赌一次锁定）。
// 关闭：~/.qoder/auth-lock-guard.json 写 {"disabled":true}；threshold/dims/ttlHours 同文件可配
// 台账与状态：~/.qoder/tmp/auth-lock-guard/{decisions.log,state.json}
// 自测：node auth-lock-guard.test.js（24 组红/对照双向；沙箱用 AUTH_LOCK_STATE_DIR 隔离）
'use strict';
require('./hook-crash-guard.js').install('auth-lock-guard');
const core = require('./auth-lock-core.js');

function out(o) { process.stdout.write(JSON.stringify(o)); }
function readStdin() {
  try { return require('fs').readFileSync(0, 'utf8'); } catch (e) {
    const chunks = []; const buf = Buffer.alloc(65512);
    try { let r; while ((r = require('fs').readSync(0, buf, 0, buf.length, 0)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

// ---- CLI（人工查看与解除；解封是人的决定，不给自动路径）----
const argv = process.argv.slice(2);
if (argv.includes('--status')) { out(core.status()); process.exit(0); }
if (argv.includes('--clear')) {
  if (argv.length !== 2 || argv[0] !== '--clear' || !argv[1] || argv[1].startsWith('--')) {
    console.error('用法: --clear <精确目标键|ALL>');
    process.exit(2);
  }
  out({ cleared: core.clear(argv[1]) });
  process.exit(0);
}

let p; try { p = JSON.parse(readStdin() || '{}'); } catch (e) { process.exit(0); }
if (String(p.hook_event_name || 'PostToolUse') !== 'PostToolUse') process.exit(0);
const r = core.postRecord(p);
if (r && r.reason) out({ decision: 'block', reason: r.reason });
process.exit(0);
