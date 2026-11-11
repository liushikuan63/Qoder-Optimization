#!/usr/bin/env node
'use strict';
// 合并 6 个 PreToolUse 守卫为单入口。
// WHY：Qoder 在 Windows 上把每个 hook 都用 Git Bash 包一层执行，一次工具调用会并发拉起 6~12 个
// MSYS 进程。MSYS2 的挂载表共享段（\BaseNamedObjects\msys-2.0S5-<key>）若在首个进程初始化中途
// 被杀，version 永远停在 0xFFFFFFFF，之后每个 bash 自旋 ~15.7s 后 add_item("/") 报 EPERM。
// 这里用 node 原生 spawnSync 串行调用原守卫，守卫逻辑零改动，只把每次工具调用的 MSYS 进程数从 N 降到 1。
// 关掉：~/.qoder/pre-tool-dispatcher.json 写 {"disabled":true}
// 台账：~/.qoder/tmp/pre-tool-dispatcher/decisions.log
require('./hook-crash-guard.js').install('pre-tool-dispatcher');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const STATE_DIR = process.env.PRE_TOOL_DISPATCHER_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'pre-tool-dispatcher');
const LEDGER = path.join(STATE_DIR, 'decisions.log');
const CONFIG = path.join(CLIENT_ROOT, 'pre-tool-dispatcher.json');
const PER_GUARD_TIMEOUT = Number(process.env.PRE_TOOL_GUARD_TIMEOUT_MS || 8000);
const MAX_REASON = 4000;

// 顺序与原 settings.json 中 PreToolUse 的条目顺序一致；matcher 为空表示所有工具。
const GUARDS = [
  { name: 'edit-guard', file: 'edit-guard.js', matcher: null },
  { name: 'huge-output-guard', file: 'huge-output-guard.js', matcher: null },
  { name: 'commit-scope-guard', file: 'commit-scope-guard.js', matcher: null },
  { name: 'cua-cursor-guard', file: 'cua-cursor-guard.js', matcher: /mcp_call|mcp__cua[_-]?driver__.*|^Bash$/ },
  { name: 'risky-match-guard', file: 'risky-match-guard.js', matcher: null },
  { name: 'win-path-guard', file: 'win-path-guard.js', matcher: /^Bash$/ },
];

function ledger(row) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, `${new Date().toISOString()}|${row}\n`);
  } catch (e) {}
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    try { let r; while ((r = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

function parseJsonLines(s) {
  const out = [];
  for (const line of String(s || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) {}
  }
  return out;
}

function clip(s) {
  const t = String(s || '');
  return t.length > MAX_REASON ? t.slice(0, MAX_REASON) + '\n…(已截断)' : t;
}

function main() {
  try { if (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).disabled === true) return; } catch (e) {}

  const raw = readStdin();
  // 排查用：保留最后一次真实 hook 输入（≤1MB），便于核对 Qoder 到底传了什么字段/转义。
  // 设 PRE_TOOL_DISPATCHER_DUMP=0 可关闭。
  if (raw && process.env.PRE_TOOL_DISPATCHER_DUMP !== '0' && raw.length <= 1024 * 1024) {
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, 'stdin-last.json'), raw); } catch (e) {}
  }
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) {}
  const tool = String(payload.tool_name || payload.toolName || payload.tool || '');

  const denyReasons = [];
  const blockReasons = [];
  const allowReasons = [];
  let updatedInput = null;

  for (const g of GUARDS) {
    if (g.matcher && !g.matcher.test(tool)) continue;
    const file = path.join(__dirname, g.file);
    if (!fs.existsSync(file)) { ledger(`skip-missing|${g.name}`); continue; }
    const r = spawnSync(process.execPath, [file], {
      input: raw,
      encoding: 'utf8',
      timeout: PER_GUARD_TIMEOUT,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) {
      // fail-open：某个守卫超时/启动失败不能阻塞工具调用（与原每个 hook 各自 fail-open 一致）
      ledger(`skip-error|${g.name}|${r.error.code || r.error.message}`);
      continue;
    }
    const objs = parseJsonLines(r.stdout);
    let hit = false;
    for (const o of objs) {
      if (!o || typeof o !== 'object') continue;
      if (o.continue === true) continue;
      const hso = o.hookSpecificOutput || {};
      hit = true;
      if (hso.permissionDecision === 'deny') {
        denyReasons.push(String(hso.permissionDecisionReason || o.reason || `[${g.name}] blocked`));
      } else if (o.decision === 'block') {
        blockReasons.push(String(o.reason || `[${g.name}] blocked`));
      } else if (hso.permissionDecision === 'allow') {
        if (hso.permissionDecisionReason) allowReasons.push(String(hso.permissionDecisionReason));
        if (hso.updatedInput && !updatedInput) updatedInput = hso.updatedInput;
      } else if (o.decision === 'approve' && o.reason) {
        allowReasons.push(String(o.reason));
      }
    }
    if (r.status === 2) {
      hit = true;
      blockReasons.push(String(r.stderr || '').trim() || `[${g.name}] blocked`);
    }
    if (hit) ledger(`hit|${g.name}|${tool}`);
  }

  if (denyReasons.length || blockReasons.length) {
    const reason = clip([...denyReasons, ...blockReasons].join('\n\n'));
    ledger(`deny|${tool}`);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }) + '\n');
    return;
  }
  if (allowReasons.length || updatedInput) {
    const reason = clip(allowReasons.join('\n\n'));
    const hso = { hookEventName: 'PreToolUse', permissionDecision: 'allow' };
    if (reason) hso.permissionDecisionReason = reason;
    if (updatedInput) hso.updatedInput = updatedInput;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: hso }) + '\n');
    return;
  }
  ledger(`pass|${tool || 'unknown'}`);
}

try { main(); } catch (e) { ledger(`error|${e && e.message}`); }
process.exit(0);
