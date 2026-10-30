#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const VERSION = 'conventions/1';
const DIMENSIONS = ['coding-style', 'tools', 'dependencies', 'versions', 'i18n'];
const EXTRA_DIMENSIONS = ['architecture', 'testing', 'data', 'security', 'delivery', 'documentation'];
const CHECKS = ['style.syntax', 'style.command', 'tools.identity', 'dependencies.lock', 'versions.range', 'i18n.catalog', 'architecture.review', 'testing.command', 'data.review', 'security.review', 'delivery.review', 'documentation.review'];
const MAX_BYTES = 2 * 1024 * 1024;
const text = value => typeof value === 'string' && value.trim().length > 0;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function dependencies() {
  try { return require('./convention-runtime'); }
  catch (error) { fail('DEPENDENCY_MISSING', 'Install the locked project dependencies: npm ci --prefix scripts/convention-runtime --ignore-scripts'); }
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) fail('INVALID_INPUT', 'values must be JSON data');
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : stable(value)).digest('hex'); }
function copy(value) { return JSON.parse(stable(value)); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function parseJson(source) {
  const value = JSON.parse(source);
  const ast = dependencies().acorn.parseExpressionAt(source, 0, { ecmaVersion: 2022 });
  function visit(node, depth) {
    if (depth > 48) fail('INVALID_INPUT', 'JSON nesting exceeds 48');
    if (node.type === 'ObjectExpression') {
      const keys = new Set();
      for (const property of node.properties) {
        const key = property.key.value;
        if (keys.has(key)) fail('DUPLICATE_KEY', 'duplicate JSON key');
        keys.add(key); visit(property.value, depth + 1);
      }
    } else if (node.type === 'ArrayExpression') for (const element of node.elements) visit(element, depth + 1);
  }
  visit(ast, 0);
  return value;
}
function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) fail('INVALID_INPUT', 'JSON must be a regular file of at most 2MiB');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) fail('INVALID_INPUT', 'JSON grew beyond the size limit');
  return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function relativeName(value, allowRoot = false) {
  if (allowRoot && value === '.') return '.';
  if (!text(value) || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || value.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) fail('PATH_SCOPE', 'use a project-relative path without redirects or traversal');
  return value;
}
function contained(root, target) { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
function projectRoot(root) {
  if (!text(root) || !path.isAbsolute(root)) fail('PATH_SCOPE', 'an absolute project root is required');
  const resolved = fs.realpathSync.native(root);
  if (!fs.statSync(resolved).isDirectory()) fail('PATH_SCOPE', 'project root is not a directory');
  return resolved;
}
function projectFile(root, relative) {
  relativeName(relative);
  const target = path.resolve(root, relative);
  let cursor = target;
  while (!fs.existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) fail('PATH_SCOPE', 'unresolvable file'); cursor = parent; }
  if (!contained(root, fs.realpathSync.native(cursor))) fail('PATH_SCOPE', 'file redirects outside the project');
  return target;
}
function git(root, args) {
  const env = {};
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) if (process.env[k]) env[k] = process.env[k];
  env.GIT_OPTIONAL_LOCKS = '0';
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, timeout: 15000, maxBuffer: 4 * MAX_BYTES, windowsHide: true });
  if (r.status !== 0 || r.error) fail('GIT_UNAVAILABLE', 'read-only Git operation failed');
  return r.stdout;
}
function identity(root) {
  root = projectRoot(root);
  const stat = fs.statSync(root, { bigint: true });
  const worktreeId = hash({ device: String(stat.dev), inode: String(stat.ino) });
  let repositoryId = worktreeId;
  if (fs.existsSync(path.join(root, '.git'))) {
    const common = fs.realpathSync.native(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    const commonStat = fs.statSync(common, { bigint: true });
    repositoryId = hash({ device: String(commonStat.dev), inode: String(commonStat.ino) });
  }
  return { root, repositoryId, worktreeId };
}
function snapshot(root, files, mode = 'working-tree') {
  root = projectRoot(root);
  if (!['working-tree', 'staged'].includes(mode) || !Array.isArray(files) || !files.length || files.length > 200 || new Set(files).size !== files.length) fail('INVALID_INPUT', 'snapshot requires 1..200 unique files and a known mode');
  const records = [];
  for (const name of [...files].sort()) {
    const file = projectFile(root, name);
    if (/(^|\/)(\.env(?:\..*)?|credentials[^/]*|[^/]+\.(?:pem|key))$/i.test(name)) fail('SENSITIVE_PATH', 'secret material is not an observation source');
    let content = null;
    if (mode === 'staged') {
      const entries = git(root, ['ls-files', '--stage', '-z', '--', name]).split('\0').filter(Boolean);
      if (entries.length) {
        const match = entries.length === 1 && entries[0].match(/^(100644|100755) ([a-f0-9]+) 0\t([\s\S]+)$/);
        if (!match || match[3] !== name) fail('GIT_SNAPSHOT', 'unmerged or redirected index entry');
        content = git(root, ['cat-file', 'blob', match[2]]);
      }
    } else if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) fail('INVALID_INPUT', 'snapshot entry must be a file of at most 2MiB');
      const bytes = fs.readFileSync(file);
      if (bytes.length > MAX_BYTES) fail('INVALID_INPUT', 'snapshot entry grew beyond the limit');
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    records.push({ path: name, exists: content !== null, sha256: content === null ? null : hash(content), content });
  }
  const stamp = records.map(({ content, ...record }) => record);
  return { schema: 1, ...identity(root), mode, digest: hash(stamp), files: records };
}
function verifySource(root, source) {
  if (!source || !text(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256 || '')) fail('SOURCE_MISSING', 'source path and SHA256 are required');
  const record = snapshot(root, [source.path]).files[0];
  if (!record.exists || record.sha256 !== source.sha256) fail('SOURCE_CHANGED', 'source is missing or changed: ' + source.path);
  return { path: source.path, sha256: source.sha256 };
}
function matches(scope, file) { return scope === '.' || file === scope || file.startsWith(scope + '/'); }
function aggregate(checks) {
  if (!Array.isArray(checks) || !checks.length) return { status: 'UNVERIFIED', exitCode: 2, checks: [], reason: 'no checks were evaluated' };
  if (checks.some(c => !c || !['PASS', 'FAIL', 'UNVERIFIED', 'NOT_APPLICABLE'].includes(c.status))) fail('INVALID_RESULT', 'unknown check status');
  const status = checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'UNVERIFIED') ? 'UNVERIFIED' : checks.every(c => c.status === 'NOT_APPLICABLE') ? 'NOT_APPLICABLE' : 'PASS';
  return { status, exitCode: status === 'FAIL' ? 1 : status === 'UNVERIFIED' ? 2 : 0, checks };
}
function discover(root, files = []) {
  root = projectRoot(root);
  const known = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.editorconfig', '.prettierrc.json', 'eslint.config.js', '.nvmrc', '.node-version', 'tsconfig.json'];
  const found = known.filter(name => fs.existsSync(projectFile(root, name)));
  const selected = [...new Set([...found, ...files])];
  const current = selected.length ? snapshot(root, selected) : { ...identity(root), mode: 'working-tree', digest: hash([]), files: [] };
  const observations = current.files.map(({ path: file, exists, sha256 }) => ({ path: file, exists, sha256 }));
  const manifest = current.files.find(f => f.path === 'package.json' && f.exists);
  let packageInfo = null;
  if (manifest) {
    const p = parseJson(manifest.content);
    packageInfo = { packageManager: p.packageManager || null, engines: p.engines || {}, scripts: Object.keys(p.scripts || {}), dependencies: Object.keys(p.dependencies || {}), devDependencies: Object.keys(p.devDependencies || {}) };
  }
  return { schema: 1, version: VERSION, project: identity(root), observations, packageInfo, dimensions: DIMENSIONS, policy: null, writes: 0, limits: 'Observed files are evidence, not approved policy. No configuration or package scripts were executed.' };
}
function resolve(request, authority = {}) {
  if (!request || request.schema !== 1 || !/^[A-Za-z0-9_-]{1,100}$/.test(request.taskId || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(request.sessionId || '') || !['read-only', 'write'].includes(request.mode)) fail('INVALID_INPUT', 'schema, safe task/session IDs and mode are required');
  const project = identity(request.projectRoot);
  const current = snapshot(project.root, request.files, request.snapshotMode || 'working-tree');
  const scopeDigest = hash({ version: VERSION, worktreeId: project.worktreeId, taskId: request.taskId, sessionId: request.sessionId, files: [...request.files].sort(), mode: request.mode, snapshotMode: current.mode, applicability: request.applicability || {}, extraDimensions: request.extraDimensions || [] });
  const extras = request.extraDimensions || [];
  if (!Array.isArray(extras) || extras.some(d => !EXTRA_DIMENSIONS.includes(d))) fail('INVALID_INPUT', 'unknown extra dimension');
  const dimensions = [...new Set([...DIMENSIONS, ...extras])];
  const facts = request.applicability || {};
  const allRules = request.rules || [];
  if (!Array.isArray(allRules) || allRules.length > 200 || new Set(allRules.map(r => r?.id)).size !== allRules.length) fail('INVALID_INPUT', 'rules must have unique IDs');
  const rules = allRules.map(rule => {
    if (!rule || !/^[A-Za-z0-9_.-]{1,80}$/.test(rule.id || '') || !dimensions.includes(rule.dimension) || !text(rule.key) || typeof rule.overridable !== 'boolean'
        || !['policy', 'observation'].includes(rule.kind) || !Array.isArray(rule.checkIds) || rule.checkIds.some(id => !CHECKS.includes(id))) fail('INVALID_RULE', 'invalid declarative rule');
    relativeName(rule.scope, true);
    if (rule.value === undefined || /"(?:command|shell|exec|eval)"\s*:/.test(stable(rule.value))) fail('UNTRUSTED_COMMAND', 'rules declare checks, never executable commands');
    const source = verifySource(project.root, rule.source);
    const pin = (authority.sources || []).find(s => s.path === source.path && s.sha256 === source.sha256);
    const trusted = rule.kind === 'policy' && pin && Array.isArray(pin.ruleDigests) && pin.ruleDigests.includes(hash(rule))
      && authority.taskId === request.taskId && authority.sessionId === request.sessionId && authority.worktreeId === project.worktreeId && authority.scopeDigest === scopeDigest;
    const before = (authority.baseline || []).find(s => s.path === source.path && s.sha256 === source.sha256);
    return { ...copy(rule), source, trusted: Boolean(trusted), independent: Boolean(before) && !(authority.generatedPaths || []).includes(source.path) };
  });
  const decisions = [], sources = [];
  for (const dimension of dimensions) {
    const fact = facts[dimension];
    const relevant = rules.filter(r => r.dimension === dimension && request.files.some(f => matches(r.scope, f)));
    const base = { dimension, decision: 'needs_evidence', reasons: [], rules: [], checkIds: [] };
    if (!fact || typeof fact.applies !== 'boolean' || !text(fact.reason) || !fact.source) {
      decisions.push({ ...base, reasons: ['applicability needs a scoped source'] }); continue;
    }
    sources.push(verifySource(project.root, fact.source));
    if (!fact.applies && !relevant.length) { decisions.push({ ...base, decision: 'not_applicable', reasons: [fact.reason] }); continue; }
    if (!fact.applies) { decisions.push({ ...base, reasons: ['an applicable rule cannot be removed by an applicability flag'] }); continue; }
    const unknownPolicy = relevant.some(r => r.kind === 'policy' && !r.trusted);
    if (unknownPolicy) { decisions.push({ ...base, reasons: ['policy source has no matching host approval'] }); continue; }
    const targets = fact.files || request.files;
    if (!Array.isArray(targets) || !targets.length || targets.some(f => !request.files.includes(f))) fail('INVALID_INPUT', 'dimension targets must be part of the current task');
    const selected = [], conflicts = [];
    for (const file of targets) {
      const scoped = relevant.filter(r => matches(r.scope, file));
      for (const key of new Set(scoped.map(r => r.key))) {
        const candidates = scoped.filter(r => r.key === key);
        const policies = candidates.filter(r => r.trusted);
        const pool = policies.length ? policies : candidates.filter(r => r.independent && r.lowCost === true && r.reversible === true);
        if (!pool.length) continue;
        const depth = r => r.scope === '.' ? 0 : r.scope.split('/').length;
        const max = Math.max(...pool.map(depth));
        const nearest = pool.filter(r => depth(r) === max);
        const chosen = nearest[0];
        const lockedConflict = policies.some(r => !r.overridable && hash(r.value) !== hash(chosen.value));
        if (nearest.some(r => hash(r.value) !== hash(chosen.value)) || lockedConflict) {
          const conflict = { file, key, dimension, ruleIds: pool.map(r => r.id).sort() };
          const conflictDigest = hash({ ...conflict, scopeDigest, rules: pool.map(r => hash(r)).sort() });
          const resolution = (authority.resolutions || []).find(r => r.scopeDigest === scopeDigest && r.conflictDigest === conflictDigest && text(r.sourceRef));
          const decided = resolution && pool.find(r => r.id === resolution.selectedRuleId);
          if (decided && (!policies.some(r => !r.overridable && hash(r.value) !== hash(decided.value)) || resolution.overrideLocked === true)) selected.push({ ...decided, file, taskDecisionRef: resolution.sourceRef });
          else conflicts.push({ ...conflict, conflictDigest });
        } else selected.push({ ...chosen, file });
      }
    }
    const uncoveredFiles = targets.filter(file => !selected.some(r => r.file === file));
    const decision = conflicts.length ? 'ask' : selected.length && !uncoveredFiles.length ? 'apply' : 'needs_evidence';
    const checks = [...new Set([...selected, ...relevant.filter(r => r.trusted)].flatMap(r => r.checkIds))].sort();
    const unique = [...new Set(selected.map(r => r.id))];
    decisions.push({ ...base, decision, reasons: [conflicts.length ? 'conflicting applicable requirements' : selected.length ? 'scoped requirements resolved' : 'no independent compatible source'], rules: unique, bindings: selected.map(r => ({ file: r.file, ruleId: r.id, key: r.key, value: r.value, checkIds: r.checkIds, origin: r.taskDecisionRef ? 'task-decision' : r.trusted ? 'policy' : 'task-inference', decisionRef: r.taskDecisionRef || null })), uncoveredFiles, conflicts, checkIds: checks, independentSources: new Set(relevant.filter(r => r.independent).map(r => r.source.sha256)).size });
  }
  const requiredCheckIds = [...new Set(decisions.flatMap(d => d.checkIds))].sort();
  const result = { schema: 1, version: VERSION, taskId: request.taskId, sessionId: request.sessionId, mode: request.mode, snapshotMode: current.mode, project, scopeDigest, snapshotDigest: current.digest,
    files: current.files.map(({ content, ...f }) => f), sources: [...new Map([...sources, ...rules.map(r => r.source)].map(s => [s.path, s])).values()],
    decisions, requiredCheckIds, ready: decisions.every(d => ['apply', 'not_applicable'].includes(d.decision)), writes: 0,
    limits: 'Host approval and task applicability must originate outside repository observations. This result is not installation, execution or publication permission.' };
  result.packageDigest = hash(result);
  return freeze(result);
}
function assertPackage(bundle) {
  if (!bundle || bundle.schema !== 1 || bundle.version !== VERSION) fail('INVALID_PACKAGE', 'unsupported convention package');
  const { packageDigest, ...body } = bundle;
  if (hash(body) !== packageDigest || DIMENSIONS.some(d => !body.decisions.some(x => x.dimension === d))) fail('PACKAGE_CHANGED', 'convention package changed or lost a required dimension');
  return bundle;
}
function cli(run) {
  try { const result = run(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.exitCode ?? (result.ready === false ? 2 : 0); }
  catch (error) { console.error(JSON.stringify({ status: 'UNVERIFIED', exitCode: 2, code: error.code || 'INVALID_INPUT', reason: error.message })); process.exitCode = 2; }
}
module.exports = { VERSION, DIMENSIONS, EXTRA_DIMENSIONS, CHECKS, MAX_BYTES, fail, text, dependencies, stable, hash, copy, freeze, parseJson, readJson, projectRoot, projectFile, relativeName, contained, git, identity, snapshot, verifySource, aggregate, discover, resolve, assertPackage, cli };
if (require.main === module) cli(args => {
  if (args[0] === 'discover' && args[1] === '--project' && args.length === 3) return discover(args[2]);
  if (args[0] === 'resolve' && [2, 4].includes(args.length) && (args.length === 2 || args[2] === '--authority')) return resolve(readJson(args[1]), args[3] ? readJson(args[3]) : {});
  fail('USAGE', 'node convention-core.cjs discover --project <root> | resolve <request.json> [--authority <host-approval.json>]');
});
