#!/usr/bin/env node
// fail-streak-core.js —— **「同类操作连败 3 种不同手段即停」的判据真源**（唯一一份，两个入口共用）
//
// 来历：AGENTS 与 rules-reminder.js 第 2 条早就写了「同类操作连败 3 次（＝3 种不同手段，重跑同一手段不计）
// 必须停手上报」，但那是**纯提示词**。按 settings.json 现役引用的 10 个 hook 脚本逐个扫描，含计数类关键词的
// 只有 2 个：rules-reminder.js 自己（提示词）与 auth-lock-guard.js（只管认证/锁库）；`grep -iE "streak|failcount"`
// 在 scripts/ 里 0 命中 ⇒ 非认证类的重复试探没有任何机制。用户 2026-10-21 弹窗批准落地（选项 A：窄判据新守卫）。
//
// 判据（宁窄勿宽——守卫噪声多就会被忽略，这是本项目实测教训）：
//   ① 只对「远程入口命令」（ssh/plink/scp/curl/wget/nc/ping/ansible + 各类 DB 客户端）建账；
//      本地构建/测试/检索类命令（npm/mvn/gradle/tsc/pytest/node/git/grep/rg/sed…）的失败属正常迭代，一律不建账；
//   ② 只有**连接层失败签名**才计数（refused / no route / timed out / curl(7)(28) / 502 / publickey 拒绝…）；
//      认证与锁定签名**交给 auth-lock**，本守卫视为中性——两套签名必须互斥，否则一次失败两个门禁各计一次；
//      HTTP 404 / 401 这类「拿到了响应」＝清零或中性，故意构造的 404 负对照绝不能被计数；
//   ③ 计的是**不同手段的个数**而非次数：同一命令形态重跑只刷新样本，不涨手段集（照用户口径「重跑同一手段不计」），
//      distinct means 达 threshold（默认 3）即拦，此后 PreToolUse 拒绝该目标的任何新调用；
//   ④ 目标同一性 = host[:port]；已拦目标**不因一次「看起来成功」自动解封**，解封只能走人工 `--clear`。
// 关闭：~/.qoder/fail-streak-guard.json 写 {"disabled":true}；threshold/ttlHours 同文件可配
// 状态与台账：~/.qoder/tmp/fail-streak-guard/{state.json,decisions.log}
// 自测：node fail-streak-guard.test.js（红/对照双向）；变异：node fail-streak-merge-mutation.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
// 台账落在本机实际存在的客户端侧（只装 CN 时不新建 ~/.qoder）。
// 先找安装后同目录的 client-root.js，再找仓库技能目录的相对位置；两者都缺时按 HOME 现有侧兜底。
const CLIENT_ROOT = (() => {
  if (process.env.QODER_HOME) return path.resolve(process.env.QODER_HOME);
  for (const file of [path.join(__dirname, 'client-root.js'), path.join(__dirname, '..', '..', '..', 'scripts', 'client-root.js')]) {
    try { return require(file).clientRoot(HOME); } catch (e) {}
  }
  const sides = ['.qoder', '.qoder-cn'].map((name) => path.join(HOME, name)).filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  return sides.length === 1 ? sides[0] : path.join(HOME, '.qoder');
})();
const CONFIG = process.env.FAIL_STREAK_CONFIG || path.join(CLIENT_ROOT, 'fail-streak-guard.json');
const STATE_DIR = process.env.FAIL_STREAK_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'fail-streak-guard');
const STATE = path.join(STATE_DIR, 'state.json');
const LEDGER = path.join(STATE_DIR, 'decisions.log');

function cfg() {
  try { const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch (e) { return {}; }
}
function ledger(f) {
  // 台账是「守卫到底跑没跑」的唯一证据；传错类型**不能静默丢**（auth-lock 真机第一版就因 `f.join` 抛错
  // 被 catch 吞掉，台账整段为空＝假绿）。所以这里对数组/字符串都容错。
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, new Date().toISOString() + '|' + (Array.isArray(f) ? f.join('|') : String(f)) + '\n');
  } catch (e) {}
}

// ---- 目标与签名 ----
// 远程入口特征：文本里必须真的出现这些客户端，否则不解析维度（防「引用文本」被抽成假目标，同 auth-lock 的 gate 教训）
const REMOTE_ENTRY = /\b(?:ssh|plink|pscp|scp|sftp|curl|wget|nc|netcat|telnet|sshpass|ping|ping6|mtr|traceroute|nmap|ansible|redis-cli|mysql|mariadb|psql|sqlplus|sqlcmd|mongosh)\b/i;
// 首 token 命中这些 = 本地构建/测试/检索，失败属正常迭代，不建账（噪声防线）
const LOCAL_ONLY = /^(?:[^\s]*[/\\])?(?:npm|npx|pnpm|yarn|mvn|mvnw|gradle|gradlew|tsc|eslint|prettier|pytest|jest|vitest|go|cargo|make|javac|java|python|python3|pip|node|git|svn|grep|rg|find|ls|cat|head|tail|sed|awk|echo|printf|cd|mkdir|touch|cp|mv|rm|tar|zip|unzip)\b/i;
const TRANSPORT_FAIL = [
  /Connection refused/i, /ECONNREFUSED/i, /EHOSTUNREACH/i, /ENETUNREACH/i,
  /No route to host/i, /Network is unreachable/i, /Connection timed out/i, /Operation timed out/i,
  /curl:\s*\(7\)/i, /curl:\s*\(28\)/i, /curl:\s*\(6\)/i, /curl:\s*\(5[16]\)/i,
  /Could not resolve host/i, /Failed to connect/i, /Unable to connect/i, /Couldn.t connect/i,
  /ssh:\s*connect to host/i, /kex_exchange_identification/i, /Connection closed by/i,
  /Connection reset by peer/i, /RemoteDisconnected/i, /Connection aborted/i,
  /Permission denied \(publickey/i, /Host key verification failed/i, /no matching key/i,
  /502 Bad Gateway/i, /503 Service Unavailable/i, /i\/o timeout/i, /context deadline exceeded/i,
  /timed? out waiting/i,
];
// 认证/锁定签名：**不计数**，由 auth-lock 负责。两条判据必须互斥（自测里有断言）。
const AUTHISH = /password authentication failed|authentication failed|access denied for user|login failed for user|invalid username|ORA-01017|\bERROR[\s:-]*1045\b|\b1045\s*\(28000\)|WRONGPASS|NOAUTH|Too many invalid attempts|ORA-28000|account is (?:locked|expired)|401 Unauthorized|403 Forbidden|账号[\s\S]{0,6}锁/i;
// 平台门禁/用户拒绝：不是目标失败，中性处理
const GATED = /SKILL_CONFIRMATION_REQUIRED|permission denied by user|user (?:denied|rejected)|denied the tool call/i;

function dims(text) {
  const t = String(text || '');
  const d = {};
  if (!REMOTE_ENTRY.test(t)) return d;
  let m = t.match(/[a-z][a-z0-9+.\-]*:\/\/([\w.\-]+)(?::(\d{2,5}))?/i);
  if (m) { d.host = m[1].toLowerCase(); if (m[2]) d.port = m[2]; }
  if (!d.host) { m = t.match(/(?:^|[\s'"])(?:-h|--host)[=\s]+["']?([\w.\-]+)/); if (m) d.host = m[1].toLowerCase(); }
  if (!d.host) { m = t.match(/[\w.\-]+@([\w.\-]+)(?::(\d{2,5}))?/); if (m) { d.host = m[1].toLowerCase(); if (m[2]) d.port = m[2]; } }
  if (!d.host) { m = t.match(/(?:^|[\s:])(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?(?=$|[\s/'"\\])/); if (m) { d.host = m[1]; if (m[2]) d.port = m[2]; } }
  if (!d.port) { m = t.match(/(?:^|[\s])(?:-P|--port)[=\s]+(\d{2,5})/); if (m) d.port = m[1]; }
  // 只认「带点的域名 / IP / localhost」，避免把 `-H "Accept: */*"`、`-u user` 之类片段抽成假目标
  if (d.host && !(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(d.host) || /^localhost$/.test(d.host) || /^[\w\-]+(?:\.[\w\-]+)+$/.test(d.host))) delete d.host;
  return d;
}
const hasDim = (d) => !!(d && d.host);
const keyOf = (d) => d.host + ':' + (d.port || '-');

// 手段签名 = 首命令 + 子命令 + 去重排序的 flag 名集合（不含值）。
// 同一手段重跑得到同一签名（不涨计数）；换工具 / 换参数形态得到新签名（算一种新手段）。
function meansOf(cmd) {
  const toks = String(cmd || '').trim().split(/\s+/).slice(0, 16);
  const head = (toks[0] || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  const flags = [...new Set(toks.filter((t) => /^-/.test(t)).map((t) => t.replace(/=.*$/, '').toLowerCase()))].sort();
  const sub = (toks.slice(1).find((t) => /^[A-Za-z][\w.\-]*$/.test(t) && !/^[-]/.test(t)) || '-').toLowerCase();
  return head + '|' + sub + '|' + flags.join(',');
}

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { entries: {} }; } }
function save(s) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (e) {} }
function prune(s, c) {
  const now = Date.now();
  const ttl = (c.ttlHours || 24) * 3600e3;
  for (const k of Object.keys(s.entries)) {
    const e = s.entries[k];
    const ts = [e.at || 0].concat(Object.values(e.means || {}).map((m) => m.at || 0));
    const last = Math.max.apply(null, ts);
    if (!e.blocked && now - last > ttl) delete s.entries[k];
  }
  return s;
}
const meansCount = (e) => Object.keys((e && e.means) || {}).length;

// 把 hook payload 归一化 → {key, cmd, means}；不构成远程目标 → null
function parse(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const c = cfg();
  if (c.disabled === true) return null;
  const rawTool = String(payload.tool_name || payload.toolName || '');
  let call = payload.tool_input || payload.toolInput || {};
  if (/^mcp_call$/i.test(rawTool) && call && typeof call === 'object') {
    call = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
  }
  const cmd = String(call.command || call.cmd || '');
  if (!cmd) return null;                    // 无 command 文本（如 dbhub 只有 server 别名）→ 交 auth-lock，本守卫不建账
  if (LOCAL_ONLY.test(cmd)) return null;    // 本地构建/测试/检索 → 不建账
  if (!REMOTE_ENTRY.test(cmd)) return null; // 无远程入口特征 → 不建账
  const d = dims(cmd);
  if (!hasDim(d)) return null;
  return { cmd, key: keyOf(d), dims: d, means: meansOf(cmd), cfg: c };
}

function reasonFor(key, e, threshold) {
  const ms = Object.keys(e.means || {});
  return '[fail-streak] 目标 `' + key + '` 已按 ' + ms.length + ' 种**不同手段**连续失败（阈值 ' + threshold + '）。'
    + '停手：不要再换第 ' + (ms.length + 1) + ' 种方式重试同一目标——每换一种手段都在搅乱现场，'
    + '而且连接层反复失败通常说明前提就不成立（服务没起 / 端口不对 / 路由不通），不是重试姿势问题。'
    + '\n已试过的手段：' + ms.map((m) => '`' + m + '`').join(' / ')
    + '\n最近报错：' + (((e.samples || [])[e.samples.length - 1]) || '(无)')
    + '\n正确动作：向用户上报已失败的手段数与报错原文，等用户决定（换思路 / 放弃该步 / 修环境）。'
    + '\n人工解除：node ~/.qoder/scripts/fail-streak-guard.js --clear "' + key + '"（或 --clear ALL）';
}

function preCheck(payload) {
  const t = parse(payload);
  if (!t) return null;
  const threshold = Number(t.cfg.threshold) > 0 ? Number(t.cfg.threshold) : 3;
  const s = prune(load(), t.cfg);
  const e = s.entries[t.key];
  if (e && (e.blocked || meansCount(e) >= threshold)) {
    ledger('block|' + t.key + '|means=' + meansCount(e));
    return { key: t.key, count: meansCount(e), reason: reasonFor(t.key, e, threshold) };
  }
  ledger('eval|allow|' + t.key + '|means=' + (e ? meansCount(e) : 0));
  return null;
}

function postRecord(payload) {
  const t = parse(payload);
  if (!t) return null;
  const threshold = Number(t.cfg.threshold) > 0 ? Number(t.cfg.threshold) : 3;
  const s = prune(load(), t.cfg);
  const resp = payload.tool_response !== undefined ? payload.tool_response
    : payload.tool_output !== undefined ? payload.tool_output
    : payload.result !== undefined ? payload.result : payload.output;
  const text = typeof resp === 'string' ? resp : JSON.stringify(resp || '');
  const anyFail = TRANSPORT_FAIL.some((re) => re.test(text));

  if (AUTHISH.test(text) || GATED.test(text)) {
    ledger('neutral|' + t.key + '|auth-or-gate');
    return { key: t.key, count: meansCount(s.entries[t.key]) || 0, kind: 'neutral' };
  }
  if (!anyFail) {
    // 连接层成功 → 清零；但已拦目标不自动解封（解封是人的决定，否则一次误判绿灯就绕过门禁）
    if (s.entries[t.key] && !s.entries[t.key].blocked) { delete s.entries[t.key]; save(s); ledger('reset|' + t.key); }
    else ledger('ok|' + t.key);
    return { key: t.key, count: meansCount(s.entries[t.key]) || 0, kind: 'ok' };
  }
  const e = s.entries[t.key] || { dims: t.dims, means: {}, at: Date.now(), samples: [] };
  const isNew = !e.means[t.means];
  e.means[t.means] = { at: Date.now(), count: (e.means[t.means] ? e.means[t.means].count : 0) + 1 };
  e.at = Date.now();
  e.samples = (e.samples || []).concat([text.replace(/\s+/g, ' ').slice(0, 160)]).slice(-4);
  if (meansCount(e) >= threshold) e.blocked = true;
  s.entries[t.key] = e;
  save(s);
  ledger((isNew ? 'streak-new|' : 'streak-repeat|') + t.key + '|means=' + meansCount(e));
  return { key: t.key, count: meansCount(e), kind: 'transportfail', reason: e.blocked ? reasonFor(t.key, e, threshold) : null };
}

function status() { const s = prune(load(), cfg()); return { state: STATE, entries: s.entries }; }
function clear(arg) {
  const s = load();
  let removed = 0;
  if (arg === 'ALL') { removed = Object.keys(s.entries).length; s.entries = {}; }
  else if (Object.prototype.hasOwnProperty.call(s.entries, arg)) { delete s.entries[arg]; removed = 1; }
  if (removed) save(s);
  ledger('clear|' + String(arg || '') + '|' + removed);
  return removed;
}

module.exports = { preCheck, postRecord, status, clear, cfg, ledger, parse, dims, meansOf, keyOf, paths: () => ({ CONFIG, STATE_DIR, STATE, LEDGER }) };
