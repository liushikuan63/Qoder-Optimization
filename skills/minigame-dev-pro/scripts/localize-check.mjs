/**
 * 出海本地化完整性校验（自研，1.1.0 新增）
 *
 * 职责：校验小游戏 i18n 资源完整性——未翻译键、空值、疑似未翻译（值与默认语言相同）、
 *       以及复用 sensitive-words.json 七分类词库对源语言字符串做跨语言敏感词预检。
 *
 * 边界（human-in-the-loop）：
 *  - 本工具**只校验完整性**，不翻译、不生成任何文案；翻译交专业服务/人工。
 *  - 跨语言敏感词预检受限于本地词库（中文分类示例词），覆盖源语言及所有目标语言字符串命中；
 *    正式发布前须结合各平台官方最新清单补充，且命中即人工复核，不直接判定违规。
 *  - 资产/生图不在此工具范围（见 asset-audit.mjs / asset-pipeline.md）。
 *
 * 输入契约（计划附录② P0）：--project 必填；缺失即报错退出（exit 1），不静默跑空。
 * 0 外部依赖。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const VERSION = '1.1.0';

const HELP = `出海本地化完整性校验（${VERSION}）

用法:
  node scripts/localize-check.mjs --project <路径> [--default-locale zh] [--locales zh,en,ja] [--json]
  node scripts/localize-check.mjs --project <路径> --in <locale目录> [--json]

必填:
  --project <path>   小游戏项目目录（自动探测 locales/ 或 i18n/ 下的 <lang>.json）

可选:
  --default-locale <code>  默认/源语言代码（默认 zh）
  --locales <csv>          指定待校验的目标语言（默认自动探测除默认外的所有 <lang>.json）
  --json                   输出 JSON
  --help                   显示本帮助

退出码:
  0  校验完成（含 warn 级缺口）
  1  --project 缺失 / 项目路径不存在 / 参数非法`;

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENSITIVE_WORDS = join(SKILL_ROOT, 'references', 'data', 'sensitive-words.json');

function loadSensitiveWords() {
  if (!existsSync(SENSITIVE_WORDS)) return [];
  try {
    const data = JSON.parse(readFileSync(SENSITIVE_WORDS, 'utf-8'));
    const words = [];
    const cats = data.categories || {};
    for (const list of Object.values(cats)) {
      if (Array.isArray(list)) words.push(...list);
    }
    return words;
  } catch {
    return [];
  }
}

function findLocaleDir(absProject) {
  const candidates = [
    join(absProject, 'locales'),
    join(absProject, 'i18n'),
    join(absProject, 'src', 'locales'),
    join(absProject, 'assets', 'i18n'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && readdirSync(c).some((f) => f.endsWith('.json'))) return c;
  }
  return null;
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

/**
 * 核心校验（可复用于 i18n-gate.mjs，零重复逻辑）
 * @returns {{found:boolean, defaultLocale:string, locales:string[], missing:Array, empty:Array, untranslated:Array, sensitiveHits:Array, summary:object}}
 */
export function runLocalize(absProject, opts = {}) {
  const defaultLocale = opts.defaultLocale || 'zh';
  const localeDir = findLocaleDir(absProject);
  if (!localeDir) {
    return { found: false, defaultLocale, locales: [], missing: [], empty: [], untranslated: [], sensitiveHits: [], summary: { files: 0, keys: 0 } };
  }
  const files = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
  const langs = files.map((f) => f.replace(/\.json$/, ''));
  const targets = opts.locales && opts.locales.length
    ? opts.locales
    : langs.filter((l) => l !== defaultLocale);

  const load = (lang) => {
    try { return flatten(JSON.parse(readFileSync(join(localeDir, `${lang}.json`), 'utf-8'))); }
    catch { return null; }
  };
  const def = load(defaultLocale);
  const sensitiveWords = loadSensitiveWords();

  const missing = [];
  const empty = [];
  const untranslated = [];
  const sensitiveHits = [];

  if (def) {
    const defKeys = Object.keys(def);
    // 源语言敏感词预检（中文分类词库对源语言 zh 字符串命中；目标语言多为非中文，命中概率低）
    for (const [k, v] of Object.entries(def)) {
      if (typeof v !== 'string') continue;
      for (const w of sensitiveWords) {
        if (v.includes(w)) sensitiveHits.push({ locale: defaultLocale, key: k, word: w });
      }
    }
    for (const lang of targets) {
      const t = load(lang);
      if (!t) { missing.push({ locale: lang, key: '(整个文件缺失/解析失败)' }); continue; }
      for (const k of defKeys) {
        if (!(k in t)) missing.push({ locale: lang, key: k });
        else if (t[k] === '' || t[k] == null) empty.push({ locale: lang, key: k });
        else if (typeof t[k] === 'string' && typeof def[k] === 'string' && t[k] === def[k]) untranslated.push({ locale: lang, key: k });
      }
      // 跨语言敏感词预检（源语言词库，覆盖所有 locale 的字符串值）
      for (const [k, v] of Object.entries(t)) {
        if (typeof v !== 'string') continue;
        for (const w of sensitiveWords) {
          if (v.includes(w)) sensitiveHits.push({ locale: lang, key: k, word: w });
        }
      }
    }
  }

  const summary = {
    files: langs.length,
    defaultKeys: def ? Object.keys(def).length : 0,
    targetLocales: targets.length,
    missing: missing.length,
    empty: empty.length,
    untranslated: untranslated.length,
    sensitiveHits: sensitiveHits.length,
  };
  return { found: true, defaultLocale, locales: langs, missing, empty, untranslated, sensitiveHits, summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;
  if (!args.project) outputError('缺少 --project <项目目录>（P0 输入契约，不静默跑空）', { hint: 'node scripts/localize-check.mjs --project ./my-game' }, json);
  const absProject = resolve(args.project);
  if (!existsSync(absProject)) outputError(`项目路径不存在: ${absProject}`, {}, json);

  const opts = { defaultLocale: args.defaultLocale || 'zh' };
  if (args.locales) opts.locales = String(args.locales).split(',').map((s) => s.trim()).filter(Boolean);
  const result = runLocalize(absProject, opts);
  if (!result.found) {
    outputSuccess({ tool: 'localize-check', version: VERSION, found: false, note: '未探测到 locale 目录（locales/ 或 i18n/ 下无 <lang>.json）；若项目需出海请先建立 i18n 资源。' }, json);
    return;
  }
  const gapCount = result.missing.length + result.empty.length + result.untranslated.length;
  outputSuccess({
    tool: 'localize-check',
    version: VERSION,
    defaultLocale: result.defaultLocale,
    locales: result.locales,
    summary: result.summary,
    missing: result.missing.slice(0, 50),
    empty: result.empty.slice(0, 50),
    untranslated: result.untranslated.slice(0, 50),
    sensitiveHits: result.sensitiveHits.slice(0, 50),
    note: gapCount ? `发现 ${gapCount} 处本地化缺口（缺键/空值/疑似未翻译）+ ${result.sensitiveHits.length} 处敏感词预检命中；翻译交专业服务/人工，命中须人工复核。` : '本地化资源完整，无缺口。',
  }, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => outputError(`localize-check.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false));
}
