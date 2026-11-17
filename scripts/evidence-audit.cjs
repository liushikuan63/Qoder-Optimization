#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const LEVELS = new Set(['static', 'simulation', 'runtime', 'artifact']);
const STATES = new Set(['verified', 'unverified', 'hypothesis', 'excluded']);
const text = s => typeof s === 'string' && s.trim().length > 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const isoTime = value => typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value));
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
function readJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('JSON文件不是普通文件或超过2MiB');
  const buffer = fs.readFileSync(file);
  if (buffer.length > MAX_BYTES) throw new Error('JSON文件超过2MiB');
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error('文件不是有效JSON'); }
  return { value, buffer };
}
function expectation(e) {
  if (!e || !Number.isInteger(e.exitCode)) return null;
  for (const key of ['stdoutIncludes', 'stderrIncludes']) {
    if (e[key] !== undefined && (!Array.isArray(e[key]) || !e[key].every(text))) return null;
  }
  return {
    exitCode: e.exitCode,
    stdoutIncludes: [...new Set(e.stdoutIncludes || [])].sort(),
    stderrIncludes: [...new Set(e.stderrIncludes || [])].sort(),
  };
}
function matches(record, exp) {
  return record.exitCode === exp.exitCode && exp.stdoutIncludes.every(s => record.stdout.includes(s)) && exp.stderrIncludes.every(s => record.stderr.includes(s));
}
function validRef(ref) {
  return ref && text(ref.file) && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(ref.sha256) && expectation(ref.expect);
}
function validPlan(p) {
  return p && p.schema === 1 && text(p.task) && text(p.runId) && text(p.cwd) &&
    Array.isArray(p.checks) && p.checks.length <= 100 && p.checks.every(c =>
      c && typeof c.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(c.id) && text(c.claim) && LEVELS.has(c.requiredLevel) && STATES.has(c.status) &&
      (c.status === 'verified' ? text(c.changedVariable) && validRef(c.positive) && validRef(c.negative) : text(c.reason))) &&
    new Set(p.checks.map(c => c.id)).size === p.checks.length &&
    (p.lastChangeAt === undefined || isoTime(p.lastChangeAt)) &&
    (p.requirements === undefined || (Array.isArray(p.requirements) && p.requirements.length >= 1 && p.requirements.length <= 100
      && p.requirements.every(r => r && typeof r.id === 'string' && CHECK_ID.test(r.id) && text(r.text)
        && Array.isArray(r.checkIds) && r.checkIds.every(id => typeof id === 'string' && CHECK_ID.test(id)))
      && new Set(p.requirements.map(r => r.id)).size === p.requirements.length));
}
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function evidence(root, plan, check, ref, side) {
  const reject = message => ({ state: 'REJECTED', issues: [side + ': ' + message] });
  const incomplete = message => ({ state: 'INCOMPLETE', issues: [side + ': ' + message] });
  if (path.isAbsolute(ref.file) || /^[A-Za-z]:/.test(ref.file)) return reject('证据路径必须相对于报告目录');
  const file = path.resolve(root, ref.file);
  if (!inside(root, file)) return reject('证据路径越出报告目录');
  let data, real;
  try {
    real = fs.realpathSync(file);
    if (!inside(root, real)) return reject('证据链接指向报告目录之外');
    data = readJson(real);
  } catch (error) { return incomplete('证据无法读取或解析（' + (error.code || 'INVALID_RECORD') + '）'); }
  if (sha(data.buffer) !== ref.sha256.toLowerCase()) return reject('SHA256不一致，证据已改变');
  const r = data.value;
  if (!r || r.schema !== 1 || !text(r.runId) || !text(r.cwd) || !LEVELS.has(r.level) ||
      !['completed', 'skipped', 'timeout', 'crashed'].includes(r.termination) ||
      typeof r.stdout !== 'string' || typeof r.stderr !== 'string') return incomplete('证据记录格式不完整');
  if (r.runId !== plan.runId || path.resolve(r.cwd) !== path.resolve(plan.cwd)) return reject('证据不属于本轮或本作用域');
  if (r.level !== check.requiredLevel) return reject('证据类型与声明要求不匹配，不可跨级证明');
  if (r.termination !== 'completed' || !Number.isInteger(r.exitCode)) return incomplete('证据未正常完成，不能算通过');
  const exp = expectation(ref.expect);
  if (!matches(r, exp)) return reject('实际退出码或输出不符合独立预期');
  return { state: 'ACCEPTED', issues: [], file: real, finishedAt: isoTime(r.finishedAt) ? r.finishedAt : null, result: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr } };
}
function requirementResults(plan, results) {
  if (!Array.isArray(plan.requirements) || !plan.requirements.length) return [];
  const stateById = new Map(results.map(r => [r.id, r.state]));
  return plan.requirements.map(req => {
    const missing = req.checkIds.filter(id => !stateById.has(id));
    if (!req.checkIds.length) return { id: req.id, state: 'REJECTED', issues: ['需求没有映射到任何检查，等于没验'], checkIds: req.checkIds };
    if (missing.length) return { id: req.id, state: 'REJECTED', issues: ['引用了不存在的检查：' + missing.join(',')], checkIds: req.checkIds };
    const states = req.checkIds.map(id => stateById.get(id));
    if (states.includes('ACCEPTED')) return { id: req.id, state: 'ACCEPTED', issues: [], checkIds: req.checkIds };
    if (states.includes('REJECTED')) return { id: req.id, state: 'REJECTED', issues: ['需求对应的检查未通过'], checkIds: req.checkIds };
    if (states.every(state => state === 'EXCLUDED')) return { id: req.id, state: 'EXCLUDED', issues: ['需求对应检查全部显式排除'], checkIds: req.checkIds };
    return { id: req.id, state: 'INCOMPLETE', issues: ['需求没有已验证证据'], checkIds: req.checkIds };
  });
}
function auditFile(file) {
  let plan, root;
  try {
    const real = fs.realpathSync(file);
    root = path.dirname(real);
    plan = readJson(real).value;
    if (!validPlan(plan)) throw new Error('需要schema=1、task/runId/cwd和有效checks（至多100项）；可选requirements与lastChangeAt格式必须有效');
  } catch (error) {
    return { verdict: 'ERROR', exitCode: 2, issues: [error.code ? '报告读取失败（' + error.code + '）' : error.message], results: [] };
  }
  const lastChange = plan.lastChangeAt === undefined ? null : Date.parse(plan.lastChangeAt);
  const results = plan.checks.map(c => {
    if (c.status !== 'verified') {
      return { id: c.id, state: c.status === 'excluded' ? 'EXCLUDED' : 'INCOMPLETE', issues: [c.status === 'excluded' ? '显式排除项，不计为已验证' : '假设或未验证项，不计为已验证'] };
    }
    if (JSON.stringify(expectation(c.positive.expect)) === JSON.stringify(expectation(c.negative.expect))) {
      return { id: c.id, state: 'REJECTED', issues: ['正负对照预期没有区分'] };
    }
    const positive = evidence(root, plan, c, c.positive, 'positive');
    const negative = evidence(root, plan, c, c.negative, 'negative');
    if (positive.state !== 'ACCEPTED' || negative.state !== 'ACCEPTED') {
      return { id: c.id, state: [positive, negative].some(r => r.state === 'REJECTED') ? 'REJECTED' : 'INCOMPLETE', issues: [...positive.issues, ...negative.issues] };
    }
    if (lastChange !== null) {
      for (const [side, record] of [['positive', positive], ['negative', negative]]) {
        if (!record.finishedAt) return { id: c.id, state: 'INCOMPLETE', issues: [side + ': 缺少 finishedAt，无法证明晚于最后一轮改动'] };
        if (Date.parse(record.finishedAt) < lastChange) return { id: c.id, state: 'REJECTED', issues: [side + ': 证据早于最后一轮改动（lastChangeAt）'] };
      }
    }
    if (positive.file === negative.file || JSON.stringify(positive.result) === JSON.stringify(negative.result)) {
      return { id: c.id, state: 'REJECTED', issues: ['正负对照使用同一记录或相同观察值'] };
    }
    if (matches(positive.result, expectation(c.negative.expect)) || matches(negative.result, expectation(c.positive.expect))) {
      return { id: c.id, state: 'REJECTED', issues: ['对照预期也匹配另一组记录，判据未区分正负结果'] };
    }
    return { id: c.id, state: 'ACCEPTED', issues: [] };
  });
  const counts = Object.fromEntries(['ACCEPTED', 'REJECTED', 'INCOMPLETE', 'EXCLUDED'].map(k => [k.toLowerCase(), results.filter(r => r.state === k).length]));
  const requirements = requirementResults(plan, results);
  const requirementCounts = Object.fromEntries(['ACCEPTED', 'REJECTED', 'INCOMPLETE', 'EXCLUDED'].map(k => [k.toLowerCase(), requirements.filter(r => r.state === k).length]));
  const failed = counts.rejected > 0 || requirementCounts.rejected > 0;
  const incomplete = counts.incomplete > 0 || requirementCounts.incomplete > 0 || !counts.accepted;
  const partial = counts.excluded > 0 || requirementCounts.excluded > 0;
  const verdict = failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : partial ? 'PARTIAL' : 'PASS';
  return {
    verdict, exitCode: verdict === 'PASS' ? 0 : 1, counts, results, requirements, requirementCounts,
    limits: '仅检查声明类型、记录完整性、哈希、本轮作用域、对照预期、需求覆盖与证据时效；不证明日志来源真实、需求拆分完整、时间顺序真实、范围完整、排除项已获授权、因果归因正确或模型行为普适。',
  };
}
// ---------- 从会话记录生成验收草稿（2026-10-27）----------
// 目的：把"本轮到底跑了什么、结果是什么"从 transcript 抽出来，而不是靠回忆写报告。
// 只做**采集**、不判定通过：生成的每项都是 unverified（缺独立预期与负对照），审计结论必为 INCOMPLETE。
// 这是有意的——草稿的作用是让"没有记录"这件事可见，而不是先给一个好看的全绿。
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
function collectTurnCommands(file) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - MAX_TRANSCRIPT_BYTES);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
  if (start > 0) lines.shift();
  let turnStart = 0;
  const calls = new Map();
  lines.forEach((line, i) => {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    const msg = j.message || j;
    const role = msg.role || j.type;
    const c = msg.content;
    if (role === 'user') {
      const arr = Array.isArray(c) ? c : [];
      const hasToolResult = arr.some(x => x && x.type === 'tool_result');
      const txt = typeof c === 'string' ? c : arr.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n');
      if (!hasToolResult && txt.trim() && !j.isMeta && !msg.isMeta) turnStart = i;
      for (const r of arr.filter(x => x && x.type === 'tool_result')) {
        const call = calls.get(r.tool_use_id);
        if (!call) continue;
        const body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
        call.exitCode = (r.is_error || /"is_error"\s*:\s*true|"success"\s*:\s*false/.test(body)) ? 1 : 0;
        call.stdout = body.slice(0, 4000);
        call.termination = 'completed';
      }
    } else if (role === 'assistant' && Array.isArray(c)) {
      for (const x of c) {
        if (x && x.type === 'tool_use' && x.name === 'Bash') {
          calls.set(x.id, { at: i, command: String((x.input || {}).command || ''), exitCode: null, stdout: '', termination: 'skipped' });
        }
      }
    }
  });
  return [...calls.values()].filter(x => x.at >= turnStart && x.command.trim());
}

function draftFromTranscript(file, outPath) {
  const calls = collectTurnCommands(file);
  if (!calls.length) {
    const err = new Error('会话记录里没有找到本轮 Bash 命令，无法生成草稿');
    err.code = 'NO_COMMANDS';
    throw err;
  }
  const runId = 'draft-' + new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const cwd = process.cwd();
  const used = calls.slice(0, 100);
  const checks = used.map((c, i) => ({
    id: 'cmd-' + (i + 1),
    claim: '本轮命令：' + c.command.replace(/\s+/g, ' ').slice(0, 160),
    status: 'unverified',
    requiredLevel: 'runtime',
    reason: '草稿由会话记录生成，缺独立预期与负对照；需人工补 negative 记录与 expect 后再标 verified',
  }));
  const report = { schema: 1, task: '会话记录草稿（待人工补充正负对照）', runId, cwd, checks };
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    const dir = path.join(path.dirname(outPath), 'records');
    fs.mkdirSync(dir, { recursive: true });
    used.forEach((c, i) => {
      const record = {
        schema: 1, runId, cwd, level: 'runtime', termination: c.termination,
        exitCode: c.exitCode === null ? -1 : c.exitCode, stdout: c.stdout, stderr: '', command: c.command,
      };
      fs.writeFileSync(path.join(dir, 'cmd-' + (i + 1) + '.json'), JSON.stringify(record, null, 2));
    });
  }
  return { report, commands: used.length };
}

module.exports = { auditFile, draftFromTranscript, collectTurnCommands };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--from-transcript') {
    const file = args[1];
    const oi = args.indexOf('--out');
    const out = oi >= 0 ? args[oi + 1] : null;
    const bad = !file || file.startsWith('--')
      || (oi >= 0 && (!out || out.startsWith('--')))
      || args.some(a => a.startsWith('--') && a !== '--from-transcript' && a !== '--out');
    if (bad) {
      console.error('用法：node evidence-audit.cjs --from-transcript <transcript.jsonl> [--out report.json]');
      process.exitCode = 2;
    } else {
      try {
        const r = draftFromTranscript(path.resolve(file), out ? path.resolve(out) : null);
        if (out) console.log('DRAFT_WRITTEN ' + out + ' checks=' + r.report.checks.length);
        else console.log(JSON.stringify(r.report, null, 2));
        process.exitCode = 0;
      } catch (e) {
        console.error('DRAFT_FAILED ' + (e && e.message));
        process.exitCode = 2;
      }
    }
    return;
  }
  const files = args.filter(a => !a.startsWith('--'));
  const file = files[0];
  if (files.length !== 1 || args.some(a => a.startsWith('--') && a !== '--json')) {
    console.error('用法：node evidence-audit.cjs <report.json> [--json]（只读，不执行报告里的命令）');
    process.exitCode = 2;
  } else {
    const result = auditFile(path.resolve(file));
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('EVIDENCE_AUDIT ' + result.verdict + ' ' + JSON.stringify(result.counts || {}));
      for (const issue of result.issues || []) console.log('ERROR ' + issue);
      const issues = result.results.filter(r => r.state !== 'ACCEPTED');
      for (const r of issues.slice(0, 20)) console.log(r.state + ' ' + r.id + ' ' + r.issues.join('；'));
      if (issues.length > 20) console.log('另有 ' + (issues.length - 20) + ' 项；使用--json查看全部');
      const reqIssues = (result.requirements || []).filter(r => r.state !== 'ACCEPTED');
      for (const r of reqIssues.slice(0, 20)) console.log('REQ_' + r.state + ' ' + r.id + ' ' + r.issues.join('；'));
      if (reqIssues.length > 20) console.log('另有 ' + (reqIssues.length - 20) + ' 项需求；使用--json查看全部');
      console.log('证据标签与哈希不证明现场真实性；静态或模拟记录不能证明真实行为。');
    }
    process.exitCode = result.exitCode;
  }
}
