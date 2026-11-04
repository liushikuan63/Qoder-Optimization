#!/usr/bin/env node
/**
 * fetch-official-docs.mjs 官方规范联网核验（质量自检工具）
 * 用法：
 *   node fetch-official-docs.mjs [--urls <逗号分隔>] [--timeout <秒>] [--ttl-hours <小时>] [--force] [--json]
 *
 * 能力：
 *  - 拉取微信官方规范文档（默认：小游戏文档首页 + 开发指南）
 *  - 本地缓存 + TTL 频率控制：有效期内重复执行命中缓存，避免频繁请求
 *  - 失败降级：网络失败/超时自动返回最近一次缓存快照并告警
 *  - 域名白名单：默认仅允许微信官方域名，防止 SSRF
 * 退出码：
 *  - 0：拉取成功 / 缓存命中 / 降级命中缓存（有可用数据）
 *  - 1：全部 URL 失败且无缓存 / 参数非法 / Node 无内置 fetch
 *
 * 设计原则：
 *  - 零外部依赖：仅用 Node 内置 fetch（Node 18+）与 node: 模块
 *  - 无副作用：缓存写入系统临时目录（--cache-dir 可指定），不触碰 skill 包
 *  - 诚实边界：微信官方文档为动态渲染页面，本工具保证可达性监测与
 *    响应快照留存；正文语义解析需结合 AI 联网能力或人工核对
 *
 * 详见 references/engine/execution-protocol.md 联网核验工具说明
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { outputError, outputSuccess, parseArgs, printHelp } from './lib/output-formatter.mjs';

// ---- 默认配置 ----

const DEFAULT_URLS = [
  'https://developers.weixin.qq.com/minigame/dev/',
  'https://developers.weixin.qq.com/minigame/dev/guide/',
];
const DEFAULT_ALLOWED_HOSTS = ['developers.weixin.qq.com', 'mp.weixin.qq.com', 'weixin.qq.com'];
const DEFAULT_TIMEOUT = 10; // 秒
const DEFAULT_TTL_HOURS = 24;
const SNIPPET_LEN = 500;

const NOTE =
  '微信官方文档为动态渲染页面（SPA），本工具保证可达性监测与响应快照留存；正文语义解析需结合 AI 联网能力或人工核对官方文档。';

const HELP = `官方规范联网核验（拉取微信官方小游戏文档，缓存 + 降级）
用法:
  node fetch-official-docs.mjs [选项]

选项:
  --json                 以 JSON 格式输出
  --urls <逗号分隔>      指定要拉取的官方 URL（默认微信小游戏文档首页 + 开发指南）
  --timeout <秒>         单请求超时，默认 10
  --ttl-hours <小时>     缓存有效期，默认 24（期内重复执行命中缓存，不重复请求）
  --force                忽略缓存有效期，强制重新拉取
  --cache-dir <路径>     缓存目录（默认系统临时目录 wxskill-docs-cache）
  --allow-domains <列表> 追加允许的域名（默认仅微信官方域名，防 SSRF）
  --allow-any-domain     放开域名限制（谨慎：仅在你信任目标地址时使用）
  --help                 显示帮助

输出说明
  source=network  本次网络拉取成功
  source=cache    缓存有效期内命中，未发起网络请求
  source=degraded 网络失败，降级返回最近缓存快照（含 warning）

诚实边界
  微信官方文档为动态渲染页面（SPA），本工具只保证：可达性、HTTP 状态、
  响应体大小与内容片段快照。正文语义解析请结合 AI 联网能力或人工核对。

退出码:
  0  拉取成功 / 缓存命中 / 降级命中缓存（有可用数据）
  1  全部 URL 失败且无缓存 / 参数非法 / Node 版本过低（需 18+）

示例:
  node fetch-official-docs.mjs --json
  node fetch-official-docs.mjs --force --json
  node fetch-official-docs.mjs --urls https://developers.weixin.qq.com/minigame/dev/ --timeout 15
`;

// ---- 参数校验 ----

function parsePositive(v, def, name, json) {
  if (v === undefined || v === true) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    outputError(`--${name} 参数非法: ${v}`, { hint: '需为正数' }, json);
  }
  return n;
}

/**
 * URL 校验：必须 http(s)，默认仅允许白名单域名（防 SSRF）
 */
function validateUrl(raw, allowedHosts, allowAny) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `非法 URL: ${raw}` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: `仅允许 http(s) URL: ${raw}` };
  }
  if (!allowAny && !allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
    return { ok: false, error: `域名不在白名单: ${u.hostname}（可用 --allow-domains 追加或 --allow-any-domain 放开）` };
  }
  return { ok: true, url: u };
}

// ---- 拉取 ----

async function fetchUrl(urlStr, timeoutSec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(urlStr, { redirect: 'follow', signal: controller.signal });
    const body = await res.text();
    return {
      ok: res.ok,
      httpStatus: res.status,
      size: Buffer.byteLength(body, 'utf8'),
      snippet: body.slice(0, SNIPPET_LEN),
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: null,
      size: 0,
      snippet: '',
      error: e && e.name === 'AbortError' ? `超时(${timeoutSec}s)` : `网络错误: ${e && e.message ? e.message : e}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 缓存 ----

function cachePathOf(cacheDir) {
  return join(cacheDir, 'official-docs-cache.json');
}

function loadCache(cacheDir) {
  const p = cachePathOf(cacheDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null; // 缓存损坏视为无缓存
  }
}

function saveCache(cacheDir, data) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePathOf(cacheDir), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 缓存写失败不致命：仅失去快照能力
  }
}

function cacheFresh(cache, ttlHours) {
  if (!cache || !cache.fetchedAt || !Array.isArray(cache.results)) return false;
  const t = new Date(cache.fetchedAt).getTime();
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) / 3600000 < ttlHours;
}

// ---- 主流程 ----

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const json = !!args.json;

  if (typeof fetch !== 'function') {
    outputError('当前 Node 版本无内置 fetch，需 Node 18+', { hint: '升级 Node 版本后重试' }, json);
  }

  const timeoutSec = parsePositive(args.timeout, DEFAULT_TIMEOUT, 'timeout', json);
  const ttlHours = parsePositive(args['ttl-hours'], DEFAULT_TTL_HOURS, 'ttl-hours', json);
  const force = !!args.force;
  const allowAny = !!args['allow-any-domain'];
  const cacheDir = args['cache-dir'] ? String(args['cache-dir']) : join(tmpdir(), 'wxskill-docs-cache');
  const extraHosts = args['allow-domains']
    ? String(args['allow-domains']).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const allowedHosts = [...DEFAULT_ALLOWED_HOSTS, ...extraHosts];

  const urls = args.urls ? String(args.urls).split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_URLS;
  if (urls.length === 0) {
    outputError('URL 列表为空', { hint: '用 --urls 传逗号分隔的官方文档地址' }, json);
  }
  for (const u of urls) {
    const v = validateUrl(u, allowedHosts, allowAny);
    if (!v.ok) outputError(v.error, { hint: '默认仅允许微信官方域名（防 SSRF）' }, json);
  }

  // 缓存命中（TTL 内且未强制）
  const cache = loadCache(cacheDir);
  if (!force && cacheFresh(cache, ttlHours)) {
    outputSuccess(
      {
        action: 'fetch_official_docs',
        source: 'cache',
        cacheHit: true,
        fetchedAt: cache.fetchedAt,
        ttlHours,
        results: cache.results,
        note: NOTE,
      },
      json
    );
  }

  // 网络拉取
  const results = [];
  for (const u of urls) {
    results.push({ url: u, ...(await fetchUrl(u, timeoutSec)) });
  }

  if (results.every((r) => r.ok)) {
    const snapshot = { fetchedAt: new Date().toISOString(), results };
    saveCache(cacheDir, snapshot);
    outputSuccess(
      {
        action: 'fetch_official_docs',
        source: 'network',
        cacheHit: false,
        fetchedAt: snapshot.fetchedAt,
        ttlHours,
        results,
        note: NOTE,
      },
      json
    );
  }

  // 部分/全部失败 → 降级命中缓存
  if (cache && Array.isArray(cache.results) && cache.results.length > 0) {
    outputSuccess(
      {
        action: 'fetch_official_docs',
        source: 'degraded',
        cacheHit: true,
        fetchedAt: cache.fetchedAt,
        ttlHours,
        results,
        warning: '网络拉取失败，已降级返回最近缓存快照',
        note: NOTE,
      },
      json
    );
  }

  // 部分成功且无可用缓存 → 返回已成功内容并提示重试失败源
  const anyOk = results.some((r) => r.ok);
  if (anyOk) {
    outputSuccess(
      {
        action: 'fetch_official_docs',
        source: 'partial',
        cacheHit: false,
        fetchedAt: new Date().toISOString(),
        ttlHours,
        results,
        warning: `部分源拉取失败（${results.filter((r) => !r.ok).length} 个），已返回成功源内容，可重试或 --urls 指定源`,
        note: NOTE,
      },
      json
    );
  }

  outputError('网络拉取失败且无可用缓存', { hint: '检查网络后重试，或 --urls 更换官方源' }, json);
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));
