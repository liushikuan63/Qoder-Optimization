/**
 * 资产规格审计（自研，1.1.0 新增）
 *
 * 职责：校验游戏资产（美术/音频/字体/地图）的命名/格式/尺寸/授权声明是否合规，
 *       并与 references/data/copyright-ip.json 联动（未授权 IP 命中 = 硬违规）。
 *
 * 边界（human-in-the-loop + 生成式资产纪律）：
 *  - 本工具**只审计规格**，不本地生成任何图像/音频 ML（算力限制 + 与"本地 ComfyUI 生图作废"纪律一致）。
 *  - 生图/生音频引用平台工具或文档工作流；本工具只验证"资产规格 + 授权声明"是否齐备。
 *  - 授权声明缺失仅 warn（不阻断），但未授权 IP/品牌角色命中为硬违规（fail 级，交人工确权）。
 *
 * 输入契约（计划附录② P0）：--project 或 --assets 必填其一；缺失即报错退出（exit 1），不静默跑空。
 * 0 外部依赖。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const VERSION = '1.1.0';

const HELP = `资产规格审计（${VERSION}）

用法:
  node scripts/asset-audit.mjs --project <路径> [--assets <资产目录>] [--spec <asset-spec.json>] [--json]
  node scripts/asset-audit.mjs --assets <目录> [--json]

必填（二选一）:
  --project <path>   小游戏项目目录（自动探测 assets/ 或 res/ 或 src/assets/）
  --assets <dir>     直接指定资产目录

可选:
  --spec <file>      资产规格文件（声明每类资产的授权/来源；缺省则按启发式审计）
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  审计完成（含 warn 级问题）
  1  --project/--assets 均缺失 / 路径不存在 / 参数非法`;

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COPYRIGHT_IP = join(SKILL_ROOT, 'references', 'data', 'copyright-ip.json');

const EXT_TYPE = {
  '.png': 'art', '.jpg': 'art', '.jpeg': 'art', '.webp': 'art', '.svg': 'art',
  '.mp3': 'music', '.wav': 'music', '.ogg': 'music', '.m4a': 'music',
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
  '.json': 'data', '.atlas': 'data', '.plist': 'data', '.skel': 'data',
};
const SIZE_LIMIT_MB = { art: 2, music: 5, font: 10, data: 1 };
const NAME_RE = /^[a-z0-9_-]+(\.[a-z0-9]+)?$/;

function loadCopyrightIp() {
  if (!existsSync(COPYRIGHT_IP)) return { hints: [], types: {} };
  try {
    const d = JSON.parse(readFileSync(COPYRIGHT_IP, 'utf-8'));
    return { hints: Array.isArray(d.unauthorizedIpHints) ? d.unauthorizedIpHints : [], types: d.assetTypes || {} };
  } catch { return { hints: [], types: {} }; }
}

function findAssetsDir(absProject) {
  for (const c of [join(absProject, 'assets'), join(absProject, 'res'), join(absProject, 'src', 'assets')]) {
    if (existsSync(c)) return c;
  }
  return null;
}

function walk(dir, out, base) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.workbuddy', 'dist', 'build'].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out, base);
    else if (e.isFile()) out.push(relative(base, full));
  }
}

/**
 * 核心审计（可复用于 asset-gate.mjs，零重复逻辑）
 * @returns {{found:boolean, assets:Array, summary:object}}
 */
export function runAssetAudit(absProject, opts = {}) {
  const assetsDir = opts.assets ? resolve(opts.assets) : findAssetsDir(absProject);
  if (!assetsDir || !existsSync(assetsDir)) {
    return { found: false, assets: [], summary: { total: 0, violations: 0, warnings: 0 } };
  }
  const { hints, types } = loadCopyrightIp();
  const spec = opts.spec && existsSync(resolve(opts.spec))
    ? safeJson(resolve(opts.spec))
    : (existsSync(join(assetsDir, 'asset-spec.json')) ? safeJson(join(assetsDir, 'asset-spec.json')) : null);

  const files = [];
  walk(assetsDir, files, assetsDir);
  const ipHints = hints.map((h) => h.toLowerCase());
  const assets = [];
  let violations = 0;
  let warnings = 0;

  for (const rel of files) {
    const issues = [];
    const name = rel.split(/[\\/]/).pop();
    const lower = name.toLowerCase();
    const ext = extname(lower);
    const type = EXT_TYPE[ext] || 'unknown';

    // 1) 命名规范
    const baseName = name.replace(/\.[^.]+$/, '');
    if (!NAME_RE.test(baseName)) {
      issues.push({ level: 'warn', detail: `命名不符规范（建议小写+下划线/连字符，无空格/中文：${name}）` });
    }
    // 2) 格式白名单
    if (type === 'unknown') {
      issues.push({ level: 'warn', detail: `格式不在白名单（${ext || '无扩展名'}）：建议 png/jpg/webp/mp3/wav/ttf/otf…` });
    }
    // 3) 尺寸
    const bytes = statSync(join(assetsDir, rel)).size;
    const mb = bytes / (1024 * 1024);
    const limit = SIZE_LIMIT_MB[type];
    if (limit && mb > limit) {
      issues.push({ level: 'warn', detail: `尺寸 ${mb.toFixed(2)}MB 超 ${type} 建议上限 ${limit}MB` });
    }
    // 4) 未授权 IP 命中（硬违规）
    for (const h of ipHints) {
      if (lower.includes(h)) {
        issues.push({ level: 'violation', detail: `文件名命中未授权 IP 线索「${h}」——须人工确权授权，禁止未授权商用` });
        break;
      }
    }
    // 5) 授权声明
    if (spec && spec.assets && spec.assets[name]) {
      const decl = spec.assets[name];
      if (!decl.license && !decl.source) {
        issues.push({ level: 'warn', detail: 'asset-spec 已登记但缺 license/source 授权声明' });
      }
    } else if (types[type] && types[type].requireLicense) {
      issues.push({ level: 'warn', detail: `${type} 类资产须商用授权/开源许可声明（asset-spec 未登记此资产）` });
    }

    const lv = issues.some((i) => i.level === 'violation') ? 'violation' : (issues.length ? 'warn' : 'ok');
    if (lv === 'violation') violations++;
    else if (lv === 'warn') warnings++;
    assets.push({ file: rel, type, sizeMB: Number(mb.toFixed(3)), issues });
  }

  return {
    found: true,
    assets,
    summary: { total: assets.length, violations, warnings, ipHints: hints.length },
  };
}

function safeJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;
  if (!args.project && !args.assets) outputError('缺少 --project 或 --assets（P0 输入契约，不静默跑空）', { hint: 'node scripts/asset-audit.mjs --project ./my-game' }, json);
  const absProject = args.project ? resolve(args.project) : process.cwd();
  if (args.project && !existsSync(absProject)) outputError(`项目路径不存在: ${absProject}`, {}, json);

  const opts = {};
  if (args.assets) opts.assets = args.assets;
  if (args.spec) opts.spec = args.spec;
  const result = runAssetAudit(absProject, opts);
  if (!result.found) {
    outputSuccess({ tool: 'asset-audit', version: VERSION, found: false, note: '未探测到资产目录（assets/ 或 res/ 或 src/assets/）；若项目含美术/音频/字体资产请先建立资产目录与 asset-spec.json。' }, json);
    return;
  }
  outputSuccess({
    tool: 'asset-audit',
    version: VERSION,
    summary: result.summary,
    assets: result.assets.slice(0, 80).map((a) => ({ file: a.file, type: a.type, sizeMB: a.sizeMB, issues: a.issues })),
    note: result.summary.violations
      ? `发现 ${result.summary.violations} 处硬违规（未授权 IP 命中）——须人工确权，禁止未授权商用。`
      : (result.summary.warnings ? `审计完成，${result.summary.warnings} 处 warn（命名/格式/尺寸/授权声明），不阻断但建议补齐。` : '资产规格合规，无违规无 warn。'),
  }, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => outputError(`asset-audit.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false));
}
