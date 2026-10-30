#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { POLICY_VERSION, TIERS, fingerprint } = require('./verification-policy.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const STATES = ['baseline', 'candidate', 'manual'];
const TIME_FIELDS = ['setupMs', 'policyMs', 'agentMs', 'questionMs', 'executeMs', 'humanWaitMs'];
const text = v => typeof v === 'string' && v.trim().length > 0;
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = v => Array.isArray(v) && v.length <= 100 && v.every(text) && new Set(v).size === v.length;
const sameSet = (a, b) => fingerprint([...a].sort()) === fingerprint([...b].sort());
const limits = '仅核对所给记录的结构、一致性和统计门槛；不验证来源真实、独立真值或现场已获准启用，合成数据不能证明实际收益。';
function result(verdict, issues, extra = {}) {
  return { verdict, exitCode: verdict === 'PASS' ? 0 : verdict === 'ERROR' ? 2 : 1, issues, limits, ...extra };
}
function load(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('实验清单必须是至多2MiB的普通文件');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) throw new Error('实验清单超过2MiB');
  return JSON.parse(bytes.toString('utf8'));
}
function validate(data) {
  if (!object(data) || data.schema !== 1 || !Array.isArray(data.tasks) || data.tasks.length > 500) return ['STRUCTURE: 需要 schema=1 与至多500个任务的数组'];
  const issues = [];
  const need = (ok, message) => { if (!ok) issues.push(message); };
  need(text(data.policyVersion), 'policyVersion 缺失');
  if (text(data.policyVersion) && data.policyVersion !== POLICY_VERSION) issues.push('CONTEXT: 不支持的政策版本');
  need(text(data.baselineSourceRef), '独立基线来源缺失');
  need(digest(data.baselineDigest), '基线指纹缺失');
  const ids = new Set(), families = new Map(), evidenceOwners = new Map();
  for (const task of data.tasks) {
    if (!object(task)) { issues.push('STRUCTURE: 任务必须是对象'); continue; }
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(task.id)) { issues.push('任务ID非法'); continue; }
    if (ids.has(task.id)) issues.push('重复任务ID: ' + task.id);
    ids.add(task.id);
    const manual = task.candidateState === 'manual';
    need(['dev', 'holdout'].includes(task.split), task.id + ': split 必须是 dev 或 holdout');
    need(Number.isInteger(task.family) && task.family >= 0, task.id + ': family 必须是非负整数');
    need(['low', 'normal', 'high'].includes(task.risk), task.id + ': risk 必须是 low/normal/high');
    need(manual ? task.candidateTier === null : TIERS.includes(task.candidateTier), task.id + ': candidateTier 缺失或非法');
    need(['manual', 'candidate'].includes(task.candidateState), task.id + ': 缺少实际候选状态，影子基线不是候选运行');
    need(typeof task.hasKnownDefect === 'boolean', task.id + ': hasKnownDefect 缺失');
    need(text(task.independentTruthRef), task.id + ': 独立缺陷真值引用缺失');
    need(list(task.defectIds), task.id + ': defectIds 非法或重复');
    const defects = list(task.defectIds) ? task.defectIds : [];
    need(task.hasKnownDefect === (defects.length > 0), task.id + ': hasKnownDefect 与 defectIds 不一致');
    need(list(task.baselineCheckIds) && task.baselineCheckIds.length > 0, task.id + ': 独立基线检查缺失');
    need(list(task.candidateCheckIds) && (manual || task.candidateCheckIds.length > 0), task.id + ': candidateCheckIds 非法');
    need(list(task.mandatoryCheckIds) && list(task.userCheckIds), task.id + ': 必需检查或用户验收清单缺失');
    if (!manual && [task.mandatoryCheckIds, task.userCheckIds, task.candidateCheckIds].every(list)) {
      need([...task.mandatoryCheckIds, ...task.userCheckIds].every(id => task.candidateCheckIds.includes(id)), task.id + ': FAULT 候选省略必需检查或用户验收');
    }
    if (manual && Array.isArray(task.candidateCheckIds) && task.candidateCheckIds.length) issues.push(task.id + ': FAULT 人工任务不应声称自动候选清单已执行');
    need(text(task.evidenceRef) && digest(task.evidenceDigest), task.id + ': 脱敏证据引用与指纹缺失');
    need(digest(task.contentDigest) && text(task.environmentKey), task.id + ': 内容指纹或环境缺失');
    need(text(task.resetPolicyRef), task.id + ': 数据、构建、进程与缓存重置策略缺失');
    const choiceValid = object(task.choice) && text(task.choice.sourceRef) && ['native-answer', 'explicit-current-user-request'].includes(task.choice.sourceKind) && digest(task.choice.proposalDigest);
    need(choiceValid, task.id + ': 真实选择来源引用或提案指纹缺失');
    if (choiceValid && (manual || TIERS.includes(task.candidateTier))) need(task.choice.optionId === (manual ? 'manual' : task.candidateTier), task.id + ': FAULT 用户选择与候选档位不一致');
    if (Number.isInteger(task.family) && ['dev', 'holdout'].includes(task.split)) {
      const set = families.get(task.family) || new Set();
      set.add(task.split); families.set(task.family, set);
    }
    if (!Array.isArray(task.runs)) { issues.push(task.id + ': 缺少原始计时与结果记录'); continue; }
    if (!manual && !task.runs.length) issues.push(task.id + ': 缺少原始计时与结果记录');
    for (const run of task.runs) {
      if (!object(run)) { issues.push('STRUCTURE: ' + task.id + ': run 必须是对象'); continue; }
      need(Number.isSafeInteger(run.round) && run.round >= 1, task.id + ': run.round 非法');
      need(STATES.includes(run.state), task.id + ': run.state 非法');
      if ((manual && run.state === 'candidate') || (!manual && run.state === 'manual')) issues.push(task.id + ': FAULT 自动与人工记录混用');
      need(['completed', 'skipped', 'timeout', 'crashed'].includes(run.termination), task.id + ': run.termination 非法');
      need(list(run.caughtDefectIds) && run.caughtDefectIds.every(id => defects.includes(id)), task.id + ': FAULT caughtDefectIds 越界、重复或非法');
      need(Number.isSafeInteger(run.falsePositiveCount) && run.falsePositiveCount >= 0, task.id + ': 误报计数缺失或非法');
      need(TIME_FIELDS.every(key => finite(run[key])), task.id + ': 计时字段必须为非负真实数值');
      need(finite(run.wallClockMs) && run.wallClockMs > 0, task.id + ': 实测 wall-clock 缺失或为零');
      if (TIME_FIELDS.every(key => finite(run[key])) && finite(run.wallClockMs)) {
        const total = TIME_FIELDS.reduce((sum, key) => sum + run[key], 0);
        need(Number.isFinite(total) && Math.abs(run.wallClockMs - total) <= Math.max(1, total * 1e-6), task.id + ': wall-clock 与不重叠阶段耗时不一致');
      }
      need(['AB', 'BA'].includes(run.order) && text(run.resetRef), task.id + ': A/B顺序或本轮重置证据缺失');
      need(text(run.evidenceRef), task.id + ': run.evidenceRef 缺失');
      if (text(run.evidenceRef)) {
        if (evidenceOwners.has(run.evidenceRef) && evidenceOwners.get(run.evidenceRef) !== task.id) issues.push(task.id + ': FAULT 不同任务复用了同一测量记录');
        evidenceOwners.set(run.evidenceRef, task.id);
      }
      const expected = { policyVersion: data.policyVersion, baselineDigest: data.baselineDigest, contentDigest: task.contentDigest,
        environmentKey: task.environmentKey, proposalDigest: task.choice?.proposalDigest, choiceDigest: choiceValid ? fingerprint(task.choice) : null };
      for (const [key, value] of Object.entries(expected)) {
        const valid = key.endsWith('Digest') ? digest : text;
        need(valid(run[key]), task.id + ': run.' + key + ' 缺失');
        if (valid(value) && valid(run[key])) need(run[key] === value, task.id + ': CONTEXT run.' + key + ' 与冻结版本/作用域不一致');
      }
      need(list(run.checkIds), task.id + ': 实际执行清单缺失');
      const checks = run.state === 'baseline' ? task.baselineCheckIds : task.candidateCheckIds;
      if (list(run.checkIds) && list(checks)) need(sameSet(run.checkIds, checks), task.id + ': FAULT 实际检查与冻结清单不一致');
    }
  }
  for (const [family, splits] of families) if (splits.size > 1) issues.push('LEAKAGE: family ' + family + ' 同时出现在 dev 与 holdout');
  return issues;
}
function totals(rows) {
  return rows.reduce((sum, row) => sum + row, 0);
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
}
function p95(values) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null;
}
function finiteMetrics(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return !value || typeof value !== 'object' || Object.values(value).every(finiteMetrics);
}
function timeSummary(pairs, includeHumanWait) {
  const time = row => row.wallClockMs - (includeHumanWait ? 0 : row.humanWaitMs);
  const baseline = pairs.map(pair => time(pair.baseline)), candidate = pairs.map(pair => time(pair.candidate));
  const baseMedian = median(baseline), candMedian = median(candidate);
  return {
    baselineMedianMs: baseMedian, candidateMedianMs: candMedian,
    baselineP95Ms: p95(baseline), candidateP95Ms: p95(candidate),
    medianPairedSavingMs: median(pairs.map(pair => time(pair.baseline) - time(pair.candidate))),
    medianReduction: baseMedian > 0 ? (baseMedian - candMedian) / baseMedian : null,
  };
}
function summarize(data, minRounds = 3) {
  if (!Number.isSafeInteger(minRounds) || minRounds < 3) return result('ERROR', ['minRounds 必须为至少3的整数，不能降低既定门槛'], { metrics: null });
  const issues = validate(data);
  if (issues.length) {
    const malformed = issues.some(i => i.startsWith('STRUCTURE:'));
    const fatal = issues.some(i => /FAULT |CONTEXT[: ]|^LEAKAGE/.test(i));
    return result(malformed ? 'ERROR' : fatal ? 'FAIL' : 'INCOMPLETE', issues, {
      tasks: Array.isArray(data?.tasks) ? data.tasks.length : 0, metrics: null,
      ...(issues.some(i => i.startsWith('LEAKAGE')) ? { code: 'SPLIT_LEAKAGE' } : {}),
    });
  }
  if (!data.tasks.length) return result('INCOMPLETE', ['没有原始测量任务'], { tasks: 0, metrics: null });
  const manual = data.tasks.filter(t => t.candidateState === 'manual');
  const automatic = data.tasks.filter(t => t.candidateState === 'candidate');
  const pairs = [], quality = [], admission = [], pending = [], warnings = [];
  let candidateCaught = 0, baselineCaught = 0, defects = 0;
  const bothMissed = new Set(), highRiskMissed = new Set();
  for (const task of automatic) {
    const base = new Map(), candidate = new Map();
    for (const row of task.runs) {
      if (row.termination !== 'completed') return result('INCOMPLETE', [task.id + ': ' + row.state + ' 轮未正常完成'], { tasks: data.tasks.length, metrics: null });
      const map = row.state === 'baseline' ? base : candidate;
      if (map.has(row.round)) return result('INCOMPLETE', [task.id + ': 重复轮次被当作独立样本'], { tasks: data.tasks.length, metrics: null });
      map.set(row.round, row);
    }
    if (base.size < minRounds || candidate.size < minRounds) return result('INCOMPLETE', [task.id + ': 少于 ' + minRounds + ' 个配对轮次'], { tasks: data.tasks.length, metrics: null });
    if (base.size !== minRounds || candidate.size !== minRounds) return result('INCOMPLETE', [task.id + ': 每任务须恰好 ' + minRounds + ' 个配对轮次，不得用重复轮次改变任务权重'], { tasks: data.tasks.length, metrics: null });
    const rounds = [...base.keys()].sort((a, b) => a - b);
    if (base.size !== candidate.size || rounds.some((round, i) => round !== i + 1 || !candidate.has(round))) {
      return result('INCOMPLETE', [task.id + ': 基线与候选必须从1开始连续且逐轮一一匹配'], { tasks: data.tasks.length, metrics: null });
    }
    let previousOrder;
    for (const round of rounds) {
      const a = base.get(round), b = candidate.get(round);
      if (a.order !== b.order || a.order === previousOrder) return result('INCOMPLETE', [task.id + ': A/B配对顺序不一致或未交替'], { tasks: data.tasks.length, metrics: null });
      previousOrder = a.order;
      pairs.push({ taskId: task.id, tier: task.candidateTier, split: task.split, baseline: a, candidate: b });
      for (const id of task.defectIds) {
        const ac = a.caughtDefectIds.includes(id), bc = b.caughtDefectIds.includes(id);
        if (ac && !bc) quality.push(task.id + '/' + round + ': 候选检出低于基线（' + id + '）');
        if (!ac && !bc) bothMissed.add(task.id + '/' + id);
        if (task.risk === 'high' && !bc) highRiskMissed.add(task.id + '/' + id);
      }
    }
    baselineCaught += task.defectIds.filter(id => [...base.values()].every(row => row.caughtDefectIds.includes(id))).length;
    candidateCaught += task.defectIds.filter(id => [...candidate.values()].every(row => row.caughtDefectIds.includes(id))).length;
    defects += task.defectIds.length;
  }
  if (!pairs.length) return result('INCOMPLETE', ['没有可配对的自动验证样本；人工待验任务不计入分母'], { tasks: data.tasks.length, metrics: null });
  const holdout = automatic.filter(t => t.split === 'holdout');
  const byTier = Object.fromEntries(TIERS.map(tier => {
    const tasks = automatic.filter(t => t.candidateTier === tier), rows = pairs.filter(p => p.tier === tier);
    const held = tasks.filter(t => t.split === 'holdout');
    return [tier, {
      taskCount: tasks.length, devCount: tasks.length - held.length, holdoutCount: held.length,
      holdoutDefectTasks: held.filter(t => t.hasKnownDefect).length, holdoutNormalTasks: held.filter(t => !t.hasKnownDefect).length,
      pairedRounds: rows.length, withHumanWait: timeSummary(rows, true), withoutHumanWait: timeSummary(rows, false),
      bySplit: Object.fromEntries(['dev', 'holdout'].map(split => {
        const selected = rows.filter(row => row.split === split);
        return [split, { taskCount: tasks.filter(task => task.split === split).length, pairedRounds: selected.length,
          withHumanWait: timeSummary(selected, true), withoutHumanWait: timeSummary(selected, false) }];
      })),
    }];
  }));
  const overhead = Object.fromEntries(['baseline', 'candidate'].map(state => [state, Object.fromEntries(TIME_FIELDS.map(key => [key, median(pairs.map(p => p[state][key]))]))]));
  const measured = {
    taskCount: data.tasks.length, automaticTaskCount: automatic.length, devCount: automatic.length - holdout.length, holdoutCount: holdout.length,
    holdoutDefects: totals(holdout.map(t => t.defectIds.length)), pairedTaskCount: automatic.length,
    independentTaskCount: new Set(automatic.map(t => t.family)).size,
    normalTasks: automatic.filter(t => !t.hasKnownDefect).length, defectTasks: automatic.filter(t => t.hasKnownDefect).length,
    bothMissedDefects: bothMissed.size, highRiskMissed: highRiskMissed.size,
    ...timeSummary(pairs, true), withoutHumanWait: timeSummary(pairs, false),
    baselineHumanWaitMedianMs: overhead.baseline.humanWaitMs, candidateHumanWaitMedianMs: overhead.candidate.humanWaitMs,
    pairedRounds: pairs.length, candidateCaught, candidateDefects: defects, candidateMissed: defects - candidateCaught,
    baselineCaught, baselineDefects: defects, baselineMissed: defects - baselineCaught,
    baselineFalsePositives: totals(pairs.map(p => p.baseline.falsePositiveCount)), candidateFalsePositives: totals(pairs.map(p => p.candidate.falsePositiveCount)),
    manualTasks: manual.length, manualTimeMs: null, policyP95Ms: p95(pairs.map(p => p.candidate.policyMs)), overhead, byTier,
  };
  if (!finiteMetrics(measured)) return result('INCOMPLETE', ['统计结果出现非有限数值，不能输出收益或准入结论'], { tasks: data.tasks.length, metrics: null });
  if (measured.baselineMissed) warnings.push('独立基线自身漏检 ' + measured.baselineMissed + ' 个已知缺陷；这些不能算作两次都正确');
  if (bothMissed.size) quality.push('基线与候选都漏检 ' + bothMissed.size + ' 个已知缺陷，不能视为成功');
  if (highRiskMissed.size) quality.push('高风险已知缺陷被漏检');
  if (measured.baselineFalsePositives || measured.candidateFalsePositives) quality.push('存在量具误报，不能算成功检出');
  if (manual.length) pending.push('存在人工待验任务，未计入自动提速或准入样本分母');
  if (automatic.length < 30) pending.push('独立配对任务少于30，不满足准入');
  if (automatic.length > 30) admission.push('第一版冻结批次必须为30个自动任务');
  if (measured.independentTaskCount < 30) admission.push('独立任务家族少于30，同源变种不能充数');
  if (measured.devCount !== 18 || measured.holdoutCount !== 12) admission.push('开发集必须18个、保留集必须12个自动任务');
  if (measured.normalTasks !== 15) admission.push('正常任务样本必须15个');
  if (measured.defectTasks !== 15) admission.push('缺陷任务样本必须15个');
  for (const [tier, counts] of Object.entries(byTier)) {
    if (counts.taskCount !== 10 || counts.devCount !== 6 || counts.holdoutCount !== 4) admission.push(tier + ': 每档10个自动任务，开发6个、保留4个');
    if (counts.holdoutDefectTasks !== 2 || counts.holdoutNormalTasks !== 2) admission.push(tier + ': 保留集每档必须2个缺陷与2个正常场景');
  }
  for (const [label, light] of [['轻量', byTier.light.withHumanWait], ['轻量保留集', byTier.light.bySplit.holdout.withHumanWait]]) {
    if (light.medianReduction === null || light.medianReduction + 4 * Number.EPSILON < 0.2) admission.push(label + '端到端p50改善不足20%');
    if (light.candidateP95Ms === null || light.baselineP95Ms === null || light.candidateP95Ms > light.baselineP95Ms) admission.push(label + '候选p95劣于基线');
  }
  if (measured.policyP95Ms > 100) admission.push('推荐器纯计算p95超过100ms');
  return result(quality.length ? 'FAIL' : pending.length ? 'INCOMPLETE' : admission.length ? 'FAIL' : 'PASS', [...quality, ...pending, ...admission], {
    warnings, tasks: data.tasks.length, metrics: measured,
    policyVersion: data.policyVersion, baselineSourceRef: data.baselineSourceRef, baselineDigest: data.baselineDigest,
  });
}
module.exports = { summarize, validate };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || args[0].startsWith('--')) throw new Error('用法：node verification-benchmark.cjs <manifest.json> [--min-rounds N] [--json]');
    let minRounds = 3;
    const seen = new Set();
    for (let i = 1; i < args.length; i++) {
      const flag = args[i];
      if (!['--json', '--min-rounds'].includes(flag) || seen.has(flag)) throw new Error('未知、重复选项或多余路径');
      seen.add(flag);
      if (flag === '--min-rounds') {
        minRounds = Number(args[++i]);
        if (!Number.isSafeInteger(minRounds) || minRounds < 3) throw new Error('--min-rounds 必须为至少3的整数');
      }
    }
    const report = summarize(load(args[0]), minRounds);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(JSON.stringify({ verdict: 'ERROR', exitCode: 2, issues: [error.message] }));
    process.exitCode = 2;
  }
}
