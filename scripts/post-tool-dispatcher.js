#!/usr/bin/env node
'use strict';
// 合并 5 个 PostToolUse 钩子为单入口，目的同 pre-tool-dispatcher：把每次工具调用的 MSYS 进程数压下来。
// 输出语义（PostToolUse 侧）：
//   {decision:'block', reason}                      -> 合并所有 reason
//   {hookSpecificOutput:{additionalContext}}        -> 合并所有 additionalContext
//   {continue:true}                                 -> 忽略
// 关掉：~/.qoder/post-tool-dispatcher.json 写 {"disabled":true}
// 台账：~/.qoder/tmp/post-tool-dispatcher/decisions.log
require('./hook-crash-guard.js').install('post-tool-dispatcher');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const STATE_DIR = process.env.POST_TOOL_DISPATCHER_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'post-tool-dispatcher');
const LEDGER = path.join(STATE_DIR, 'decisions.log');
const CONFIG = path.join(CLIENT_ROOT, 'post-tool-dispatcher.json');
const PER_GUARD_TIMEOUT = Number(process.env.POST_TOOL_GUARD_TIMEOUT_MS || 8000);
const MAX_CONTEXT = Number(process.env.POST_TOOL_MAX_CONTEXT || 200000);

// 顺序与原 settings.json 中 PostToolUse 条目顺序一致。
const GUARDS = [
  { name: 'continuity', file: process.env.CONTINUITY_CJS || path.join(CLIENT_ROOT, 'scripts', 'continuity.cjs'), args: ['hook'], matcher: /^(Write|Edit|Bash)$/ },
  { name: 'cua-cursor-guard', file: path.join(__dirname, 'cua-cursor-guard.js'), args: [], matcher: /mcp_call|mcp__cua[_-]?driver__.*|^Bash$/ },
  { name: 'auth-lock-guard', file: path.join(__dirname, 'auth-lock-guard.js'), args: [], matcher: /^Bash$|mcp_call|mcp__dbhub__.*/ },
  { name: 'attempt-lock-guard', file: path.join(__dirname, 'attempt-lock-guard.js'), args: [], matcher: /^Bash$/ },
  { name: 'tool-payload-guard', file: path.join(__dirname, 'tool-payload-guard.js'), args: [], matcher: /^Bash$|^Read$|^Agent$|^Task$|mcp_call/ },
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

function main() {
  try { if (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).disabled === true) return; } catch (e) {}

  const raw = readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (e) {}
  const tool = String(payload.tool_name || payload.toolName || payload.tool || '');

  const blockReasons = [];
  const contexts = [];

  for (const g of GUARDS) {
    if (g.matcher && !g.matcher.test(tool)) continue;
    if (!fs.existsSync(g.file)) { ledger(`skip-missing|${g.name}`); continue; }
    const r = spawnSync(process.execPath, [g.file, ...(g.args || [])], {
      input: raw,
      encoding: 'utf8',
      timeout: PER_GUARD_TIMEOUT,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) { ledger(`skip-error|${g.name}|${r.error.code || r.error.message}`); continue; }
    let hit = false;
    for (const o of parseJsonLines(r.stdout)) {
      if (!o || typeof o !== 'object') continue;
      if (o.decision === 'block' && o.reason) { blockReasons.push(String(o.reason)); hit = true; }
      const hso = o.hookSpecificOutput;
      if (hso && hso.additionalContext) { contexts.push(String(hso.additionalContext)); hit = true; }
    }
    if (r.status === 2 && String(r.stderr || '').trim()) {
      blockReasons.push(String(r.stderr).trim());
      hit = true;
    }
    if (hit) ledger(`hit|${g.name}|${tool}`);
  }

  if (!blockReasons.length && !contexts.length) { ledger(`pass|${tool || 'unknown'}`); return; }
  const outObj = {};
  if (blockReasons.length) {
    outObj.decision = 'block';
    outObj.reason = blockReasons.join('\n\n');
  }
  if (contexts.length) {
    let ctx = contexts.join('\n\n');
    if (ctx.length > MAX_CONTEXT) ctx = ctx.slice(0, MAX_CONTEXT) + '\n…(已截断)';
    outObj.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: ctx };
  }
  process.stdout.write(JSON.stringify(outObj) + '\n');
  ledger(`out|${tool}|block=${blockReasons.length}|ctx=${contexts.length}`);
}

try { main(); } catch (e) { ledger(`error|${e && e.message}`); }
process.exit(0);
