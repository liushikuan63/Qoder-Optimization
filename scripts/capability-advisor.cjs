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
// 使用类动作先占位，维护类（更新/审查差异）只在名额有余时补充，不能把任务建议挤掉。
const ACTION_RANK = { AUTO_USE: 5, ASK_USE: 4, AUTO_LOAD: 4, KEEP: 3, ASK_INSTALL: 2, UPDATE: 1, REVIEW_UPDATE: 1, SKIP: 0 };
const skillDescriptionCache = new Map();
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
  'continuation-state-audit': [['接续'], ['继续任务'], ['恢复进度'], ['压缩'], ['continuation'], ['上次', '做完'], ['上次', '完成'], ['交付', '复核']],
  'concurrent-edit-attribution-check': [['同一文件'], ['多人编辑'], ['并发编辑'], ['并行会话'], ['共享工作区'], ['concurrent']],
  'parallel-orchestration': [['并行'], ['多 agent'], ['多agent'], ['parallel'], ['worktree'], ['多模块'], ['多个模块'], ['跨模块'], ['多文件'], ['多个文件'], ['任务拆分'], ['模块拆分'], ['独立模块'], ['依赖图'], ['拆分', '模块'], ['同时', '处理'], ['同时', '做'], ['一起', '做'], ['分工'], ['并发'], ['子代理'], ['subagent'], ['前后端'], ['全项目'], ['整个项目'], ['全仓'], ['全仓库'], ['多个项目'], ['多项目'], ['多个版本'], ['多版本'], ['多个代码库'], ['多代码库'], ['多个服务'], ['多服务'], ['跨服务'], ['多个端'], ['多端'], ['三端'], ['多套'], ['三套'], ['审查', '项目'], ['审阅', '项目'], ['分析', '项目'], ['介绍', '项目'], ['评估', '项目'], ['梳理', '项目'], ['整体', '分析'], ['整体', '审查'], ['项目', '架构'], ['审查', '完整版'], ['审查', 'lite'], ['完整版', 'lite'], ['完整版', 'svn'], ['全部代码']],
  'vibe-coding-workflow': [['实现功能'], ['开发功能'], ['实现', '功能'], ['开发', '功能'], ['vibecoding'], ['vibe coding']],
  'vibecoding-doc': [['需求文档'], ['任务文档'], ['开发方案'], ['spec']],
  'goal-driven-execution': [['目标模式'], ['goal mode'], ['长任务'], ['多步骤'], ['完成判据'], ['持续推进'], ['盯到完成'], ['直到完成']],
  'self-evolution': [['记住'], ['长期偏好'], ['经验沉淀'], ['自进化']],
  'clarify': [['指令不清'], ['需求不清'], ['意图不清'], ['表述不清'], ['需求含糊'], ['表述含糊'], ['提示词纠正'], ['纠正提示词'], ['澄清需求'], ['澄清'], ['说不清'], ['帮我理一下'], ['clarify']],
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
  'local-db-migrations': [['数据库迁移'], ['表结构'], ['加字段'], ['加一个字段'], ['迁移'], ['schema', 'migration']],
  'architecture-designer': [['架构']],
  'local-performance-evidence': [['性能优化'], ['性能', '基线']],
  'share-package-release': [['分享包', '发布'], ['release', 'package']],
};
// 触发词里的泛化动词/名词不能单独把任何技能拉进建议：领域词（技能名、专有名词）才成立。
// 精确路由 ROUTES 仍可用这些词，因为路由是人工逐技能维护的，不跨领域漂移。
const GENERIC_TRIGGER_WORDS = new Set([
  '验证', '测试', '验收', '检查', '排查', '优化', '性能', '性能优化', '页面', '界面', '浏览器', '文档',
  '代码', '文件', '修改', '编辑', '提交', '推送', '审查', '评审', '截图', '配置', '日志', '报错', '异常',
  '问题', '功能', '需求', '任务', '项目', '开发', '实现', '设计', '迁移', '表', '字段', '接口', '服务',
  '模块', '组件', '流程', '规则', '技能', '命令', '工具', '脚本', '方案', '报告', '数据', '数据库', '缓存',
  '连接', '慢查询', '延迟', '超时', '部署', '发布', '上线', '安装', '更新', '对比', '分析', '梳理', '整理',
  '清理', '生成', '运行', '调试', '修复', '重构', '读取', '写入', '操作', '使用',
]);

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
    if (/^(?:(?:请|帮我|请帮我|现在|本次|这次|暂时|先)\s*|please\s+)*(?:不要|别|不用|无需|不必|不需要|do not|don't|avoid)\s*(?:使用|用|调用|启用|加载|安装|use|load|install)?\s*(?:技能|skill)?\s*[`"'“‘「『]?$/i.test(before)) intent = 'decline';
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
  if (/^(?:请\s*)?(?:解释|介绍|什么是|如何|怎么|请问)|^(?:what|how|explain|describe|is|are|was|were|has|have)\b/i.test(value)) return true;
  if (/(?:是什么|什么意思|是否合适|是否应该|是否已经|是否已安装|安装了?吗|启用了?吗|怎么样)[？?\s]*$/.test(value)) return true;
  // 权衡/求解释型但没有任何执行动作时才静默；"要不要……帮我接一下"仍是执行请求。
  const weighing = /(?:要不要|该不该|是否应该|值不值得|先讲|先介绍|讲一下|说说|原理|区别|优缺点|利弊|在考虑|考虑用)/;
  const acting = /(?:帮我|替我|给我|请你|现在|直接|马上|开始|接入|装一下|用起来|跑一下|执行|实现|改成|修复|部署|提交|发布|安装|清理|生成)/;
  return weighing.test(value) && !acting.test(value);
}

function commandDescription(entry, clientDir, bindings) {
  if (entry.category !== 'command') return '';
  try {
    const file = path.join(clientDir, 'commands', entry.name + '.md');
    if (!ordinaryWithin(clientDir, file, false, bindings)) return '';
    const match = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const line = match && match[1].match(/^description:\s*(.+)$/m);
    return line ? line[1] : '';
  } catch {
    return '';
  }
}

function localSkillDescription(entry, clientDir, bindings) {
  for (const tier of ['skills', 'skills-library']) {
    const file = path.join(clientDir, tier, entry.name, 'SKILL.md');
    if (!ordinaryWithin(clientDir, file, false, bindings)) continue;
    try {
      const stat = fs.statSync(file), key = file + ':' + stat.mtimeMs;
      if (skillDescriptionCache.has(key)) return skillDescriptionCache.get(key);
      const match = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const line = match && match[1].match(/^description:\s*(.+)$/m);
      const value = line ? line[1] : '';
      skillDescriptionCache.set(key, value);
      return value;
    } catch {}
  }
  return '';
}

function descriptionTriggerScore(entry, prompt, clientDir, bindings) {
  const local = entry.category === 'command' ? commandDescription(entry, clientDir, bindings)
    : entry.category === 'skill' ? localSkillDescription(entry, clientDir, bindings) : '';
  const words = new Set([...triggerWords(entry.description), ...triggerWords(local)]);
  let strong = false;
  for (const word of words) {
    if (!termMatches(prompt, word) || GENERIC_TRIGGER_WORDS.has(text(word).trim())) continue;
    strong = true;
    break;
  }
  return strong ? (entry.category === 'command' ? 25 : 20) : 0;
}

function routeScore(entry, prompt, clientDir, bindings) {
  if (termMatches(prompt, entry.id) || termMatches(prompt, entry.name)) return 100;
  let score = descriptionTriggerScore(entry, prompt, clientDir, bindings);
  for (const words of ROUTES[entry.name] || []) if (words.every(word => termMatches(prompt, word))) score = Math.max(score, 40 + words.length * 5 + words.reduce((sum, word) => sum + word.length, 0));
  return score;
}

// 现场扫描两层技能：索引是派生快照，可能落后；发现必须跟随调用方绑定的客户端。
function localSkillEntries(clientDir, catalog, bindings) {
  const entries = collectSkills(clientDir, { bindings });
  const catalogNames = new Set(catalog.entries.map(entry => String(entry.name).toLowerCase()));
  const seen = new Set();
  return entries.filter(entry => {
    if (!entry || typeof entry.name !== 'string' || entry.tier !== 'library') return false;
    if (catalogNames.has(entry.name.toLowerCase())) return false;
    if (typeof entry.path !== 'string' || !ordinaryWithin(clientDir, entry.path, false, bindings)) return false;
    const key = entry.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localCommandEntries(clientDir, catalog, bindings) {
  const catalogNames = new Set(catalog.entries.map(entry => String(entry.name).toLowerCase()));
  const dir = path.join(clientDir, 'commands');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const entries = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -3);
    if (catalogNames.has(name.toLowerCase())) continue;
    const target = path.join(dir, file);
    if (!ordinaryWithin(clientDir, target, false, bindings)) continue;
    try {
      const match = fs.readFileSync(target, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const line = match && match[1].match(/^description:\s*(.+)$/m);
      entries.push({ name, category: 'command', path: target, description: line ? line[1] : '' });
    } catch {}
  }
  return entries;
}

function triggerWords(description) {
  const match = /触发词?[:：]\s*([^。\n]+)/.exec(String(description || ''));
  if (!match) return [];
  return match[1].split(/[、,，/|]+/).map(word => word.trim()).filter(word => word.length >= 2 && word.length <= 20);
}

function localSkillScore(entry, prompt) {
  let score = 0;
  const first = String(entry.name).split('-')[0];
  if (first.length >= 4 && termMatches(prompt, first)) score = 100;
  for (const words of ROUTES[entry.name] || []) if (words.every(word => termMatches(prompt, word))) score = Math.max(score, 40 + words.length * 5 + words.reduce((sum, word) => sum + word.length, 0));
  for (const word of triggerWords(entry.description)) {
    if (!termMatches(prompt, word) || GENERIC_TRIGGER_WORDS.has(text(word).trim())) continue;
    score = Math.max(score, 20);
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
function ordinaryWithin(client, target, directory = false, bindings) {
  return require('./capability-roots.cjs').ordinaryWithin(client, target, directory, bindings);
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
function baselineFor(entry, paths, previous, client, bindings) {
  const baseline = { verified: false, catalogFile: previous.file, reason: 'PREVIOUS_SOURCE_UNAVAILABLE' };
  if (!previous.catalog || !paths.length) return baseline;
  const matches = previous.catalog.entries.filter(old => old.id === entry.id && old.name === entry.name && old.category === entry.category && old.source === entry.source && old.install?.mode === entry.install?.mode);
  if (matches.length !== 1) return { ...baseline, reason: 'PREVIOUS_ENTRY_UNAVAILABLE' };
  const source = sourcePath(matches[0], path.dirname(previous.file));
  if (!source) return baseline;
  try {
    const directory = entry.category === 'skill' || (entry.category === 'script' && entry.install?.mode === 'copy-directory');
    if (paths.some(target => !ordinaryWithin(client, target, directory, bindings))) return { ...baseline, reason: 'LOCAL_CONTENT_UNVERIFIABLE' };
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
    const score = phase === 'task' ? routeScore(entry, routeText, clientDir, options.bindings) : 0;
    if (phase === 'task' && !score && !requested) return;
    const metadata = [entry.id, entry.name, entry.description || ''].join(' ');
    const preferred = prefs.preferredIds.includes(text(entry.id)) || prefs.preferredKeywords.some(keyword => termMatches(metadata, keyword));
    const excluded = prefs.excludedIds.includes(text(entry.id)) || prefs.excludedKeywords.some(keyword => termMatches(metadata, keyword));
    const generic = entry.tier === 'core' || entry.install?.tier === 'core' || GENERIC.has(entry.id);
    const presence = localPresence(entry, root, clientDir, options.bindings), installedPaths = presence.installedPaths || [];
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
      if (phase === 'task' && entry.category === 'command' && ordinaryWithin(clientDir, output.entryPath, false, options.bindings)) decide('ASK_USE', 'RELEVANT_INSTALLED_COMMAND');
      else if (phase === 'task' && intent === 'use' && ordinaryWithin(clientDir, output.entryPath, false, options.bindings)) { decide('KEEP', 'EXPLICIT_USE_REQUEST'); output.authorized = true; }
      else if (presence.differs !== false) {
        output.baseline = baselineFor(entry, installedPaths, previous, clientDir, options.bindings);
        // 任务请求优先回答"用哪个能力"；本地有差异不等于不能使用，维护检查只在安装阶段做。
        const localTask = phase === 'task' && intent !== 'install';
        if (presence.differs === true && output.baseline.verified && !localTask) { decide('UPDATE', 'PRISTINE_PREVIOUS_SOURCE'); output.autoUpdate = true; }
        else if (localTask) { decide('ASK_USE', 'RELEVANT_INSTALLED_CAPABILITY_LOCAL_DIFF'); output.localDiff = true; }
        else decide('REVIEW_UPDATE', output.baseline.reason);
      } else if (phase === 'task' && intent === 'use') decide('REVIEW_UPDATE', 'LOCAL_ENTRY_UNVERIFIABLE');
      else if (phase === 'task' && intent !== 'install') decide(AUTO_USE_IDS.has(entry.id) ? 'AUTO_USE' : 'ASK_USE', AUTO_USE_IDS.has(entry.id) ? 'AUTO_TRIGGERED_INSTALLED_CAPABILITY' : 'RELEVANT_INSTALLED_CAPABILITY');
      else decide('KEEP', 'ALREADY_CURRENT');
    } else if (presence.present === false && (generic || preferred || requested)) decide('ASK_INSTALL', requested ? 'CURRENT_EXPLICIT_REQUEST' : preferred ? 'PREFERRED_MISSING_CAPABILITY' : 'GENERIC_MISSING_CAPABILITY');
    else decide('SKIP', presence.present === false ? 'SPECIALIZED_NOT_PREFERRED' : 'LOCAL_STATE_UNVERIFIED');
    output.requiresConfirmation = ['ASK_INSTALL', 'ASK_USE', 'REVIEW_UPDATE'].includes(output.action) || (phase === 'task' && output.action === 'UPDATE');
    planned.push({ output, score: score + (requested ? 1000 : 0) + (preferred ? 3 : 0), index });
  });
  if (phase === 'task') {
    // 未进入包登记的本地命令也必须能按描述召回；命令更具体，优先于泛化技能。
    const localCommands = localCommandEntries(clientDir, catalog, options.bindings)
      .map(entry => ({ entry, intent: intentFor(prompt, { id: 'command:' + entry.name, name: entry.name }), score: descriptionTriggerScore(entry, routeText, clientDir, options.bindings) }))
      .filter(item => item.intent !== 'decline' && (item.intent === 'use' || (!discussion && prefs.enabled && !excludedLocalSkill(item.entry, prefs))))
      .filter(item => item.intent === 'use' || item.score > 0)
      .sort((a, b) => (b.intent === 'use') - (a.intent === 'use') || b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    let automaticCommands = 0;
    for (const { entry, intent, score } of localCommands) {
      if (intent !== 'use' && automaticCommands++ >= 1) continue;
      const authorized = intent === 'use';
      planned.push({
        output: {
          id: 'command:' + entry.name, name: entry.name, category: 'command',
          action: authorized ? 'KEEP' : 'ASK_USE',
          reason: authorized ? 'EXPLICIT_USE_REQUEST' : 'RELEVANT_LOCAL_COMMAND',
          entry: null, present: true, differs: false,
          installedPaths: [path.dirname(entry.path)], installedPath: path.dirname(entry.path), entryPath: path.resolve(entry.path),
          generic: false, preferred: false, matched: true, requested: authorized, authorized,
          autoUpdate: false, maintenanceNeeded: false,
          baseline: { verified: false, catalogFile: previous.file, reason: 'NOT_NEEDED' },
          requiresConfirmation: !authorized, local: true,
        },
        score: score + (authorized ? 1000 : 2),
        index: catalog.entries.length,
      });
    }
    // 本地候选与包候选共同筛选：领域技能不再被通用候选挤掉；当前拒绝与点名使用同路处理。
    const local = localSkillEntries(clientDir, catalog, options.bindings)
      .map(entry => ({ entry, intent: intentFor(prompt, { id: 'skill:' + entry.name, name: entry.name }) }))
      .filter(({ entry, intent }) => intent !== 'decline' && (intent === 'use' || (!discussion && prefs.enabled && !excludedLocalSkill(entry, prefs))))
      .map(({ entry, intent }) => ({ entry, intent, score: localSkillScore(entry, routeText) }))
      .filter(item => item.intent === 'use' || item.score > 0)
      .sort((a, b) => (b.intent === 'use') - (a.intent === 'use') || b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    // Explicit current choices outrank suggestions. Only automatic discovery is
    // limited to one local candidate; the final three-item cap still applies.
    let automaticCount = 0;
    for (const { entry, intent, score } of local) {
      if (intent !== 'use' && automaticCount++ >= 1) continue;
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
  if (phase === 'task') planned.sort((a, b) => (a.output.action === 'SKIP') - (b.output.action === 'SKIP')
    || ACTION_RANK[b.output.action] - ACTION_RANK[a.output.action] || b.score - a.score || a.index - b.index);
  const items = (phase === 'task' ? planned.slice(0, 3) : planned).map(item => item.output);
  return { schema: 1, items, summary: { phase, reason: hasCatalog ? 'OK' : 'LOCAL_DISCOVERY_ONLY', total: items.length, considered: catalog.entries.length, omitted: planned.length - items.length, counts: Object.fromEntries(ACTIONS.map(action => [action, items.filter(item => item.action === action).length])), requiresConfirmation: items.filter(item => item.requiresConfirmation).length } };
}

const WORKFLOW_CHOICES = { parallel: ['assess', 'skip'], goal: ['recommend', 'skip'], verification: ['assess', 'skip'], documentation: ['recommend', 'skip'] };
const WORKFLOW_LIMIT = 2 * 1024 * 1024;
const workflowText = (value, max = 1000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);
function workflowObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(code, 'unexpected or missing workflow object');
}
function workflowRestrictions(prompt) {
  const value = taskRouteText(prompt).normalize('NFKC');
  const refusal = '(?:不要|不用|无需|不必|不需要|禁止|禁用|关闭|停用|取消|不|别)\\s*(?:(?:再|给我|为我)\\s*)?(?:启用|开启|创建|使用|用|采用|进行|生成|写|派发|分派|开|启动)?\\s*(?:(?:任何|新的|额外的|其他|一个|一项)\\s*)?';
  return {
    readOnly: /(?:^|[，,。；;!?！？\n])\s*(?:(?:请|帮我|你|先|现在|本次|这次|暂时|务必)\s*)*(?:只读|仅审阅|只审查|只分析|仅分析|只评估|仅评估)|(?:全程|始终|全都)\s*只读|(?:不要|不许|禁止|不得|无需|不用|不必|不需要|别|不)\s*(?:再\s*)?(?:修改|改动|更改|写入|写)\s*(?:(?:任何|所有|这些|这个)\s*)?(?:文件|代码|磁盘)|不\s*改\s*文件|零文件写入|\bread[- ]only\b|\b(?:do\s+not|don't|never)\s+(?:modify|write|edit|change)\s+(?:(?:any|the)\s+)?(?:files?|code)\b/i.test(value),
    parallel: new RegExp(refusal + '(?:并行|parallel|多\\s*agent|子代理)|(?:串行|顺序)(?:执行|推进|实现|处理)|\\bno parallel\\b', 'i').test(value),
    goal: new RegExp(refusal + '(?:目标模式|目标化执行|目标|goal)|\\bno goals?\\b', 'i').test(value),
    verification: new RegExp(refusal + '(?:选档|验证选档|自适应验证|分档验证)|\\bno verification tier\\b', 'i').test(value),
    documentation: new RegExp(refusal + '(?:成文|文档|四层文档)|\\bno docs?\\b', 'i').test(value),
  };
}
function workflowBinding(context) {
  workflowObject(context, ['schema', 'decisionId', 'sessionId', 'workspaceKey', 'requestMessageId', 'requestDigest', 'restrictions'], 'INVALID_WORKFLOW_CONTEXT');
  if (context.schema !== 1 || typeof context.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.sessionId)
      || !workflowText(context.decisionId, 100) || !workflowText(context.requestMessageId, 200)
      || !workflowText(context.workspaceKey) || !path.isAbsolute(context.workspaceKey)
      || !/^[a-f0-9]{64}$/.test(context.requestDigest || '')) fail('INVALID_WORKFLOW_CONTEXT', 'current request identity and absolute workspace are required');
  const keys = ['readOnly', ...Object.keys(WORKFLOW_CHOICES)];
  workflowObject(context.restrictions, keys, 'INVALID_WORKFLOW_CONTEXT');
  if (keys.some(key => typeof context.restrictions[key] !== 'boolean')) fail('INVALID_WORKFLOW_CONTEXT', 'restrictions must be explicit booleans');
  return crypto.createHash('sha256').update(JSON.stringify([
    context.schema, context.decisionId, context.sessionId, context.workspaceKey, context.requestMessageId,
    context.requestDigest, keys.map(key => context.restrictions[key]),
  ])).digest('hex');
}
function createWorkflowContext(event) {
  if (!event || typeof event.prompt !== 'string' || !event.prompt.trim() || typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd)) fail('INVALID_WORKFLOW_CONTEXT', 'full prompt and absolute cwd are required');
  const decisionId = crypto.randomUUID();
  const context = {
    schema: 1, decisionId, sessionId: event.session_id, workspaceKey: path.resolve(event.cwd),
    requestMessageId: event.request_message_id ?? decisionId,
    requestDigest: crypto.createHash('sha256').update(event.prompt).digest('hex'),
    restrictions: workflowRestrictions(event.prompt),
  };
  workflowBinding(context);
  return context;
}
function buildWorkflowNote(context, script) {
  const binding = workflowBinding(context);
  if (!workflowText(script, 32768) || !path.isAbsolute(script)) fail('INVALID_WORKFLOW_COMMAND', 'an absolute advisor script is required');
  const command = { executable: process.execPath, args: [script, '--workflow-decision', '-', '--binding', binding, '--json'] };
  // The structured argv is authoritative. The local-shell rendering also keeps
  // spaces, quotes and shell metacharacters inside literal path arguments.
  const quote = process.platform === 'win32'
    ? value => "'" + value.replace(/'/g, "''") + "'"
    : value => "'" + value.replace(/'/g, "'\\''") + "'";
  const shellCommand = (process.platform === 'win32' ? '& ' : '') + [command.executable, ...command.args].map(quote).join(' ');
  return '\n【工作方式 · 模型判断】由当前主会话模型依据完整用户消息、当前授权和最小只读现场证据，判断并行、目标、验证选档、成文是否值得采用，并把文档/目标/并行结论写入开工确认卡；关键词仅召回候选，不决定启用。hook 不另调模型、不联网。'
    + '\nWORKFLOW_CONTEXT ' + JSON.stringify(context)
    + '\nWORKFLOW_BINDING ' + binding
    + '\nWORKFLOW_COMMAND ' + JSON.stringify(command)
    + '\nWORKFLOW_SHELL_COMMAND ' + JSON.stringify(shellCommand)
    + '\n结构化输入：{schema:1,context:<上方原样对象>,model:{schema:1,bindingDigest:<上方绑定值>,taskId:<当前任务ID>,intent:question|read-only|execute|continuation|unclear,confidence:low|medium|high,sourceRefs:[<真实来源>],reason:<简短判断>,parallel:assess|skip,goal:recommend|skip,verification:assess|skip,documentation:recommend|skip},parallelPlan?:<parallel-plan 的完整输入>,verificationRequest?:<verification-policy 的完整输入>}。不能编造事实或授权；confidence 是自评，不是正确性证明。'
    + '\n在业务写入或启用额外流程前，按 WORKFLOW_COMMAND 的 executable 和 args 原样调用，结构化输入经 stdin 传入；WORKFLOW_SHELL_COMMAND 是本机 ' + (process.platform === 'win32' ? 'PowerShell' : 'POSIX shell') + ' 的等价命令。只读任务不写请求文件。没有当前身份、结果无效或 NEEDS_FACTS 时不回退成关键词自动启用；保留串行/任务清单及必需验证，补足最小证据后再判断。'
    + '\n开工自检（模型判断，不等关键词）：① 含混自检：主动判断请求是否存在多种合理解读、对象/范围/验收是否明确；误判会导致返工时，先用 AskUserQuestion 给 2–4 个真实备选（推荐项在前、写清代价）确认后开工；② 能力自检：对照当前任务判断是否需要已安装的专项能力，建议与关键词只是召回线索——命中也要核对适用边界，未命中不代表没有适用能力（可用 skills-router / skill-load 检索）；两项都不得为明确单步请求制造确认门。'
    + '\n文档、目标、验证档与并行计划审批全部并入开工确认卡（见 KICKOFF 注入块）：一次弹窗、最多 4 问＝计划（含并行）/文档/目标/验证档；把 cardPrefill 原样并入卡片作预填推荐，不另开弹窗。未确认按不建目标、不成文、不启用并行处理，不依据模型建议调用 CreateGoal。只读检查可并行、无需征求；写并行须在计划问里显式选中 opt-in（推荐默认恒为串行），写入收敛单会话；只读任务只展示计划，不写文件、不派发。'
    + '\n验证选档须给真实 facts/checks/baseline，taskId 绑定当前任务，sessionId/workspaceKey/requestMessageId 与本轮 context 一致；当本请求属于业务写入/执行类且未 veto 选档时，必须在开工前把推荐档与四个选项作为开工卡的「验证档」问取得明确选择（本轮没有开工卡时才单独 AskUserQuestion），facts/checks/baseline 不足时先补最小只读证据，未答复/取消不默认档，同任务不重复询问；没有 resolveAuthority 仍为咨询模式，不调用 applyChoice/beginVerification。skip 只跳过可选选档，不能删除必需验证或降低发布检查。'
    + '\nfacts.uncertainty 描述动作风险；只是结论尚待取证时写 uncertaintyScope=conclusion（仅本地+可逆+非敏感+低影响低风险免阻断并标注结论待取证，高风险仍 NEEDS_FACTS）。'
    + '\n继续同一任务先核对既有计划、目标和明确答复；已有适用选择不重复询问，拒绝/取消不催问，范围或事实改变重新判断。所有裁决只是建议，不发放创建目标、派发、写入、安装、发布或生产操作权限。';
}
function evaluateWorkflowDecision(input, expectedBinding) {
  workflowObject(input, ['schema', 'context', 'model', 'parallelPlan', 'verificationRequest'], 'INVALID_WORKFLOW_DECISION');
  if (input.schema !== 1 || !/^[a-f0-9]{64}$/.test(expectedBinding || '')) fail('INVALID_WORKFLOW_DECISION', 'schema 1 and the independent current binding are required');
  const binding = workflowBinding(input.context), model = input.model;
  if (binding !== expectedBinding) fail('WORKFLOW_SCOPE_MISMATCH', 'context does not match the current hook binding');
  workflowObject(model, ['schema', 'bindingDigest', 'taskId', 'intent', 'confidence', 'sourceRefs', 'reason', ...Object.keys(WORKFLOW_CHOICES)], 'INVALID_WORKFLOW_MODEL');
  if (model.schema !== 1 || model.bindingDigest !== binding) fail('STALE_WORKFLOW_DECISION', 'model decision is not for this request');
  if (typeof model.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model.taskId)
      || !['question', 'read-only', 'execute', 'continuation', 'unclear'].includes(model.intent)
      || !['low', 'medium', 'high'].includes(model.confidence) || !workflowText(model.reason, 300)
      || !Array.isArray(model.sourceRefs) || model.sourceRefs.length > 20 || model.sourceRefs.some(ref => !workflowText(ref, 500))
      || Object.entries(WORKFLOW_CHOICES).some(([key, choices]) => !choices.includes(model[key]))) fail('INVALID_WORKFLOW_MODEL', 'bounded structured model suggestions and source references are required');
  const restrictions = input.context.restrictions;
  const result = {
    schema: 1, taskId: model.taskId, bindingDigest: binding, verdict: 'ADVISORY', authorizesExecution: false,
    parallel: { action: 'SEQUENTIAL' }, goal: { action: 'TASK_LIST' }, documentation: { action: 'NONE' },
    verification: { action: 'REQUIRED_BASELINE', mandatoryChecksPreserved: true }, reasonCodes: [],
  };
  const eligible = !['question', 'continuation', 'unclear'].includes(model.intent) && model.confidence !== 'low' && model.sourceRefs.length > 0;
  // A quiet or uncertain workflow suggestion cannot discard an already supplied
  // mandatory checklist. Validate its scope and preserve it before early returns.
  if (input.verificationRequest) {
    const request = input.verificationRequest, context = input.context;
    if (request.taskId !== model.taskId || request.sessionId !== context.sessionId || request.workspaceKey !== context.workspaceKey || request.requestMessageId !== context.requestMessageId) fail('WORKFLOW_SCOPE_MISMATCH', 'verification request belongs to another scope');
    const policy = require('./verification-policy.cjs').evaluatePolicy(request);
    const external = ['push', 'pull-request', 'deploy', 'publish'].includes(request.facts.action);
    result.verification = {
      action: eligible && model.verification === 'assess' && !restrictions.verification ? 'ASK_IN_KICKOFF_CARD' : 'REQUIRED_BASELINE',
      mandatoryChecksPreserved: true, policy,
      requiredCheckIds: [...new Set([...policy.mandatoryCheckIds, ...(external ? policy.options.find(option => option.tier === 'deep').checkIds : policy.baselineCheckIds)])].sort(),
    };
    if (policy.blockers.length) { result.verdict = 'NEEDS_FACTS'; result.verification.action = 'RESOLVE_FACTS'; result.reasonCodes.push(...policy.blockers); }
    // C1：裁决只作卡内预填推荐，不再另开一次弹窗；四个选项与推荐档原样交给开工卡。
    if (result.verification.action === 'ASK_IN_KICKOFF_CARD') {
      result.cardPrefill = result.cardPrefill || {};
      result.cardPrefill.verification = {
        tier: policy.recommendedTier,
        reason: ((policy.conclusionPending ? '结论待取证；' : '') + '推荐档 ' + policy.recommendedTier + '，依据 ' + policy.reasonCodes.join('/')).slice(0, 280),
        policyDigest: policy.policyDigest,
        options: policy.options.map(option => ({ optionId: option.optionId, description: option.description })),
      };
      result.verification.channel = 'KICKOFF_CARD';
    }
    if (policy.conclusionPending && !policy.blockers.length) result.reasonCodes.push('CONCLUSION_UNCERTAIN');
  }
  if (model.intent === 'question') { result.reasonCodes.push('QUESTION_ONLY'); return result; }
  if (model.intent === 'continuation') { result.reasonCodes.push('CHECK_EXISTING_TASK_AND_CHOICES'); return result; }
  if (model.intent === 'unclear' || model.confidence === 'low' || !model.sourceRefs.length) {
    result.verdict = 'NEEDS_FACTS'; result.reasonCodes.push('INSUFFICIENT_MODEL_EVIDENCE'); return result;
  }
  const readOnly = restrictions.readOnly || model.intent === 'read-only';
  if (model.goal === 'recommend' && !readOnly && !restrictions.goal) result.goal.action = 'CHECK_ACTIVE_GOAL_THEN_ASK_IF_NEEDED';
  if (model.documentation === 'recommend' && !readOnly && !restrictions.documentation) result.documentation.action = 'CHECK_EXISTING_DOCS_THEN_ASK_IF_NEEDED';
  if (model.parallel === 'assess' && !restrictions.parallel) {
    if (!input.parallelPlan) {
      result.parallel.action = 'NEEDS_PLAN'; result.verdict = 'NEEDS_FACTS'; result.reasonCodes.push('PARALLEL_PLAN_REQUIRED');
    } else {
      if (input.parallelPlan.taskId !== model.taskId) fail('WORKFLOW_SCOPE_MISMATCH', 'parallel plan belongs to another task');
      const plan = require('./parallel-plan.cjs').evaluatePlan(input.parallelPlan);
      result.parallel = { action: 'SEQUENTIAL', plan };
      if (plan.verdict === 'INVALID_PLAN') { result.verdict = 'NEEDS_FACTS'; result.reasonCodes.push('INVALID_PARALLEL_PLAN'); }
      else if (readOnly && plan.units.some(unit => unit.kind === 'write')) {
        result.parallel = { action: 'SEQUENTIAL' }; result.reasonCodes.push('READ_ONLY_WRITE_VETO');
      }
      else if (plan.verdict === 'BLOCKED_HUMAN') { result.parallel.action = 'BLOCKED_HUMAN'; result.reasonCodes.push(...plan.reasonCodes); }
      else if (plan.requiresPlanApproval) {
        result.parallel = readOnly
          ? { action: 'DISPLAY_READ_ONLY_PLAN', planDigest: plan.planDigest, waves: plan.waves, units: plan.units, requiresWriteApproval: true }
          : { action: 'ASK_IN_KICKOFF_CARD', channel: 'KICKOFF_CARD', plan };
        if (!readOnly) {
          // C1：计划审批折进开工卡的计划问，不再单独弹窗；写并行的 opt-in 仍是独立选项。
          result.cardPrefill = result.cardPrefill || {};
          result.cardPrefill.parallel = {
            mode: 'parallel',
            optInKind: plan.optInKind === 'worktree-write' ? 'worktree-write' : 'read-only',
            planDigest: plan.planDigest,
            reason: (plan.requiresUserOptIn ? '计划审批并入计划问；写并行须显式选中 opt-in，推荐默认串行。' : '计划审批并入计划问；只读并行，写入仍收敛单会话。').slice(0, 280),
          };
        }
      }
      else result.reasonCodes.push(...plan.reasonCodes);
    }
  }
  if (!input.verificationRequest && model.verification === 'assess' && !restrictions.verification) {
    result.verdict = 'NEEDS_FACTS'; result.verification.action = 'NEEDS_CHECKS'; result.reasonCodes.push('VERIFICATION_CHECKS_REQUIRED');
  }
  for (const key of Object.keys(WORKFLOW_CHOICES)) if (restrictions[key]) result.reasonCodes.push('USER_VETO_' + key.toUpperCase());
  if (readOnly) result.reasonCodes.push('READ_ONLY_SCOPE');
  return result;
}
function readWorkflowInput(file) {
  const fd = file === '-' ? 0 : fs.openSync(file, 'r');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const bytes = Buffer.alloc(8192), count = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (!count) break;
      size += count;
      if (size > WORKFLOW_LIMIT) fail('WORKFLOW_INPUT_TOO_LARGE', 'workflow input exceeds 2MiB');
      chunks.push(bytes.subarray(0, count));
    }
  } finally { if (fd !== 0) fs.closeSync(fd); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_WORKFLOW_JSON', 'workflow input must be valid JSON'); }
}

function parseArgs(argv) {
  const values = {}, seen = new Set(), allowed = new Set(['catalog', 'client-root', 'phase', 'prompt', 'preferences', 'previous-catalog', 'workflow-decision', 'binding', 'json']);
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
    if (args['workflow-decision'] !== undefined || args.binding !== undefined) {
      if (!args['workflow-decision'] || !args.binding || Object.keys(args).some(key => !['workflow-decision', 'binding', 'json'].includes(key))) fail('USAGE', 'use --workflow-decision <json|-> --binding <current digest> [--json]');
      const result = evaluateWorkflowDecision(readWorkflowInput(args['workflow-decision']), args.binding);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.verdict === 'NEEDS_FACTS' ? 1 : 0;
      return;
    }
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
    process.exitCode = ['USAGE', 'INVALID_PREFERENCES', 'INVALID_CATALOG'].includes(code) || /^(?:INVALID_WORKFLOW|WORKFLOW_|STALE_WORKFLOW)/.test(code) ? 2 : 1;
  }
}

module.exports = { planCapabilities, createWorkflowContext, workflowBinding, buildWorkflowNote, evaluateWorkflowDecision };
if (require.main === module) main(process.argv.slice(2));
