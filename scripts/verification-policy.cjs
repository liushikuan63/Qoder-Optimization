#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');

const POLICY_VERSION = 'adaptive-verification/1';
const TIERS = ['light', 'standard', 'deep'];
const EVIDENCE_TYPES = ['static', 'simulation', 'runtime', 'artifact'];
const LABELS = { light: '轻量验证', standard: '标准验证', deep: '强化验证' };
const rank = tier => TIERS.indexOf(tier);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const list = value => Array.isArray(value) && value.length <= 100 && value.every(text);
const union = (...values) => [...new Set(values.flat())].sort();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fingerprint(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function validateScope(scope) {
  for (const key of ['taskId', 'sessionId']) {
    if (typeof scope?.[key] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(scope[key])) fail('INVALID_SCOPE_ID', key + ' must be a safe identifier');
  }
  for (const key of ['requestMessageId', 'workspaceKey', 'environmentKey']) {
    if (!text(scope[key])) fail('INVALID_SCOPE', key + ' is required');
  }
  return Object.fromEntries(['taskId', 'sessionId', 'requestMessageId', 'workspaceKey', 'environmentKey'].map(key => [key, scope[key]]));
}
function validateRequest(input) {
  if (!input || input.schema !== 1) fail('INVALID_SCHEMA', 'schema must be 1');
  const scope = validateScope(input);
  const f = input.facts;
  if (!f || !['local', 'push', 'pull-request', 'deploy', 'publish', 'unknown'].includes(f.action)
      || !['low', 'normal', 'high', 'unknown'].includes(f.risk)
      || !['local', 'module', 'cross-module', 'unknown'].includes(f.impact)
      || !['low', 'gaps', 'high', 'unknown'].includes(f.uncertainty)
      || ![true, false, null].includes(f.reversible) || ![true, false, null].includes(f.sensitive)
      || !list(f.sourceRefs) || !f.sourceRefs.length) fail('INVALID_FACTS', 'facts and their source references are required');
  if (!TIERS.includes(input.modelSuggestedTier)) fail('INVALID_TIER', 'modelSuggestedTier must be light, standard or deep');
  if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 100) fail('INVALID_CHECKS', 'provide 1..100 checks');
  const checks = input.checks.map(c => {
    if (!c || typeof c.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(c.id)
        || !TIERS.includes(c.fromTier) || typeof c.mandatory !== 'boolean' || !EVIDENCE_TYPES.includes(c.evidenceType)
        || !list(c.requirementIds) || !c.requirementIds.length || !list(c.dependencies) || !list(c.preconditions)
        || !text(c.commandRef) || !text(c.expectedOutcomeRef)
        || (c.authorityRef !== undefined && c.authorityRef !== null && !text(c.authorityRef))) fail('INVALID_CHECK', 'invalid check definition');
    return {
      id: c.id, fromTier: c.fromTier, mandatory: c.mandatory, evidenceType: c.evidenceType,
      requirementIds: union(c.requirementIds), dependencies: union(c.dependencies), preconditions: union(c.preconditions),
      commandRef: c.commandRef, expectedOutcomeRef: c.expectedOutcomeRef, authorityRef: c.authorityRef ?? null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (new Set(checks.map(c => c.id)).size !== checks.length) fail('DUPLICATE_CHECK', 'check IDs must be unique');
  if (!list(input.userCheckIds) || !list(input.baselineCheckIds) || !input.baselineCheckIds.length || !text(input.baselineSourceRef)) fail('INVALID_BASELINE', 'explicit user checks and an independently sourced baseline are required');
  return {
    schema: 1, ...scope,
    facts: { action: f.action, risk: f.risk, impact: f.impact, uncertainty: f.uncertainty, reversible: f.reversible, sensitive: f.sensitive, sourceRefs: union(f.sourceRefs) },
    modelSuggestedTier: input.modelSuggestedTier, checks, userCheckIds: union(input.userCheckIds),
    baselineCheckIds: union(input.baselineCheckIds), baselineSourceRef: input.baselineSourceRef,
  };
}
function checkClosure(checks, ids) {
  const byId = new Map(checks.map(c => [c.id, c]));
  const visiting = new Set(), found = new Set();
  function visit(id) {
    if (!byId.has(id)) fail('UNKNOWN_CHECK', 'unknown check reference');
    if (visiting.has(id)) fail('CYCLIC_CHECKS', 'cyclic check dependency');
    if (found.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependencies) visit(dep);
    visiting.delete(id);
    found.add(id);
  }
  for (const id of ids) visit(id);
  return [...found].sort();
}
function evaluatePolicy(input) {
  const request = validateRequest(input), f = request.facts;
  checkClosure(request.checks, request.checks.map(c => c.id));
  const reasonCodes = [];
  let suggested = 'light';
  if (f.sensitive === true || f.risk === 'high' || f.reversible === false || ['push', 'pull-request', 'deploy', 'publish'].includes(f.action)) {
    suggested = 'deep'; reasonCodes.push(f.reversible === false ? 'IRREVERSIBLE' : 'SENSITIVE_OR_EXTERNAL');
  } else if (f.uncertainty === 'high' && f.impact === 'cross-module') {
    suggested = 'deep'; reasonCodes.push('CROSS_MODULE_UNCERTAINTY');
  } else if (f.action !== 'local' || f.risk !== 'low' || f.impact !== 'local' || f.uncertainty !== 'low' || f.reversible !== true || f.sensitive !== false) {
    suggested = 'standard'; reasonCodes.push('NONTRIVIAL_OR_UNKNOWN');
  } else reasonCodes.push('BOUNDED_REVERSIBLE');
  const recommendedTier = TIERS[Math.max(rank(suggested), rank(request.modelSuggestedTier))];
  if (recommendedTier !== suggested) reasonCodes.push('MODEL_RECOMMENDS_MORE');
  const mandatoryCheckIds = checkClosure(request.checks, union(request.checks.filter(c => c.mandatory).map(c => c.id), request.userCheckIds));
  const baselineCheckIds = checkClosure(request.checks, request.baselineCheckIds);
  const profiles = Object.fromEntries(TIERS.map(tier => [tier, checkClosure(request.checks, union(mandatoryCheckIds, request.checks.filter(c => rank(c.fromTier) <= rank(tier)).map(c => c.id)))]));
  const recommended = profiles[recommendedTier];
  const blockers = (f.action === 'unknown' || f.risk === 'unknown' || f.impact === 'unknown' || f.uncertainty !== 'low' || f.reversible === null || f.sensitive === null) ? ['FACTS_UNRESOLVED'] : [];
  const options = [recommendedTier, ...TIERS.filter(tier => tier !== recommendedTier)].map(tier => {
    const omitted = recommended.filter(id => !profiles[tier].includes(id));
    const added = profiles[tier].filter(id => !recommended.includes(id));
    return {
      optionId: tier, execution: 'automated', tier,
      label: LABELS[tier] + (tier === recommendedTier ? ' (Recommended)' : ''),
      description: `${profiles[tier].length}项检查；比推荐新增${added.length}项、省略${omitted.length}项；必需检查保留，暂无可靠估时。`,
      checkIds: profiles[tier], manualCheckIds: [], addedComparedToRecommended: added, omittedComparedToRecommended: omitted,
      estimatedMinutes: null, estimateSourceRef: null,
    };
  });
  options.push({
    optionId: 'manual', execution: 'manual', tier: null, label: '交由人工验证',
    description: '不自动运行测试或审查；提供人工步骤与预期，保持待人工验证，不视为通过或发布许可。',
    checkIds: [], manualCheckIds: union(baselineCheckIds, recommended), addedComparedToRecommended: [], omittedComparedToRecommended: recommended,
    estimatedMinutes: null, estimateSourceRef: null,
  });
  return {
    schema: 1, policyVersion: POLICY_VERSION, ...validateScope(request), request,
    policyDigest: fingerprint(request), recommendedTier, reasonCodes, blockers, mandatoryCheckIds,
    userCheckIds: request.userCheckIds, baselineCheckIds,
    baselineDigest: fingerprint({ ids: baselineCheckIds, sourceRef: request.baselineSourceRef, checks: request.checks.filter(c => baselineCheckIds.includes(c.id)) }),
    checks: request.checks, options,
  };
}
function readJson(file) {
  if (!file || fs.statSync(file).size > 2 * 1024 * 1024) fail('INVALID_INPUT', 'input must be a JSON file of at most 2MiB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
module.exports = { POLICY_VERSION, TIERS, EVIDENCE_TYPES, evaluatePolicy, validateScope, checkClosure, fingerprint, stable };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || args[0].startsWith('--')) fail('USAGE', 'node verification-policy.cjs <request.json>');
    console.log(JSON.stringify(evaluatePolicy(readJson(args[0])), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ verdict: 'ERROR', code: error.code || 'INVALID_INPUT', message: error.message }));
    process.exitCode = 2;
  }
}
