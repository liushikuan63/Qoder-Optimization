#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./convention-core.cjs');

function result(id, status, issues = [], extra = {}) { return { id, status, issues, ...extra }; }
function inspectStyle(current, policy) {
  const issues = [], unknown = [];
  let parsed = 0;
  if (!policy || !['commonjs', 'esm'].includes(policy.modules) || (policy.quotes && !['single', 'double'].includes(policy.quotes))) return result('style.syntax', 'UNVERIFIED', ['explicit supported style policy is required']);
  for (const file of current.files.filter(f => f.exists)) {
    if (!/\.(?:cjs|mjs|js)$/.test(file.path)) { unknown.push(file.path + ': unsupported code syntax'); continue; }
    const tokens = [];
    try {
      core.dependencies().acorn.parse(file.content, { ecmaVersion: 'latest', sourceType: policy.modules === 'esm' ? 'module' : 'script', locations: true, onToken: tokens });
      parsed++;
    } catch (error) { issues.push({ code: 'SYNTAX_OR_MODULE', file: file.path, line: error.loc?.line || 1, message: 'invalid syntax for the selected module format' }); continue; }
    if (policy.quotes) {
      const quote = policy.quotes === 'single' ? "'" : '"';
      for (const token of tokens.filter(t => t.type.label === 'string')) {
        const raw = file.content.slice(token.start, token.end);
        if (raw[0] !== quote && !raw.includes(quote)) issues.push({ code: 'QUOTES', file: file.path, line: token.loc.start.line, token: raw });
      }
    }
    if (policy.noTabs === true) file.content.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*\t/.test(line)) issues.push({ code: 'INDENT_TABS', file: file.path, line: i + 1 });
    });
  }
  return result('style.syntax', issues.length ? 'FAIL' : unknown.length || !parsed ? 'UNVERIFIED' : 'PASS', [...issues, ...unknown], { parsed, level: 'static', limits: 'Syntax, module parsing, token quotes and indentation only; architecture and naming need a project checker or independent review.' });
}
function commandDigest(definition) { return core.hash(definition); }
function runTrusted(definition, context, authority) {
  const id = definition?.id || 'tools.identity';
  if (context.mode === 'read-only' || context.snapshotMode === 'staged') return result(id, 'UNVERIFIED', ['read-only tasks and unmaterialized index snapshots do not execute project commands']);
  if (!definition || !core.CHECKS.includes(id) || !Array.isArray(definition.args) || !definition.args.every(a => typeof a === 'string') || definition.args.length > 40
      || !path.isAbsolute(definition.executable || '') || !/^[a-f0-9]{64}$/.test(definition.sha256 || '') || !Array.isArray(definition.inputs)) return result(id, 'UNVERIFIED', ['invalid trusted checker definition']);
  const stamp = commandDigest(definition);
  if (!authority || authority.taskId !== context.taskId || authority.worktreeId !== core.identity(context.projectRoot).worktreeId || !authority.commandDigests?.includes(stamp)) return result(id, 'UNVERIFIED', ['checker implementation and arguments need explicit host approval']);
  const expected = definition.expect;
  if (!expected || !Number.isInteger(expected.exitCode) || !Array.isArray(expected.stdoutIncludes) || !expected.stdoutIncludes.length || !expected.stdoutIncludes.every(core.text)) return result(id, 'UNVERIFIED', ['freeze a nonempty independent expectation before execution']);
  try {
    const executable = fs.realpathSync.native(definition.executable);
    if (core.hash(fs.readFileSync(executable)) !== definition.sha256) return result(id, 'FAIL', ['approved executable has changed'], { executed: false });
    for (const arg of definition.args) {
      const candidate = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      if (!candidate || candidate.startsWith('-')) continue;
      const absolute = path.resolve(context.projectRoot, candidate);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const relative = path.relative(core.projectRoot(context.projectRoot), absolute).split(path.sep).join('/');
      if (!definition.inputs.some(source => source.path === relative)) return result(id, 'UNVERIFIED', ['file arguments must be included in the approved implementation fingerprints'], { executed: false });
    }
    for (const source of definition.inputs) core.verifySource(core.projectRoot(context.projectRoot), source);
    const env = {};
    for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
    const beganAt = new Date().toISOString();
    const child = spawnSync(executable, definition.args, { cwd: core.projectRoot(context.projectRoot), env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
    const record = { schema: 1, commandDigest: stamp, taskId: context.taskId, worktreeId: authority.worktreeId, beganAt, endedAt: new Date().toISOString(), executable, level: 'runtime', termination: child.error || child.signal || child.status === null ? 'incomplete' : 'completed', exitCode: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
    if (record.termination !== 'completed') return result(id, 'UNVERIFIED', ['checker timed out, crashed or exceeded output limits'], { executed: true, record });
    if (core.hash(fs.readFileSync(executable)) !== definition.sha256) return result(id, 'FAIL', ['executable changed during the check'], { executed: true, record });
    for (const source of definition.inputs) core.verifySource(core.projectRoot(context.projectRoot), source);
    const matched = record.exitCode === expected.exitCode && expected.stdoutIncludes.every(s => record.stdout.includes(s));
    return result(id, matched ? 'PASS' : 'FAIL', matched ? [] : ['actual observation differs from the frozen expectation'], { executed: true, record });
  } catch (error) { return result(id, 'UNVERIFIED', [error.code || 'CHECKER_UNAVAILABLE'], { executed: false }); }
}
function checkVersions(policy, observation) {
  const semver = core.dependencies().semver;
  if (!policy || !semver.validRange(policy.declared || '') || !semver.valid(policy.locked || '')) return result('versions.range', 'UNVERIFIED', ['declared range and resolved version must both be available']);
  if (!observation || !semver.valid(observation.version || '') || !core.text(observation.sourceRef)) return result('versions.range', 'UNVERIFIED', ['actual runtime identity/version is missing']);
  const actual = semver.clean(observation.version);
  const mismatch = !semver.satisfies(policy.locked, policy.declared) || !semver.satisfies(actual, policy.declared)
    || (policy.exactRuntime === true && !semver.eq(actual, policy.locked))
    || (policy.executable && fs.realpathSync.native(policy.executable) !== fs.realpathSync.native(observation.executable));
  return result('versions.range', mismatch ? 'FAIL' : 'PASS', mismatch ? ['declared, resolved or actual runtime versions do not satisfy policy'] : [], { declared: policy.declared, locked: policy.locked, actual, sourceRef: observation.sourceRef, level: 'runtime' });
}
function checkDependencies(current, policy) {
  const files = new Map(current.files.map(f => [f.path, f]));
  const manifest = files.get(policy?.manifest || 'package.json'), lock = files.get(policy?.lock || 'package-lock.json');
  if (!manifest?.exists || !lock?.exists) return result('dependencies.lock', 'UNVERIFIED', ['required manifest or lockfile is missing']);
  const issues = [], unknown = [];
  try {
    const pkg = core.parseJson(manifest.content), locked = core.parseJson(lock.content), semver = core.dependencies().semver;
    if (pkg.workspaces || ![2, 3].includes(locked.lockfileVersion) || !locked.packages?.['']) return result('dependencies.lock', 'UNVERIFIED', ['only non-workspace npm lockfile v2/v3 is supported']);
    const groups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const used = new Map();
    for (const group of groups) {
      const declared = pkg[group] || {}, pinned = locked.packages[''][group] || {};
      if (core.hash(declared) !== core.hash(pinned)) issues.push({ code: 'LOCK_DECLARATION', group });
      for (const [name, range] of Object.entries(declared)) {
        if (used.has(name) && group !== 'peerDependencies') issues.push({ code: 'DEPENDENCY_SCOPE', name });
        used.set(name, group);
        if (!semver.validRange(range)) { unknown.push({ code: 'UNSUPPORTED_DEPENDENCY_SPEC', name }); continue; }
        const entry = locked.packages['node_modules/' + name];
        if (!entry || !semver.valid(entry.version || '')) { unknown.push({ code: 'UNRESOLVED_DEPENDENCY', name }); continue; }
        if (!semver.satisfies(entry.version, range)) issues.push({ code: 'DEPENDENCY_VERSION', name });
        if (group === 'dependencies' && entry.dev === true) issues.push({ code: 'DEPENDENCY_SCOPE', name });
        if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity || '')) unknown.push({ code: 'INTEGRITY_MISSING', name });
        if (!Array.isArray(policy.allowedRegistries) || !policy.allowedRegistries.length) unknown.push({ code: 'REGISTRY_POLICY_MISSING', name });
        else {
          try {
            const url = new URL(entry.resolved);
            if (url.username || url.password || url.protocol !== 'https:' || !policy.allowedRegistries.some(base => url.origin === new URL(base).origin && url.pathname.startsWith(new URL(base).pathname))) issues.push({ code: 'DEPENDENCY_SOURCE', name });
          } catch { unknown.push({ code: 'DEPENDENCY_SOURCE_UNKNOWN', name }); }
        }
        if (policy.baseline && !groups.some(g => Object.hasOwn(policy.baseline[g] || {}, name)) && !(policy.approvedAdditions || []).includes(name)) issues.push({ code: 'UNAPPROVED_ADDITION', name });
      }
    }
    for (const [location, entry] of Object.entries(locked.packages)) {
      if (location === '') continue;
      if (!entry || typeof entry !== 'object' || entry.link || !semver.valid(entry.version || '')) { unknown.push({ code: 'UNSUPPORTED_LOCK_ENTRY', location }); continue; }
      if (!used.has(location.replace(/^node_modules\//, ''))) {
        if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity || '')) unknown.push({ code: 'TRANSITIVE_INTEGRITY_MISSING', location });
        if (!Array.isArray(policy.allowedRegistries) || !policy.allowedRegistries.length) unknown.push({ code: 'REGISTRY_POLICY_MISSING', location });
        else {
          try {
            const url = new URL(entry.resolved);
            if (url.username || url.password || url.protocol !== 'https:' || !policy.allowedRegistries.some(base => url.origin === new URL(base).origin && url.pathname.startsWith(new URL(base).pathname))) issues.push({ code: 'TRANSITIVE_SOURCE', location });
          } catch { unknown.push({ code: 'TRANSITIVE_SOURCE_UNKNOWN', location }); }
        }
      }
      const requirements = { ...(entry.dependencies || {}), ...(entry.peerDependencies || {}), ...(entry.optionalDependencies || {}) };
      for (const [name, range] of Object.entries(requirements)) {
        let resolved = null, directory = location;
        while (!resolved) {
          if (path.posix.basename(directory) !== 'node_modules') resolved = locked.packages[path.posix.join(directory, 'node_modules', name)];
          if (directory === '.') break;
          directory = path.posix.dirname(directory);
        }
        const optional = Object.hasOwn(entry.optionalDependencies || {}, name) || entry.peerDependenciesMeta?.[name]?.optional === true;
        if (!resolved) { if (!optional) unknown.push({ code: 'TRANSITIVE_UNRESOLVED', location, name }); continue; }
        if (!semver.validRange(range) || !semver.valid(resolved.version || '')) unknown.push({ code: 'TRANSITIVE_SPEC_UNSUPPORTED', location, name });
        else if (!semver.satisfies(resolved.version, range)) issues.push({ code: 'TRANSITIVE_VERSION', location, name });
      }
    }
    for (const equivalents of policy.equivalentGroups || []) {
      const present = equivalents.filter(name => used.has(name));
      if (present.length > 1) issues.push({ code: 'DUPLICATE_CAPABILITY', names: present });
    }
    return result('dependencies.lock', issues.length ? 'FAIL' : unknown.length ? 'UNVERIFIED' : 'PASS', [...issues, ...unknown], { dependencies: used.size, level: 'static', limits: 'Lockfile declarations, integrity and approved origins only; package behavior and compatibility still require project tests.' });
  } catch (error) { return result('dependencies.lock', 'UNVERIFIED', [error.code || 'INVALID_MANIFEST']); }
}
function checkReview(review, current, authority) {
  const id = review?.id || 'architecture.review';
  if (!core.CHECKS.includes(id) || !id.endsWith('.review') || !review?.source || !core.text(review.reviewerRef)) return result(id, 'UNVERIFIED', ['an independent scoped review record is required']);
  try {
    const source = core.verifySource(current.root, review.source);
    if (!authority?.reviewDigests?.includes(core.hash(review))) return result(id, 'UNVERIFIED', ['review has no host-confirmed independent provenance']);
    const report = core.readJson(core.projectFile(current.root, source.path));
    if (report.snapshotDigest !== current.digest || report.reviewerRef !== review.reviewerRef || (review.requirementsDigest && report.requirementsDigest !== review.requirementsDigest) || !['PASS', 'FAIL'].includes(report.status) || !core.text(report.reason)) return result(id, 'UNVERIFIED', ['review is missing scope, requirements, result or rationale']);
    return result(id, report.status, [report.reason], { level: 'review', reviewerRef: report.reviewerRef, source });
  } catch (error) { return result(id, 'UNVERIFIED', [error.code || 'REVIEW_MISSING']); }
}
function check(input, authority = {}) {
  if (!input || input.schema !== 1) core.fail('INVALID_INPUT', 'schema=1 is required');
  const current = core.snapshot(input.projectRoot, input.files, input.snapshotMode || 'working-tree');
  const checks = [];
  if (input.style) checks.push(inspectStyle(current, input.style));
  if (input.dependencies) checks.push(checkDependencies(current, input.dependencies));
  if (input.versions) {
    const observation = input.versions.tool === 'node' ? { version: process.version, executable: process.execPath, sourceRef: 'current-process:' + process.pid } : null;
    checks.push(checkVersions(input.versions, observation));
  }
  for (const definition of input.commands || []) checks.push(runTrusted(definition, input, authority));
  for (const review of input.reviews || []) checks.push(checkReview(review, current, authority));
  if (new Set(checks.map(c => c.id)).size !== checks.length) core.fail('INVALID_INPUT', 'check IDs must be unique');
  return { schema: 1, version: core.VERSION, snapshotDigest: current.digest, worktreeId: current.worktreeId, ...core.aggregate(checks) };
}
module.exports = { result, inspectStyle, commandDigest, runTrusted, checkVersions, checkDependencies, checkReview, check };
if (require.main === module) core.cli(args => {
  if (args[0] !== 'check' || ![2, 4].includes(args.length) || (args.length === 4 && args[2] !== '--authority')) core.fail('USAGE', 'node convention-engineering.cjs check <request.json> [--authority <host-approval.json>]');
  return check(core.readJson(args[1]), args[3] ? core.readJson(args[3]) : {});
});
