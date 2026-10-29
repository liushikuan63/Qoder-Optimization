#!/usr/bin/env node
// 分享包索引：检索包内/外部内容，按需加装。默认 dry-run，--apply 才写盘。
// 用法：pkg-catalog.cjs search <关键词> [--catalog <catalog.json>]
//       pkg-catalog.cjs show <id|名称>
//       pkg-catalog.cjs list [--category skill|plugin|mcp|script|command|agent]
//       pkg-catalog.cjs install <id|名称> [--apply] [--tier core|library] [--force]
//       pkg-catalog.cjs register [<包目录>]        # 记住包位置，供 skill-load 未命中时兜底检索
// 退出码：0 成功；1 安装失败/目标已存在；2 参数或条目错误；3 检索无命中。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const { dependenciesFor } = require('./package-dependencies.cjs');
const CLIENT_ROOT = clientRoot();
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');

const HOME = os.homedir();
const QODER = CLIENT_ROOT;
const POINTER = path.join(QODER, 'share-package.json');
const argv = process.argv.slice(2);
const CMD = argv[0] || '';
const has = (f) => argv.includes('--' + f);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? String(argv[i + 1] || '') : ''; };
const APPLY = has('apply');
const FORCE = has('force');
const TIER = opt('tier');
const CATEGORY = opt('category');
const CATALOG_ARG = opt('catalog');
const positionals = argv.slice(1).filter((a, i) => {
  if (!a.startsWith('--')) {
    const prev = argv.slice(1)[i - 1];
    return !['--tier', '--category', '--catalog'].includes(prev);
  }
  return false;
});
const value = positionals.join(' ').trim();

const fail = (code, msg) => { console.error(msg); process.exit(code); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function resolveCatalog() {
  if (CATALOG_ARG) return path.resolve(CATALOG_ARG);
  if (process.env.QODER_SHARE_CATALOG) return path.resolve(process.env.QODER_SHARE_CATALOG);
  try {
    const p = readJson(POINTER);
    if (p.catalog) return path.resolve(p.catalog);
  } catch {}
  const local = path.join(__dirname, '..', 'catalog.json');
  return fs.existsSync(local) ? local : '';
}

function loadCatalog() {
  const file = resolveCatalog();
  if (!file || !fs.existsSync(file)) {
    fail(2, '找不到 catalog.json：请先 `pkg-catalog.cjs register <分享包目录>`，或加 --catalog <路径>');
  }
  const catalog = readCatalog(file);
  return { file, root: path.dirname(file), catalog, entries: catalog.entries };
}

function readCatalog(file) {
  const catalog = readJson(file);
  const schemaOk = catalog.schema === 1 || catalog.schema === 'qoder-share-catalog/1';
  if (!schemaOk || !Array.isArray(catalog.entries) || catalog.entries.some(e =>
    !e || typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.category !== 'string' ||
    (e.description !== undefined && typeof e.description !== 'string'))) {
    throw new Error('分享包索引格式错误：需要 schema=1（或 "qoder-share-catalog/1"）和有效 entries');
  }
  return catalog;
}

const norm = (s) => String(s || '').toLowerCase();
// 类别中文名也进检索面：搜「插件」「技能」「脚本」应能列出对应类别
const CAT_LABEL = { skill: '技能', plugin: '插件', mcp: 'MCP 连接', script: '脚本', command: '命令', agent: '子智能体' };
const hay = (e) => e.name + ' ' + (e.description || '') + ' ' + (CAT_LABEL[e.category] || '');
function scoreEntry(e, query, tokens) {
  const name = norm(e.name);
  const desc = norm(hay(e));
  const id = norm(e.id);
  const q = norm(query);
  let score = 0;
  if (name === q || id === q) score += 20;
  else if (name.includes(q) || id.includes(q)) score += 8;
  if (desc.includes(q)) score += 3;
  for (const t of tokens) {
    if (name.includes(t)) score += 4;
    else if (desc.includes(t)) score += 1;
  }
  return score;
}

function localPresence(e) {
  if (e.category === 'plugin' || e.category === 'mcp') return { label: '安装/连接状态未核验，先用平台工具核对', present: null };
  const roots = e.category === 'skill' ? ['skills', 'skills-library'] :
    ({ script: ['scripts'], command: ['commands'], agent: ['agents'] }[e.category] || []);
  const name = e.category === 'skill' ? e.name : path.basename(e.source || '');
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) return { label: '本地状态未核验', present: null };
  const found = roots.filter(root => {
    const p = path.join(QODER, root, name, ...(e.category === 'skill' ? ['SKILL.md'] : []));
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  return { present: found.length > 0, label: found.length ? `本地文件已存在（${found.join(' + ')}；未验装载）` : '本地未发现' };
}

function formatEntry(e, catalogFile = '') {
  const BADGE = { shipped: '随包', external: '外部', disabled: '来源已停用', template: '模板', recommended: '推荐', optional: '可选', 'on-demand': '按需', bundled: '随客户端' };
  const badge = BADGE[e.status] || e.status;
  const presence = localPresence(e);
  const lines = [`${e.id}  [${e.category}/${badge}]  ${e.name}`, '  ' + presence.label];
  if (e.description) lines.push('  ' + e.description.slice(0, 140));
  if (e.install && e.install.command && presence.present !== true) lines.push('  ' + e.install.command);
  if (e.status === 'shipped' && presence.present === false) {
    lines.push(`  安装预演：node ${JSON.stringify(path.join(QODER, 'scripts', 'pkg-catalog.cjs'))} install ${JSON.stringify(e.id)}${catalogFile ? ' --catalog ' + JSON.stringify(catalogFile) : ''}`);
  }
  return lines.join('\n');
}

function findEntry(entries, key) {
  const k = norm(key);
  return entries.find((e) => norm(e.id) === k) || entries.find((e) => norm(e.name) === k) ||
    entries.find((e) => norm(e.id).split(':')[0] === k && norm(e.name) === k);
}

function searchEntries(entries, query, limit = 8) {
  const tokens = norm(query).split(/[\s,，、/|]+/).filter(Boolean);
  if (!tokens.length) return [];
  return entries.map(e => ({ e, s: scoreEntry(e, query, tokens) }))
    .filter(x => x.s > 0 && tokens.every(t => norm(hay(x.e) + ' ' + (x.e.id || '')).includes(t)))
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name)).slice(0, limit);
}

function cmdSearch() {
  const { file, entries } = loadCatalog();
  if (!value) fail(2, '用法：pkg-catalog.cjs search <关键词>');
  const hits = searchEntries(entries, value);
  if (!hits.length) { console.error(`NO_MATCH 包内索引没有「${value}」。可换同义词再查，或到技能库/扩展市场找。`); process.exit(3); }
  console.log(`命中 ${hits.length} 条（按相关度排序）：`);
  for (const h of hits) console.log(formatEntry(h.e, file));
}

function cmdShow() {
  const { entries } = loadCatalog();
  if (!value) fail(2, '用法：pkg-catalog.cjs show <id|名称>');
  const e = findEntry(entries, value);
  if (!e) fail(2, `没有条目「${value}」`);
  console.log(JSON.stringify(e, null, 2));
}

function cmdList() {
  const { entries } = loadCatalog();
  const rows = CATEGORY ? entries.filter((e) => e.category === CATEGORY) : entries;
  const by = {};
  for (const e of rows) by[e.category] = (by[e.category] || 0) + 1;
  console.log(`共 ${rows.length} 条：` + Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' / '));
  for (const e of rows) console.log(`- ${e.id}  [包标记:${e.status}]  ${e.name}  ${localPresence(e).label}`);
}

function within(root, p) {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function installTarget(e, root) {
  const tier = TIER || e.install.tier || 'library';
  if (e.category === 'skill') {
    if (!['core', 'library'].includes(tier)) fail(2, '--tier 只能是 core 或 library');
    return { target: path.join(QODER, tier === 'core' ? 'skills' : 'skills-library', e.name), tier };
  }
  if (e.category === 'script') return { target: path.join(QODER, 'scripts', path.basename(e.source)) };
  if (e.category === 'command') return { target: path.join(QODER, 'commands', path.basename(e.source)) };
  if (e.category === 'agent') return { target: path.join(QODER, 'agents', path.basename(e.source)) };
  return null;
}

function rebuildIndex() {
  const script = path.join(QODER, 'scripts', 'build-skills-index.cjs');
  if (!fs.existsSync(script)) return '索引未重建（build-skills-index.cjs 不在 ~/.qoder/scripts）';
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`索引重建失败（exit=${r.status}）：${(r.stderr || '').slice(0, 200)}`);
  return '索引已重建';
}

function cmdInstall() {
  const { root, entries } = loadCatalog();
  if (!value) fail(2, '用法：pkg-catalog.cjs install <id|名称> [--apply] [--tier core|library] [--force]');
  const e = findEntry(entries, value);
  if (!e) fail(2, `没有条目「${value}」，先 search`);
  if (!e.install || typeof e.install !== 'object' || Array.isArray(e.install)) {
    fail(2, '条目的 install 格式无效：请使用已修复的分享包索引');
  }
  if (e.install.mode === 'external' || e.status === 'local-only') {
    console.log(`[外部] ${e.name} 不随包转发源码，需你自行安装：`);
    console.log('  ' + (e.install.command || e.install.note || '见分享包清单'));
    return;
  }
  if (e.install.mode === 'merge' || e.status === 'template') {
    console.log(`[模板] ${e.name} 需手工合并：`);
    console.log('  ' + (e.install.note || '见 mcp/README-mcp.md'));
    return;
  }
  const assertNoLinks = file => {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) fail(2, '安装路径不能含符号链接');
    if (st.isDirectory()) for (const name of fs.readdirSync(file)) assertNoLinks(path.join(file, name));
  };
  const fingerprint = file => {
    const hash = createHash('sha256');
    const walk = (p, rel) => {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('目标在检查后变成符号链接');
      hash.update(rel + (st.isDirectory() ? '/' : ':'));
      if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name), rel + '/' + name);
      else hash.update(fs.readFileSync(p));
    };
    walk(file, ''); return hash.digest('hex');
  };
  const copyExclusive = (source, target, owned) => {
    const st = fs.statSync(source);
    if (st.isDirectory()) {
      fs.mkdirSync(target);
      const created = fs.lstatSync(target);
      owned.push({ path: target, ino: created.ino, dev: created.dev, directory: true });
      for (const name of fs.readdirSync(source)) copyExclusive(path.join(source, name), path.join(target, name), owned);
    } else {
      const bytes = fs.readFileSync(source), fd = fs.openSync(target, 'wx', st.mode);
      const created = fs.fstatSync(fd);
      owned.push({ path: target, ino: created.ino, dev: created.dev, hash: createHash('sha256').update(bytes).digest('hex') });
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    }
  };
  const plan = [], visiting = new Set(), visited = new Set();
  const visit = entry => {
    if (visited.has(entry.id)) return;
    if (visiting.has(entry.id)) fail(2, '循环依赖：' + entry.id);
    visiting.add(entry.id);
    if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/:]/.test(entry.name)) fail(2, '条目名称无效');
    const expected = { skill: `skills/${entry.name}`, script: `scripts/${entry.name}`, command: `commands/${entry.name}.md`, agent: `agents/${entry.name}.md` }[entry.category];
    if (!expected || entry.source !== expected) fail(2, '条目的 source 与类别或名称不一致');
    const src = path.resolve(root, expected);
    if (!fs.existsSync(src) || !within(fs.realpathSync(root), fs.realpathSync(src))) fail(2, '安装源不存在或越界');
    assertNoLinks(src);
    if (entry.category === 'skill' ? !fs.statSync(src).isDirectory() || !fs.existsSync(path.join(src, 'SKILL.md')) || !fs.statSync(path.join(src, 'SKILL.md')).isFile() : !fs.statSync(src).isFile()) fail(2, '条目源类型或入口无效');
    let dependencies;
    try { dependencies = dependenciesFor(root, entry); } catch (error) { fail(2, error.message); }
    for (const id of dependencies) {
      const dependency = entries.find(item => item.id === id);
      if (!dependency) fail(2, '缺少依赖条目：' + id);
      visit(dependency);
    }
    const t = installTarget(entry, root);
    if (entry.category === 'skill') {
      const other = path.join(QODER, t.tier === 'core' ? 'skills-library' : 'skills', entry.name);
      if (fs.existsSync(other)) {
        if (entry === e || fs.existsSync(t.target)) fail(1, '另一层已有同名技能，请先明确迁移：' + entry.name);
        assertNoLinks(other);
        if (!fs.existsSync(path.join(other, 'SKILL.md'))) fail(1, '已安装依赖不完整：' + entry.id);
        t.target = other;
      }
    }
    if (fs.existsSync(t.target)) {
      assertNoLinks(t.target);
      if (entry === e && !FORCE) fail(1, `目标已存在：${t.target}（确需覆盖加 --force）`);
      if (entry !== e) { visiting.delete(entry.id); visited.add(entry.id); return; }
    }
    const previous = fs.existsSync(t.target);
    plan.push({ entry, src, target: t.target, previous, before: previous ? fingerprint(t.target) : null, owned: [], originalMoved: false });
    visiting.delete(entry.id); visited.add(entry.id);
  };
  visit(e);
  for (const item of plan) console.log(`[${APPLY ? '安装' : '预演'}] ${item.entry.id} → ${item.target}`);
  if (!APPLY) { console.log('  未写盘；确认后加 --apply。'); return; }
  fs.mkdirSync(QODER, { recursive: true });
  const stage = fs.mkdtempSync(path.join(QODER, '.pkg-install-'));
  const indexPath = path.join(QODER, 'skills-index.json');
  const indexBefore = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : null;
  const applied = [];
  let restored = false, indexAttempted = false;
  try {
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      item.staged = path.join(stage, 'new-' + i);
      item.backup = path.join(stage, 'old-' + i);
      fs.cpSync(item.src, item.staged, { recursive: true, force: false, errorOnExist: true });
    }
    for (const item of plan) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      applied.push(item);
      if (item.previous) {
        if (fingerprint(item.target) !== item.before) throw new Error('目标在预检后已变化：' + item.entry.id);
        fs.renameSync(item.target, item.backup);
        item.originalMoved = true;
      }
      copyExclusive(item.staged, item.target, item.owned);
    }
    if (plan.some(item => item.entry.category === 'skill')) { indexAttempted = true; console.log('  ' + rebuildIndex()); }
    console.log('  已安装全部依赖并通过入口校验。');
    for (const item of plan) if (item.entry.category === 'skill' && fs.existsSync(path.join(item.target, 'package-lock.json'))) {
      console.log('  第三方依赖需另行安装：npm ci --ignore-scripts --prefix ' + JSON.stringify(item.target));
    }
    if (plan.some(item => item.previous)) console.log('  原文件备份保留于：' + stage);
    else fs.rmSync(stage, { recursive: true, force: true });
  } catch (error) {
    try {
      let conflict = false;
      for (const item of applied.reverse()) {
        for (const owned of item.owned.reverse()) {
          if (!fs.existsSync(owned.path)) continue;
          const st = fs.lstatSync(owned.path);
          if (st.ino !== owned.ino || st.dev !== owned.dev || st.isSymbolicLink()) { conflict = true; continue; }
          if (owned.directory) {
            if (fs.readdirSync(owned.path).length) { conflict = true; continue; }
            fs.rmdirSync(owned.path);
          } else {
            if (createHash('sha256').update(fs.readFileSync(owned.path)).digest('hex') !== owned.hash) { conflict = true; continue; }
            fs.unlinkSync(owned.path);
          }
        }
        if (item.originalMoved) {
          if (fs.existsSync(item.target)) conflict = true;
          else copyExclusive(item.backup, item.target, []);
        }
      }
      if (indexAttempted) {
        if (indexBefore) fs.writeFileSync(indexPath, indexBefore);
        else if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
      }
      if (conflict) throw new Error('目标内容或归属变化，未完整回滚；保留文件与备份供核对：' + stage);
      restored = true;
    } finally {
      if (restored) fs.rmSync(stage, { recursive: true, force: true });
    }
    fail(1, '安装失败，已回滚：' + error.message);
  }
}

function cmdRegister() {
  const dir = path.resolve(value || (CATALOG_ARG ? path.dirname(path.resolve(CATALOG_ARG)) : '.'));
  const file = path.join(dir, 'catalog.json');
  if (!fs.existsSync(file)) fail(2, `目录下没有 catalog.json：${dir}`);
  readCatalog(file);
  fs.mkdirSync(QODER, { recursive: true });
  fs.writeFileSync(POINTER, JSON.stringify({ catalog: file, registered_at: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
  console.log(`已登记分享包索引：${file}`);
  console.log('之后可用 `pkg-catalog.cjs search <关键词>` 检索；skill-load 未命中时也会提示。');
}

const usage = () => console.log([
  '用法：pkg-catalog.cjs <search|show|list|install|register> ...',
  '  search <关键词>                 检索包内与外部可装内容',
  '  show <id>                       查看条目详情',
  '  list [--category skill]         列出全部条目',
  '  install <id> [--apply]          安装随包条目（默认 dry-run；技能默认入按需库，--tier core 进常驻）',
  '  register [<包目录>]             登记分享包位置（供 skill-load 兜底检索）',
].join('\n'));

module.exports = { resolveCatalog, readCatalog, searchEntries, formatEntry };
if (require.main === module) {
  try {
    switch (CMD) {
      case 'search': cmdSearch(); break;
      case 'show': cmdShow(); break;
      case 'list': cmdList(); break;
      case 'install': cmdInstall(); break;
      case 'register': cmdRegister(); break;
      default: usage(); process.exitCode = 2;
    }
  } catch (error) {
    console.error('CATALOG_ERROR: ' + error.message);
    process.exitCode = 2;
  }
}
