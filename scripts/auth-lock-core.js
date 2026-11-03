#!/usr/bin/env node
// auth-lock-core.js —— **认证失败计数与锁库拦截的判据真源**（唯一一份，两个入口共用）
//
// 为什么要有这个文件：门禁需要挂在两个不同的事件面上——
//   · PreToolUse：调用发出**之前**查状态并拦（入口 = `risky-match-guard.js`，2026-10-21 按用户要求并入，
//     不再为"失败计数"单独挂第 7 个 hook）；
//   · PostToolUse：只看**工具返回**给次数记账（入口 = `auth-lock-guard.js`，失败签名只出现在返回里）。
// 判据若抄两遍必然分叉，所以两个入口都只做"读 stdin → 调本模块 → 打印/退出"。
//
// 事故背景与判据说明见 auth-lock-guard.js 头注释与 README-rule-enforcement.md 的 auth-lock 一节。
// 关闭：~/.qoder/auth-lock-guard.json 写 {"disabled":true}；threshold/dims/ttlHours 同文件可配
// 状态与台账：~/.qoder/tmp/auth-lock-guard/{state.json,decisions.log}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CONFIG = process.env.AUTH_LOCK_CONFIG || path.join(CLIENT_ROOT, 'auth-lock-guard.json');
const STATE_DIR = process.env.AUTH_LOCK_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'auth-lock-guard');
const STATE = path.join(STATE_DIR, 'state.json');
const LEDGER = path.join(STATE_DIR, 'decisions.log');

function cfg() {
  try { const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function ledger(f) {
  // 容错：调用点历史上既传数组也传字符串，传错时**不能静默丢台账**（台账是"守卫到底跑没跑"的唯一证据；
  // 真机第一版就因为 `f.join` 抛错被 catch 吞掉，台账整段为空＝假绿）
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LEDGER, new Date().toISOString() + '|' + (Array.isArray(f) ? f.join('|') : String(f)) + '\n'); } catch (e) {}
}

const AUTH_FAIL = [
  /password authentication failed/i, /authentication failed/i, /\baccess denied for user\b/i,
  /login failed for user/i, /invalid username\/password/i, /ORA-01017/i,
  /\bERROR[\s:-]*1045\b|\b1045\s*\(28000\)/i, /WRONGPASS|ERR invalid password|NOAUTH\b/i,
  /认证失败|身份验证失败|密码错误|登录失败/i,
];
const LOCKED = [
  /too many invalid attempts/i, /ORA-28000/i, /account is (?:locked|expired)/i,
  /user\b[\s\S]{0,40}\bwas\b[\s\S]{0,20}\block/i, /账号[\s\S]{0,6}锁/i, /被锁(?:定|死)/i,
  /contact the syssso/i, /max_connection_errors/i,
];
// 中性：拿不到凭据对错的证据，不清零也不计数
const NEUTRAL = /ECONNREFUSED|connection refused|ETIMEDOUT|timed out|could not connect|no route to host|connection reset|ENOTFOUND|网络|unreachable/i;

// 从一个文本块里抽目标维度：{srv, host, user}
// gate=true 时要求文本里**先出现数据库客户端入口**才解析 host/user：真机首跑发现任意 Bash 文本里的
// `-u xxx`、`a@b` 片段会被抽成假账号键（台账里出现过 `3_40`、`4_47` 这种行号残片），
// 假键一旦和真账号撞上就是误拦。MCP 侧有 srv 别名可锚，不需要 gate。
const DB_ENTRY = /\b(?:psql|pg_dump|pg_restore|mysql|mariadb|sqlplus|sqlcl|sqlcmd|sqlline|beeline|gsql|mongo(?:sh)?|redis-cli)\b|jdbc:|execute_sql/i;
function dims(text, srvFromTool, gate) {
  const t = String(text || '');
  const d = {};
  if (srvFromTool) d.srv = String(srvFromTool).toLowerCase();
  const mSrv = t.match(/execute_sql[_-]([a-z0-9_]+)/i);
  if (mSrv && !d.srv) d.srv = mSrv[1].toLowerCase();
  if (gate && !DB_ENTRY.test(t)) return d;
  const mJdbc = t.match(/jdbc:[a-z0-9]+:\/\/([\w.\-]+)(?::(\d+))?/i);
  if (mJdbc) d.host = mJdbc[1].toLowerCase();
  const mHost = t.match(/(?:^|[\s'"])(?:-h|--host)[=\s]+["']?([\w.\-]+)/);
  if (mHost && !d.host) d.host = mHost[1].toLowerCase();
  const mUser = t.match(/(?:^|[\s'"])(?:-U|--username|-u)[=\s]+["']?([\w.\-]+)/);
  if (mUser) d.user = mUser[1].toLowerCase();
  const mForUser = t.match(/\b(?:for\s+)?user\s+["']([^"'\\\r\n]+)["']/i) || t.match(/\bfor user\s+([^\s:;,"'()]+)/i);
  if (mForUser && !d.user) d.user = mForUser[1].toLowerCase();
  const mDbUser = t.match(/["']?(?:username|user|uid)["']?\s*[=:]\s*["']([^"'\\\r\n]+)["']/i);
  if (mDbUser && !d.user) d.user = mDbUser[1].toLowerCase();
  const uri = t.match(/(?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|redis|mongodb):\/\/[^\s"']+/i);
  if (uri) {
    try { const url = new URL(uri[0].replace(/^jdbc:/i, '')); if (!d.host && url.hostname) d.host = url.hostname.toLowerCase(); if (!d.user && url.username) d.user = decodeURIComponent(url.username).toLowerCase(); } catch {}
  }
  const mAt = !mForUser && !mDbUser && t.match(/(?:^|[\s"'(])([a-z][a-z0-9_.\-]{1,})@([a-z0-9.\-]+)/i);
  if (mAt) { if (!d.user) d.user = mAt[1].toLowerCase(); if (!d.host) d.host = mAt[2].toLowerCase(); }
  return d;
}
const hasDim = (d) => !!(d && (d.srv || d.host || d.user));
const keyOf = (d) => [d.srv || '-', d.host || '-', d.user || '-'].join('/');
const DIMS_DEFAULT = ['srv', 'host', 'user'];
function sameDim(a, b, dimsAllowed) {
  for (const k of dimsAllowed) if (a[k] && b[k] && a[k] === b[k]) return k;
  return null;
}

function load() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { entries: {} }; } }
function save(s) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (e) {} }
function prune(s, c) {
  const now = Date.now();
  const ttl = (c.ttlHours || 24) * 3600e3;
  for (const k of Object.keys(s.entries)) {
    const e = s.entries[k];
    if (!e.blocked && !e.locked && now - (e.at || 0) > ttl) delete s.entries[k];
  }
  return s;
}
function identities(entry, key) {
  const fromKey = {};
  const values = String(key || '').split('/');
  if (values.length === 3) for (let i = 0; i < 3; i++) if (values[i] && values[i] !== '-') fromKey[DIMS_DEFAULT[i]] = values[i];
  return [fromKey, entry.dims || {}, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(hasDim);
}
function findMatches(s, d, dimsAllowed) {
  const hits = [], known = [d], seen = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [k, e] of Object.entries(s.entries)) {
      if (seen.has(k) || !identities(e, k).some(a => known.some(b => sameDim(a, b, dimsAllowed)))) continue;
      seen.add(k);
      hits.push({ k, e });
      known.push(...identities(e, k));
      changed = true;
    }
  }
  return hits;
}

const STOP = '停手：不要再换连接方式/工具/端口重试同一目标——每一次认证失败都在逼近服务端锁定阈值'
  + '（瀚高/PG 约 10 次即 `Too many invalid attempts`，Oracle ORA-28000，MySQL 1045 累计触发主机屏蔽），'
  + '一旦锁定只能由 sysso/DBA 手工解锁，且锁定期内任何重连都在续命。';
const HOWTO = '先查凭据本身再谈重试：① 从配置文件/环境变量取到的密码先校验字节——内网仓库的 `application*.yml` 多为 CRLF，'
  + '按行截取的值带尾部 `\\r`，连发的全是"错密码"；② 优先用已配置好的只读 MCP 连接，不要手搓直连去试生产库；'
  + '③ 向用户上报已失败次数与报错原文，等用户决定（解锁/换凭据/放弃该步）。';

// 只守"能真的发起数据目标连接"的工具面。真机发现 Edit/Write 的 new_string 里只要**引用**了
// `psql -h ... -U ...` 这种字符串（写测试、写文档时必然出现）也会被建出目标键——同一类假键问题。
const SHELLISH = /^(bash|shell|cmd|powershell|terminal|zsh)$/i;
const DBTOOL = /execute_sql|sqlcl|psql|mysql|mariadb|sqlplus|redis-cli/i;
const DB_COMMAND = /^(?:psql|pg_dump|pg_restore|mysql|mariadb|sqlplus|sqlcl|sqlcmd|sqlline|beeline|gsql|mongo|mongosh|redis-cli|execute_sql[_-][a-z0-9_]+)$/i;
const commandName = word => path.basename(String(word || '').replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

function commandOffset(parts) {
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i] || '')) i++;
  while (/^(?:env|sudo|command|exec|nohup)$/.test(commandName(parts[i]))) {
    i++;
    while (parts[i] && (parts[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]))) {
      i += /^(?:-u|-g|--user|--group|--unset)$/.test(parts[i]) ? 2 : 1;
    }
  }
  return i;
}

function commandSubstitution(text, start) {
  const backtick = text[start] === '`';
  if (!backtick && !(text[start] === '$' && text[start + 1] === '(' && text[start + 2] !== '(')) return null;
  const from = start + (backtick ? 1 : 2);
  let nesting = 1, quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (backtick) { if (ch === '`') return { body: text.slice(from, i), end: i }; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') nesting++;
    if (ch === ')' && --nesting === 0) return { body: text.slice(from, i), end: i };
  }
  return null;
}

function shellTargets(command, depth = 0) {
  if (depth > 4) return [];
  const text = String(command || '');
  const commands = [], heredocs = [], targets = [];
  let words = [], word = '', quote = '', active = false, quoted = false, delimiter = null;
  const flushWord = () => {
    if (!active) return;
    if (delimiter) { heredocs.push({ value: word, tabs: delimiter.tabs, quoted, owner: commandName(words[commandOffset(words)]) }); delimiter = null; }
    else words.push(word);
    word = ''; active = false; quoted = false;
  };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const substitution = quote !== "'" && !delimiter ? commandSubstitution(text, i) : null;
    if (substitution) {
      targets.push(...shellTargets(substitution.body, depth + 1));
      word += '__expansion__'; active = true; i = substitution.end;
      continue;
    }
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && /["\\$`\n]/.test(text[i + 1] || '')) { if (text[i + 1] !== '\n') word += text[i + 1]; i++; continue; }
      word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; active = true; quoted = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { if (text[i + 1] !== '\n') { word += text[i + 1]; active = true; } i++; continue; }
    if (ch === '#' && !active) { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      flushWord(); delimiter = { tabs: text[i + 2] === '-' }; i += delimiter.tabs ? 2 : 1; continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      flushCommand();
      if (ch === '\n') {
        while (heredocs.length) {
          const endMarker = heredocs.shift();
          let body = '';
          while (i + 1 < text.length) {
            const start = i + 1, end = text.indexOf('\n', start);
            const line = text.slice(start, end < 0 ? text.length : end).replace(/\r$/, '');
            i = end < 0 ? text.length : end;
            if ((endMarker.tabs ? line.replace(/^\t+/, '') : line) === endMarker.value) break;
            body += line + '\n';
          }
          if (/^(?:bash|sh|zsh|dash)$/.test(endMarker.owner)) targets.push(...shellTargets(body, depth + 1));
          else if (!endMarker.quoted) {
            for (let j = 0; j < body.length; j++) {
              if (body[j] === '\\') { j++; continue; }
              const substitution = commandSubstitution(body, j);
              if (substitution) { targets.push(...shellTargets(substitution.body, depth + 1)); j = substitution.end; }
            }
          }
        }
      }
      continue;
    }
    if (/\s/.test(ch)) { flushWord(); continue; }
    active = true; word += ch;
  }
  flushCommand();
  for (const parts of commands) {
    const i = commandOffset(parts);
    const executable = commandName(parts[i]);
    const argv = parts.slice(i + 1);
    if (/^(?:bash|sh|zsh|dash|cmd|powershell|pwsh)$/.test(executable)) {
      const scriptIndex = argv.findIndex(a => /^-[a-z]*c[a-z]*$|^--command$|^\/c$|^-command$/i.test(a));
      if (scriptIndex >= 0) targets.push(...shellTargets(executable === 'cmd' ? argv.slice(scriptIndex + 1).join(' ') : argv[scriptIndex + 1], depth + 1));
      continue;
    }
    if (/^(?:ssh|plink)$/.test(executable)) {
      let remote = 0;
      const valueOptions = executable === 'ssh'
        ? /^(?:-[BbcDEeFIiJLlmOopQRSWw]|--login)$/
        : /^(?:-l|-P|-pw|-i|-hostkey|-proxycmd|-sercfg|-loghost|-sshlog|-sshrawlog|-sessionlog)$/;
      while (remote < argv.length && argv[remote].startsWith('-')) {
        if (argv[remote] === '--') { remote++; break; }
        remote += valueOptions.test(argv[remote]) ? 2 : 1;
      }
      const destination = argv[remote++];
      if (destination && remote < argv.length) {
        const nested = shellTargets(argv.slice(remote).join(' '), depth + 1);
        const host = destination.replace(/^.*@/, '').replace(/^\[|\]$/g, '').toLowerCase();
        for (const target of nested) {
          if (!target.host) target.host = host;
          targets.push(target);
        }
      }
      continue;
    }
    if (!DB_COMMAND.test(executable)) continue;
    const target = {};
    const srv = executable.match(/^execute_sql[_-](.+)$/i);
    if (srv) target.srv = srv[1];
    for (let j = 0; j < argv.length; j++) {
      const arg = argv[j], option = arg.split('=')[0];
      if (/^(?:-c|-e|--command|--execute)$/.test(option)) { if (!arg.includes('=')) j++; continue; }
      const dimension = /^(?:-h|--host)$/.test(option) ? 'host' : /^(?:-U|-u|--username|--user)$/.test(option) ? 'user' : null;
      if (dimension) {
        const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++j];
        if (value) target[dimension] = value.toLowerCase();
      } else if (/^(?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|redis|mongodb):\/\//i.test(arg)) {
        try { const url = new URL(arg.replace(/^jdbc:/i, '')); if (url.hostname) target.host = url.hostname.toLowerCase(); if (url.username) target.user = decodeURIComponent(url.username).toLowerCase(); } catch {}
      } else if (/^(?:sqlplus|sqlcl)$/.test(executable)) {
        const at = arg.match(/^([^\s/@]+)(?:\/[^@]*)?@([^\s/:]+)(?::\d+)?(?:\/.*)?$/);
        if (at) { target.user = at[1].toLowerCase(); target.host = at[2].toLowerCase(); }
      }
    }
    if (hasDim(target)) targets.push(target);
  }
  return targets;
}

// 把 hook payload 归一化；与数据目标无关 → null
function parse(p) {
  if (!p || typeof p !== 'object') return null;
  const c = cfg();
  if (c.disabled === true) return null;
  const event = String(p.hook_event_name || (p.tool_response !== undefined || p.tool_output !== undefined || p.result !== undefined ? 'PostToolUse' : 'PreToolUse'));
  const rawTool = String(p.tool_name || p.toolName || '');
  let toolName = rawTool, call = p.tool_input || p.toolInput || {};
  // MCP 懒加载形态：真名在 tool_input.toolName，参数在 tool_input.arguments（只按限定名写判据会永远匹配不上）
  if (/^mcp_call$/.test(rawTool) && call && typeof call === 'object') {
    toolName = String(call.toolName || '');
    call = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
  }
  if (!(SHELLISH.test(rawTool) || DBTOOL.test(toolName))) return null;
  const srvFromTool = (toolName.match(/execute_sql[_-]([a-z0-9_]+)/i) || [])[1];
  let callTargets;
  if (SHELLISH.test(rawTool)) callTargets = shellTargets(typeof call === 'string' ? call : call.command);
  else {
    const target = dims(toolName, srvFromTool, !srvFromTool);
    const host = call.host || call.hostname, user = call.username || call.user || call.uid;
    if (typeof host === 'string' && host) target.host = host.toLowerCase();
    if (typeof user === 'string' && user) target.user = user.toLowerCase();
    for (const uri of [call.dsn, call.url, call.jdbcUrl, call.connectionString]) {
      if (typeof uri !== 'string' || !/^(?:jdbc:)?(?:postgres(?:ql)?|mysql|mariadb|redis|mongodb):\/\//i.test(uri)) continue;
      const identity = dims(uri);
      for (const key of ['host', 'user']) if (!target[key] && identity[key]) target[key] = identity[key];
    }
    callTargets = [target].filter(hasDim);
  }
  if (!callTargets.length) return null;
  return { event, rawTool, toolName, call, callTargets, srvFromTool, cfg: c };
}

// PreToolUse：查状态，该拦就给 reason。返回 null＝放行（已建目标时顺带留 allow 台账）
function preCheck(payload) {
  const t = parse(payload);
  if (!t) return null;
  const dimensions = Array.isArray(t.cfg.dims) ? t.cfg.dims.filter(d => DIMS_DEFAULT.includes(d)) : [];
  const dimsAllowed = dimensions.length ? dimensions : DIMS_DEFAULT;
  const threshold = Math.min(3, Math.max(1, Math.floor(Number(t.cfg.threshold) || 3)));
  const s = prune(load(), t.cfg);
  for (const target of t.callTargets) {
    const hits = findMatches(s, target, dimsAllowed);
    const count = hits.reduce((total, hit) => total + (hit.e.count || 0), 0);
    const idKey = hits.length ? hits[0].k : keyOf(target);
    if (hits.some(hit => hit.e.blocked || hit.e.locked) || count >= threshold) {
      ledger('block|' + idKey + '|n=' + count);
      return {
        key: idKey, count,
        reason: '[auth-lock] 目标 `' + idKey + '` 已累计认证失败 ' + count + ' 次'
          + (hits.some(hit => hit.e.locked) ? '，且返回里已出现**锁定签名**（该账号大概率已被服务端锁死，只能由 sysso/DBA 解锁）' : '') + '，本次调用被拦。' + STOP + '\n' + HOWTO
          + '\n人工解除：node ~/.qoder/scripts/auth-lock-guard.js --clear "' + idKey + '"（或 --clear ALL）',
      };
    }
    ledger('eval|allow|' + idKey + '|n=' + count);
  }
  return null;
}

function responseText(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (['{', '[', '"'].includes(value.trim()[0])) { try { return responseText(JSON.parse(value), depth + 1); } catch {} }
    return value;
  }
  if (Array.isArray(value)) return value.map(part => responseText(part, depth + 1)).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);
  const code = value.errno === 1045 || value.code === 1045 || value.code === 'ER_ACCESS_DENIED_ERROR' ? ['ERROR 1045'] : [];
  return code.concat(['error', 'errors', 'message', 'stderr', 'stdout', 'text', 'content', 'output'].map(key => responseText(value[key], depth + 1))).filter(Boolean).join('\n');
}

function authenticatedRows(value, depth = 0) {
  if (depth > 4) return false;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
  if (!value || typeof value !== 'object' || value.isError === true || value.is_error === true || value.error || value.stderr
      || (Array.isArray(value.errors) ? value.errors.length > 0 : value.errors)
      || (Number.isInteger(value.exitCode) && value.exitCode !== 0) || (Number.isInteger(value.exit_code) && value.exit_code !== 0)) return false;
  if (Array.isArray(value.rows)) return true;
  return Array.isArray(value.content) && value.content.length > 0 && value.content.every(part => part && part.type === 'text' && authenticatedRows(part.text, depth + 1));
}

// PostToolUse：只看返回给次数记账。返回 {key, count, kind, reason}；reason 非空＝该当场叫停
function postRecord(payload) {
  const t = parse(payload);
  if (!t) return null;
  const dimensions = Array.isArray(t.cfg.dims) ? t.cfg.dims.filter(d => DIMS_DEFAULT.includes(d)) : [];
  const dimsAllowed = dimensions.length ? dimensions : DIMS_DEFAULT;
  const threshold = Math.min(3, Math.max(1, Math.floor(Number(t.cfg.threshold) || 3)));
  const s = prune(load(), t.cfg);
  const resp = payload.tool_response !== undefined ? payload.tool_response
    : payload.tool_output !== undefined ? payload.tool_output
    : payload.result !== undefined ? payload.result : payload.output;
  const respText = responseText(resp);
  let envelope = resp;
  if (typeof envelope === 'string') { try { envelope = JSON.parse(envelope); } catch {} }
  const explicitError = payload.is_error === true || (envelope && typeof envelope === 'object'
    && (envelope.isError === true || envelope.is_error === true || envelope.error || envelope.stderr
      || (Array.isArray(envelope.errors) ? envelope.errors.length > 0 : envelope.errors)
      || (Number.isInteger(envelope.exitCode) && envelope.exitCode !== 0) || (Number.isInteger(envelope.exit_code) && envelope.exit_code !== 0)));
  const shellRows = SHELLISH.test(t.rawTool) && !explicitError && /\(\s*\d+\s+rows?\s*\)\s*$/m.test(respText) && !/^\s*(?:ERROR\b|FATAL\b|ORA-\d+|psql:)/mi.test(respText);
  const any = pats => pats.some(re => re.test(respText));
  let kind = 'neutral';
  if (!explicitError && (authenticatedRows(resp) || shellRows)) kind = 'ok';
  else if (any(LOCKED)) kind = 'locked';
  else if (any(AUTH_FAIL)) kind = 'authfail';
  else if (!NEUTRAL.test(respText) && /(?:\bERROR:\s*syntax error\b|\bORA-009(?:00|04|07|17|23|33|36)\b|you have an error in your SQL syntax)/i.test(respText)) kind = 'ok';

  const resDims = kind === 'authfail' || kind === 'locked' ? dims(respText, t.srvFromTool) : {};
  const target = t.callTargets.find(d => sameDim(d, resDims, dimsAllowed)) || t.callTargets[0];
  const merged = Object.assign({}, resDims, target);
  const hits = findMatches(s, merged, dimsAllowed);
  const idKey = hits.length ? hits[0].k : keyOf(merged);
  const count = hits.reduce((total, hit) => total + (hit.e.count || 0), 0);
  if (kind === 'ok') {
    if (hits.length && !hits.some(hit => hit.e.blocked || hit.e.locked)) {
      for (const hit of hits) delete s.entries[hit.k];
      save(s); ledger('reset|' + idKey);
      return { key: idKey, count: 0, kind };
    }
    return { key: idKey, count, kind };
  }
  if (kind === 'neutral') { ledger('neutral|' + idKey); return { key: idKey, count, kind }; }

  const aliases = new Map(hits.flatMap(hit => identities(hit.e, hit.k)).concat([merged]).map(d => [keyOf(d), d]));
  const cur = {
    dims: merged,
    aliases: [...aliases.values()],
    count: kind === 'locked' ? Math.max(threshold, count + 1) : count + 1,
    at: Date.now(),
    samples: hits.flatMap(hit => hit.e.samples || []).concat([kind === 'locked' ? '服务返回锁定签名' : '服务返回认证失败签名']).slice(-3),
    locked: kind === 'locked' || hits.some(hit => hit.e.locked),
    blocked: hits.some(hit => hit.e.blocked || hit.e.locked),
  };
  if (cur.locked || cur.count >= threshold) cur.blocked = true;
  for (const hit of hits) delete s.entries[hit.k];
  s.entries[idKey] = cur;
  save(s);
  ledger(kind + '|' + idKey + '|n=' + cur.count);
  return {
    key: idKey, count: cur.count, kind,
    reason: cur.blocked
      ? '[auth-lock] 目标 `' + idKey + '` 认证失败已累计到 ' + cur.count + ' 次'
        + (cur.locked ? '（返回里已出现**锁定签名**）' : '') + '。' + STOP + '\n' + HOWTO
        + '\n最近报错：' + cur.samples[cur.samples.length - 1]
      : null,
  };
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

module.exports = { preCheck, postRecord, status, clear, cfg, ledger, parse, paths: () => ({ CONFIG, STATE_DIR, STATE, LEDGER }) };
