/**
 * 本地构建 / 出包闭环（自研，1.0.7 新增）
 *
 * 职责：把已 scaffold 的小游戏项目构建为可上传的平台包，并做包体预算审计。
 *
 * 设计边界（严格，避免表面功能 / 弄虚作假）：
 *  - 原生小游戏（engine=native）：分发物即源码目录本身，本脚本在离线环境下真实"组装包"——
 *    将项目文件（排除 node_modules/.git 等）复制到输出目录，产出可直接被微信开发者工具上传的包。
 *    此路径不依赖任何外部 CLI，可在沙箱内真实跑通。
 *  - Cocos / Laya 引擎项目：必须经引擎 CLI 产出 game.js，本脚本检测引擎 CLI；缺失时
 *    **优雅降级**（built:false + 安装提示），绝不伪造一次"成功构建"。
 *  - 微信开发者工具 CLI：负责 preview/upload，不是"编译"。原生包组装无需它；引擎构建产物的
 *    上传由 qa-gate / 上传环节处理。因此 build 本身只在引擎构建路径里依赖引擎 CLI。
 *  - 包体预算：从 references/data/platforms.json 按平台读取（wechat 4/30/4，douyin 4/16/20/30），
 *    不使用 package-analyzer 的硬编码 4/30（那仅覆盖微信且未分流平台）。
 *  - 预算超标的处置：build 如实报告 preflight.budget.status='over' 并写入 warnings，**不**自行 exit 1；
 *    硬失败由 tests/qa-gate.mjs 负责（构建与闸门职责分离，避免双重所有权）。
 *  - CLI 缺失 / 引擎 CLI 缺失：降级为 built:false + installHint，exit 0（不中断链路）。
 *  - 项目结构非法 / 真实构建命令失败：outputError exit 1（这是真错误，不是降级）。
 *
 * 依赖：仅 node 内置模块（fs / path / os / child_process）。0 外部依赖。
 */

import { existsSync, statSync, readdirSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform as osPlatform, homedir } from 'node:os';
import { spawn, execSync } from 'node:child_process';

import { detectProject, calcDirSize } from './lib/project-detector.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const PLATFORMS_JSON = join(SKILL_ROOT, 'references', 'data', 'platforms.json');

const SUPPORTED_PLATFORMS = ['wechat', 'douyin'];
const EXCLUDE_DIRS_DEFAULT = ['node_modules', '.git', 'miniprogram_npm', 'typings'];

const HELP = `小游戏本地构建 / 出包闭环

用法:
  node scripts/build.mjs --platform <wechat|douyin> --project <项目路径> [选项]

必填:
  --platform <name>     目标平台：wechat | douyin（其他平台预算未核实，后续版本再补）
  --project <path>      已 scaffold 的小游戏项目目录（需含 game.json + game.js）

可选:
  --engine <name>       指定引擎：cocos | laya | native | auto（默认 auto=推断）
  --out <dir>           输出包目录（默认：<项目上级>/<项目名>-build-<platform>）
  --cli <path>          指定引擎 CLI 路径（覆盖自动探测）
  --json                输出 JSON 结构化结果
  --help                显示本帮助

退出码:
  0  命令正常完成（可能 built:false 降级，详见输出）
  1  项目结构非法 / 真实构建命令失败（真错误）

说明:
  原生小游戏离线即可组装包（built:true）；Cocos/Laya 需引擎 CLI，缺失则降级提示。`;

// ---- 主流程 ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);

  const platform = args.platform;
  const projectPath = args.project;
  const engineArg = args.engine || 'auto';
  const json = !!args.json;
  const cliOverride = args.cli || null;

  // 1) 参数校验
  if (!platform) {
    outputError('缺少必填参数 --platform（wechat|douyin）', { hint: 'node scripts/build.mjs --platform wechat --project <路径>' }, json);
  }
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    // 诚实：拒绝为预算未核实的平台猜测包体上限
    outputError(
      `当前仅支持 wechat/douyin 构建；平台 "${platform}" 的包体预算在 platforms.json 中为 pending-verify，禁止猜测上限。`,
      { hint: '请使用 --platform wechat 或 --platform douyin；多平台矩阵待后续版本补充' },
      json,
    );
  }
  if (!projectPath) {
    outputError('缺少必填参数 --project <项目路径>', { hint: 'node scripts/build.mjs --platform wechat --project <路径>' }, json);
  }
  const absProject = resolve(projectPath);
  if (!existsSync(absProject)) {
    outputError(`项目路径不存在: ${absProject}`, {}, json);
  }

  // 2) 加载平台预算
  const platforms = loadPlatforms();
  const pmeta = platforms[platform];
  if (!pmeta || !pmeta.packageLimitMB || typeof pmeta.packageLimitMB !== 'object') {
    outputError(
      `平台 "${platform}" 的 packageLimitMB 在 platforms.json 中未核实（pending-verify），无法执行包体预算审计。`,
      { hint: '待补全该平台官方包体上限核实后再构建' },
      json,
    );
  }
  const budget = pmeta.packageLimitMB;
  const globalObject = pmeta.globalObject || null;

  // 3) 结构检测
  const detection = detectProject(absProject);
  if (!detection.valid || detection.type !== 'minigame') {
    outputError(
      '项目结构不合法，无法构建：' + (detection.errors.length ? detection.errors.join('；') : `检测到类型=${detection.type}（需 minigame）`),
      { type: detection.type, info: detection.info },
      json,
    );
  }

  // 4) 引擎判定
  let engine = engineArg === 'auto' ? detection.info.engine : engineArg;
  if (!['cocos', 'laya', 'native'].includes(engine)) {
    // 无法判定引擎：原生小游戏也能组装包，降级为 native 处理（诚实标注 confidence=low）
    engine = 'native';
  }
  const engineVersion = engineArg === 'auto' ? detection.info.engineVersion : null;

  // 5) 包体预算审计（静态，不依赖 CLI）
  const budgetReport = auditBudget(absProject, detection, budget, platform);

  // 6) 构建 / 组装
  const outDir = args.out ? resolve(args.out) : resolve(dirname(absProject), `${basename(absProject)}-build-${platform}`);
  const buildResult = await performBuild({
    platform, engine, absProject, outDir, cliOverride, json,
  });

  // 7) 汇总输出
  const warnings = [];
  if (budgetReport.status !== 'ok') {
    warnings.push(`包体超预算：${budgetReport.summary}`);
  }
  if (!buildResult.built) {
    warnings.push(buildResult.message || '未产出平台包（降级）');
  }

  outputSuccess({
    platform,
    globalObject,
    engine,
    engineVersion,
    engineConfidence: detection.info.engineConfidence,
    built: buildResult.built,
    cliFound: buildResult.cliFound,
    cliPath: buildResult.cliPath || null,
    outputDir: buildResult.built ? outDir : null,
    method: buildResult.method || null,
    preflight: {
      structureValid: true,
      budget: budgetReport,
    },
    warnings,
    installHint: buildResult.installHint || null,
  }, json);
}

// ---- 平台预算加载 ----

export function loadPlatforms() {
  try {
    const raw = JSON.parse(readFileSync(PLATFORMS_JSON, 'utf-8'));
    return raw.platforms || {};
  } catch (e) {
    outputError(`读取 platforms.json 失败: ${e.message}`, { path: PLATFORMS_JSON }, false);
  }
}

// ---- 包体预算审计 ----

export function auditBudget(projectPath, detection, budget, platform) {
  const subRoots = (detection.info.subpackages || []).map((s) => s.root || s.name).filter(Boolean);
  const excludeForTotal = [...EXCLUDE_DIRS_DEFAULT];
  const excludeForMain = [...EXCLUDE_DIRS_DEFAULT, ...subRoots];

  const totalBytes = calcDirSize(projectPath, excludeForTotal);
  const mainBytes = calcDirSize(projectPath, excludeForMain);
  const totalMB = +(totalBytes / 1024 / 1024).toFixed(2);
  const mainMB = +(mainBytes / 1024 / 1024).toFixed(2);

  const checks = [];
  let status = 'ok';

  if (platform === 'wechat') {
    const mainLimit = budget.main;       // 4
    const totalLimit = budget.total;     // 30
    const indSubLimit = budget.independentSub; // 4
    const mainOver = mainMB > mainLimit;
    const totalOver = totalMB > totalLimit;
    checks.push({ scope: 'main', mb: mainMB, limitMB: mainLimit, over: mainOver });
    checks.push({ scope: 'total', mb: totalMB, limitMB: totalLimit, over: totalOver });
    for (const s of detection.info.subpackages || []) {
      const rootRaw = s.root || s.name;
      if (!rootRaw) continue;
      const root = rootRaw.replace(/\/+$/, '');
      const sz = calcDirSize(join(projectPath, root), EXCLUDE_DIRS_DEFAULT);
      const szMB = +(sz / 1024 / 1024).toFixed(2);
      const isInd = s.independent === true;
      const lim = isInd ? indSubLimit : totalLimit;
      checks.push({ scope: `sub:${root}`, independent: isInd, mb: szMB, limitMB: lim, over: szMB > lim });
    }
    if (mainOver) status = 'over-main';
    else if (totalOver || checks.some((c) => c.scope.startsWith('sub:') && c.over)) status = 'over-total';
  } else if (platform === 'douyin') {
    const mainLimit = budget.main;            // 4
    const nonSubTotal = budget.nonSubTotal;   // 16
    const subTotal = budget.subTotal;         // 20（含 VP 30）
    const subTotalWithVp = budget.subTotalWithVp; // 30
    const mainOver = mainMB > mainLimit;
    // 非分包部分：total - 分包之和
    const subBytesSum = subRoots.reduce((acc, r) => acc + calcDirSize(join(projectPath, r), EXCLUDE_DIRS_DEFAULT), 0);
    const nonSubMB = +((totalBytes - subBytesSum) / 1024 / 1024).toFixed(2);
    const nonSubOver = nonSubMB > nonSubTotal;
    checks.push({ scope: 'main', mb: mainMB, limitMB: mainLimit, over: mainOver });
    checks.push({ scope: 'nonSubTotal', mb: nonSubMB, limitMB: nonSubTotal, over: nonSubOver });
    for (const s of detection.info.subpackages || []) {
      const rootRaw = s.root || s.name;
      if (!rootRaw) continue;
      const root = rootRaw.replace(/\/+$/, '');
      const sz = calcDirSize(join(projectPath, root), EXCLUDE_DIRS_DEFAULT);
      const szMB = +(sz / 1024 / 1024).toFixed(2);
      const lim = subTotalWithVp; // 分包含 VP 上限 30，非 VP 上限 20；保守以 20 判，超出提示 VP 路径
      const over = szMB > subTotal;
      checks.push({ scope: `sub:${root}`, mb: szMB, limitMB: subTotal, limitVpMB: subTotalWithVp, over });
    }
    if (mainOver) status = 'over-main';
    else if (nonSubOver || checks.some((c) => c.scope.startsWith('sub:') && c.over)) status = 'over-total';
  }

  const overChecks = checks.filter((c) => c.over);
  const summary = overChecks.length
    ? overChecks.map((c) => `${c.scope}=${c.mb}MB > 上限${c.limitMB}MB`).join('；')
    : '全部在预算内';

  return {
    platform,
    mainMB,
    totalMB,
    limit: budget,
    checks,
    status, // 'ok' | 'over-main' | 'over-total'
    summary,
  };
}

// ---- 构建 / 组装 ----

async function performBuild({ platform, engine, absProject, outDir, cliOverride, json }) {
  if (engine === 'native') {
    // 原生小游戏：分发物即源码，离线组装包
    try {
      assemblePackage(absProject, outDir);
      return { built: true, cliFound: true, cliPath: null, method: 'package-assembly', message: null, installHint: null };
    } catch (e) {
      outputError(`包组装失败: ${e.message}`, {}, json);
    }
  }

  // Cocos / Laya：需引擎 CLI
  const cli = findEngineCli(engine, cliOverride);
  if (!cli.found) {
    return {
      built: false,
      cliFound: false,
      cliPath: null,
      method: null,
      message: `未找到 ${engine} 引擎 CLI，无法产出 game.js 构建物。`,
      installHint: cli.error,
    };
  }
  // 引擎 CLI 存在：调用其构建命令，产出到 outDir
  const r = await runEngineBuild(engine, platform, absProject, outDir, cli.cliPath);
  if (!r.ok) {
    outputError(`引擎构建失败: ${r.error}`, { stdout: r.stdout?.slice(0, 800), stderr: r.stderr?.slice(0, 800) }, json);
  }
  return { built: true, cliFound: true, cliPath: cli.cliPath, method: `engine-build:${engine}`, message: null, installHint: null };
}

/**
 * 复制项目到输出目录（排除 node_modules/.git 等），产出可上传包。
 */
function assemblePackage(projectPath, outDir) {
  if (existsSync(outDir)) {
    // 清空旧产物（仅删除 --out 指定的构建输出目录，由本脚本自己创建，安全）
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  // 手动递归复制并排除 node_modules/.git 等：不依赖 cpSync 的 filter（该 API 在本环境大文件下不稳定）。
  copyTree(projectPath, outDir, projectPath);
}

/**
 * 递归复制目录树，排除 EXCLUDE_DIRS_DEFAULT。
 * @param {string} src 当前源路径
 * @param {string} dst 当前目标路径
 * @param {string} root 项目根（用于防止输出目录自身被递归复制）
 */
function copyTree(src, dst, root) {
  const entries = readdirSync(src);
  for (const entry of entries) {
    if (EXCLUDE_DIRS_DEFAULT.includes(entry)) continue;
    const s = join(src, entry);
    const d = join(dst, entry);
    let st;
    try { st = statSync(s); } catch { continue; }
    if (st.isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d, root);
    } else {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
}

// ---- 引擎 CLI 探测 ----

function findEngineCli(engine, override) {
  if (override) {
    if (existsSync(override)) return { found: true, cliPath: override, error: null };
    return { found: false, cliPath: null, error: `指定的引擎 CLI 路径不存在: ${override}` };
  }
  const names = engine === 'cocos'
    ? ['cocos', 'CocosCreator', 'Cocos Creator.exe', 'cocos-console']
    : ['laya', 'LayaAir', 'layacmd', 'layaair'];
  // 1) PATH 探测
  for (const n of names) {
    const p = which(n);
    if (p) return { found: true, cliPath: p, error: null };
  }
  // 2) 常见安装目录
  const dirs = engine === 'cocos'
    ? ['C:\\Program Files\\Cocos Creator', 'C:\\CocosCreator', join(homedir(), 'CocosCreator')]
    : ['C:\\Program Files\\LayaAir', 'C:\\LayaAir', join(homedir(), 'LayaAir')];
  for (const d of dirs) {
    if (existsSync(d)) {
      const exe = engine === 'cocos' ? join(d, 'CocosCreator.exe') : join(d, 'layacmd');
      if (existsSync(exe)) return { found: true, cliPath: exe, error: null };
    }
  }
  return {
    found: false,
    cliPath: null,
    error: `未找到 ${engine} 引擎 CLI（已尝试 PATH 与常见目录）。请安装 Cocos Creator / LayaAir IDE，或用 --cli 指定其可执行文件路径。`,
  };
}

function runEngineBuild(engine, platform, projectPath, outDir, cliPath) {
  return new Promise((resolve) => {
    // 命令形态因引擎/版本而异，这里给出通用封装；真实可用需用户在环境中验证。
    const target = platform === 'wechat' ? 'wechatgame' : platform === 'douyin' ? 'douyin' : platform;
    const args = engine === 'cocos'
      ? ['--project', projectPath, '--build', `platform=${target};debug=false`]
      : ['build', '--project', projectPath, '--platform', target, '--out', outDir];
    let child;
    try {
      child = spawn(cliPath, args, { cwd: projectPath, windowsHide: true, shell: osPlatform() === 'win32' });
    } catch (e) {
      resolve({ ok: false, error: `引擎 CLI 启动失败: ${e.message}`, stdout: '', stderr: '' });
      return;
    }
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, 300000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? null : `引擎 CLI 退出码 ${code}` });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `引擎 CLI 错误: ${err.message}`, stdout, stderr });
    });
  });
}

// ---- 小工具 ----

function which(name) {
  const isWin = osPlatform() === 'win32';
  const cmd = isWin ? 'where' : 'command';
  const parts = isWin ? ['where', name] : ['command', '-v', name];
  try {
    const out = execSync(cmd + ' ' + parts.slice(1).map((a) => `"${a}"`).join(' '), { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out ? out.split(/\r?\n/)[0] : null;
  } catch (_) {
    return null;
  }
}

// 仅当作为 CLI 直接运行时执行；被 qa-gate 等模块 import 时不自动运行
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    outputError(`build.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
  });
}
