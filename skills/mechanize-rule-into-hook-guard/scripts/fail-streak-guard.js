#!/usr/bin/env node
// fail-streak-guard.js —— **PostToolUse 半边入口：同一远程目标按 3 种不同手段连败即拦**
// （判据真源在 `fail-streak-core.js`；PreToolUse 半边挂进 `risky-match-guard.js` 的委托段，
//  不再单独新增第 6 个 PreToolUse 条目——carrier-preflight 报 Pre 峰值已 5、软上限 6。）
// 本文件只做：读 stdin → 调 core.postRecord → 需要时出声；外加人工 CLI（--status / --clear）。
// 自测：node fail-streak-guard.test.js   变异：node fail-streak-merge-mutation.test.js
// 关闭：~/.qoder/fail-streak-guard.json 写 {"disabled":true}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// hook-crash-guard 只存在于 ~/.qoder/scripts：本文件在技能目录里暂存时按绝对路径兜底，
// 安装到 scripts/ 后走相对 require。两种位置都必须能装崩溃守卫，否则守卫自己崩了就是静默放行。
try {
  const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const cg = require(path.join(__dirname, 'hook-crash-guard.js'));
  cg.install('fail-streak-guard');
} catch (e) {
  for (const side of ['.qoder', '.qoder-cn']) {
    try {
      const alt = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), side, 'scripts', 'hook-crash-guard.js');
      require(alt).install('fail-streak-guard');
      break;
    } catch (e2) {}
  }
}
const core = require('./fail-streak-core.js');

function out(o) { process.stdout.write(JSON.stringify(o)); }
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) {
    const chunks = []; const buf = Buffer.alloc(65512);
    try { let r; while ((r = fs.readSync(0, buf, 0, buf.length, 0)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

// ---- CLI（人工查看与解除；解封是人的决定，不给自动路径）----
const argv = process.argv.slice(2);
if (argv.includes('--status')) { out(core.status()); process.exit(0); }
if (argv.includes('--paths')) { out(core.paths()); process.exit(0); }
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
