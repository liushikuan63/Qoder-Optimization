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
const { isPublicFile, scriptDirectoryFiles } = require('./pack-share-extras.cjs');
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
const NON_INTERACTIVE = has('non-interactive');
let TIER = opt('tier');
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

function validateArgs() {
  const allowed = {
    search: ['catalog'], show: ['catalog'], list: ['catalog', 'category'],
    drift: ['catalog'], install: ['catalog', 'tier', 'apply', 'force', 'non-interactive'], register: ['catalog'],
  }[CMD];
  if (!allowed) return;
  const seen = new Set(), words = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (!arg.startsWith('--') || !allowed.includes(name) || seen.has(name)) throw new Error('未知、重复或不适用的参数：' + arg);
    seen.add(name);
    if (['catalog', 'tier', 'category'].includes(name)) {
      const next = argv[++i];
      if (!next || !next.trim() || next.startsWith('-')) throw new Error(arg + ' 需要明确值');
      if (name === 'tier' && !['core', 'library'].includes(next)) throw new Error('--tier 只能是 core 或 library');
      if (name === 'category' && !Object.hasOwn(CAT_LABEL, next)) throw new Error('--category 类别无效');
    }
  }
  if (['drift', 'list'].includes(CMD) && words.length) throw new Error(CMD + ' 不接受位置参数');
  if (['install', 'show', 'register'].includes(CMD) && words.length > 1) throw new Error(CMD + ' 只接受一个条目或目录；含空格的路径需整体引用');
}

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

function digestOf(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

// 只比对包内会安装的公开文件：本地新增文件与 .bak 不参与判断，
// 否则一份本地备份就会把"与包内一致"误报成"可更新"。
function packageFiles(root, rel) {
  const files = [];
  const walk = (abs, relPath) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const next = relPath + '/' + name;
      if (!isPublicFile(next)) continue;
      const full = path.join(abs, name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) return false;
      if (st.isDirectory()) {
        if (!walk(full, next)) return false;
      } else if (st.isFile()) {
        const hash = digestOf(full);
        if (!hash) return false;
        files.push({ rel: next.slice(rel.length + 1), hash });
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(path.join(root, rel), rel) ? files : null;
}

function compareWithPackage(e, root, localTarget) {
  if (!root || !e.source) return null;
  try {
    const src = path.resolve(root, e.source);
    if (!within(fs.realpathSync(root), fs.realpathSync(src))) return null;
    if (e.category === 'skill' || (e.category === 'script' && e.install?.mode === 'copy-directory')) {
      const files = packageFiles(root, e.source);
      if (!files || !files.length) return null;
      for (const f of files) {
        if (digestOf(path.join(localTarget, f.rel)) !== f.hash) return { differs: true, file: f.rel };
      }
      return { differs: false };
    }
    const sourceHash = digestOf(src);
    const localHash = digestOf(localTarget);
    if (!sourceHash || !localHash) return null;
    return { differs: sourceHash !== localHash, file: path.basename(localTarget) };
  } catch {
    return null;
  }
}

function localPresence(e, root = '', client = QODER) {
  if (e.category === 'plugin' || e.category === 'mcp') return { label: '安装/连接状态未核验，先用平台工具核对', present: null, differs: null, installedPaths: [] };
  const roots = e.category === 'skill' ? ['skills', 'skills-library'] :
    ({ script: ['scripts'], command: ['commands'], agent: ['agents'] }[e.category] || []);
  const name = e.category === 'skill' ? e.name : path.basename(e.source || '');
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name)) return { label: '本地状态未核验', present: null, differs: null, installedPaths: [] };
  const directory = e.category === 'skill' || (e.category === 'script' && e.install?.mode === 'copy-directory');
  const found = [];
  for (const r of roots) {
    const p = path.join(client, r, name);
    try {
      // A partially installed directory is still a local copy to compare;
      // missing entry points and companions must not disappear from drift.
      if (directory ? !fs.statSync(p).isDirectory() : !fs.statSync(p).isFile()) continue;
      found.push({ root: r, target: p });
    } catch { /* 未安装或目录不完整 */ }
  }
  if (!found.length) return { present: false, differs: null, label: '本地未发现', installedPaths: [] };
  const installedPaths = found.map(item => item.target);
  const where = found.map(f => f.root).join(' + ');
  // Both tiers may exist even when a later index build would reject the duplicate.
  // A matching first copy must never hide edits in the other installed copy.
  const comparisons = found.map(f => ({ ...f, cmp: compareWithPackage(e, root, f.target) }));
  const changed = comparisons.find(f => f.cmp?.differs);
  if (changed) {
    return { present: true, differs: true, installedPaths, label: `本地文件已存在（${where}；内容与包内不同：${changed.root}/${changed.cmp.file || name}，可更新或本地已改，需比对）` };
  }
  if (comparisons.every(f => f.cmp)) return { present: true, differs: false, installedPaths, label: `本地文件已存在（${where}；与包内一致，未验装载）` };
  return { present: true, differs: null, installedPaths, label: `本地文件已存在（${where}；包内来源不可比对，未验装载）` };
}

function needsAsk(e, presence) {
  return e.status === 'shipped' && (presence.present === false || presence.differs === true);
}

function formatEntry(e, catalogFile = '', presence = localPresence(e, catalogFile ? path.dirname(catalogFile) : '')) {
  const BADGE = { shipped: '随包', external: '外部', disabled: '来源已停用', template: '模板', recommended: '推荐', optional: '可选', 'on-demand': '按需', bundled: '随客户端' };
  const badge = BADGE[e.status] || e.status;
  const installer = path.join(QODER, 'scripts', 'pkg-catalog.cjs');
  const catalogArg = catalogFile ? ' --catalog ' + JSON.stringify(catalogFile) : '';
  const lines = [`${e.id}  [${e.category}/${badge}]  ${e.name}`, '  ' + presence.label];
  if (e.description) lines.push('  ' + e.description.slice(0, 140));
  if (e.install && e.install.command && (presence.present !== true || presence.differs === true)) lines.push('  ' + e.install.command);
  if (e.status === 'shipped' && presence.present === false) {
    lines.push(`  安装预演：node ${JSON.stringify(installer)} install ${JSON.stringify(e.id)}${catalogArg}`);
  } else if (e.status === 'shipped' && presence.differs === true) {
    lines.push(`  更新预演（覆盖前先三路比对并备份）：node ${JSON.stringify(installer)} install ${JSON.stringify(e.id)} --force${catalogArg}`);
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
  const root = path.dirname(file);
  console.log(`命中 ${hits.length} 条（按相关度排序）：`);
  let ask = 0;
  for (const h of hits) {
    const presence = localPresence(h.e, root);
    console.log(formatEntry(h.e, file, presence));
    if (needsAsk(h.e, presence)) ask++;
  }
  if (ask) console.log(`\nNEXT_ACTION: ASK_INSTALL_OR_UPDATE — ${ask} 条可安装或可更新；必须用 AskUserQuestion 询问用户，未获明确选择不得执行安装或更新。`);
}

function cmdShow() {
  const { entries } = loadCatalog();
  if (!value) fail(2, '用法：pkg-catalog.cjs show <id|名称>');
  const e = findEntry(entries, value);
  if (!e) fail(2, `没有条目「${value}」`);
  console.log(JSON.stringify(e, null, 2));
}

function cmdList() {
  const { file, entries } = loadCatalog();
  const root = path.dirname(file);
  const rows = CATEGORY ? entries.filter((e) => e.category === CATEGORY) : entries;
  const by = {};
  for (const e of rows) by[e.category] = (by[e.category] || 0) + 1;
  console.log(`共 ${rows.length} 条：` + Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' / '));
  for (const e of rows) {
    const presence = localPresence(e, root);
    const tag = needsAsk(e, presence) ? (presence.present === false ? '  [可安装]' : '  [可更新]') : '';
    console.log(`- ${e.id}  [包标记:${e.status}]  ${e.name}  ${presence.label}${tag}`);
  }
}

function cmdDrift() {
  const { file, entries } = loadCatalog();
  const root = path.dirname(file);
  const rows = [], unknown = [];
  for (const e of entries) {
    const presence = localPresence(e, root);
    if (e.status === 'shipped' && presence.present === true && presence.differs === true) rows.push({ e, presence });
    if (e.status === 'shipped' && presence.present === true && presence.differs === null) unknown.push({ e, presence });
  }
  if (unknown.length) {
    console.log(`DRIFT_UNVERIFIED ${unknown.length} 条已安装内容无法完成包内比对：`);
    for (const { e, presence } of unknown) console.log(`- ${e.id}  ${presence.label}`);
    process.exitCode = 2;
  }
  if (!rows.length && !unknown.length) {
    console.log('DRIFT_NONE 已安装的随包条目与包内内容一致（未验装载；第三方依赖与运行期状态另查）。');
    return;
  }
  if (!rows.length) return;
  console.log(`DRIFT ${rows.length} 条已安装但与包内不同（可更新或本地已改）：`);
  for (const { e, presence } of rows) console.log(`- ${e.id}  ${e.name}\n  ${presence.label}`);
  console.log('\nNEXT_ACTION: ASK_UPDATE — 必须用 AskUserQuestion 逐条询问是否更新；更新前三路比对并备份，未获明确选择不得 --force 覆盖。');
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

function rebuildIndex(output) {
  const script = path.join(QODER, 'scripts', 'build-skills-index.cjs');
  if (!fs.existsSync(script)) return '索引未重建（build-skills-index.cjs 不在 ~/.qoder/scripts）';
  // The builder exports a read-only collector. Invoke that API in a child so a
  // failed/older builder cannot commit an index that the installer cannot own.
  const runner = "const fs=require('fs'),builder=require(process.argv[1]);" +
    "if(typeof builder.collectSkills!=='function')throw new Error('builder lacks collectSkills');" +
    "const entries=builder.collectSkills();if(!Array.isArray(entries))throw new Error('invalid skill index entries');" +
    "fs.writeFileSync(process.argv[2],JSON.stringify({generated_at:new Date().toISOString(),count:entries.length,entries},null,1),{flag:'wx'});";
  const r = spawnSync(process.execPath, ['-e', runner, script, output], { encoding: 'utf8', timeout: 60000, env: { ...process.env, QODER_HOME: QODER } });
  if (r.status !== 0) throw new Error(`索引重建失败（exit=${r.status}）：${(r.stderr || '').slice(0, 200)}`);
  if (!fs.existsSync(output) || !fs.lstatSync(output).isFile() || fs.lstatSync(output).isSymbolicLink()) throw new Error('索引重建未生成可提交的普通文件');
  const index = readJson(output);
  if (!Array.isArray(index.entries) || index.count !== index.entries.length) throw new Error('重建的技能索引格式无效');
  return '索引已重建';
}

function promptResidentTier(entry) {
  process.stdout.write(`「${entry.name}」是否设为常驻？常驻技能描述每轮注入、占上下文；按需库只在 skill-load 命中后读取。[y/N] `);
  const buf = Buffer.alloc(256);
  let text = '';
  try {
    while (!text.includes('\n')) {
      const read = fs.readSync(0, buf, 0, buf.length, null);
      if (!read) break;
      text += buf.toString('utf8', 0, read);
    }
  } catch {}
  const resident = /^(?:y|yes|是|同意)$/i.test(text.trim());
  console.log(resident ? '→ 常驻（core）' : '→ 按需（library，默认）');
  return resident ? 'core' : 'library';
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
  // Resident count is a per-user choice, not a package constant: ask only for
  // the skill actually selected, once, and only in a real interactive apply.
  if (APPLY && !TIER && e.category === 'skill' && !NON_INTERACTIVE && process.stdin.isTTY && process.stdout.isTTY) {
    TIER = promptResidentTier(e);
  }
  const assertNoLinks = (file, skipModules = false) => {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) fail(2, '安装路径不能含符号链接');
    if (st.isDirectory()) for (const name of fs.readdirSync(file)) {
      // Excluded modules are never copied, and reused dependencies are not modified.
      if (skipModules && name === 'node_modules') continue;
      assertNoLinks(path.join(file, name), skipModules);
    }
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
    const directoryScript = entry.category === 'script' && entry.install?.mode === 'copy-directory';
    assertNoLinks(src, directoryScript);
    if (directoryScript) {
      if (!fs.statSync(src).isDirectory()) fail(2, '目录脚本源类型无效');
      scriptDirectoryFiles(root, expected);
    } else if (entry.category === 'skill' ? !fs.statSync(src).isDirectory() || !fs.existsSync(path.join(src, 'SKILL.md')) || !fs.statSync(path.join(src, 'SKILL.md')).isFile() : !fs.statSync(src).isFile()) fail(2, '条目源类型或入口无效');
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
      assertNoLinks(t.target, directoryScript && entry !== e);
      if (entry === e && !FORCE) fail(1, `目标已存在：${t.target}（确需覆盖加 --force）`);
      if (entry !== e) {
        if (directoryScript) scriptDirectoryFiles(path.dirname(t.target), path.basename(t.target));
        visiting.delete(entry.id); visited.add(entry.id); return;
      }
    }
    const previous = fs.existsSync(t.target);
    plan.push({ entry, src, target: t.target, previous, before: previous ? fingerprint(t.target) : null, owned: [], originalMoved: false });
    visiting.delete(entry.id); visited.add(entry.id);
  };
  visit(e);
  for (const item of plan) console.log(`[${APPLY ? '安装' : '预演'}] ${item.entry.id} → ${item.target}`);
  if (e.category === 'skill' && !TIER) console.log('  技能默认进按需库；交互执行 --apply 时会询问是否常驻，非交互请显式 --tier core|library。');
  if (!APPLY) { console.log('  未写盘；确认后加 --apply。'); return; }
  fs.mkdirSync(QODER, { recursive: true });
  const stage = fs.mkdtempSync(path.join(QODER, '.pkg-install-'));
  const indexPath = path.join(QODER, 'skills-index.json');
  const indexBackup = path.join(stage, 'old-index.json');
  const stagedIndex = path.join(stage, 'new-index.json');
  const indexSnapshot = file => {
    let st;
    try { st = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('技能索引不是普通文件，拒绝修改');
    return { ino: st.ino, dev: st.dev, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  };
  const sameIndex = (a, b) => !a || !b ? a === b : a.ino === b.ino && a.dev === b.dev && a.hash === b.hash;
  const applied = [];
  const rebuildSkills = plan.some(item => item.entry.category === 'skill');
  let restored = false, indexBefore, indexMoved = false;
  const indexOwned = [];
  try {
    if (rebuildSkills) indexBefore = indexSnapshot(indexPath);
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      item.staged = path.join(stage, 'new-' + i);
      item.backup = path.join(stage, 'old-' + i);
      fs.cpSync(item.src, item.staged, { recursive: true, force: false, errorOnExist: true,
        filter: file => isPublicFile(path.relative(root, file).split(path.sep).join('/')) });
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
    if (rebuildSkills) {
      const message = rebuildIndex(stagedIndex);
      if (fs.existsSync(stagedIndex)) {
        if (!sameIndex(indexSnapshot(indexPath), indexBefore)) throw new Error('技能索引在安装期间已变化，保留其他写入者的内容');
        if (indexBefore) {
          fs.renameSync(indexPath, indexBackup);
          indexMoved = true;
          // A writer may have changed the path between comparison and rename.
          // Keep the actual moved file so rollback restores those newer bytes.
          if (!sameIndex(indexSnapshot(indexBackup), indexBefore)) throw new Error('技能索引在提交时已变化，保留实际移入备份的内容');
        }
        // Exclusive creation protects a concurrently recreated index path.
        copyExclusive(stagedIndex, indexPath, indexOwned);
      }
      console.log('  ' + message);
    }
    console.log('  已安装全部包内依赖并通过入口校验；第三方依赖与现役装载未验证。');
    for (const item of plan) if (fs.statSync(item.target).isDirectory() && fs.existsSync(path.join(item.target, 'package-lock.json'))) {
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
      if (indexOwned.length) {
        const owned = indexOwned[0];
        let current;
        try { current = indexSnapshot(indexPath); } catch { conflict = true; }
        if (current) {
          if (sameIndex(current, owned)) fs.unlinkSync(indexPath);
          else conflict = true;
        }
      }
      if (indexMoved) {
        // Linking is exclusive: restoring a backup must never replace a path
        // created by another writer while skill-file rollback was running.
        try { fs.linkSync(indexBackup, indexPath); }
        catch (restoreError) { if (restoreError.code === 'EEXIST') conflict = true; else throw restoreError; }
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
  '用法：pkg-catalog.cjs <search|show|list|drift|install|register> ...',
  '  search <关键词>                 检索包内与外部可装内容（可安装/可更新时输出 NEXT_ACTION）',
  '  show <id>                       查看条目详情',
  '  list [--category skill]         列出全部条目',
  '  drift                           列出已安装但与包内内容不同的随包条目',
  '  install <id> [--apply]          安装随包条目（默认 dry-run；技能默认入按需库，交互 --apply 会询问是否常驻，非交互用 --tier core|library）',
  '  register [<包目录>]             登记分享包位置（供 skill-load 兜底检索）',
].join('\n'));

module.exports = { resolveCatalog, readCatalog, searchEntries, formatEntry, localPresence, needsAsk, compareWithPackage };
if (require.main === module) {
  try {
    validateArgs();
    switch (CMD) {
      case 'search': cmdSearch(); break;
      case 'show': cmdShow(); break;
      case 'list': cmdList(); break;
      case 'drift': cmdDrift(); break;
      case 'install': cmdInstall(); break;
      case 'register': cmdRegister(); break;
      default: usage(); process.exitCode = 2;
    }
  } catch (error) {
    console.error('CATALOG_ERROR: ' + error.message);
    process.exitCode = 2;
  }
}
