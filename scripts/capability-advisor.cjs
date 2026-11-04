#!/usr/bin/env node
// 能力规划：只读核对已装与缺失、可信旧包更新、通用/明确偏好筛选和任务使用询问。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readCatalog, localPresence } = require('./pkg-catalog.cjs');
const { collectSkills } = require('./build-skills-index.cjs');
const { clientRoot: resolveClientRoot } = require('./client-root.js');

const ACTIONS = ['UPDATE', 'REVIEW_UPDATE', 'ASK_INSTALL', 'ASK_USE', 'AUTO_USE', 'AUTO_LOAD', 'KEEP', 'SKIP'];
const GENERIC = new Set([
  'skill:parallel-orchestration', 'skill:office-docs', 'skill:write-repowiki',
  'skill:counterexample-driven-plan-review', 'skill:rules-conflict-audit',
  'script:rules-reminder.js', 'script:capability-advisor.cjs', 'script:pkg-catalog.cjs',
  'script:skill-load.cjs', 'script:build-skills-index.cjs',
]);
// 已安装且命中即自动加载并执行判定的能力；派发仍由技能自身的计划确认把关。
const AUTO_USE_IDS = new Set(['skill:parallel-orchestration']);
// Curated phrases route tasks; a whole natural-language request is never an AND query.
// Each alternative is an AND group; alternatives are ORed. More specific groups win.
const ROUTES = {
  'safe-text-editing': [['修改文本'], ['编辑文件'], ['替换文本'], ['修改文件'], ['修改', '文本'], ['修改', '文档'], ['text', 'edit']],
  'structured-edit-safety': [['结构化编辑'], ['批量替换'], ['apply_patch'], ['patch']],
  'verify-before-claim': [['验证'], ['验收'], ['回归'], ['测试'], ['verify'], ['test']],
  'verify-ui-in-browser': [['浏览器'], ['页面'], ['界面'], ['playwright'], ['browser'], ['ui']],
  'ship-clean-pr': [['提交'], ['推送'], ['pull request'], ['pr'], ['commit']],
  'continuation-state-audit': [['接续'], ['继续任务'], ['恢复进度'], ['压缩'], ['continuation']],
  'concurrent-edit-attribution-check': [['同一文件'], ['多人编辑'], ['并发编辑'], ['并行会话'], ['共享工作区'], ['concurrent']],
  'parallel-orchestration': [['并行'], ['多 agent'], ['多agent'], ['parallel'], ['worktree'], ['多模块'], ['多个模块'], ['跨模块'], ['多文件'], ['任务拆分'], ['模块拆分'], ['独立模块'], ['依赖图'], ['拆分', '模块'], ['同时', '处理'], ['同时', '做'], ['一起', '做'], ['分工'], ['并发'], ['子代理'], ['subagent'], ['前后端']],
  'vibe-coding-workflow': [['实现功能'], ['开发功能'], ['vibecoding'], ['vibe coding']],
  'vibecoding-doc': [['需求文档'], ['任务文档'], ['开发方案'], ['spec']],
  'goal-driven-execution': [['目标模式'], ['goal mode']],
  'self-evolution': [['记住'], ['长期偏好'], ['经验沉淀'], ['自进化']],
  'skills-router': [['技能'], ['skill'], ['能力目录']],
  'office-docs': [['word'], ['excel'], ['ppt'], ['docx'], ['xlsx'], ['表格'], ['文档排版']],
  'write-repowiki': [['wiki'], ['仓库文档']],
  'kafka-best-practices': [['kafka']], 'rabbitmq-expert': [['rabbitmq']],
  'mysql': [['mysql']], 'oracledb': [['oracle']],
  'postgresql-optimization': [['postgresql', '优化'], ['postgres', 'performance']],
  'postgresql-table-design': [['postgresql', '表'], ['postgres', 'schema']],
  'redis-core': [['redis']], 'redis-connections': [['redis', '连接'], ['redis', 'connection']],
  'redis-security': [['redis', '安全'], ['redis', 'security']],
  'redis-observability': [['redis', '性能'], ['redis', '排查'], ['redis', 'monitor']],
  'redis-clustering': [['redis', '集群'], ['redis', 'cluster']],
  'java-quality': [['java', '质量'], ['java', '审查']], 'java-architect': [['java', '架构']],
  'local-spring-mybatis': [['spring'], ['mybatis']], 'springboot-patterns': [['spring boot']],
  'local-rust-engineering': [['rust'], ['cargo']], 'python-programmer': [['python']],
  'python-testing-patterns': [['python', '测试'], ['pytest']],
  'vue-expert': [['vue']], 'typescript-pro': [['typescript']],
  'frontend-development': [['前端'], ['frontend']], 'local-browser-e2e': [['e2e'], ['playwright']],
  'local-api-contracts': [['api', '契约'], ['rest', '分页']],
  'local-db-migrations': [['数据库迁移'], ['schema', 'migration']],
  'local-performance-evidence': [['性能优化'], ['性能', '基线']],
  'share-package-release': [['分享包', '发布'], ['release', 'package']],
};

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function text(value) { return typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''; }
function escaped(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function termMatches(haystack, term) {
  const needle = text(term).trim(), hay = text(haystack);
  if (!needle) return false;
  if (/[a-z0-9]/.test(needle[0]) || /[a-z0-9]/.test(needle.at(-1))) {
    return new RegExp((/^[a-z0-9]/.test(needle) ? '(?<![a-z0-9_])' : '') + escaped(needle) + (/[a-z0-9]$/.test(needle) ? '(?![a-z0-9_])' : ''), 'i').test(hay);
  }
  return hay.includes(needle);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function loadPreferences(client, supplied) {
  let raw = supplied;
  if (raw === undefined) {
    try { raw = readJson(path.join(client, 'capability-preferences.json')); }
    catch (error) { if (error.code !== 'ENOENT') fail('INVALID_PREFERENCES', 'capability preferences could not be read'); }
  }
  if (raw === undefined) raw = { schema: 1 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1 || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')) fail('INVALID_PREFERENCES', 'preferences must use schema 1 and a boolean enabled field');
  const result = { schema: 1, enabled: raw.enabled !== false };
  for (const key of ['preferredIds', 'excludedIds', 'preferredKeywords', 'excludedKeywords']) {
    const values = raw[key] === undefined ? [] : raw[key];
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) fail('INVALID_PREFERENCES', 'preferences ' + key + ' must be an array of non-empty strings');
    result[key] = [...new Set(values.map(value => text(value).trim()))];
  }
  return result;
}

function intentFor(prompt, entry) {
  const names = [entry.id, entry.name];
  let intent = null;
  const clauses = String(prompt).replace(/```[\s\S]*?```/g, '').split(/[。！!；;\n，,]/);
  for (const clause of clauses) for (const name of names) {
    const match = new RegExp(escaped(name), 'i').exec(clause);
    if (!match || !termMatches(clause, name)) continue;
    const before = clause.slice(0, match.index).trim();
    const after = clause.slice(match.index + name.length).trim().replace(/^[`"'”’」』]+/, '');
    if (/如何|怎么|是否|合适|应该|\?|？|\b(?:how|whether|should)\b/i.test(after)) continue;
    if (/^(?:(?:请|帮我|请帮我|现在)\s*|please\s+)*(?:不要|别|不用|无需|不必|不需要|do not|don't|avoid)\s*(?:使用|用|调用|启用|加载|安装|use|load|install)?\s*(?:技能|skill)?\s*[`"'“‘「『]?$/i.test(before)) intent = 'decline';
    else {
      const use = /^(?:(?:请|帮我|请帮我|并|然后|同时|现在|直接)\s*|please\s+)*(使用|调用|启用|加载|安装|use|load|install)\s*(?:技能\s*|skill\s+)?[`"'“‘「『]?$/i.exec(before);
      if (use) intent = /安装|install/i.test(use[1]) ? 'install' : 'use';
    }
  }
  return intent;
}

function taskRouteText(prompt) {
  return String(prompt).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
    .replace(/“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/g, ' ').replace(/"[^"\n]*"|'[^'\n]*'/g, ' ');
}
function discussionOnly(prompt) {
  const value = prompt.trim();
  return /^(?:请\s*)?(?:解释|介绍|什么是|如何|怎么|请问)|^(?:what|how|explain|describe|is|are|was|were|has|have)\b/i.test(value)
    || /(?:是什么|什么意思|是否合适|是否应该|是否已经|是否已安装|安装了?吗|启用了?吗|怎么样)[？?\s]*$/.test(value);
}

function routeScore(entry, prompt) {
  if (termMatches(prompt, entry.id) || termMatches(prompt, entry.name)) return 100;
  let score = 0;
  for (const words of ROUTES[entry.name] || []) if (words.every(word => termMatches(prompt, word))) score = Math.max(score, 10 + words.length * 5 + words.reduce((sum, word) => sum + word.length, 0));
  return score;
}

// 现场扫描两层技能：索引是派生快照，可能落后；发现必须跟随调用方绑定的客户端。
function localSkillEntries(clientDir, catalog) {
  const entries = collectSkills(clientDir);
  const catalogNames = new Set(catalog.entries.map(entry => String(entry.name).toLowerCase()));
  const seen = new Set();
  return entries.filter(entry => {
    if (!entry || typeof entry.name !== 'string' || entry.tier !== 'library') return false;
    if (catalogNames.has(entry.name.toLowerCase())) return false;
    if (typeof entry.path !== 'string' || !fs.existsSync(entry.path)) return false;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function triggerWords(description) {
  const match = /触发词[:：]\s*([^。\n]+)/.exec(String(description || ''));
  if (!match) return [];
  return match[1].split(/[、,，/|]+/).map(word => word.trim()).filter(word => word.length >= 2 && word.length <= 20);
}

function localSkillScore(entry, prompt) {
  let score = 0;
  const first = String(entry.name).split('-')[0];
  if (first.length >= 4 && termMatches(prompt, first)) score = 100;
  for (const word of triggerWords(entry.description)) {
    if (termMatches(prompt, word)) score = Math.max(score, 20);
  }
  return score;
}

function excludedLocalSkill(entry, prefs) {
  if (prefs.excludedIds.includes('skill:' + entry.name)) return true;
  const metadata = entry.name + ' ' + (entry.description || '');
  return prefs.excludedKeywords.some(keyword => termMatches(metadata, keyword));
}
function expectedSource(entry) {
  if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/:\x00-\x1f]/.test(entry.name)) return null;
  return ({ skill: 'skills/' + entry.name, script: 'scripts/' + entry.name, command: 'commands/' + entry.name + '.md', agent: 'agents/' + entry.name + '.md' })[entry.category] || null;
}
function sourcePath(entry, root) {
  const expected = expectedSource(entry);
  if (!expected || entry.source !== expected || entry.status !== 'shipped') return null;
  const base = path.resolve(root), target = path.resolve(base, expected);
  try {
    let current = base;
    for (const part of expected.split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) return null; }
    const relative = path.relative(fs.realpathSync(base), fs.realpathSync(target));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
    return target;
  } catch { return null; }
}

function treeDigest(target) {
  const hash = crypto.createHash('sha256');
  const visit = (file, relative) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('non-ordinary installed content');
    hash.update(JSON.stringify([relative, stat.isDirectory() ? 'directory' : 'file']) + '\n');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative + '/' + name);
    else { const bytes = fs.readFileSync(file); hash.update(String(bytes.length) + ':'); hash.update(bytes); }
  };
  visit(target, ''); return hash.digest('hex');
}
function ordinaryWithin(client, target, directory = false) {
  try {
    const base = path.resolve(client), file = path.resolve(target), relative = path.relative(base, file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
    const rootStat = fs.lstatSync(base);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    let current = base;
    for (const part of relative.split(path.sep)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) return false; }
    const stat = fs.lstatSync(file), realRelative = path.relative(fs.realpathSync(base), fs.realpathSync(file));
    if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative) || (directory ? !stat.isDirectory() : !stat.isFile())) return false;
    fs.accessSync(file, fs.constants.R_OK); return true;
  } catch { return false; }
}
function previousCatalog(client, explicit) {
  let file = explicit;
  if (file === undefined) {
    try { const pointer = readJson(path.join(client, 'share-package.json')); if (typeof pointer.catalog === 'string' && pointer.catalog.trim()) file = path.resolve(client, pointer.catalog); }
    catch { /* An unavailable old source is not an automatic-update baseline. */ }
  }
  if (typeof file !== 'string' || !file.trim()) return { file: null, catalog: null };
  try { return { file: path.resolve(file), catalog: readCatalog(path.resolve(file)) }; }
  catch { return { file: path.resolve(file), catalog: null }; }
}
function baselineFor(entry, paths, previous, client) {
  const baseline = { verified: false, catalogFile: previous.file, reason: 'PREVIOUS_SOURCE_UNAVAILABLE' };
  if (!previous.catalog || !paths.length) return baseline;
  const matches = previous.catalog.entries.filter(old => old.id === entry.id && old.name === entry.name && old.category === entry.category && old.source === entry.source && old.install?.mode === entry.install?.mode);
  if (matches.length !== 1) return { ...baseline, reason: 'PREVIOUS_ENTRY_UNAVAILABLE' };
  const source = sourcePath(matches[0], path.dirname(previous.file));
  if (!source) return baseline;
  try {
    const directory = entry.category === 'skill' || (entry.category === 'script' && entry.install?.mode === 'copy-directory');
    if (paths.some(target => !ordinaryWithin(client, target, directory))) return { ...baseline, reason: 'LOCAL_CONTENT_UNVERIFIABLE' };
    const sourceDigest = treeDigest(source), targets = paths.map(file => ({ path: file, digest: treeDigest(file) }));
    if (targets.some(target => target.digest !== sourceDigest)) return { ...baseline, reason: 'LOCAL_CHANGES_OR_EXTRA_FILES' };
    return { ...baseline, verified: true, reason: 'PRISTINE_PREVIOUS_SOURCE', sourceDigest, targets };
  } catch { return { ...baseline, reason: 'LOCAL_CONTENT_UNVERIFIABLE' }; }
}

function planCapabilities(options = {}) {
  const { catalogFile, clientRoot: client, prompt = '', phase = 'task' } = options;
  if (!['task', 'install'].includes(phase)) fail('USAGE', 'phase must be task or install');
  if (typeof client !== 'string' || !client.trim()) fail('USAGE', 'clientRoot must be an explicit non-empty path');
  if (typeof prompt !== 'string') fail('USAGE', 'prompt must be text');
  const clientDir = path.resolve(client);
  // 包只负责包内候选与维护；包不可用不得阻断本地按需库发现。
  const hasCatalog = typeof catalogFile === 'string' && Boolean(catalogFile.trim()) && fs.existsSync(catalogFile);
  const file = hasCatalog ? path.resolve(catalogFile) : null;
  const root = file ? path.dirname(file) : '';
  const catalog = hasCatalog ? readCatalog(file) : { schema: 1, entries: [] };
  if (new Set(catalog.entries.map(entry => entry.id)).size !== catalog.entries.length) fail('INVALID_CATALOG', 'duplicate catalog capability IDs');
  const prefs = loadPreferences(clientDir, options.preferences), previous = previousCatalog(clientDir, options.previousCatalogFile);
  const routeText = taskRouteText(prompt), discussion = discussionOnly(routeText);
  const planned = [];
  if (hasCatalog) catalog.entries.forEach((entry, index) => {
    const intent = intentFor(prompt, entry), requested = intent === 'use' || intent === 'install';
    const score = phase === 'task' ? routeScore(entry, routeText) : 0;
    if (phase === 'task' && !score && !requested) return;
    const metadata = [entry.id, entry.name, entry.description || ''].join(' ');
    const preferred = prefs.preferredIds.includes(text(entry.id)) || prefs.preferredKeywords.some(keyword => termMatches(metadata, keyword));
    const excluded = prefs.excludedIds.includes(text(entry.id)) || prefs.excludedKeywords.some(keyword => termMatches(metadata, keyword));
    const generic = entry.tier === 'core' || entry.install?.tier === 'core' || GENERIC.has(entry.id);
    const presence = localPresence(entry, root, clientDir), installedPaths = presence.installedPaths || [];
    const installedPath = installedPaths[0] || null;
    const output = {
      id: entry.id, name: entry.name, category: entry.category, action: 'SKIP', reason: 'NOT_APPLICABLE',
      entry, present: presence.present, differs: presence.differs, installedPaths, installedPath,
      entryPath: installedPath ? (entry.category === 'skill' ? path.join(installedPath, 'SKILL.md') : installedPath) : null,
      generic, preferred, matched: score > 0, requested, authorized: false, autoUpdate: false,
      maintenanceNeeded: presence.present === true && presence.differs !== false,
      baseline: { verified: false, catalogFile: previous.file, reason: 'NOT_NEEDED' },
    };
    const decide = (action, reason) => Object.assign(output, { action, reason });
    if (intent === 'decline') decide('SKIP', 'CURRENT_REQUEST_DECLINED');
    else if (phase === 'task' && discussion && !requested) decide('SKIP', 'CAPABILITY_DISCUSSION_ONLY');
    else if (!requested && (!prefs.enabled || excluded)) decide('SKIP', !prefs.enabled ? 'PREFERENCES_DISABLED' : 'EXPLICIT_PREFERENCE_EXCLUSION');
    else if (!sourcePath(entry, root)) decide('SKIP', ['plugin', 'mcp'].includes(entry.category) ? 'PLATFORM_STATE_UNVERIFIED' : 'PACKAGE_SOURCE_UNAVAILABLE');
    else if (installedPaths.length > 1) decide('REVIEW_UPDATE', 'AMBIGUOUS_INSTALLED_TIERS');
    else if (presence.present === true) {
      if (phase === 'task' && intent === 'use' && ordinaryWithin(clientDir, output.entryPath)) { decide('KEEP', 'EXPLICIT_USE_REQUEST'); output.authorized = true; }
      else if (presence.differs !== false) {
        output.baseline = baselineFor(entry, installedPaths, previous, clientDir);
        if (presence.differs === true && output.baseline.verified) { decide('UPDATE', 'PRISTINE_PREVIOUS_SOURCE'); output.autoUpdate = true; }
        else decide('REVIEW_UPDATE', output.baseline.reason);
      } else if (phase === 'task' && intent === 'use') decide('REVIEW_UPDATE', 'LOCAL_ENTRY_UNVERIFIABLE');
      else if (phase === 'task' && intent !== 'install') decide(AUTO_USE_IDS.has(entry.id) ? 'AUTO_USE' : 'ASK_USE', AUTO_USE_IDS.has(entry.id) ? 'AUTO_TRIGGERED_INSTALLED_CAPABILITY' : 'RELEVANT_INSTALLED_CAPABILITY');
      else decide('KEEP', 'ALREADY_CURRENT');
    } else if (presence.present === false && (generic || preferred || requested)) decide('ASK_INSTALL', requested ? 'CURRENT_EXPLICIT_REQUEST' : preferred ? 'PREFERRED_MISSING_CAPABILITY' : 'GENERIC_MISSING_CAPABILITY');
    else decide('SKIP', presence.present === false ? 'SPECIALIZED_NOT_PREFERRED' : 'LOCAL_STATE_UNVERIFIED');
    output.requiresConfirmation = ['ASK_INSTALL', 'ASK_USE', 'REVIEW_UPDATE'].includes(output.action) || (phase === 'task' && output.action === 'UPDATE');
    planned.push({ output, score: score + (requested ? 1000 : 0) + (preferred ? 3 : 0), index });
  });
  if (phase === 'task' && !discussion && prefs.enabled) {
    // 本地候选与包候选共同筛选：领域技能不再被通用候选挤掉；当前拒绝与点名使用同路处理。
    const local = localSkillEntries(clientDir, catalog)
      .map(entry => ({ entry, intent: intentFor(prompt, { id: 'skill:' + entry.name, name: entry.name }) }))
      .filter(({ entry, intent }) => intent !== 'decline' && (intent === 'use' || !excludedLocalSkill(entry, prefs)))
      .map(({ entry, intent }) => ({ entry, intent, score: localSkillScore(entry, routeText) }))
      .filter(item => item.intent === 'use' || item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, 1);
    for (const { entry, intent, score } of local) {
      const installedPath = path.dirname(entry.path);
      const authorized = intent === 'use';
      planned.push({
        output: {
          id: 'skill:' + entry.name, name: entry.name, category: 'skill',
          action: authorized ? 'KEEP' : 'AUTO_LOAD',
          reason: authorized ? 'EXPLICIT_USE_REQUEST' : 'RELEVANT_LOCAL_LIBRARY_SKILL',
          entry: null, present: true, differs: false,
          installedPaths: [installedPath], installedPath, entryPath: path.resolve(entry.path),
          generic: false, preferred: false, matched: true, requested: authorized, authorized,
          autoUpdate: false, maintenanceNeeded: false,
          baseline: { verified: false, catalogFile: previous.file, reason: 'NOT_NEEDED' },
          requiresConfirmation: false, local: true,
        },
        score: score + (authorized ? 1000 : 1),
        index: catalog.entries.length,
      });
    }
  }
  if (phase === 'task') planned.sort((a, b) => (a.output.action === 'SKIP') - (b.output.action === 'SKIP') || b.score - a.score || a.index - b.index);
  const items = (phase === 'task' ? planned.slice(0, 3) : planned).map(item => item.output);
  return { schema: 1, items, summary: { phase, reason: hasCatalog ? 'OK' : 'LOCAL_DISCOVERY_ONLY', total: items.length, considered: catalog.entries.length, omitted: planned.length - items.length, counts: Object.fromEntries(ACTIONS.map(action => [action, items.filter(item => item.action === action).length])), requiresConfirmation: items.filter(item => item.requiresConfirmation).length } };
}

function parseArgs(argv) {
  const values = {}, seen = new Set(), allowed = new Set(['catalog', 'client-root', 'phase', 'prompt', 'preferences', 'previous-catalog', 'json']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], key = arg.startsWith('--') ? arg.slice(2) : '';
    if (!allowed.has(key) || seen.has(key)) fail('USAGE', 'unknown or repeated argument: ' + arg);
    seen.add(key);
    if (key === 'json') values.json = true;
    else { const next = argv[++i]; if (typeof next !== 'string' || !next.trim() || next.startsWith('--')) fail('USAGE', 'missing value for ' + arg); values[key] = next; }
  }
  return values;
}
function main(argv) {
  const json = argv.includes('--json');
  try {
    const args = parseArgs(argv), client = args['client-root'] || resolveClientRoot();
    let catalogFile = args.catalog;
    if (!catalogFile) { try { catalogFile = readJson(path.join(client, 'share-package.json')).catalog; if (typeof catalogFile === 'string') catalogFile = path.resolve(client, catalogFile); } catch {} }
    const result = planCapabilities({ catalogFile, clientRoot: client, phase: args.phase || 'task', prompt: args.prompt || '', preferences: args.preferences ? readJson(args.preferences) : undefined, previousCatalogFile: args['previous-catalog'] });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const item of result.items) console.log(item.action + ' ' + item.id + ' — ' + item.reason + (item.entryPath ? '\n  ' + item.entryPath : ''));
      if (!result.items.length) console.log(result.summary.reason);
      if (result.items.some(item => item.action === 'ASK_USE')) console.log('NEXT_ACTION: ASK_USE — 询问是否使用已安装的相关能力；未确认不自动执行。');
      if (result.items.some(item => item.action === 'AUTO_USE')) console.log('NEXT_ACTION: AUTO_USE — 自动加载已安装能力并执行判定；派发前仍须计划确认。');
      if (result.items.some(item => item.action === 'ASK_INSTALL')) console.log('NEXT_ACTION: ASK_INSTALL — 询问是否安装缺失的通用或已选能力；不自动安装。');
      if (result.items.some(item => item.action === 'REVIEW_UPDATE' || (result.summary.phase === 'task' && item.action === 'UPDATE'))) console.log('NEXT_ACTION: ASK_UPDATE — 核对差异并询问更新选择；保留本地修改。');
    }
  } catch (error) {
    const code = error.code || 'CAPABILITY_ERROR';
    if (json) console.log(JSON.stringify({ schema: 1, ok: false, code, message: error.message }));
    else console.error(code + ': ' + error.message);
    process.exitCode = ['USAGE', 'INVALID_PREFERENCES', 'INVALID_CATALOG'].includes(code) ? 2 : 1;
  }
}

module.exports = { planCapabilities };
if (require.main === module) main(process.argv.slice(2));
