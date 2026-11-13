#!/usr/bin/env node
// global-config-guard.js 的自测。守卫最容易犯的两种错都在这里：
// ① 把自己跑超时 —— 本脚本由 SessionStart hook 以 timeout:15 调用，两路检查是串行的，
//    只给每路各设上限不设总截止线时，两路相加可以越过 15s，整个 hook 被掐死、一段提醒都不输出；
// ② 检查器"跑不起来"时静默当通过 —— 那等于把要报的异常吞掉，比没有守卫更糟。
//   node ~/.qoder/scripts/global-config-guard.test.js   → 全绿退 0，任一失败退 1
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'global-config-guard.js');
const NODE = process.execPath;
/**
 * 沙箱按进程号独立：上一轮被 timeout 掐掉的 `bash sleep` 孤儿会短暂占住目录（Windows 上表现为
 * rmSync 撞 ENOTEMPTY、writeFileSync 撞 EPERM），复用同一个目录就会把"脚手架没清干净"读成判据红。
 */
let SB;
const sandboxes = [];
let fail = 0;
const check = (l, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' :: ' + d : ''}`); if (!ok) fail++; };

function reset() {
  SB = fs.mkdtempSync(path.join(os.tmpdir(), 'gcg-audit-'));
  sandboxes.push(SB);
  const scripts = path.join(SB, '.qoder', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(scripts, 'global-config-guard.js'));
  for (const file of ['client-root.js', 'hook-crash-guard.js', 'hook-targets.cjs']) fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
}

/** 造一个假检查脚本：`exit <code>` 之前可以先 sleep 若干秒。 */
function fake(name, code, sleepSec) {
  const p = path.join(SB, '.qoder', 'scripts', name);
  fs.writeFileSync(p, `#!/bin/sh\n${sleepSec ? `sleep ${sleepSec}\n` : ''}exit ${code}\n`, { mode: 0o755 });
  return p;
}

/**
 * A65：确定性用例（干净零输出 / 漂移必报 / 悬空引用）不该被「负载下起 bash 的 OS 开销」判红。
 * 实测：同一测试隔离跑 4.5s 全绿，在全量套件里 34s 且两条断言红——红因是桩脚本（立即 exit）
 * 光是 spawn 就超过了写死的 8000ms 时间片，守卫如实报「超时未跑完」，于是零输出断言拿到 446B。
 * 这里默认给足时间片，把「环境慢」与「被测行为错」分开；**显式传入的 env 一律覆盖默认值**，
 * 所以预算类用例（小预算 / 跳过 / 超时）的判据一字未改。默认值本身另有两条用例守住（见文件末尾）。
 */
const ROOMY = { GUARD_BUDGET_MS: '45000', GUARD_RESERVE_MS: '600', GUARD_PER_CALL_CAP_MS: '40000' };

function run(env) {
  const t0 = Date.now();
  const r = spawnSync(NODE, [path.join(SB, '.qoder', 'scripts', 'global-config-guard.js')], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'gcg-test', cwd: SB }),
    env: Object.assign({}, process.env, { HOME: SB, USERPROFILE: SB, QODER_HOME: path.join(SB, '.qoder') }, ROOMY, env || {}),
    timeout: 60000,
  });
  return { ms: Date.now() - t0, out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}

const ctxOf = (r) => {
  try {
    return JSON.parse(r.out.trim()).hookSpecificOutput.additionalContext || '';
  } catch (e) {
    return '';
  }
};

// ---------- ① 健康时必须零输出（守卫的噪声成本由这一条守住） ----------
reset();
fake('sync-global-config.sh', 0, 0);
fake('sync-memory.sh', 0, 0);
let r = run();
check('两侧都干净时不注入任何提醒', r.out.trim() === '' && r.code === 0, `退${r.code} 输出 ${r.out.length}B`);

// ---------- ② 漂移要报，且要能指出是哪一侧 ----------
reset();
fs.writeFileSync(path.join(SB, '.qoder', 'scripts', 'sync-global-config.sh'),
  '#!/bin/sh\necho "DRIFT AGENTS.md"\nexit 1\n', { mode: 0o755 });
fake('sync-memory.sh', 0, 0);
r = run();
check('AGENTS.md 漂移时报出来', ctxOf(r).includes('两侧漂移') && ctxOf(r).includes('AGENTS.md'), ctxOf(r).slice(0, 60));
check('维护提示不授权写入且不阻塞无关任务', ctxOf(r).includes('只读任务不自动修复') && !ctxOf(r).includes('开工前先修') && !ctxOf(r).includes('取较新覆盖'));

reset();
fs.writeFileSync(path.join(SB, '.qoder', 'scripts', 'sync-memory.sh'),
  '#!/bin/sh\necho "  分叉（两侧都有且内容不同，要人来合）: MEMORY.md"\nexit 1\n', { mode: 0o755 });
fake('sync-global-config.sh', 0, 0);
r = run();
check('记忆分叉时报出来', ctxOf(r).includes('memory 检查异常') && ctxOf(r).includes('MEMORY.md'), ctxOf(r).slice(0, 60));

// ---------- ③ 检查器跑不起来必须出声（旧写法：memory 那一路静默当通过） ----------
reset();
fake('sync-global-config.sh', 2, 0);
fake('sync-memory.sh', 0, 0);
r = run();
check('config 检查退出码 2 时报"未能执行"', ctxOf(r).includes('sync-global-config.sh') && ctxOf(r).includes('未能执行'), ctxOf(r).slice(0, 70));

reset();
fake('sync-global-config.sh', 0, 0);
fake('sync-memory.sh', 2, 0);
r = run();
check('memory 检查退出码 2 时同样报"未能执行"（这一条以前是静默的）',
  ctxOf(r).includes('sync-memory.sh') && ctxOf(r).includes('未能执行'), ctxOf(r).slice(0, 70));

// ---------- ④ 总截止线：两路都慢时，整体不得越过 hook 预算，且要说明跳过了什么 ----------
reset();
fake('sync-global-config.sh', 0, 5);
fake('sync-memory.sh', 0, 5);
r = run({ GUARD_BUDGET_MS: '2500', GUARD_RESERVE_MS: '600' });
check('两路各睡 5s 时总耗时压在预算内（旧写法会跑到 ~10s，超过 hook 的 15s）',
  r.ms < 4500, `实测 ${r.ms}ms`);
check('被跳过的那一路要明说"未检查"，而不是静默通过',
  ctxOf(r).includes('sync-memory.sh') && ctxOf(r).includes('未检查'), ctxOf(r).slice(0, 90));

// ---------- ⑤ 悬空引用：skills/<技能>/scripts/<文件> 形态也要查到（本轮新增，含必红对照） ----------
reset();
fake('sync-global-config.sh', 0, 0);
fake('sync-memory.sh', 0, 0);
fs.writeFileSync(path.join(SB, '.qoder', 'AGENTS.md'),
  '引用 `skills/foo/scripts/missing.js` 和 `scripts/also-missing.js`\n');
r = run();
check('悬空引用（skills/ 形态与 scripts/ 形态）都要报出来',
  ctxOf(r).includes('悬空引用') && ctxOf(r).includes('missing.js') && ctxOf(r).includes('also-missing.js'),
  ctxOf(r).slice(0, 90));

reset();
fake('sync-global-config.sh', 0, 0);
fake('sync-memory.sh', 0, 0);
for (const side of ['.qoder', '.qoder-cn']) {
  fs.mkdirSync(path.join(SB, side, 'skills', 'foo', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(SB, side, 'skills', 'foo', 'scripts', 'present.js'), '// x\n');
}
fs.writeFileSync(path.join(SB, '.qoder', 'AGENTS.md'), '引用 `skills/foo/scripts/present.js`\n');
r = run();
check('两侧都在的 skills 引用不算悬空（零输出）', r.out.trim() === '' && r.code === 0, `退${r.code} 输出 ${r.out.length}B`);

reset();
fake('sync-global-config.sh', 0, 0);
fake('sync-memory.sh', 0, 0);
fs.writeFileSync(path.join(SB, '.qoder', 'scripts', 'present.js'), '');
fs.writeFileSync(path.join(SB, '.qoder', 'AGENTS.md'), '引用 `scripts/present.js`\n');
r = run();
check('单端已有引用不误报另一端缺失', r.code === 0 && r.out.trim() === '' && !fs.existsSync(path.join(SB, '.qoder-cn')), r.out.slice(0, 180));

for (const extension of ['cjs', 'mjs']) {
  reset();
  fake('sync-global-config.sh', 0, 0);
  fake('sync-memory.sh', 0, 0);
  fs.writeFileSync(path.join(SB, '.qoder', 'AGENTS.md'), '引用 `scripts/missing.' + extension + '`\n');
  r = run();
  check('遗漏的' + extension + '引用必须报出', r.code === 0 && ctxOf(r).includes('missing.' + extension), r.out.slice(0, 180));
}

// ---------- ⑥ A65：时间片开关本身也要被守住（放宽 ≠ 关掉超时路径，默认值不许漂） ----------
// 给小片仍必须如实报超时：证明开关只是把「环境慢」与「脚本慢」分开，没有把诚实降级改成静默通过。
reset();
fake('sync-global-config.sh', 0, 3);
fake('sync-memory.sh', 0, 0);
r = run({ GUARD_BUDGET_MS: '20000', GUARD_PER_CALL_CAP_MS: '1500' });
check('A65 显式小时间片仍如实报超时（1500ms）',
  ctxOf(r).includes('超时未跑完') && ctxOf(r).includes('只分到 1500ms'), ctxOf(r).slice(0, 110));

// 模式隔离：不给开关时默认时间片必须仍是 8000ms（现役路径行为与改动前一致）。
reset();
fake('sync-global-config.sh', 0, 9);
fake('sync-memory.sh', 0, 0);
r = run({ GUARD_BUDGET_MS: '20000', GUARD_PER_CALL_CAP_MS: '' });
check('A65 模式隔离：不给开关时默认时间片仍是 8000ms',
  ctxOf(r).includes('超时未跑完') && ctxOf(r).includes('只分到 8000ms'), ctxOf(r).slice(0, 110));

// 反空断言：给足时间片时，慢检查必须**真的跑完**（耗时 ≥ sleep），不是被跳过冒充健康。
reset();
fake('sync-global-config.sh', 0, 3);
fake('sync-memory.sh', 0, 0);
r = run();
check('A65 给足时间片时慢检查真的跑完（不是跳过冒充健康）',
  r.out.trim() === '' && r.code === 0 && r.ms >= 3000, `退${r.code} 输出 ${r.out.length}B 实测 ${r.ms}ms`);

for (const dir of sandboxes) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { console.log('测试沙箱仍被超时子进程占用，暂保留：' + dir); }
}

console.log(fail === 0 ? '\n[global-config-guard.test] 全绿' : `\n[global-config-guard.test] ${fail} 条失败`);
process.exit(fail === 0 ? 0 : 1);
