#!/usr/bin/env node
// attempt-lock-core.js —— **同类操作连败计数器**的判据真源（唯一一份，两个入口共用）
//
// 为什么要有它：AGENTS 里"同类操作连败 3 次（3 种不同手段）必须停手上报"此前只有认证类被机械化
// （auth-lock-core 只认数据库连接目标）。构建 / 测试 / 部署这三类失败同样是"越重试越远"的形状：
// 同一组命令连跑三次还红，第四次不会自己变绿，只会把时间和上下文烧掉。
//
// 判据（宁窄勿宽，噪声多就会被忽略）：
//   ① 只对 Bash 里明确属于 构建 / 测试 / 部署 的命令建账（test 优先于 build，避免 `mvn test` 两边都算）；
//   ② 失败判定只认**明确信号**：is_error / 非零 exitCode / BUILD FAILURE / npm ERR! /
//      "Tests failed" / "error TS1234"；拿不到明确信号的返回记为 neutral（不计数也不清零）；
//   ③ 成功判定同样只认明确信号（exit code 0 / BUILD SUCCESS / BUILD SUCCESSFUL / Tests passed / PASS）；
//   ④ 同一目标（工作目录 / workspace + family + 命令签名）连续失败达到阈值（默认 3）⇒ 该目标下一次调用被拦，
//      直到人工 `--clear`。成功一次即清零（"连续"语义，不是累计）。
// 关闭：~/.qoder/attempt-lock.json 写 {"disabled":true}；threshold/ttlHours/blockTtlHours 同文件可配
// 状态与台账：~/.qoder/tmp/attempt-lock/{state.json,decisions.log}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG = process.env.ATTEMPT_LOCK_CONFIG || path.join(CLIENT_ROOT, 'attempt-lock.json');
const STATE_DIR = process.env.ATTEMPT_LOCK_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'attempt-lock');
const STATE = path.join(STATE_DIR, 'state.json');
const LEDGER = path.join(STATE_DIR, 'decisions.log');

function cfg() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; } }
function ledger(v) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, new Date().toISOString() + '|' + (Array.isArray(v) ? v.join('|') : String(v)) + '\n');
  } catch (e) {}
}
function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { entries: {} }; } }
function save(s) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (e) {} }

function familyOfWords(words) {
  const executable = path.basename(String(words[0] || '').replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  const separator = words.indexOf('--');
  const args = words.slice(1, separator < 0 ? undefined : separator);
  if (args.some(arg => /^(?:--(?:help|version)(?:=.*)?|-h|-V)$/.test(arg))) return null;
  // Classify the executed program's operation, never command-like text in its
  // arguments. In particular, an SSH remote command is still a deployment call.
  if (/^(?:ssh|scp|sftp|rsync|pscp|plink)$/.test(executable)) return 'deploy';
  if (/^(?:pytest|tox|phpunit|vitest|jest)$/.test(executable)) return 'test';
  if (/^(?:tsc|make)$/.test(executable)) return 'build';
  if (executable === 'node') return args.includes('--test') && !args.some(arg => /^(?:-v$|-e(?:=|$)|--eval(?:=|$)|-p(?:=|$)|--print(?:=|$))/.test(arg)) ? 'test' : null;
  if (/^(?:npm|pnpm|yarn|bun)$/.test(executable)) {
    const operation = args.filter(arg => !/^(?:--silent|--quiet|--verbose|--if-present|-s|-q)$/.test(arg));
    const task = operation[0] === 'run' ? operation[1] : operation[0];
    if (/^(?:test|e2e)$/.test(task || '')) return 'test';
    if (/^(?:build|ci)$/.test(task || '')) return 'build';
    return null;
  }
  if (/^(?:go|cargo|dotnet)$/.test(executable)) return args[0] === 'test' ? 'test' : args[0] === 'build' ? 'build' : null;
  if (executable === 'systemctl') return /^(?:restart|start|stop|reload)$/.test(args[0] || '') ? 'deploy' : null;
  if (executable === 'docker') return args[0] === 'compose' && /^(?:up|restart)$/.test(args[1] || '') ? 'deploy' : null;
  if (/^(?:mvn|gradle|gradlew)$/.test(executable)) {
    const goals = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (/^(?:-f|--file|-s|--settings|-gs|--global-settings|-P|--activate-profiles|-b|--build-file|-c|--settings-file|-I|--init-script|-g|--gradle-user-home|-p|--project-dir|--include-build)$/.test(arg)) { i++; continue; }
      if (!arg.startsWith('-')) goals.push(arg.split(':').pop());
    }
    if (goals.some(goal => /^(?:test|check)$/.test(goal))) return 'test';
    if (goals.some(goal => /^(?:package|install|compile|verify|build|assemble)$/.test(goal))) return 'build';
  }
  return null;
}

// 只解析直接命令、引号、分隔符和 cd；不猜测变量展开、函数或完整 shell 控制流。
function commandWords(command) {
  const segments = [], words = [];
  let word = '', quote = '', active = false;
  const flushWord = () => { if (active) words.push(word); word = ''; active = false; };
  const flushCommand = () => { flushWord(); if (words.length) segments.push(words.splice(0)); };
  const text = String(command || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && /["\\]/.test(text[i + 1] || '')) { word += text[++i]; continue; }
      word += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; active = true; continue; }
    if (ch === '\\' && /[\s'";&|]/.test(text[i + 1] || '')) { word += text[++i]; active = true; continue; }
    if (ch === '#' && !active) { while (i < text.length && text[i] !== '\n') i++; flushCommand(); continue; }
    if (/[;&|\n\r]/.test(ch)) { flushCommand(); continue; }
    if (/\s/.test(ch)) { flushWord(); continue; }
    word += ch; active = true;
  }
  if (quote) return [];
  flushCommand();
  return segments;
}
function directoryOf(base, value) {
  const win = /^[A-Za-z]:[\\/]|^\\\\/.test(String(value || '')) || /^[A-Za-z]:[\\/]|^\\\\/.test(base);
  const api = win ? path.win32 : path;
  const resolved = api.resolve(base, value || '.');
  return win ? resolved.toLowerCase() : resolved;
}
const executableOf = word => path.basename(String(word || '').replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
// 只展开已知的直接执行包装形态；帮助、查询、-c 文本和未知选项不按真实目标猜测。
function unwrapWords(input, packages = true) {
  let words = [...input];
  for (let depth = 0; depth < 5; depth++) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] || '')) words.shift();
    const executable = executableOf(words[0]);
    if (/^(?:env|sudo|command|exec|nohup)$/.test(executable)) {
      let i = 1;
      for (; i < words.length; i++) {
        const arg = words[i];
        if (arg === '--') { i++; break; }
        if (executable === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
        if (!arg.startsWith('-')) break;
        if (executable === 'sudo' && /^(?:-u|-g|--user|--group)$/.test(arg)) { i++; continue; }
        if (executable === 'env' && /^(?:-u|--unset)$/.test(arg)) { i++; continue; }
        if (executable === 'sudo' && /^(?:-[nEHSkb]|--non-interactive|--preserve-env|--user=.+|--group=.+)$/.test(arg)) continue;
        if (executable === 'env' && /^(?:-i|--ignore-environment|--unset=.+)$/.test(arg)) continue;
        if (executable === 'command' && arg === '-p') continue;
        return [];
      }
      words = words.slice(i); continue;
    }
    if (packages && (executable === 'npx' || /^(?:npm|pnpm|yarn)$/.test(executable) && words[1] === 'exec')) {
      let i = executable === 'npx' ? 1 : 2;
      for (; i < words.length; i++) {
        const arg = words[i];
        if (arg === '--') { i++; break; }
        if (!arg.startsWith('-')) break;
        if (/^(?:--package|-p)$/.test(arg)) { i++; continue; }
        if (/^(?:--package=.+|--yes|--no|--no-install|--offline|-y)$/.test(arg)) continue;
        return [];
      }
      words = words.slice(i); continue;
    }
    if (/^(?:python(?:\d+(?:\.\d+)*)?|py)$/.test(executable)) {
      let i = 1;
      while (/^-(?:I|B|E|s|S|u|2|3)$/.test(words[i] || '')) i++;
      if (words[i] === '-m' && /^(?:pytest|tox)$/.test(words[i + 1] || '')) { words = words.slice(i + 1); continue; }
    }
    if (executable === 'uv' && words[1] === 'run' && words[2] && !words[2].startsWith('-')) { words = words.slice(2); continue; }
    return words;
  }
  return [];
}
function commandTargets(command, cwd) {
  let directory = directoryOf(process.cwd(), cwd || process.cwd());
  const targets = [];
  for (const original of commandWords(command)) {
    const words = unwrapWords(original, false);
    if (/^(?:cd|chdir|set-location)$/i.test(words[0] || '')) {
      const dir = words.slice(1).filter(w => !/^(?:\/d|--|-literalpath|-path)$/i.test(w))[0];
      if (dir) directory = directoryOf(directory, dir);
      continue;
    }
    let targetDirectory = directory;
    const selectors = [], filtered = [words[0]];
    const executable = path.basename(String(words[0] || '').replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
    const manager = /^(?:npm|pnpm|yarn|bun|make|gradle|gradlew|mvn)$/.test(executable);
    for (let i = 1; i < words.length; i++) {
      // -- 后是脚本参数，不再把其中的 --prefix/--workspace 解释为包管理器目标。
      if (words[i] === '--') { filtered.push(...words.slice(i)); break; }
      const match = manager && words[i].match(/^(--prefix|--cwd|--dir|-C|--workspace|--workspaces|-w|--filter|-F|-pl|--projects)(?:=(.*))?$/);
      if (!match) { filtered.push(words[i]); continue; }
      if (match[1] === '--workspaces') { if (!/^(?:false|0)$/i.test(match[2] || 'true')) selectors.push('--workspaces'); continue; }
      const value = match[2] !== undefined ? match[2] : words[++i];
      if (!value) continue;
      if (/^(?:--prefix|--cwd|--dir|-C)$/.test(match[1])) targetDirectory = directoryOf(directory, value);
      else selectors.push(value);
    }
    const command = unwrapWords(filtered);
    const family = familyOfWords(command);
    if (family) targets.push({ family, words: command, directory: targetDirectory, selectors: [...new Set(selectors)].sort() });
  }
  return targets;
}
function familyOf(cmd) {
  const targets = commandTargets(cmd);
  return ['test', 'build', 'deploy'].find(family => targets.some(t => t.family === family)) || null;
}
// 目录/workspace 入键，避免全局 hook 把不同项目的 npm run build 误当成同一目标。
// 路径只存摘要；同一目标换 verbosity 等无关参数仍共用预算。旧版无作用域键不再匹配新调用。
function keyOf(family, cmd, cwd) {
  const target = commandTargets(cmd, cwd).find(t => t.family === family);
  if (!target) return null;
  const sig = target.words.filter(t => t && t.charAt(0) !== '-').slice(0, 3).join(' ').toLowerCase();
  // Remote destinations often follow multiple option/value pairs. Retain the
  // complete invocation in its digest so different hosts cannot share a key.
  // Only known verbosity switches are ignored; other remote arguments remain
  // part of the operation rather than guessing each client's option grammar.
  const remote = family === 'deploy' ? target.words.filter(word => !/^(?:-v+|-q|--verbose|--quiet)$/.test(word)) : [];
  const scopeParts = [target.directory, target.selectors];
  if (remote.length) scopeParts.push(remote);
  const scope = crypto.createHash('sha256').update(JSON.stringify(scopeParts)).digest('hex').slice(0, 16);
  return family + '@' + sig + '#' + scope;
}

const FAIL = [
  /BUILD\s+FAIL(?:URE|ED)/i, /\bnpm\s+ERR!/i, /\bTests?\s+failed\b/i, /\berror\s+TS\d+/i,
  /\bFAILED\b/, /\bmake(?:\[\d+\])?:\s*\*\*\*/,
];
const OK = [
  /BUILD\s+SUCCESS(?:FUL)?/i, /\bTests?\s+(?:run|passed)\b/i, /\ball\s+tests\s+passed\b/i,
  /\bexit\s+code\s*[:=]?\s*0\b/i, /"exitCode"\s*:\s*0\b/, /"exit_code"\s*:\s*0\b/, /^\s*PASS\b/m,
];

function failureSignal(payload) {
  const resp = payload.tool_response !== undefined ? payload.tool_response
    : payload.tool_output !== undefined ? payload.tool_output
      : payload.result !== undefined ? payload.result : payload.output;
  const raw = typeof resp === 'string' ? resp : JSON.stringify(resp === undefined ? '' : resp);
  if (payload.is_error === true) return 'fail';
  if (resp && typeof resp === 'object') {
    if (resp.is_error === true) return 'fail';
    const code = Number.isInteger(resp.exitCode) ? resp.exitCode : (Number.isInteger(resp.exit_code) ? resp.exit_code : null);
    if (code !== null) return code === 0 ? 'ok' : 'fail';
  }
  // 结构化 JSON 文本里的退出码（harness 会把 exitCode 写进返回体的情形）
  const mCode = raw.match(/"exit_?[Cc]ode"\s*:\s*(-?\d+)/);
  if (mCode) return Number(mCode[1]) === 0 ? 'ok' : 'fail';
  if (FAIL.some((re) => re.test(raw))) return 'fail';
  if (OK.some((re) => re.test(raw))) return 'ok';
  return 'neutral';
}

function parse(p) {
  if (!p || typeof p !== 'object') return null;
  const c = cfg();
  if (c.disabled) return null;
  const tool = String(p.tool_name || p.toolName || '');
  if (!/^(?:bash|shell|cmd|powershell|terminal|zsh)$/i.test(tool)) return null;
  const input = p.tool_input || p.toolInput || {};
  const cmd = String(input.command || '');
  const family = familyOf(cmd);
  if (!family) return null;
  return { family, key: keyOf(family, cmd, input.cwd || input.workdir || p.cwd || process.cwd()), cmd, config: c };
}

function prune(s, c) {
  const now = Date.now();
  const ttl = (c.ttlHours || 2) * 3600e3;
  const bttl = (c.blockTtlHours || 24) * 3600e3;
  for (const k of Object.keys(s.entries || {})) {
    const e = s.entries[k];
    const age = now - (e.at || 0);
    if (e.blocked ? age > bttl : age > ttl) delete s.entries[k];
  }
  return s;
}

// PreToolUse：该拦就给 reason；null = 放行（已建目标时顺带留 allow 台账）
function preCheck(payload) {
  const t = parse(payload);
  if (!t) return null;
  const threshold = Number(t.config.threshold) > 0 ? Number(t.config.threshold) : 3;
  const s = prune(load(), t.config);
  const e = s.entries[t.key];
  if (e && (e.blocked || (e.count || 0) >= threshold)) {
    ledger(['block', t.key, 'n=' + (e.count || 0)]);
    return {
      key: t.key,
      count: e.count || 0,
      reason: '[attempt-lock] `' + t.key + '` 已连续失败 ' + (e.count || 0) + ' 次，本次调用被拦。'
        + '按全局规则「同类操作连败 3 次（3 种不同手段）必须停手上报」：不要再原样重跑——'
        + '先换一种诊断手段（读原始日志 / 缩小成单条用例 / 加 -x 或 -e 追根因），'
        + '仍不成立就把失败次数与报错原文上报，等用户决定。\n'
        + '人工解除：node ~/.qoder/scripts/attempt-lock-guard.js --clear "' + t.key + '"（或 --clear ALL）',
    };
  }
  ledger(['allow', t.key, 'n=' + (e ? e.count || 0 : 0)]);
  return null;
}

// PostToolUse：只看返回记账。返回 {key, count, kind, reason}；reason 非空 = 该当场叫停
function postRecord(payload) {
  const t = parse(payload);
  if (!t) return null;
  const threshold = Number(t.config.threshold) > 0 ? Number(t.config.threshold) : 3;
  const s = prune(load(), t.config);
  const signal = failureSignal(payload);
  const cur = s.entries[t.key];
  if (signal === 'neutral') { ledger(['neutral', t.key]); return { key: t.key, count: cur ? cur.count || 0 : 0, kind: 'neutral' }; }
  if (signal === 'ok') {
    if (cur && !cur.blocked) { delete s.entries[t.key]; save(s); ledger(['reset', t.key]); }
    return { key: t.key, count: 0, kind: 'ok' };
  }
  const e = cur || { count: 0, at: Date.now() };
  e.count = (e.count || 0) + 1;
  e.at = Date.now();
  if (e.count >= threshold) e.blocked = true;
  s.entries[t.key] = e;
  save(s);
  ledger(['fail', t.key, 'n=' + e.count]);
  return {
    key: t.key, count: e.count, kind: 'fail',
    reason: e.count >= threshold
      ? '[attempt-lock] `' + t.key + '` 已连续失败 ' + e.count + ' 次。按「连败 3 次即停」：'
        + '停止原样重试，换诊断手段；下一次同类调用会被 PreToolUse 硬拦，人工解除用 --clear。'
      : null,
  };
}

function status() { const s = prune(load(), cfg()); return { state: STATE, entries: s.entries }; }
function clear(arg) {
  const s = load();
  let removed = 0;
  if (!arg || arg === 'ALL') { removed = Object.keys(s.entries).length; s.entries = {}; }
  else if (s.entries[arg]) { delete s.entries[arg]; removed = 1; }
  save(s); ledger(['clear', arg || 'ALL', String(removed)]);
  return removed;
}

module.exports = { preCheck, postRecord, status, clear, cfg, familyOf, keyOf, failureSignal, paths: () => ({ CONFIG, STATE_DIR, STATE, LEDGER }) };
