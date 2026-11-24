#!/usr/bin/env node
// grep-scope-guard.test.js —— 重依赖目录宽检索门禁的正负自测。
// Pre 类判据一律 spawn **合并后的入口** risky-match-guard.js（不是直接调 core），否则测的是"判据自己"。
// 用真实仓库路径当样本，扫描结果可失败：把 fronted 换成 docs 就应当从"拦"翻成"放行"。
// 用法：node grep-scope-guard.test.js   退出码：0 全绿 / 1 有红项
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const PRE_ENTRY = path.join(HERE, 'risky-match-guard.js');
const CORE = path.join(HERE, 'grep-scope-core.cjs');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-scope-test-'));
const STATE_DIR = path.join(SB, 'tmp', 'grep-scope-guard');
const CACHE = path.join(STATE_DIR, 'roots.json');
const CFG = path.join(SB, 'grep-scope-guard.json');
const QODER_HOME = path.join(SB, 'qoder-home');
fs.mkdirSync(QODER_HOME, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

const ENV = {
  ...process.env,
  QODER_HOME,
  GREP_SCOPE_GUARD_STATE_DIR: STATE_DIR,
  GREP_SCOPE_GUARD_CONFIG: CFG,
  RISKY_MATCH_STATE_DIR: path.join(SB, 'tmp', 'risky-match'),
};

// 合成仓库样本：HEAVY＝根下 4 层内含 node_modules；CLEAN＝推荐窄 path（内含 .umi/target）。
// 不依赖任何本机项目路径，干净检出也能复现同一正负对照。
const REPO = path.join(SB, 'repo');
const HEAVY = path.join(REPO, 'frontend');
const CLEAN_SRC = path.join(REPO, 'frontend', 'app', 'src');
const CLEAN_BE = path.join(REPO, 'backend', 'service');
const HIT = 'grep-scope-guard';
for (const rel of [
  'frontend/app/node_modules/pkg',
  'frontend/workflow/node_modules/pkg',
  'frontend/app/src/.umi',
  'backend/service/target',
  'git-only/.git/node_modules/pkg',
  'docs',
]) fs.mkdirSync(path.join(REPO, rel), { recursive: true });

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 240) : ''}`);
  }
}
function writeCfg(o) {
  fs.writeFileSync(CFG, JSON.stringify(o));
}
function pre(toolName, toolInput, cwd) {
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 't' + Date.now() + Math.random(),
    cwd: cwd || REPO,
    tool_name: toolName,
    tool_input: toolInput,
  };
  const r = spawnSync(process.execPath, [PRE_ENTRY], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: ENV,
    timeout: 30000,
    windowsHide: true,
  });
  return String(r.stdout || '') + String(r.stderr || '');
}
function cli(args) {
  const r = spawnSync(process.execPath, [CORE].concat(args), { encoding: 'utf8', env: ENV, timeout: 30000, windowsHide: true });
  return String(r.stdout || '') + String(r.stderr || '');
}

writeCfg({});

// 1. 正例：重依赖根必须被拦，且给出可执行的收窄改法
let o = pre('Grep', { pattern: 'x', path: HEAVY, glob: '**/src/**/*.{ts,tsx}' });
check('1 重依赖根（frontend）→硬拦+改法', o.includes('"decision":"block"') && o.includes(HIT) && o.includes('node_modules') && o.includes('frontend/<app>/src'), o);

// 2. 负例（对照，判据可失败）：推荐的窄 path 必须放行——src 下有 .umi、backend 下有 target，都不算雷区
o = pre('Grep', { pattern: 'x', path: CLEAN_SRC, glob: '*.tsx' });
check('2 窄 path（frontend/app/src，内含 .umi）→放行', !o.includes(HIT), o);
o = pre('Grep', { pattern: 'x', path: CLEAN_BE });
check('3 窄 path（backend/service，内含 target）→放行', !o.includes(HIT), o);

// 4. 负例：glob 显式排除依赖 → 放行（rg 会剪枝，这是合法宽检索）
o = pre('Grep', { pattern: 'x', path: HEAVY, glob: '**/src/**,!node_modules' });
check('4 glob 排除 !node_modules→放行', !o.includes(HIT), o);
o = pre('Grep', { pattern: 'x', path: HEAVY, glob: '**/src/**,!**/node_modules/**' });
check('4b glob 排除写法二→放行', !o.includes(HIT), o);
fs.rmSync(CACHE, { force: true });
o = pre('Glob', { pattern: '!node_modules', path: HEAVY });
check('4c Glob 的 pattern 不是排除语法→仍拦', o.includes('"decision":"block"') && o.includes(HIT), o);

// 5. 正例：不带 path（落在会话 cwd＝仓库根）同样拦
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x' }, REPO);
check('5 缺省 path 取会话 cwd→拦', o.includes('"decision":"block"') && o.includes(HIT), o);
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x', path: 'frontend' }, REPO);
check('5b 相对 path 按会话 cwd 解析→拦', o.includes('"decision":"block"') && o.includes(HIT), o);

// 6. 正例：Glob 工具同判据
fs.rmSync(CACHE, { force: true });
o = pre('Glob', { pattern: '**/*.ts', path: HEAVY });
check('6 Glob 工具同样拦', o.includes('"decision":"block"') && o.includes(HIT), o);

// 7. 负例：其它工具不受影响
o = pre('Bash', { command: 'ls ' + HEAVY }, REPO);
check('7 Bash→不误伤', !o.includes(HIT), o);
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x', path: path.join(REPO, 'git-only') });
check('7b .git 内部依赖不参与判定→放行', !o.includes(HIT), o);

// 8. 变异自证：maxDepth=1（只看根的直接子目录）时 fronted 的依赖目录在下一层、扫不到 → 放行；
//    默认 4 层时同样这个根必须拦（见用例 1）——一拦一放成对，判据不是恒真。
writeCfg({ maxDepth: 1 });
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x', path: HEAVY });
check('8 maxDepth=1→放行（判据可失败）', !o.includes(HIT), o);
writeCfg({});
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x', path: HEAVY });
check('8b 同根回到默认 4 层→仍拦', o.includes('"decision":"block"') && o.includes(HIT), o);

// 9. fail-open：扫描预算用尽（maxDirs=1）时放行并留痕，不误伤
writeCfg({ maxDirs: 1 });
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x', path: REPO });
check('9 扫描预算用尽→放行并留痕', !o.includes(HIT) && fs.readFileSync(path.join(STATE_DIR, 'decisions.log'), 'utf8').includes('unknown'), o);
writeCfg({});

// 10. mode=warn：出声但不拦
fs.rmSync(CACHE, { force: true });
writeCfg({ mode: 'warn' });
o = pre('Grep', { pattern: 'x', path: HEAVY });
check('10 warn 模式→approve 且无 block', o.includes('"decision":"approve"') && o.includes(HIT) && !o.includes('"decision":"block"'), o);
writeCfg({});

// 11. disabled：完全静默
writeCfg({ disabled: true });
fs.rmSync(CACHE, { force: true });
o = pre('Grep', { pattern: 'x', path: HEAVY });
check('11 disabled→静默', !o.includes(HIT), o);
writeCfg({});

// 12. 缓存：found 结论落 roots.json，--status 能读出来，--clear 后消失
fs.rmSync(CACHE, { force: true });
pre('Grep', { pattern: 'x', path: HEAVY });
let st = {};
try {
  st = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
} catch (e) {}
const keys = Object.keys(st);
check('12a found 结论写入缓存', keys.length === 1 && st[keys[0]].state === 'found' && /node_modules/.test(String(st[keys[0]].hit)), JSON.stringify(st));
o = cli(['--status']);
check('12b --status 报缓存与配置', o.includes('searchRoot') && o.includes('"cfg"') && o.includes('found'), o);
o = cli(['--clear']);
check('12c --clear 清账', o.includes('cleared') && !fs.existsSync(CACHE), o);

// 13. --probe 直读判据：重依赖根 found / docs 目录 clean
fs.rmSync(CACHE, { force: true });
o = cli(['--probe', HEAVY]);
check('13a --probe 重依赖根→found', o.includes('"state":"found"') && o.includes('node_modules'), o);
o = cli(['--probe', REPO + '/docs']);
check('13b --probe docs→clean（负对照）', o.includes('"state":"clean"'), o);

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n合计：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
