#!/usr/bin/env node
// install-fail-streak.cjs —— 把 fail-streak 守卫接到现役强制层（流水线第 9 步的执行器）
//
// 默认 **dry-run**：只打印将要发生的改动，一个字节都不写。加 `--apply` 才写。
// 写入顺序固定为「先备份（且必须给出可用备份文件）→ 写临时文件 → node --check → 覆盖 → 复验幂等」；
// 任一步失败即中止该侧，不再继续写后续文件（避免半套接线）。
// 幂等：委托段必须同时有开/闭标记且指向 fail-streak-core 才算已安装；settings.json 必须是
// 单条、type/完整命令/matcher/timeout 全部匹配的条目才算已接线——不一致一律拒绝，不静默当作完成。
// 命令中的 Node 与守卫路径都加引号，路径含空格时也能被宿主正确解析。
//
// 用法：
//   node install-fail-streak.cjs                       体检两侧（~/.qoder 与 ~/.qoder-cn），只打印计划
//   node install-fail-streak.cjs --apply               真写（每个已有目标先跑 backup-file.js）
//   node install-fail-streak.cjs --selftest            沙箱端到端：装配 + 真跑 Pre 判红 + 摘委托段判绿
//   node install-fail-streak.cjs --home <目录>          只处理该体检根（测试/单侧用）
//   可选：--node <可执行路径> --matcher <正则> --timeout <秒> --backup <backup-file.js 路径>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const SRC = __dirname;
const HOST = 'risky-match-guard.js';
const GUARD = 'fail-streak-guard.js';
const FILES = ['fail-streak-core.js', GUARD, 'fail-streak-guard.test.js', 'fail-streak-merge-mutation.test.js'];
const MARK_OPEN = '// <fail-streak-delegation>';
const MARK_CLOSE = '// </fail-streak-delegation>';

const DELEGATION = [
  MARK_OPEN,
  '// 「同类操作连败 3 种不同手段即停」的 PreToolUse 半边（判据与状态全在 fail-streak-core.js，',
  '//  由技能 mechanize-rule-into-hook-guard 的 install-fail-streak.cjs 插入；',
  '//  开关：~/.qoder/fail-streak-guard.json 写 {"disabled":true}；人工解封：fail-streak-guard.js --clear ALL）。',
  '// 位置是硬要求：必须在 auth-lock 委托之后、记忆优先提醒之前。两者都是「先出声者定论」的分支，',
  '// 硬停必须赢过一次性提醒——反过来会让变异验证拿到 [memory-first] 的假结果。',
  'try {',
  "  const fst = require('./fail-streak-core.js').preCheck(input);",
  '  if (fst && fst.reason) {',
  "    ledger('block|fail-streak|' + String(fst.key || '').slice(0, 60));",
    "console.log(JSON.stringify({ decision: 'block', reason: fst.reason }));",
  '    process.exit(0);',
  '  }',
  '} catch (e) {',
  '  // 崩了必须留痕（静默 catch＝Pre 半边悄悄失效）；core 缺失是最常见崩法，所以用宿主自己的 ledger',
  "  try { ledger('fail-streak-pre-error|' + String((e && e.message) || e).replace(/\\s+/g, ' ').slice(0, 140)); } catch (e2) {}",
  '}',
  MARK_CLOSE,
].join('\n');

function parseArgs(argv) {
  const a = { node: process.execPath, matcher: '^Bash$|mcp_call', timeout: 10, backup: path.join(HOME, '.qoder', 'scripts', 'backup-file.js') };
  const values = new Set(['--home', '--second', '--node', '--matcher', '--timeout', '--backup']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') a.apply = true;
    else if (flag === '--selftest') a.selftest = true;
    else {
      if (!values.has(flag)) throw new Error('未识别的选项：' + flag);
      const value = argv[++i];
      if (!value || !value.trim() || value.startsWith('--')) throw new Error(flag + ' 缺少值');
      a[flag.slice(2)] = value;
    }
  }
  a.timeout = Number(a.timeout);
  if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Error('--timeout 必须是有限正数（秒）');
  return a;
}
const slash = (p) => String(p).replace(/\\/g, '/');

// ---- 计划：三类改动，每类都先证明「为什么是这个位置」 ----
function filePlans(root) {
  return FILES.map((name) => {
    const s = path.join(SRC, name), d = path.join(root, 'scripts', name);
    if (!fs.existsSync(s)) return { target: d, action: 'abort', why: '技能目录里缺源文件 ' + name };
    const after = fs.readFileSync(s, 'utf8');
    const exists = fs.existsSync(d);
    const before = exists ? fs.readFileSync(d, 'utf8') : null;
    return { target: d, action: exists ? (before === after ? 'skip' : 'overwrite') : 'create', before, after, why: exists ? (before === after ? '内容一致，不动' : '目标已存在且不同 → 备份后覆盖') : '新增' };
  });
}

function hostPlan(root) {
  const target = path.join(root, 'scripts', HOST);
  if (!fs.existsSync(target)) return { target, action: 'abort', why: '宿主守卫不存在，Pre 半边无处可挂' };
  const before = fs.readFileSync(target, 'utf8');
  const open = before.split(MARK_OPEN).length - 1, close = before.split(MARK_CLOSE).length - 1;
  if (open || close) {
    const start = before.indexOf(MARK_OPEN), end = before.indexOf(MARK_CLOSE);
    const valid = open === 1 && close === 1 && start >= 0 && end > start
      && before.slice(start, end).includes("require('./fail-streak-core.js').preCheck");
    if (valid) return { target, action: 'skip', why: '委托段完整且指向 fail-streak-core（幂等跳过）', before };
    return { target, action: 'abort', why: `标记不完整或委托内容不符（open=${open} close=${close}）——拒绝当作已安装，请人工核对后再决定`, before };
  }
  const iAuth = before.indexOf('auth-lock-pre-error');
  let iMf = before.indexOf('// 记忆优先门禁');
  if (iMf < 0) iMf = before.indexOf('const mfVerdict');
  if (!(iAuth >= 0 && iMf > iAuth)) {
    return { target, action: 'abort', why: `锚点不可证（auth-lock 委托@${iAuth}、记忆优先@${iMf}）——拒绝插入。顺序错了硬停会被提醒吃掉，接了等于没接。`, before };
  }
  const lineStart = before.lastIndexOf('\n', iMf) + 1;
  const after = before.slice(0, lineStart) + DELEGATION + '\n' + before.slice(lineStart);
  return { target, action: 'insert', before, after, order: { authLock: iAuth, insertAt: lineStart, memoryFirst: iMf }, why: '插在 auth-lock 委托之后、记忆优先提醒之前' };
}

function commandPaths(command) {
  // Only a Node executable and the guard itself may run here. Looking for the
  // guard anywhere in a shell command also accepts `echo` and `--clear ALL`.
  const token = '(?:"([^"\\r\\n]+)"|([^\\s"\'`|&;<>$()]+))';
  const match = String(command || '').match(new RegExp('^\\s*' + token + '\\s+' + token + '\\s*$'));
  return match ? [match[1] || match[2], match[3] || match[4]] : null;
}

function sameCommandPath(actual, expected) {
  const left = path.resolve(actual), right = path.resolve(expected);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function settingsPlan(root, opts) {
  const target = path.join(root, 'settings.json');
  if (!fs.existsSync(target)) return { target, action: 'abort', why: 'settings.json 不存在' };
  const before = fs.readFileSync(target, 'utf8');
  let j;
  try { j = JSON.parse(before); } catch (e) { return { target, action: 'abort', why: '不是纯 JSON，拒绝改写：' + e.message, before }; }
  const hooks = (j.hooks || {});
  const post = hooks.PostToolUse || [];
  // 命令里的脚本路径走 realpath：本机 `.qoder-cn/scripts` 是指向 `.qoder/scripts` 的 junction，
  // 两侧 settings.json 却是各自独立的文件。照 root 拼路径会给 -cn 侧写出 `-cn/scripts/...`，
  // 和现役条目（一律写真源路径）不一致 —— sync-global-config.sh --check 会把它判成接线漂移。
  let scriptsDir = path.join(root, 'scripts');
  try { scriptsDir = fs.realpathSync(scriptsDir); } catch (e) {}
  const expectedGuard = path.join(scriptsDir, GUARD);
  const command = `"${slash(opts.node)}" "${slash(expectedGuard)}"`;
  const existing = post.filter((en) => (en.hooks || []).some((h) => /fail-streak-guard\.js/i.test(String(h.command || ''))));
  if (existing.length) {
    const match = existing.length === 1 && (existing[0].hooks || []).length === 1
      && existing[0].matcher === opts.matcher && existing[0].hooks[0].timeout === opts.timeout
      && existing[0].hooks[0].type === 'command'
      && (() => { const paths = commandPaths(existing[0].hooks[0].command); return paths && sameCommandPath(paths[0], opts.node) && sameCommandPath(paths[1], expectedGuard); })();
    if (match) return { target, action: 'skip', why: 'PostToolUse 已有与期望一致的 fail-streak 条目（幂等）', before, entriesBefore: post.length };
    return { target, action: 'abort', why: `已有 ${existing.length} 条 fail-streak 条目但与期望不一致（type/完整命令/matcher/timeout）——拒绝重复接线，请人工核对`, before, entriesBefore: post.length };
  }
  const next = JSON.parse(before);
  next.hooks = next.hooks || {};
  next.hooks.PostToolUse = post.concat([{ matcher: opts.matcher, hooks: [{ type: 'command', command, timeout: opts.timeout }] }]);
  const after = JSON.stringify(next, null, 2) + '\n';
  try { JSON.parse(after); } catch (e) { return { target, action: 'abort', why: '序列化后 JSON 无效：' + e.message, before }; }
  // 格式化漂移要**看得见**：原文件若不是 2 空格缩进，整体重写会产生一份巨大无关 diff，
  // 把「加一条 hook」埋进改 200 行里——审阅的人会因此跳过它，而这正是改权限配置最不该有的事。
  const formatDrift = (JSON.stringify(JSON.parse(before), null, 2) + '\n') !== before;
  return { target, action: 'append', before, after, command, formatDrift, entriesBefore: post.length, entriesAfter: next.hooks.PostToolUse.length, why: '新开一条 PostToolUse（Pre 峰值已满，Post 半边不能并进别的守卫：它要读本轮返回）' + (formatDrift ? '；注意：原文件缩进与 2 空格不一致，本次会整体重排格式' : '') };
}

function planFor(root, opts) {
  const rows = filePlans(root).concat([hostPlan(root), settingsPlan(root, opts)]);
  return { root, rows, aborts: rows.filter((r) => r.action === 'abort'), writes: rows.filter((r) => r.action !== 'skip' && r.action !== 'abort') };
}

// ---- 执行：备份 → 临时文件 → 语法校验 → 覆盖 ----
function backup(target, opts, log) {
  if (!fs.existsSync(target)) return log.push('  [备份] 目标不存在，无需备份'), null;
  if (fs.existsSync(opts.backup)) {
    const r = spawnSync(process.execPath, [opts.backup, target], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error('backup-file.js 失败（' + r.status + '）：' + String(r.stderr || r.stdout).slice(0, 200));
    const reported = (String(r.stdout || '').match(/\[备份\]\s*(.+)/) || [, ''])[1].trim();
    if (!reported || !fs.existsSync(reported) || !fs.statSync(reported).isFile()) throw new Error('backup-file.js 未给出可用的备份文件，拒绝写入');
    return reported;
  }
  const alt = target + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(target, alt);
  log.push('  [备份] backup-file.js 不可用，已退化为同目录副本 ' + alt);
  return alt;
}

function applyPlan(plan, opts) {
  const out = { root: plan.root, done: [], backups: [], errors: [] };
  if (plan.aborts.length) { out.errors.push('中止：' + plan.aborts.map((r) => path.basename(r.target) + ' → ' + r.why).join(' | ')); return out; }
  for (const row of plan.writes) {
    const log = [];
    let tmp = null;
    try {
      // 临时文件必须**保住原扩展名**：`node --check x.js.fail-streak-new` 会因扩展名未知直接抛
      // ERR_UNKNOWN_FILE_EXTENSION，看起来像"语法坏了"，其实是在校验器自己身上。
      tmp = path.join(path.dirname(row.target), '.fail-streak-tmp-' + path.basename(row.target));
      fs.writeFileSync(tmp, row.after);
      if (/\.(js|cjs|mjs)$/.test(row.target)) {
        const chk = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 30000 });
        if (chk.status !== 0) throw new Error('语法校验未过，已放弃写入：' + String(chk.stderr || '').slice(0, 200));
      } else {
        JSON.parse(row.after);
      }
      const bak = backup(row.target, opts, log);
      if (bak) out.backups.push(bak);
      fs.renameSync(tmp, row.target);
      tmp = null;
      out.done.push(row.action + ' → ' + row.target);
    } catch (e) {
      out.errors.push(row.target + ' :: ' + e.message);
    } finally {
      if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (e) {} }
    }
    out.done.push(...log);
    if (out.errors.length) break;
  }
  return out;
}

function printPlan(plan, opts) {
  console.log('=== 体检根 ' + plan.root + ' ===');
  for (const r of plan.rows) {
    const tag = { skip: '不动', create: '新增', overwrite: '备份后覆盖', insert: '插入委托段', append: '追加 PostToolUse 条目', abort: '拒绝' }[r.action] || r.action;
    console.log('  [' + tag + '] ' + r.target + (r.why ? '  · ' + r.why : ''));
    if (r.action === 'append') console.log('        matcher=' + JSON.stringify(opts.matcher) + ' command=' + r.command + ' timeout=' + opts.timeout + '（条目 ' + r.entriesBefore + ' → ' + r.entriesAfter + '）' + (r.formatDrift ? ' !! 会整体重排 JSON 格式' : ''));
    if (r.action === 'insert') console.log('        位置：auth-lock@' + r.order.authLock + ' < 插入点@' + r.order.insertAt + ' < memory-first@' + r.order.memoryFirst);
  }
  if (plan.aborts.length) console.log('  !! 该侧有 ' + plan.aborts.length + ' 项被拒；--apply 时会整侧中止（不做半套接线）');
}

// ---- 沙箱端到端：证明「接上去真的会拦」，且这条绿能被摘掉委托段判红 ----
function selftest(opts) {
  const deps = [HOST, 'hook-crash-guard.js', 'auth-lock-core.js', 'attempt-lock-core.js', 'client-root.js'];
  const candidates = [path.resolve(SRC, '../../../scripts'), path.join(HOME, '.qoder', 'scripts'), path.join(HOME, '.qoder-cn', 'scripts')];
  const real = candidates.find(dir => deps.every(name => fs.existsSync(path.join(dir, name))));
  if (!real) { console.error('自检缺少宿主依赖闭包（' + deps.join(', ') + '），未执行安装'); return 1; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-install-'));
  const root = path.join(dir, 'qoder');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const d of deps) fs.copyFileSync(path.join(real, d), path.join(root, 'scripts', d));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: opts.node + ' ' + slash(path.join(root, 'scripts', HOST)) }] }], PostToolUse: [] } }, null, 2) + '\n');

  let fail = 0;
  const check = (label, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 170) : '')); if (!ok) fail++; };
  const st = path.join(dir, 'state');
  const env = Object.assign({}, process.env, {
    QODER_HOME: root,
    FAIL_STREAK_STATE_DIR: path.join(st, 'fs'), FAIL_STREAK_CONFIG: path.join(dir, 'no-config.json'),
    RISKY_MATCH_STATE_DIR: path.join(st, 'risky'), AUTH_LOCK_STATE_DIR: path.join(st, 'auth'),
    AUTH_LOCK_CONFIG: path.join(dir, 'no-auth-config.json'), HOOK_CRASH_LOG: path.join(dir, 'crash.log'),
  });
  const run = (script, payload) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000, env });
    const crash = fs.existsSync(env.HOOK_CRASH_LOG) && fs.statSync(env.HOOK_CRASH_LOG).size > 0;
    check('自检子进程健康 ' + path.basename(script), !r.error && r.status === 0 && !crash,
      'exit=' + r.status + (r.error ? ' ' + r.error.message : '') + (crash ? ' hook crash log is not empty' : ''));
    let d = {}; try { d = JSON.parse(r.stdout || '{}'); } catch (e) {}
    return { code: r.status, out: r.stdout || '', decision: d.decision, reason: d.reason || '' };
  };

  const dry = planFor(root, opts);
  printPlan(dry, opts);
  const hostBefore = fs.readFileSync(path.join(root, 'scripts', HOST), 'utf8');
  check('自检1 只出计划不写文件（dry-run 路径下 scripts/ 里不得出现任何 fail-streak 产物）', fs.readFileSync(path.join(root, 'scripts', HOST), 'utf8') === hostBefore && fs.readdirSync(path.join(root, 'scripts')).filter((f) => /fail-streak/.test(f)).length === 0, 'dry 计划里本应有 ' + dry.writes.length + ' 项待写');

  const applied = applyPlan(planFor(root, opts), Object.assign({}, opts, { backup: path.join(real, 'backup-file.js') }));
  check('自检2 apply 无错误', applied.errors.length === 0, applied.errors.join(' | '));
  const hostAfter = fs.readFileSync(path.join(root, 'scripts', HOST), 'utf8');
  const marks = (hostAfter.match(new RegExp(MARK_OPEN.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g')) || []).length;
  check('自检3 委托段插入且只有一份', marks === 1 && hostAfter.includes(MARK_CLOSE), 'marks=' + marks);
  check('自检4 顺序：硬停在提醒之前', hostAfter.indexOf('auth-lock-pre-error') < hostAfter.indexOf(MARK_OPEN) && hostAfter.indexOf(MARK_OPEN) < hostAfter.indexOf('// 记忆优先门禁'));
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
  const fsEntries = (settings.hooks.PostToolUse || []).filter((en) => (en.hooks || []).some((h) => /fail-streak-guard\.js/i.test(String(h.command || ''))));
  check('自检5 settings.json 新增且只有 1 条 fail-streak 条目', fsEntries.length === 1 && fsEntries[0].matcher === opts.matcher && fsEntries[0].hooks[0].timeout === opts.timeout);
  check('自检6 四个脚本已落到 scripts/', FILES.every((f) => fs.existsSync(path.join(root, 'scripts', f))));
  check('自检7 备份真实存在（改前可回滚）', applied.backups.length >= 1, applied.backups.join(', '));

  const againPlan = planFor(root, opts);
  const again = applyPlan(againPlan, opts);
  const hostAgain = fs.readFileSync(path.join(root, 'scripts', HOST), 'utf8');
  const entriesAgain = (JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).hooks.PostToolUse || []).filter((en) => (en.hooks || []).some((h) => /fail-streak-guard\.js/i.test(String(h.command || '')))).length;
  check('自检8 重复执行幂等（不产生第二份委托/条目）', hostAgain === hostAfter && entriesAgain === 1 && againPlan.writes.length === 0 && again.errors.length === 0, 'writes=' + againPlan.writes.length + ' entries=' + entriesAgain + ' errors=' + again.errors.join('|'));

  const T = '198.51.100.77';
  const G = path.join(root, 'scripts', GUARD);
  const posts = [
    ['curl -sS http://' + T + '/api', 'curl: (7) Failed to connect to ' + T + ' port 80: Connection refused'],
    ['ssh -o ConnectTimeout=5 root@' + T + ' systemctl status agent', 'ssh: connect to host ' + T + ' port 22: Operation timed out'],
    ['ping -n 2 ' + T, 'ping: transmit failed. General error. (No route to host)'],
  ];
  posts.forEach(([c, resp]) => run(G, { hook_event_name: 'PostToolUse', session_id: 'fs-selftest', tool_name: 'Bash', tool_input: { command: c }, tool_response: resp }));
  const pre = run(path.join(root, 'scripts', HOST), { hook_event_name: 'PreToolUse', session_id: 'fs-selftest', tool_name: 'Bash', tool_input: { command: 'wget -q -O - http://' + T + '/x' } });
  check('自检9 真跑宿主 Pre：第四种手段被 [fail-streak] 拦下', pre.code === 0 && pre.decision === 'block' && /\[fail-streak\]/.test(pre.reason), 'decision=' + pre.decision + ' reason=' + pre.reason.slice(0, 90));

  // 负对照：摘掉委托段的宿主副本，同一序列不得再出现 [fail-streak]（证明自检9 不是恒绿）
  const stripped = path.join(root, 'scripts', 'host-no-delegation.js');
  const seg = hostAfter.indexOf(MARK_OPEN), segEnd = hostAfter.indexOf(MARK_CLOSE) + MARK_CLOSE.length;
  fs.writeFileSync(stripped, hostAfter.slice(0, seg) + hostAfter.slice(segEnd));
  const pre2 = run(stripped, { hook_event_name: 'PreToolUse', session_id: 'fs-selftest-2', tool_name: 'Bash', tool_input: { command: 'wget -q -O - http://' + T + '/x' } });
  check('自检10 负对照：摘掉委托段后不再出现 [fail-streak]（绿不是恒真）', pre2.code === 0 && !/\[fail-streak\]/.test(pre2.reason), 'decision=' + pre2.decision + ' reason=' + pre2.reason.slice(0, 70));

  const ledgerTxt = (() => { try { return fs.readFileSync(path.join(st, 'fs', 'decisions.log'), 'utf8'); } catch (e) { return ''; } })();
  check('自检11 台账含 streak-new×3 与 block（守卫真跑过）', (ledgerTxt.match(/streak-new\|198\.51\.100\.77/g) || []).length === 3 && /block\|198\.51\.100\.77/.test(ledgerTxt));
  check('自检12 真实 ~/.qoder/tmp/fail-streak-guard 未被自检写入', !fs.existsSync(path.join(HOME, '.qoder', 'tmp', 'fail-streak-guard', 'state.json')) || !/198\.51\.100\.77/.test(fs.readFileSync(path.join(HOME, '.qoder', 'tmp', 'fail-streak-guard', 'state.json'), 'utf8')));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail === 0 ? '\n安装器自检全绿：接线会在真实宿主里判红，摘掉委托段即失效' : `\nRED: ${fail} 项自检未过 —— 别用这个安装器接生产`);
  return fail === 0 ? 0 : 1;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error('[错误] 无效参数: ' + error.message); return 2; }
  if (opts.selftest) return selftest(opts);
  const roots = [];
  if (opts.home) roots.push(path.resolve(opts.home));
  else {
    roots.push(path.join(HOME, '.qoder'));
    const second = opts.second ? path.resolve(opts.second) : path.join(HOME, '.qoder-cn');
    if (fs.existsSync(path.join(second, 'settings.json'))) roots.push(second);
  }
  console.log(opts.apply ? '模式：--apply（会写文件；每个已有目标先备份）' : '模式：dry-run（不写任何文件；加 --apply 才写）');
  console.log('node=' + opts.node + '  matcher=' + JSON.stringify(opts.matcher) + '  timeout=' + opts.timeout + '  备份器=' + opts.backup + '\n');
  let rc = 0;
  for (const r of roots) {
    const plan = planFor(r, opts);
    printPlan(plan, opts);
    if (!opts.apply) continue;
    const res = applyPlan(plan, opts);
    res.done.forEach((d) => console.log('  [完成] ' + d));
    res.backups.forEach((b) => console.log('  [备份] ' + b));
    res.errors.forEach((e) => { console.log('  [中止] ' + e); rc = 1; });
    const re = planFor(r, opts);
    const idempotent = re.writes.length === 0;
    console.log('  [复验] 再次计划应全为不动 → ' + (idempotent ? 'OK（幂等）' : 'FAIL，仍有 ' + re.writes.length + ' 项待写'));
    if (!idempotent) rc = 1;
  }
  if (opts.apply && rc === 0) {
    console.log('\n接线完成后的复验命令（必跑，别只看这里的全绿）：');
    console.log('  node ' + slash(path.join(roots[0], 'scripts', 'fail-streak-guard.test.js')) + ' --installed');
    console.log('  node ' + slash(path.join(roots[0], 'scripts', 'rules-weekly-audit.js')) + ' --no-fix');
    console.log('  bash ' + slash(path.join(roots[0], 'scripts', 'sync-global-config.sh')) + ' --check');
    console.log('  node ' + path.join(SRC, 'hook-gap-scan.cjs') + '   （缺口判定应从「成立」翻成「已有机制」）');
    console.log('回滚：删掉两侧 settings.json 里的 fail-streak 条目 + risky-match-guard.js 标记之间那段，再用上面的备份文件覆盖宿主与脚本。');
    console.log('未做（需另行授权）：进分享包要把四个脚本加进 pack-share-extras.js 白名单；README-rule-enforcement.md 与 rules-reminder.js 那条提示词要同批回写。');
  } else if (!opts.apply) {
    console.log('\n以上是计划，未写入。确认无误后由使用者本人跑：node ' + path.join(SRC, 'install-fail-streak.cjs') + ' --apply');
  }
  return rc;
}
if (require.main === module) process.exit(main());
module.exports = { planFor, hostPlan, settingsPlan, filePlans, applyPlan, DELEGATION, MARK_OPEN, MARK_CLOSE };
