#!/usr/bin/env node
// attempt-lock-guard.js —— **PostToolUse 半边入口：构建/测试/部署同类连败三次即停**
// （判据真源在 attempt-lock-core.js；PreToolUse 半边并入 risky-match-guard.js，不再单挂一个 Pre hook。）
//
// 事故背景：AGENTS 里"同类操作连败 3 次必须停手上报"此前只有数据库认证被机械化过；
// 构建/部署失败的重试没有任何计数器——同一个 `npm run build` 连跑六次、每次只换一句解释，是常见形态。
//
// 本文件只做：读 stdin → 调 core.postRecord → 需要时出声；外加人工 CLI（--status / --clear）。
// 关闭：~/.qoder/attempt-lock.json 写 {"disabled":true}
// 自测：node attempt-lock-guard.test.js
'use strict';
require('./hook-crash-guard.js').install('attempt-lock-guard');
const core = require('./attempt-lock-core.js');

function out(o) { process.stdout.write(JSON.stringify(o)); }
function readStdin() {
  try { return require('fs').readFileSync(0, 'utf8'); } catch (e) {
    const chunks = []; const buf = Buffer.alloc(65512);
    try { let r; while ((r = require('fs').readSync(0, buf, 0, buf.length, 0)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--status')) { out(core.status()); process.exit(0); }
if (argv.includes('--clear')) {
  const i = argv.indexOf('--clear'), arg = argv[i + 1];
  out({ cleared: core.clear(!arg || arg.startsWith('--') ? 'ALL' : arg) });
  process.exit(0);
}

let p;
try { p = JSON.parse(readStdin() || '{}'); } catch (e) { process.exit(0); }
if (String(p.hook_event_name || 'PostToolUse') !== 'PostToolUse') process.exit(0);
const r = core.postRecord(p);
if (r && r.reason) out({ decision: 'block', reason: r.reason });
// advisory 只提示不硬拦：同一目标换 3 种手段仍失败时提醒停手定位根因。
else if (r && r.advisory) out({ decision: 'approve', reason: r.advisory });
process.exit(0);
