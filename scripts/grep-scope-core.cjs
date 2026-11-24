'use strict';
// grep-scope-core.cjs —— **重依赖目录里的宽 path 检索＝必然超时**的判据（PreToolUse 侧，结构性判定）。
//
// 事故形态：Grep 的 path 打在 `frontend/` 或仓库根上，glob 写成 `**/src/**` 这类
// "看起来已经限定"的形态。glob 只过滤**结果**，不阻止 rg **遍历** node_modules；
// 没有 .gitignore / .ignore 剪枝时，依赖树会把一次检索推成 20 秒超时。
// 提示层写着"先限定 backend/<service>/src 或 frontend/<app>/src"仍没挡住，所以做成机制。
//
// 为什么放在 Pre 侧、而不是"看返回给超时记账"：实测 **工具报错那一次不触发 PostToolUse**
// （同根超时那次在 post-tool-dispatcher 台账里没有对应行，紧接着一发成功的 Grep 有 `pass|Grep`）。
// ⇒ 记账式判据在真实载荷上永远学不到东西，只能结构性预判。
//
// 判据（宁窄勿宽，误拦就成了挡路）：
//   · 只看 `node_modules`（含 node_modules.* 变体）。**不**把 `.umi` / `target` / `dist` 当雷区：
//     实测 fronted/<app>/src（内含 src/.umi）与 backend（内含 target）在 20s 内正常返回，
//     而它们正是推荐的窄 path——把它们算进去就会拦掉正确改法。
//   · 从检索根按层向下找，最多 maxDepth 层 / 最多 maxDirs 个目录 / deadline 到点即罢手；
//     拿不准（capped / slow）一律放行，只留台账。
//   · Grep 的 glob 里显式排除 node_modules（`!node_modules`、`!**/node_modules/**`）→ 放行（rg 会剪枝）。
//   · 结论按根缓存 cacheMinutes（默认 120 分钟），重复调用零开销。
// 开关：~/.qoder/grep-scope-guard.json 写 {"disabled":true}；只提醒不拦：{"mode":"warn"}
// 台账：~/.qoder/tmp/grep-scope-guard/decisions.log；缓存：同目录 roots.json
// CLI：node grep-scope-core.cjs --status | --clear | --probe <路径>
// 自测：node grep-scope-guard.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

let clientRootDir = null;
try {
  clientRootDir = require('./client-root.js').clientRoot();
} catch (e) {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  clientRootDir = path.join(home, '.qoder');
}
const CLIENT_ROOT = process.env.QODER_HOME || clientRootDir;
const CONFIG = process.env.GREP_SCOPE_GUARD_CONFIG || path.join(CLIENT_ROOT, 'grep-scope-guard.json');
const STATE_DIR = process.env.GREP_SCOPE_GUARD_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'grep-scope-guard');
const CACHE = path.join(STATE_DIR, 'roots.json');

const DEFAULTS = { mode: 'block', ttlMinutes: 120, maxDepth: 4, maxDirs: 2000, deadlineMs: 120 };
const TOOLS = new Set(['Grep', 'Glob']);
const SKIP_DIRS = new Set(['.git', '.hg', '.svn']);
// 排除 node_modules 的 glob 写法：-g '!node_modules' / '!**/node_modules/**' / 否定组里的 !node_modules
const NEG_MODULE_RE = /!\*{0,2}\/{0,2}node_modules/;
const HEAVY_RE = /^node_modules(\.|$)/;

function cfg() {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {};
  } catch (e) {}
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    disabled: j.disabled === true,
    mode: j.mode === 'warn' ? 'warn' : 'block',
    ttlMs: num(j.ttlMinutes, DEFAULTS.ttlMinutes) * 60000,
    maxDepth: num(j.maxDepth, DEFAULTS.maxDepth),
    maxDirs: num(j.maxDirs, DEFAULTS.maxDirs),
    deadlineMs: num(j.deadlineMs, DEFAULTS.deadlineMs),
  };
}

function ledger(row) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'decisions.log'), `${new Date().toISOString()}|${row}\n`);
  } catch (e) {}
}

function resolveRoot(toolInput, cwd) {
  const base = cwd || process.cwd();
  const p = toolInput && (toolInput.path || toolInput.cwd || toolInput.dir);
  const raw = p && String(p).trim() ? String(p).trim() : base;
  try {
    const abs = path.resolve(base, raw);
    return abs.replace(/[\/\\]+$/, '') || abs;
  } catch (e) {
    return String(raw);
  }
}

function keyOf(abs) {
  const s = String(abs).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// 逐层向下找重依赖目录；三种终止态：found / clean（扫完没超预算）/ unknown（超目录数或超时限）
function scanHeavy(root, limit) {
  const t0 = Date.now();
  const queue = [[root, 0]];
  const seen = new Set();
  let dirs = 0;
  while (queue.length) {
    const [d, dep] = queue.shift();
    if (seen.has(d)) continue;
    seen.add(d);
    dirs++;
    if (dirs > limit.maxDirs) return { state: 'unknown', why: 'maxDirs', dirs, ms: Date.now() - t0 };
    if (Date.now() - t0 > limit.deadlineMs) return { state: 'unknown', why: 'deadline', dirs, ms: Date.now() - t0 };
    if (dep >= limit.maxDepth) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (!HEAVY_RE.test(e.name)) {
        queue.push([path.join(d, e.name), dep + 1]);
        continue;
      }
      return { state: 'found', hit: path.join(d, e.name), dirs, ms: Date.now() - t0 };
    }
  }
  return { state: 'clean', dirs, ms: Date.now() - t0 };
}

function loadCache() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {};
  } catch (e) {}
  return s && typeof s === 'object' ? s : {};
}

function saveCache(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(s, null, 1));
    return true;
  } catch (e) {
    ledger(`cache-write-error|${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 120)}`);
    return false;
  }
}

function reasonFor(root, hit) {
  return (
    `[grep-scope-guard] 检索根 ${root} 内含 ${hit}。glob 只过滤结果、不阻止 rg 遍历，` +
    `node_modules 会把整棵依赖树走一遍；工具超时＝**未查**，不得据此下"没有 X"的结论。\n` +
    `改法（任一）：① path 收窄到不含 node_modules 的子树，如 backend/<service>/src、frontend/<app>/src；` +
    `② Grep 的 glob 里加排除，如 \`**/src/**,!node_modules*\`（带星才能连 node_modules.* 变体一起剪掉，` +
    `只写 \`!node_modules\` 剪不掉变体）；` +
    `③ 跨仓语义检索改用 SearchWorkspace。\n` +
    `关：~/.qoder/grep-scope-guard.json 写 {"disabled":true}；只提醒不拦：{"mode":"warn"}；` +
    `判据参数（maxDepth/maxDirs/deadlineMs/ttlMinutes）同文件可调，慢到超时限会自动放行不误伤。`
  );
}

function preCheck(payload) {
  const c = cfg();
  if (c.disabled) return null;
  const tool = String((payload && (payload.tool_name || payload.toolName)) || '');
  if (!TOOLS.has(tool)) return null;
  const input = (payload && payload.tool_input) || {};
  const root = resolveRoot(input, payload && payload.cwd);
  const rk = keyOf(root);
  // 只有 Grep 的独立 glob 过滤器能表达排除；Glob 的 pattern 不是排除语法，不能据此放行。
  const globStr = tool === 'Grep' ? String(input.glob || '') : '';
  if (NEG_MODULE_RE.test(globStr)) {
    ledger(`allow|negglob|${root}`);
    return null;
  }
  const cache = loadCache();
  const rec = cache[rk];
  const fresh = rec && rec.state && Date.now() - Number(rec.at || 0) < c.ttlMs;
  let verdict = fresh ? rec : null;
  if (!verdict) {
    const scanned = scanHeavy(root, c);
    if (scanned.state === 'unknown') {
      // 拿不准一律放行（fail-open）：误拦比漏拦更糟，只留痕
      ledger(`allow|unknown-${scanned.why}|${root}|dirs=${scanned.dirs}|ms=${scanned.ms}`);
      return null;
    }
    verdict = { root, state: scanned.state, hit: scanned.hit || null, at: Date.now(), dirs: scanned.dirs, ms: scanned.ms };
    cache[rk] = verdict;
    const keys = Object.keys(cache);
    if (keys.length > 40) {
      keys
        .sort((a, b) => Number(cache[a].at || 0) - Number(cache[b].at || 0))
        .slice(0, keys.length - 40)
        .forEach((drop) => delete cache[drop]);
    }
    saveCache(cache);
  }
  if (verdict.state !== 'found') return null;
  const reason = reasonFor(root, verdict.hit);
  if (c.mode === 'warn') {
    ledger(`warn|${root}`);
    return { decision: 'allow', reason, key: rk };
  }
  ledger(`block|${root}|${verdict.hit || ''}`);
  return { decision: 'block', reason, key: rk };
}

module.exports = { preCheck, scanHeavy, resolveRoot, keyOf, cfg, ledger, CACHE, STATE_DIR, CONFIG, NEG_MODULE_RE, reasonFor };

// ==================== CLI（人工查看/清账/试判据；被 require 时不执行） ====================
if (require.main === module) {
  const argv = process.argv.slice(2);
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (argv.includes('--status')) {
    let s = {};
    try {
      s = JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {};
    } catch (e) {}
    out({
      cache: CACHE,
      cfg: cfg(),
      roots: Object.keys(s).map((k) => ({
        searchRoot: s[k].root || k,
        hit: s[k].hit || null,
        state: s[k].state,
        at: new Date(s[k].at || 0).toISOString(),
      })),
    });
    process.exit(0);
  }
  if (argv.includes('--clear')) {
    try {
      fs.unlinkSync(CACHE);
      out({ cleared: 'ALL' });
    } catch (e) {
      out({ cleared: null, note: '无缓存文件' });
    }
    process.exit(0);
  }
  if (argv.includes('--probe')) {
    const p = argv[argv.indexOf('--probe') + 1];
    if (!p) {
      out({ error: '用法：--probe <路径>' });
      process.exit(1);
    }
    const abs = resolveRoot({ path: p }, process.cwd());
    const r = scanHeavy(abs, cfg());
    out({ root: abs, ...r });
    process.exit(0);
  }
  out({ note: '这是 PreToolUse 判据真源；人工入口：--status / --clear / --probe <路径>。测试：node grep-scope-guard.test.js' });
}
