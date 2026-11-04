/**
 * 运行时可玩性证据聚合器（自研，1.0.7 新增）
 *
 * 职责：聚合一个小游戏项目在"构建 / 运行 / 真机"环节产生的证据，产出验证完整度状态。
 * 对标头部 collect_runtime_evidence：把分散的构建物、截图、日志、手动操作记录汇成一份证据清单。
 *
 * 设计边界（严格，禁止弄虚作假）：
 *  - 只读：默认不写任何文件，仅扫描并汇总现有证据。
 *  - 不伪造：找不到证据就如实报告 completeness='none' / 'partial'，绝不编造"已通过"。
 *  - 完整度定义（核心 4 项）：
 *      build 构建物（dist/build/含 game.js+game.json 的目录）、
 *      screenshots 运行时截图（≥1 张 png）、
 *      logs 运行日志（≥1 个）、
 *      checklist 手动可玩性清单（manual/playtest-checklist.md）。
 *    4 项齐全 = complete；部分 = partial；0 项 = none。
 *  - project.config.json 作为结构证据一并报告，但不计入核心完整度（脚手架必带）。
 *  - --init-checklist：显式可选，向项目写入一份"手动可玩性清单模板"（模板不是证据，是给用户填的）。
 *    此举为显式用户动作，不视为伪造运行时证据。
 *  - 退出码：缺参 / 项目不存在 = 1（真错误）；证据缺失 = 0（如实报告 none/partial）。
 *
 * 依赖：仅 node 内置模块。0 外部依赖。
 */

import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const SCAN_DIRS = ['', 'evidence', 'playtest', 'runtime', 'dist', 'build', 'logs', '.workbuddy'];
const EXCLUDE_DIRS = ['node_modules', '.git', 'miniprogram_npm', 'typings'];
const MAX_DEPTH = 4;

const HELP = `小游戏运行时可玩性证据聚合

用法:
  node scripts/playtest-evidence.mjs --project <项目路径> [选项]

必填:
  --project <path>   小游戏项目目录

可选:
  --json             输出 JSON 结构化结果
  --init-checklist   向项目写入 manual-playtest-checklist.md 模板（可选，非证据）
  --help             显示本帮助

完整度:
  complete  构建物 + 截图 + 日志 + 手动清单 四项齐全
  partial   仅部分齐全
  none      四项皆无`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);

  const projectPath = args.project;
  const json = !!args.json;
  if (!projectPath) {
    outputError('缺少必填参数 --project <项目路径>', { hint: 'node scripts/playtest-evidence.mjs --project <路径>' }, json);
  }
  const absProject = resolve(projectPath);
  if (!existsSync(absProject)) {
    outputError(`项目路径不存在: ${absProject}`, {}, json);
  }

  // 可选：写入清单模板（显式动作，非伪造证据）
  if (args['init-checklist']) {
    const tplPath = join(absProject, 'manual-playtest-checklist.md');
    writeFileSync(tplPath, CHECKLIST_TEMPLATE, 'utf-8');
    outputSuccess({ action: 'init-checklist', written: true, path: tplPath }, json);
    return;
  }

  const evidence = collectEvidence(absProject);
  const { core, coreKeys, presentCount, completeness, missing } = classifyCompleteness(evidence);

  outputSuccess({
    project: absProject,
    evidence,
    completeness,
    presentCount,
    missing,
    summary: completeness === 'complete'
      ? '运行时可玩性证据齐全（构建物/截图/日志/手动清单）'
      : completeness === 'partial'
        ? `运行时证据部分齐全，缺失：${missing.join('、')}`
        : '未找到任何运行时可玩性证据',
  }, json);
}

// ---- 证据收集（只读） ----

/**
 * 根据证据判定完整度（核心 4 项：build / screenshots / logs / checklist）
 * @returns {{core: object, coreKeys: string[], presentCount: number, completeness: 'none'|'partial'|'complete', missing: string[]}}
 */
export function classifyCompleteness(evidence) {
  const core = {
    build: evidence.buildOutput.found,
    screenshots: evidence.screenshots.count > 0,
    logs: evidence.logs.count > 0,
    checklist: evidence.manualChecklist.found,
  };
  const coreKeys = ['build', 'screenshots', 'logs', 'checklist'];
  const presentCount = coreKeys.filter((k) => core[k]).length;
  const completeness = presentCount === 0 ? 'none' : (presentCount === coreKeys.length ? 'complete' : 'partial');
  const missing = coreKeys.filter((k) => !core[k]);
  return { core, coreKeys, presentCount, completeness, missing };
}

export function collectEvidence(projectPath) {
  const screenshots = findFiles(projectPath, ['png', 'jpg', 'jpeg']);
  const logs = dedupeByPath(findFiles(projectPath, ['log']).concat(findInDirs(projectPath, ['logs', 'log'])));
  const mdFiles = findFiles(projectPath, ['md']);
  const manualChecklist = locateChecklist(projectPath, mdFiles);
  const buildOutput = locateBuildOutput(projectPath);
  const projectConfig = {
    found: existsSync(join(projectPath, 'project.config.json')),
    path: existsSync(join(projectPath, 'project.config.json')) ? join(projectPath, 'project.config.json') : null,
    appId: readAppId(join(projectPath, 'project.config.json')),
  };
  const runtimeManifest = locateRuntimeManifest(projectPath);

  return {
    buildOutput,
    screenshots: { found: screenshots.length > 0, count: screenshots.length, paths: screenshots.slice(0, 20).map((f) => f.relPath) },
    logs: { found: logs.length > 0, count: logs.length, paths: logs.slice(0, 20).map((f) => f.relPath) },
    manualChecklist,
    projectConfig,
    runtimeManifest,
  };
}

function locateBuildOutput(projectPath) {
  // 1) 约定构建目录
  for (const d of ['dist', 'build']) {
    const p = join(projectPath, d);
    if (existsSync(p) && statSync(p).isDirectory()) {
      return { found: true, path: p, kind: `dir:${d}` };
    }
  }
  // 2) build.mjs 输出目录：<project>-build-<platform>
  const parent = dirname(projectPath);
  const base = basename(projectPath);
  try {
    for (const e of readdirSync(parent)) {
      if (e.startsWith(`${base}-build-`) && statSync(join(parent, e)).isDirectory()) {
        return { found: true, path: join(parent, e), kind: 'build-cli-output' };
      }
    }
  } catch (_) { /* ignore */ }
  // 3) 项目内任一含 game.js + game.json 的子目录视为构建物
  const inner = findDirWithFiles(projectPath, ['game.js', 'game.json']);
  if (inner) return { found: true, path: inner, kind: 'inner-package' };
  return { found: false, path: null, kind: null };
}

function locateChecklist(projectPath, mdFiles) {
  const candidates = mdFiles.filter((f) =>
    /playtest|checklist|manual|可玩|测试清单|回归/i.test(f.relPath));
  if (candidates.length) return { found: true, path: candidates[0].path, relPath: candidates[0].relPath };
  return { found: false, path: null, relPath: null };
}

function locateRuntimeManifest(projectPath) {
  for (const name of ['runtime-evidence.json', 'playtest-evidence.json', 'evidence.json']) {
    const p = join(projectPath, name);
    if (existsSync(p)) return { found: true, path: p };
    // 也在 evidence/ 下找
    const pe = join(projectPath, 'evidence', name);
    if (existsSync(pe)) return { found: true, path: pe };
  }
  return { found: false, path: null };
}

// ---- 文件查找工具 ----

function dedupeByPath(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (!item || !item.path) continue;
    const key = item.path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function findFiles(root, exts) {
  const results = [];
  walk(root, root, 0, (full, rel, ext) => {
    if (exts.includes(ext)) results.push({ path: full, relPath: rel, ext });
  });
  return results;
}

function findInDirs(root, dirNames) {
  const results = [];
  walk(root, root, 0, (full, rel, ext, isDir) => {
    if (isDir && dirNames.includes(basename(full))) {
      // 收集该目录下的日志文件
      collectLogsInDir(full, results, root);
    }
  });
  return results;
}

function collectLogsInDir(dir, out, root) {
  try {
    for (const e of readdirSync(dir)) {
      if (EXCLUDE_DIRS.includes(e)) continue;
      const full = join(dir, e);
      const st = statSync(full);
      if (st.isFile() && /\.log$/i.test(e)) {
        out.push({ path: full, relPath: relative(root, full).split(sep).join('/'), ext: 'log' });
      }
    }
  } catch (_) { /* ignore */ }
}

function findDirWithFiles(root, required) {
  let found = null;
  walk(root, root, 0, (full, rel, ext, isDir) => {
    if (found) return;
    if (full === root) return; // 跳过项目根：根目录含 game.js+game.json 只是源码，不算"构建物"证据
    if (isDir) {
      const hasAll = required.every((rf) => existsSync(join(full, rf)));
      if (hasAll) found = full;
    }
  });
  return found;
}

function walk(dir, root, depth, cb) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir); } catch (_) { return; }
  for (const e of entries) {
    if (EXCLUDE_DIRS.includes(e)) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    const isDir = st.isDirectory();
    const ext = isDir ? '' : e.includes('.') ? e.split('.').pop().toLowerCase() : '';
    const rel = relative(root, full).split(sep).join('/');
    cb(full, rel, ext, isDir);
    if (isDir) walk(full, root, depth + 1, cb);
  }
}

function readAppId(p) {
  if (!existsSync(p)) return null;
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf-8'));
    return cfg.appid || cfg.appId || null;
  } catch { return null; }
}

const CHECKLIST_TEMPLATE = `# 手动可玩性测试清单（模板）

> 本文件为模板，由人工填写实际结果。脚本仅检测其"是否存在"，不伪造内容。
> 每项标注：✅ 通过 / ❌ 失败 / ⚠️ 跳过（附原因）。

## 启动
- [ ] 冷启动进入主场景，无白屏/崩溃
- [ ] 首屏加载耗时可接受（< 3s 记录实测值）

## 核心玩法
- [ ] 主循环可正常进行（输入→反馈→状态变化）
- [ ] 暂停/恢复正确
- [ ] 失败/结算流程可达

## 平台能力
- [ ] 登录态（如适用）
- [ ] 分享/排行（如适用）
- [ ] 支付/广告（如适用，注意 iOS 虚拟支付限制）

## 性能
- [ ] 真机帧率稳定（记录实测 FPS）
- [ ] 内存无持续增长泄漏

## 回归
- [ ] 上版本已知问题未复现
`;

// 仅当作为 CLI 直接运行时执行；被 qa-gate 等模块 import 时不自动运行
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    outputError(`playtest-evidence.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false);
  });
}
