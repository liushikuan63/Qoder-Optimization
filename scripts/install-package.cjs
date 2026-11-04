#!/usr/bin/env node
// 主包能力安装：核对已有更新、筛选缺失能力，并事务安装可实际触发的任务路由。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const { clientRoot } = require('./client-root.js');
const { dependenciesFor } = require('./package-dependencies.cjs');
const { readCatalog } = require('./pkg-catalog.cjs');
const { isPublicFile } = require('./pack-share-extras.cjs');

const BASE_IDS = [
  'script:rules-reminder.js', 'script:capability-advisor.cjs',
  'script:skill-load.cjs', 'script:pkg-catalog.cjs', 'script:build-skills-index.cjs',
  'script:parallel-plan.cjs', 'script:parallel-context.cjs',
  'skill:skills-router', 'command:skill-load', 'command:pkg-find',
];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root, file) => { const rel = path.relative(root, file); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

function parseArgs(argv) {
  const result = { install: [], resident: [], yes: false, dryRun: false };
  const seen = new Set();
  const flags = new Map([['--yes', 'yes'], ['--dry-run', 'dryRun'], ['--json', 'json'], ['--continuity', 'continuity'], ['--no-auto-bind', 'noAutoBind'], ['--help', 'help'], ['-h', 'help'], ['--no', 'skip'], ['--skip', 'skip'], ['--non-interactive', 'nonInteractive']]);
  const values = new Map([['--client-root', 'client'], ['--catalog', 'catalogFile'], ['--preferences', 'preferencesFile'], ['--install', 'install'], ['--resident', 'resident']]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--install', '--resident'].includes(arg) && seen.has(arg)) throw new Error('重复参数：' + arg);
    seen.add(arg);
    if (flags.has(arg)) result[flags.get(arg)] = true;
    else if (values.has(arg)) {
      const value = argv[++i];
      if (!value || !value.trim() || value.startsWith('-')) throw new Error(arg + ' 需要明确值');
      if (arg === '--install' || arg === '--resident') {
        if (!/^(?:skill|script|command|agent):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(arg + ' 需要完整的精确条目 id');
        const list = result[values.get(arg)];
        if (list.includes(value)) throw new Error('重复选择：' + value);
        list.push(value);
      } else result[values.get(arg)] = path.resolve(value);
    } else throw new Error('未知参数：' + arg);
  }
  return result;
}

function physical(file) {
  const parts = [];
  let cursor = path.resolve(file);
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...parts.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling link is not a missing directory that we may create through.
      try { fs.lstatSync(cursor); throw new Error('路径含悬空链接：' + cursor); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      parts.push(path.basename(cursor)); cursor = parent;
    }
  }
}

function snapshot(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const hash = crypto.createHash('sha256');
  const walk = (current, rel) => {
    const s = fs.lstatSync(current);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error('安装目标必须是普通文件或目录：' + current);
    hash.update(JSON.stringify([rel, s.dev, s.ino, s.isDirectory() ? 'directory' : 'file']));
    if (s.isDirectory()) for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), rel + '/' + name);
    else hash.update(fs.readFileSync(current));
  };
  walk(file, '');
  return { ino: stat.ino, dev: stat.dev, hash: hash.digest('hex') };
}
const same = (a, b) => !a || !b ? a === b : a.ino === b.ino && a.dev === b.dev && a.hash === b.hash;

function publicSourceProof(file, sourceRel) {
  if (!isPublicFile(sourceRel)) throw new Error('条目来源不属于公开分发文件');
  const proof = [];
  const walk = (current, rel) => {
    if (!isPublicFile(sourceRel + (rel ? '/' + rel : ''))) return;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('公开安装源不是普通对象：' + current);
    if (stat.isDirectory()) {
      proof.push([rel, 'directory']);
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), rel ? rel + '/' + name : name);
    } else proof.push([rel, 'file', digest(fs.readFileSync(current))]);
  };
  walk(file, '');
  return digest(JSON.stringify(proof));
}

function sourceSnapshot(file, sourceRel) {
  const stat = fs.lstatSync(file);
  return { ino: stat.ino, dev: stat.dev, hash: publicSourceProof(file, sourceRel) };
}

function withPending(result) {
  const committed = result.status !== 'DRY_RUN';
  const completed = new Set(committed ? result.receipt?.installedIds || [] : []);
  const accepted = new Set(committed ? result.plan.acceptedInstallIds : []);
  const incomplete = result.plan.items.filter(item => ['ASK_INSTALL', 'REVIEW_UPDATE', 'UPDATE'].includes(item.action) && !completed.has(item.id));
  const pendingItems = incomplete.filter(item => item.action !== 'ASK_INSTALL' || !accepted.has(item.id))
    .map(({ id, action, reason, present, installedPaths }) => ({ id, action: committed && action === 'UPDATE' ? 'REVIEW_UPDATE' : action, reason: committed && action === 'UPDATE' ? 'AUTHORIZED_UPDATE_BLOCKED_REVIEW_REQUIRED' : reason, present, installedPaths }));
  const blockedItems = incomplete.filter(item => accepted.has(item.id) && (item.action === 'ASK_INSTALL' || item.action === 'UPDATE'))
    .map(({ id, action }) => ({ id, action, reason: 'ALREADY_AUTHORIZED_BUT_BLOCKED', requiresConfirmation: false }));
  const nextActions = [...new Set(pendingItems.map(item => item.action === 'ASK_INSTALL' ? 'ASK_INSTALL' : 'ASK_UPDATE'))];
  return { ...result, pendingItems, blockedItems, nextActions };
}

function assertPath(plan, file) {
  if (!inside(plan.client, file) || normalized(file) === normalized(plan.client)) throw new Error('安装目标越界');
  if (normalized(physical(plan.client)) !== normalized(plan.realClient)) throw new Error('客户端目录在安装期间改变');
  if (!inside(plan.realClient, physical(path.dirname(file)))) throw new Error('安装目标子路径越界：' + file);
  if (plan.clientIdentity) {
    const now = fs.statSync(plan.client);
    if (now.ino !== plan.clientIdentity.ino || now.dev !== plan.clientIdentity.dev) throw new Error('客户端目录归属在安装期间改变');
  }
}

function targetFor(entry, client, item, resident = new Set()) {
  if (item?.installedPaths?.length === 1) return path.resolve(item.installedPaths[0]);
  if (entry.category === 'skill') return path.join(client, resident.has(entry.id) || entry.install?.tier === 'core' || entry.tier === 'core' ? 'skills' : 'skills-library', entry.name);
  return path.join(client, { script: 'scripts', command: 'commands', agent: 'agents' }[entry.category], path.basename(entry.source));
}

function settingsFor(bytes, target) {
  let settings;
  try { settings = bytes ? JSON.parse(bytes.toString('utf8')) : {}; }
  catch { throw new Error('settings.json 无效，未修改配置'); }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings)) throw new Error('settings.json 顶层必须是对象');
  if (settings.hooks === undefined) settings.hooks = {};
  if (!object(settings.hooks)) throw new Error('settings.hooks 必须是对象');
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !object(hook)))) throw new Error('settings.hooks.' + event + ' 结构无效');
  }
  const client = path.dirname(path.dirname(target));
  const command = '"' + process.execPath + '" "' + target + '" --client-root "' + client + '"';
  const groups = settings.hooks.UserPromptSubmit || [];
  const found = groups.flatMap(group => group.hooks.filter(hook => String(hook.command || '').includes('rules-reminder.js')).map(hook => ({ group, hook })));
  let state = 'ADD';
  if (found.length) {
    const { group, hook } = found[0];
    const match = String(hook.command || '').match(/^\s*(?:"([^"\r\n]+)"|([^\s"'`|&;<>$()]+))\s+(?:"([^"\r\n]+)"|([^\s"'`|&;<>$()]+))(?:\s+--client-root\s+(?:"([^"\r\n]+)"|([^\s"'`|&;<>$()]+)))?\s*$/);
    const node = match && (match[1] || match[2]).split(/[\\/]/).pop();
    const boundClient = match && (match[5] || match[6]);
    if (found.length !== 1 || !match || !/^node(?:\.exe)?$/i.test(node) || normalized(match[3] || match[4]) !== normalized(target)
      || (boundClient !== undefined && (!path.isAbsolute(boundClient) || normalized(boundClient) !== normalized(client)))
      || group.matcher !== undefined || hook.type !== 'command' || hook.timeout !== 10) throw new Error('已有 rules-reminder 接线与完整命令/client-root/matcher/type/timeout 冲突，保留配置供核对');
    state = hook.command === command ? 'KEEP' : 'UPDATE';
    hook.command = command;
  } else settings.hooks.UserPromptSubmit = [...groups, { hooks: [{ type: 'command', command, timeout: 10 }] }];
  return { bytes: Buffer.from(JSON.stringify(settings, null, 2) + '\n'), state };
}

function readPreferences(file) {
  if (!file) return undefined;
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema !== 1) throw new Error('能力偏好需要 schema=1 对象');
  return data;
}

function prepare(options = {}) {
  const catalogFile = path.resolve(options.catalogFile || path.join(__dirname, '..', 'catalog.json'));
  const catalog = readCatalog(catalogFile), root = path.dirname(catalogFile);
  const client = path.resolve(options.client || clientRoot());
  const pointer = path.join(client, 'share-package.json'), settings = path.join(client, 'settings.json');
  const plan = { catalogFile, catalogHash: digest(fs.readFileSync(catalogFile)), root, client, realClient: physical(client), items: [], changes: [], baseIds: BASE_IDS, diagnostics: [] };
  try { const stat = fs.statSync(client); if (!stat.isDirectory()) throw new Error('客户端路径不是目录'); plan.clientIdentity = { ino: stat.ino, dev: stat.dev }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of [pointer, settings, path.join(client, 'skills-index.json'), path.join(client, 'package-activation.json')]) { assertPath(plan, file); snapshot(file); }
  let previous = {};
  if (fs.existsSync(pointer)) {
    try { previous = JSON.parse(fs.readFileSync(pointer, 'utf8')); }
    catch { throw new Error('share-package.json 无效，保留原登记供核对'); }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('share-package.json 必须是对象');
  }
  const defaultPreferences = path.join(client, 'capability-preferences.json');
  let preferences = readPreferences(options.preferencesFile || (fs.existsSync(defaultPreferences) ? defaultPreferences : undefined));
  if (options.install?.length) {
    preferences = { ...(preferences || { schema: 1 }), preferredIds: [...new Set([...(preferences?.preferredIds || []), ...options.install])], excludedIds: (preferences?.excludedIds || []).filter(id => !options.install.includes(id)) };
  }
  const entries = new Map(catalog.entries.map(entry => [entry.id, entry]));
  for (const id of [...BASE_IDS, ...(options.install || []), ...(options.resident || [])]) if (!entries.has(id)) throw new Error('包内缺少精确条目：' + id);
  const resident = new Set(options.resident || []);
  for (const id of resident) {
    if (entries.get(id).category !== 'skill') throw new Error('--resident 只接受技能：' + id);
    if (!(options.install || []).includes(id)) throw new Error('--resident 需要同时用 --install 选择该技能：' + id);
  }
  const closure = ids => {
    const order = [], visiting = new Set(), visited = new Set();
    const visit = id => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error('包内循环依赖：' + id);
      const entry = entries.get(id);
      if (!entry || entry.status !== 'shipped' || !entry.install || !['copy-skill', 'copy-script', 'copy-file', 'copy-directory', 'copy-command', 'copy-agent'].includes(entry.install.mode)) throw new Error('条目不是可复制的随包能力：' + id);
      const expected = { skill: 'skills/' + entry.name, script: 'scripts/' + entry.name, command: 'commands/' + entry.name + '.md', agent: 'agents/' + entry.name + '.md' }[entry.category];
      if (!expected || entry.source !== expected || /[\\/:]/.test(entry.name) || entry.name === '.' || entry.name === '..') throw new Error('条目 source/name 无效：' + id);
      const source = path.join(root, expected);
      if (!inside(fs.realpathSync(root), fs.realpathSync(source))) throw new Error('包内来源越界：' + id);
      visiting.add(id);
      for (const dependency of dependenciesFor(root, entry)) visit(dependency);
      visiting.delete(id); visited.add(id); order.push(id);
    };
    ids.forEach(visit); return order;
  };
  const baseClosure = closure(BASE_IDS);
  const explicitClosure = closure([...BASE_IDS, ...(options.install || [])]);
  // An exact install choice includes its necessary technical dependencies.
  // Preferences control suggestions, never veto that current choice; local
  // differences still go through the advisor's pristine-baseline checks.
  const { planCapabilities } = require('./capability-advisor.cjs');
  const prompt = explicitClosure.map(id => '安装 ' + id).join('；');
  const advice = planCapabilities({ catalogFile, clientRoot: client, prompt, phase: 'install', preferences, previousCatalogFile: typeof previous.catalog === 'string' ? path.resolve(client, previous.catalog) : undefined });
  plan.items = advice.items || [];
  plan.diagnostics = advice.diagnostics || advice.warnings || [];
  const items = new Map(plan.items.map(item => [item.id || item.entry?.id, item]));
  for (const id of resident) if (items.get(id)?.action === 'KEEP') throw new Error('已安装技能不能通过 --resident 换层，请用 tier-skills --promote：' + id);
  plan.acceptedInstallIds = [...new Set([...explicitClosure, ...plan.items.filter(item => item.action === 'UPDATE').map(item => item.id)])];
  const blocked = id => items.get(id)?.action === 'REVIEW_UPDATE' || (items.get(id)?.installedPaths?.length || 0) > 1;
  plan.baseBlocked = baseClosure.filter(blocked);
  plan.baseReady = plan.baseBlocked.length === 0;
  const requested = new Set();
  for (const id of options.install || []) {
    if (!['ASK_INSTALL', 'KEEP', 'UPDATE'].includes(items.get(id)?.action)) throw new Error('所选能力不适配或需要先审阅本地差异：' + id);
    requested.add(id);
  }
  for (const item of plan.items) if (item.action === 'UPDATE' && (plan.baseReady || !baseClosure.includes(item.id || item.entry.id))) requested.add(item.id || item.entry.id);
  if (plan.baseReady) BASE_IDS.forEach(id => requested.add(id));
  const selected = new Set();
  for (const id of requested) {
    const needed = closure([id]);
    const conflicts = needed.filter(blocked);
    if (conflicts.length) { plan.diagnostics.push(id + ' 的依赖需要审阅：' + conflicts.join(', ')); continue; }
    for (const dependency of needed) selected.add(dependency);
  }
  plan.verifyTargets = [];
  for (const id of closure([...selected])) {
    if (!selected.has(id)) continue;
    const entry = entries.get(id), item = items.get(id);
    const target = targetFor(entry, client, item, resident);
    assertPath(plan, target);
    const before = snapshot(target);
    const source = path.join(root, entry.source);
    const sourceBefore = sourceSnapshot(source, entry.source);
    if (item?.action === 'KEEP') { plan.verifyTargets.push({ id, target, before, source, sourceRel: entry.source, sourceBefore }); continue; }
    if (before && item?.action !== 'UPDATE') throw new Error('已有目标没有安全更新基线：' + id);
    plan.changes.push({ id, entry, source, sourceBefore, target, before, tier: entry.category === 'skill' ? path.basename(path.dirname(target)) === 'skills' ? 'core' : 'library' : undefined });
  }
  const approvedSources = new Map([...plan.changes, ...plan.verifyTargets].map(item => [item.id, { id: item.id, source: item.source, sourceRel: item.entry?.source || item.sourceRel, sourceBefore: item.sourceBefore }]));
  // The catalog installer and index builder execute code as well as copy data.
  // Approve their closure even when activation is blocked and only an
  // independent capability update is selected.
  const executionIds = closure(['script:pkg-catalog.cjs', ...(plan.baseReady ? ['script:build-skills-index.cjs'] : []), ...(options.continuity ? ['script:install-continuity.cjs'] : [])]);
  for (const id of executionIds) if (!approvedSources.has(id)) {
    const entry = entries.get(id), source = path.join(root, entry.source);
    approvedSources.set(id, { id, source, sourceRel: entry.source, sourceBefore: sourceSnapshot(source, entry.source) });
  }
  plan.approvedSources = [...approvedSources.values()];
  plan.settingsBefore = snapshot(settings);
  plan.settingsBytes = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
  plan.hook = settingsFor(plan.settingsBytes, path.join(client, 'scripts/rules-reminder.js'));
  plan.pointerBefore = snapshot(pointer);
  plan.pointerValue = { ...previous, catalog: catalogFile, ...(typeof previous.catalog === 'string' && previous.catalog !== catalogFile ? { previous_catalog: previous.catalog } : {}), registered_at: new Date().toISOString().slice(0, 10) };
  plan.indexBefore = snapshot(path.join(client, 'skills-index.json'));
  plan.receiptBefore = snapshot(path.join(client, 'package-activation.json'));
  return plan;
}

function createExclusive(source, target, owned) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('暂存源不是普通对象');
  if (stat.isDirectory()) {
    fs.mkdirSync(target);
    const now = fs.lstatSync(target);
    owned.push({ file: target, ino: now.ino, dev: now.dev, directory: true });
    for (const name of fs.readdirSync(source)) createExclusive(path.join(source, name), path.join(target, name), owned);
    return;
  }
  const bytes = fs.readFileSync(source), fd = fs.openSync(target, 'wx', stat.mode);
  const now = fs.fstatSync(fd), item = { file: target, ino: now.ino, dev: now.dev, hash: digest(Buffer.alloc(0)) };
  owned.push(item);
  try {
    let at = 0;
    while (at < bytes.length) {
      const written = fs.writeSync(fd, bytes, at, bytes.length - at);
      if (!written) throw new Error('文件写入没有进展');
      at += written; item.hash = digest(bytes.subarray(0, at));
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function restoreExclusive(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('恢复源不是普通对象');
  if (stat.isFile()) { fs.linkSync(source, target); return; }
  fs.mkdirSync(target);
  for (const name of fs.readdirSync(source)) restoreExclusive(path.join(source, name), path.join(target, name));
}

function apply(plan, options = {}) {
  if (!options.yes || options.dryRun) return withPending({ status: 'DRY_RUN', ready: false, plan });
  if (digest(fs.readFileSync(plan.catalogFile)) !== plan.catalogHash) throw new Error('包目录在规划后已变化');
  if (!plan.clientIdentity) {
    if (fs.existsSync(plan.client)) throw new Error('客户端目录在规划后被创建');
    fs.mkdirSync(path.dirname(plan.client), { recursive: true });
    fs.mkdirSync(plan.client, { mode: 0o700 });
    const stat = fs.statSync(plan.client); plan.clientIdentity = { ino: stat.ino, dev: stat.dev };
  }
  assertPath(plan, path.join(plan.client, 'share-package.json'));
  const stage = fs.mkdtempSync(path.join(plan.client, '.package-activation-'));
  const stagedClient = path.join(stage, 'client'); fs.mkdirSync(stagedClient);
  const frozenPackage = path.join(stage, 'frozen-package');
  const frozenCatalog = path.join(frozenPackage, 'catalog.json');
  const logs = [], applied = [], createdParents = [];
  const verifySources = () => {
    if (digest(fs.readFileSync(plan.catalogFile)) !== plan.catalogHash) throw new Error('包目录在暂存或发布期间改变');
    for (const item of plan.approvedSources) if (!same(sourceSnapshot(item.source, item.sourceRel), item.sourceBefore)) throw new Error('包内源在规划后改变：' + item.id);
  };
  const verifyFrozen = () => {
    if (digest(fs.readFileSync(frozenCatalog)) !== plan.catalogHash) throw new Error('冻结包索引与批准版本不一致');
    for (const item of plan.approvedSources) if (publicSourceProof(path.join(frozenPackage, item.sourceRel), item.sourceRel) !== item.sourceBefore.hash) throw new Error('冻结来源与批准内容不一致：' + item.id);
  };
  const verifyStaged = () => {
    for (const item of plan.changes) if (!item.staged || publicSourceProof(item.staged, item.entry.source) !== item.sourceBefore.hash) throw new Error('暂存内容与规划时批准的公开来源不一致：' + item.id);
  };
  const mkdirParents = dir => {
    if (normalized(dir) === normalized(plan.client)) return;
    try { if (!fs.statSync(dir).isDirectory()) throw new Error('目标父路径不是目录'); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirParents(path.dirname(dir)); assertPath(plan, path.join(dir, 'placeholder'));
    fs.mkdirSync(dir); const stat = fs.lstatSync(dir); createdParents.push({ file: dir, ino: stat.ino, dev: stat.dev });
  };
  const publish = item => {
    // Check every source and every staged payload before each publication.
    // A source changed just for the child copy and then restored is caught by
    // the content proof of the staged bytes, not merely a final source read.
    verifySources(); verifyFrozen(); verifyStaged();
    for (const prior of applied) if (prior.entry && publicSourceProof(prior.target, prior.entry.source) !== prior.sourceBefore.hash) throw new Error('已发布内容在事务期间改变：' + prior.id);
    assertPath(plan, item.target);
    if (!same(snapshot(item.target), item.before)) throw new Error('安装目标在规划后改变：' + (item.id || item.target));
    mkdirParents(path.dirname(item.target));
    item.owned = []; item.backup = path.join(stage, 'prior-' + applied.length); applied.push(item);
    if (item.before) {
      fs.renameSync(item.target, item.backup); item.moved = true;
      if (!same(snapshot(item.backup), item.before)) throw new Error('目标在发布时发生并发改变：' + (item.id || item.target));
    }
    assertPath(plan, item.target);
    createExclusive(item.staged, item.target, item.owned);
    if (item.entry && publicSourceProof(item.target, item.entry.source) !== item.sourceBefore.hash) throw new Error('实际发布内容与批准版本不一致：' + item.id);
  };
  try {
    verifySources();
    // Freeze only approved public sources and executable dependencies. No
    // mutable original-package script is used as a child-process entry point.
    fs.mkdirSync(frozenPackage);
    fs.copyFileSync(plan.catalogFile, frozenCatalog, fs.constants.COPYFILE_EXCL);
    for (const item of plan.approvedSources) {
      const target = path.join(frozenPackage, item.sourceRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(item.source, target, { recursive: true, force: false, errorOnExist: true,
        filter: file => isPublicFile(path.relative(plan.root, file).split(path.sep).join('/')) });
    }
    verifySources(); verifyFrozen();
    // Only touched entries are staged: no account, transcript or unrelated
    // node_modules tree is copied from the user's client.
    for (const item of plan.changes) if (item.before) {
      const target = path.join(stagedClient, path.relative(plan.client, item.target));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(item.target, target, { recursive: true, force: false, errorOnExist: true });
      if (!same(snapshot(item.target), item.before)) throw new Error('安装目标在暂存时改变：' + item.id);
    }
    const env = { ...process.env, QODER_HOME: stagedClient };
    for (const item of plan.changes) {
      verifySources(); verifyFrozen();
      const args = [path.join(frozenPackage, 'scripts/pkg-catalog.cjs'), 'install', item.id, '--catalog', frozenCatalog, '--apply'];
      if (item.before) args.push('--force');
      if (item.tier) args.push('--tier', item.tier);
      const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 120000 });
      logs.push({ id: item.id, exit: result.status, stdout: result.stdout || '', stderr: result.stderr || '' });
      if (result.status !== 0) throw new Error('条目暂存安装失败：' + item.id + '（exit=' + result.status + '）');
      item.staged = path.join(stagedClient, path.relative(plan.client, item.target));
    }
    verifySources(); verifyFrozen(); verifyStaged();
    for (const item of plan.changes) publish(item);
    if (plan.baseReady) {
      for (const item of plan.verifyTargets) {
        assertPath(plan, item.target);
        if (!same(snapshot(item.target), item.before)) throw new Error('基础路由在安装期间改变：' + item.id);
      }
      // Collect the actual two installed tiers after publication. Stage-only
      // indexes omit unrelated skills and contain transient absolute paths.
      const index = path.join(stage, 'skills-index.json');
      const code = "const fs=require('node:fs'),b=require(process.argv[1]);const entries=b.collectSkills();fs.writeFileSync(process.argv[2],JSON.stringify({generated_at:new Date().toISOString(),count:entries.length,entries},null,1),{flag:'wx',mode:0o600});";
      verifySources(); verifyFrozen();
      const result = spawnSync(process.execPath, ['-e', code, path.join(frozenPackage, 'scripts/build-skills-index.cjs'), index], { env: { ...process.env, QODER_HOME: plan.client }, encoding: 'utf8', timeout: 60000 });
      if (result.status !== 0) throw new Error('真实客户端技能索引生成失败：' + String(result.stderr || '').slice(0, 200));
      publish({ id: 'metadata:skills-index', target: path.join(plan.client, 'skills-index.json'), before: plan.indexBefore, staged: index });
      if (plan.hook.state !== 'KEEP') {
        const file = path.join(stage, 'settings.json'); fs.writeFileSync(file, plan.hook.bytes, { flag: 'wx', mode: 0o600 });
        publish({ id: 'metadata:settings', target: path.join(plan.client, 'settings.json'), before: plan.settingsBefore, staged: file });
      } else if (!same(snapshot(path.join(plan.client, 'settings.json')), plan.settingsBefore)) throw new Error('既有hook配置在安装期间改变');
    }
    if (plan.baseReady) {
      const pointer = path.join(stage, 'share-package.json'); fs.writeFileSync(pointer, JSON.stringify(plan.pointerValue, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      publish({ id: 'metadata:share-package', target: path.join(plan.client, 'share-package.json'), before: plan.pointerBefore, staged: pointer });
    }
    const receipt = { schema: 1, installedAt: new Date().toISOString(), catalog: plan.catalogFile, catalogSha256: plan.catalogHash, ready: plan.baseReady, hook: plan.baseReady ? plan.hook.state : 'BLOCKED', baseBlocked: plan.baseBlocked, installedIds: plan.changes.map(item => item.id), recoveryDirectory: stage };
    const receiptFile = path.join(stage, 'package-activation.json'); fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    publish({ id: 'metadata:activation', target: path.join(plan.client, 'package-activation.json'), before: plan.receiptBefore, staged: receiptFile });
    fs.writeFileSync(path.join(stage, 'transaction.json'), JSON.stringify({ status: 'COMMITTED', receipt, logs }, null, 2));
    return withPending({ status: plan.baseReady ? 'INSTALLED' : 'ACTIVATION_BLOCKED', ready: plan.baseReady, recoveryDirectory: stage, frozenPackage, receipt, logs, plan });
  } catch (error) {
    const conflicts = [];
    for (const item of applied.reverse()) {
      try {
        assertPath(plan, item.target);
        for (const owned of item.owned.reverse()) {
          let stat;
          try { stat = fs.lstatSync(owned.file); } catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
          if (stat.ino !== owned.ino || stat.dev !== owned.dev || stat.isSymbolicLink()) { conflicts.push(owned.file); continue; }
          if (owned.directory) { if (fs.readdirSync(owned.file).length) { conflicts.push(owned.file); continue; } fs.rmdirSync(owned.file); }
          else if (digest(fs.readFileSync(owned.file)) === owned.hash) {
            // Detach before the final ownership check so a replacement in the
            // read-to-unlink window is retained rather than deleted.
            const withdrawn = path.join(stage, 'withdrawn-' + crypto.randomUUID());
            fs.renameSync(owned.file, withdrawn);
            const actual = fs.lstatSync(withdrawn);
            if (actual.ino === owned.ino && actual.dev === owned.dev && actual.isFile() && !actual.isSymbolicLink() && digest(fs.readFileSync(withdrawn)) === owned.hash) fs.unlinkSync(withdrawn);
            else {
              try { fs.linkSync(withdrawn, owned.file); } catch {}
              conflicts.push(owned.file);
            }
          } else conflicts.push(owned.file);
        }
        if (item.moved) {
          // Same-volume hardlinks restore the old bytes without a second data
          // allocation after ENOSPC, and still refuse a concurrent target.
          restoreExclusive(item.backup, item.target);
        }
      } catch { conflicts.push(item.target); }
    }
    for (const parent of createdParents.reverse()) {
      try { const stat = fs.lstatSync(parent.file); if (stat.ino === parent.ino && stat.dev === parent.dev && !stat.isSymbolicLink() && fs.readdirSync(parent.file).length === 0) fs.rmdirSync(parent.file); } catch {}
    }
    try { fs.writeFileSync(path.join(stage, 'transaction.json'), JSON.stringify({ status: conflicts.length ? 'RECOVERY_REQUIRED' : 'ROLLED_BACK', error: error.message, conflicts, logs }, null, 2)); } catch {}
    error.message += '；' + (conflicts.length ? '并发内容与备份均保留，需核对' : '本事务变更已回滚') + '；恢复目录：' + stage;
    throw error;
  }
}

function printSummary(result) {
  const plan = result.plan;
  const pendingItems = result.pendingItems || withPending(result).pendingItems;
  console.log('Qoder-Optimization 包能力核对：' + plan.catalogFile);
  console.log('客户端：' + plan.client + '；状态：' + result.status);
  if (result.receipt?.installedIds?.length) console.log('APPLIED: ' + result.receipt.installedIds.join(', '));
  for (const action of ['UPDATE', 'ASK_INSTALL', 'REVIEW_UPDATE', 'KEEP', 'SKIP']) {
    const items = (action === 'KEEP' || action === 'SKIP' ? plan.items : pendingItems).filter(item => item.action === action);
    console.log(action + ': ' + items.length);
    if (action !== 'KEEP' && action !== 'SKIP') for (const item of items) console.log('  ' + (item.id || item.entry.id) + ' — ' + (item.reason || item.reasonCode || action));
  }
  if (result.status === 'DRY_RUN') console.log('未写盘；--yes 接受基础路由与有旧包基线的 UPDATE。新可选能力只在 --install <exact-id> 明确选择后安装。');
  if (!plan.baseReady) console.log('基础路由因本地差异未接线：' + plan.baseBlocked.join(', '));
  if (result.recoveryDirectory) console.log('备份/事务记录：' + result.recoveryDirectory);
  if (pendingItems.length) console.log('NEXT_ACTION: ASK_INSTALL_OR_UPDATE — 仅询问上述未完成的候选/差异；已完成的基础安装、更新与精确选择无需重复批准。');
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('用法：node scripts/install-package.cjs [--yes] [--dry-run] [--client-root <目录>] [--catalog <catalog.json>] [--install <exact-id>] [--resident <exact-id>] [--preferences <json>] [--continuity] [--no-auto-bind] [--json]\n默认只核对；--yes 安装基础路由并更新与旧包一致的已安装条目。缺失可选项另用 --install 明确选择，个人修改只报告。所选技能默认进按需库；交互运行会询问是否常驻，非交互用 --resident 选择常驻（需与 --install 同时给出）。已安装技能换层请用 tier-skills --promote。接续存储仅在 --continuity 单独同意时调用旧安装器。');
    return 0;
  }
  if (options.skip) { console.log('已跳过，未修改任何文件。'); return 0; }
  let plan = prepare(options);
  if (!options.yes && !options.dryRun && !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY) {
    printSummary({ status: 'DRY_RUN', plan });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      options.yes = /^(?:y|yes|是|同意)$/i.test((await rl.question('安装基础路由并更新有安全旧包基线的已有能力？[y/N] ')).trim());
      const installSkills = (options.install || []).filter(id => id.startsWith('skill:') && plan.items.find(item => (item.id || item.entry?.id) === id)?.action !== 'KEEP');
      if (options.yes && installSkills.length && !(options.resident || []).length) {
        options.resident = /^(?:y|yes|是|同意)$/i.test((await rl.question('本次选择的技能（' + installSkills.join(', ') + '）是否设为常驻？常驻描述每轮注入。[y/N] ')).trim()) ? installSkills : [];
        plan = prepare(options);
      }
    } finally { rl.close(); }
  }
  const result = apply(plan, options);
  let continuityExit = 0;
  if (options.yes && !options.dryRun && options.continuity) {
    const args = [path.resolve(result.frozenPackage, 'scripts/install-continuity.cjs'), '--yes', '--client-root', plan.client];
    if (options.noAutoBind) args.push('--no-auto-bind');
    const continuation = spawnSync(process.execPath, args, { stdio: options.json ? 'pipe' : 'inherit', encoding: 'utf8', env: process.env });
    continuityExit = continuation.status === null ? 1 : continuation.status;
    result.continuity = { exit: continuityExit, ...(options.json ? { stdout: continuation.stdout || '', stderr: continuation.stderr || '' } : {}) };
  }
  if (options.json) {
    // Existing settings may contain credentials; never serialize the private
    // snapshots or merged settings bytes held by the transaction plan.
    const publicPlan = { catalogFile: plan.catalogFile, client: plan.client, baseReady: plan.baseReady, baseBlocked: plan.baseBlocked, diagnostics: plan.diagnostics, changes: plan.changes.map(item => ({ id: item.id, target: item.target, update: Boolean(item.before) })), items: plan.items.map(({ id, action, reason, present, installedPaths }) => ({ id, action, reason, present, installedPaths })) };
    console.log(JSON.stringify({ ...result, nextAction: result.pendingItems.length ? 'ASK_INSTALL_OR_UPDATE' : null, plan: publicPlan }));
  } else printSummary(result);
  if (continuityExit !== 0) { if (!options.json) console.error('基础包结果已保留；可选 continuity 未完成。'); return continuityExit; }
  return result.status === 'ACTIVATION_BLOCKED' ? 3 : 0;
}

module.exports = { BASE_IDS, parseArgs, prepare, apply, settingsFor };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error('PACKAGE_INSTALL_ERROR: ' + error.message); process.exitCode = 1; });
