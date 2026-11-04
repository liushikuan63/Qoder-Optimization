#!/usr/bin/env node
// SessionStart 守卫：每次会话开台先做一次"规则真源体检"，健康时零输出。
// 检三件事：① AGENTS.md 与 rules/*.md 两侧是否漂移；② 记忆两侧是否分叉；
// ③ 规则里引用的本地文件（rules/xxx.md、memory/xxx.md、scripts/xxx）是否真的存在（防悬空引用）。
// 任一异常 → 注入一行提醒 + 修复命令；脚本自身出错一律静默放行，不阻塞会话。
'use strict';
require('./hook-crash-guard.js').install('global-config-guard'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
const fs = require('fs');
const path = require('path');
const { clientRoot, counterpart } = require('./client-root.js');
const { findMissingHookTargets } = require('./hook-targets.cjs');
const CLIENT_ROOT = clientRoot();
const { spawnSync } = require('child_process');

const A = CLIENT_ROOT;
const B = counterpart(A);
// bash 路径按候选表探测（可用 QODER_BASH 覆盖）：写死单一路径的版本在别人机器上会静默跑不起来，
// 本机候选全落空时退回 PATH 里的 bash —— 与 hook 的 fail-open 语义一致，绝不因路径不对把体检变成崩溃。
const BASH = (() => {
  const cands = [process.env.QODER_BASH, 'C:/Program Files/Git/bin/bash.exe', 'D:/software/Git/bin/bash.exe'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return 'bash';
})();

/**
 * 总预算：本脚本被 SessionStart hook 以 `timeout: 15`（秒）调用，而下面两路检查是**串行**的。
 * 只给每一路各设 8s 上限的话，两路相加最坏 16s > 15s ⇒ 整个 hook 被掐死，
 * 一段提醒都不会输出（检查从"报得准"退化成"静默"，比没检查更糟）。
 * 所以这里改成**一个共享截止线**：预算用尽就跳过剩下的检查，并明确报"没检查完"。
 * 11s = 15s 减去 node 启动与写出的余量（Windows 上 spawn 一次实测约 320ms）。
 */
const BUDGET_MS = Number(process.env.GUARD_BUDGET_MS) > 0 ? Number(process.env.GUARD_BUDGET_MS) : 11000;
const RESERVE_MS = Number(process.env.GUARD_RESERVE_MS) > 0 ? Number(process.env.GUARD_RESERVE_MS) : 600;
const PER_CALL_CAP_MS = 8000;
const DEADLINE = Date.now() + BUDGET_MS;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function sh(script, args) {
  const left = DEADLINE - Date.now() - RESERVE_MS;
  if (left <= 0) return { code: -2, out: '', skipped: true, timedOut: false, capMs: 0 };
  const capMs = Math.min(PER_CALL_CAP_MS, left);
  try {
    const r = spawnSync(BASH, [script, ...args], { encoding: 'utf8', timeout: capMs });
    const timedOut = r.status === null && !!(r.error || (r.signal && String(r.signal) !== 'null'));
    return { code: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || ''), skipped: false, timedOut, capMs };
  } catch (e) {
    return { code: -1, out: '', skipped: false, timedOut: false, capMs };
  }
}

/** 退出码不是 0/1（跑不起来、超时、bash 路径不对…）时的说法 —— 这类情况**必须出声**。 */
function notRun(label, r) {
  if (r.skipped) return label + ' 未检查（本 hook 的 ' + BUDGET_MS + 'ms 预算已用尽，跳过以保提醒能落地）';
  if (r.timedOut) return label + ` 超时未跑完（只分到 ${r.capMs}ms 没跑完；预算 ${BUDGET_MS}ms，先单独跑那个脚本看卡在哪）`;
  return label + ' 未能执行（退出码 ' + r.code + '）';
}

// 规则正文里引用的相对路径是否存在（两种形态：rules/x.md、memory/x.md、scripts/x、commands/x，以及 skills/<技能>/scripts/x）
function danglingRefs() {
  const bad = [];
  const files = [];
  try {
    files.push(path.join(A, 'AGENTS.md'));
    for (const f of fs.readdirSync(path.join(A, 'rules'))) files.push(path.join(A, 'rules', f));
  } catch (e) {}
  try {
    for (const f of fs.readdirSync(path.join(A, 'commands'))) files.push(path.join(A, 'commands', f));
  } catch (e) {}
  for (const f of files) {
    let txt;
    try {
      txt = fs.readFileSync(f, 'utf8');
    } catch (e) {
      continue;
    }
    for (const m of txt.matchAll(/`((?:(?:rules|memory|scripts|commands)\/[\w.\-]+|skills\/[\w.\-]+\/scripts\/[\w.\-]+)\.(?:cjs|mjs|md|sh|js|ps1))(?:\/\*)?`/g)) {
      const rel = m[1];
      if (rel.endsWith('/*') || rel.includes('*')) continue;
      const inA = fs.existsSync(path.join(A, rel));
      const inB = B ? fs.existsSync(path.join(B, rel)) : false;
      if (!inA) bad.push(rel + '（引用于 ' + path.basename(f) + (inB ? '，本侧找不到）' : B ? '，两侧都找不到）' : '，本客户端找不到）'));
      else if (B && !inB) bad.push(rel + '（只在本侧，另一客户端缺）');
    }
  }
  return bad;
}

function main() {
  readStdin();
  const problems = [];

  const cfg = sh(path.join(__dirname, 'sync-global-config.sh'), ['--check']);
  if (cfg.code === 1) {
    const lines = cfg.out.split('\n').filter((x) => /^(DRIFT|MISSING)/.test(x));
    problems.push('AGENTS.md / rules / commands 两侧漂移: ' + (lines.join('; ') || '见 sync-global-config.sh --check'));
  } else if (cfg.code !== 0) {
    problems.push(notRun('sync-global-config.sh --check', cfg));
  }

  const mem = sh(path.join(__dirname, 'sync-memory.sh'), []);
  if (mem.code === 1) {
    const lines = mem.out.split('\n').filter((x) => /索引不自洽|分叉（|only|只在|未进索引/.test(x)).slice(0, 3);
    problems.push('memory 检查异常: ' + (lines.join(' | ') || '跑 bash ~/.qoder/scripts/sync-memory.sh 看明细'));
  } else if (mem.code !== 0) {
    // 旧写法只有 `=== 1` 一个分支：这一路超时或跑不起来时**静默当通过**，
    // 于是"记忆分叉"可以在没有任何提示的情况下长期存在（本次就是它漏掉的）。
    problems.push(notRun('sync-memory.sh', mem));
  }

  const dang = danglingRefs();
  if (dang.length) problems.push('规则存在悬空引用: ' + dang.slice(0, 5).join('; '));

  const hookMissing = findMissingHookTargets(path.join(A, 'settings.json'), path.join(A, 'scripts'));
  if (hookMissing.length) problems.push('hooks 接线指向不存在的脚本: ' + hookMissing.slice(0, 5).join(', '));

  if (!problems.length) return;
  const ctx =
    '【全局规则维护提示】先判断是否影响当前任务；无关告警不阻塞开工，只读任务不自动修复：\n' +
    problems.map((p) => '- ' + p).join('\n') +
    '\n只读复核：bash ~/.qoder/scripts/sync-global-config.sh --check；bash ~/.qoder/scripts/sync-memory.sh。索引问题补索引，单边缺失才考虑 --copy-missing；分叉先对比并备份，不按时间戳自动覆盖。' +
    '\n修复仅在有效授权内执行；并行写入时先重查，不把维护提示当作写入授权。';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }) + '\n');
}

try {
  main();
} catch (e) {
  process.stdout.write(JSON.stringify({ systemMessage: 'global-config-guard 未执行: ' + String(e && e.message) }) + '\n');
}
process.exit(0);
