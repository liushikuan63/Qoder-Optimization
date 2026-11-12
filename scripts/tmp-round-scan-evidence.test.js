#!/usr/bin/env node
// T-18 / C10: evidence protection and recoverable cleanup.
// Falsifiable: directory deletion must default to the .trash quarantine, a cleanup
// ledger must be written, and doc-registered evidence must survive without markers.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'tmp-round-scan.cjs');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-t18-'));
const ROOT = path.join(SB, 'tmp-root');
fs.mkdirSync(ROOT, { recursive: true });
const DOCS = path.join(SB, 'docs');
fs.mkdirSync(DOCS, { recursive: true });

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };
const since = new Date(Date.now() - 60 * 1000).toISOString();

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000, cwd: SB });
  let j = null;
  const line = (r.stdout || '').split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (line) { try { j = JSON.parse(line); } catch (e) {} }
  return { code: r.status, json: j, out: (r.stdout || '') + (r.stderr || '') };
}
function mkdir(name, content) {
  const d = path.join(ROOT, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'payload.bin'), content || 'x'.repeat(2048));
  return d;
}
const base = ['--since', since, '--root', ROOT, '--force', '--json'];

// 1. directory deletion defaults to quarantine, and is recoverable
const d1 = mkdir('evidence-no-marker');
let r = run([...base, '--apply']);
check('目录删除默认进 .trash 隔离区', !!(r.json && r.json.trashed && r.json.trashed.length === 1), JSON.stringify(r.json && r.json.trashed));
check('隔离副本真实存在且内容完整', fs.existsSync(path.join(ROOT, '.trash')) && fs.readdirSync(path.join(ROOT, '.trash')).some(b => fs.existsSync(path.join(ROOT, '.trash', b, 'evidence-no-marker', 'payload.bin'))));
check('源目录已移走', !fs.existsSync(d1));
check('trash 标志为真', !!(r.json && r.json.trash === true));

// 2. negative control: --no-trash still permanently deletes
const d2 = mkdir('explicit-no-trash');
r = run([...base, '--apply', '--no-trash']);
check('负对照 --no-trash 永久删除', !fs.existsSync(d2) && !!(r.json && r.json.trashed && r.json.trashed.length === 0));

// 3. KEEP_MARKERS still protect the whole tree
const d3 = mkdir('marked-evidence');
fs.writeFileSync(path.join(d3, '.evidence.json'), JSON.stringify({ schema: 1, task: 'T18' }));
r = run([...base, '--apply']);
check('带 .evidence.json 的目录整棵保留', fs.existsSync(path.join(d3, 'payload.bin')));
check('保留项出现在 recommended.preserve', !!(r.json && r.json.recommended.preserve.some(p => p.endsWith('marked-evidence'))));

// 4. doc-registered evidence survives WITHOUT markers
const d4 = mkdir('registered-evidence');
fs.writeFileSync(path.join(DOCS, 'audit.md'), `证据落盘位置：${d4.replace(/\\/g, '/')} 与 ${d4}\n`);
r = run([...base, '--apply', '--evidence-docs', DOCS]);
check('被文档登记的证据目录即使无标记也保留', fs.existsSync(path.join(d4, 'payload.bin')), r.out.slice(0, 160));
check('登记保护在结果中可见', !!(r.json && (r.json.registeredEvidence || []).some(p => p.endsWith('registered-evidence'))));

// 5. negative control for doc registration: an unrelated dir is still cleaned
const d5 = mkdir('unregistered-scratch');
r = run([...base, '--apply', '--evidence-docs', DOCS]);
check('负对照 未被登记的目录仍被清理', !fs.existsSync(d5));

// 6. cleanup ledger is written
const ledger = path.join(ROOT, '.last-cleanup');
check('清理台账 .last-cleanup 已落盘', fs.existsSync(ledger));
if (fs.existsSync(ledger)) {
  let lj = null; try { lj = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch (e) {}
  check('台账含本次条目数与时间', !!(lj && typeof lj.deleted === 'number' && lj.at), JSON.stringify(lj).slice(0, 140));
}

// 7. dry-run must not write the ledger or delete anything
const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : null;
const d7 = mkdir('dry-run-dir');
r = run(base);
check('dry-run 不删除', fs.existsSync(d7));
check('dry-run 不改台账', before === (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8') : null));

// 8. T-18 格2：把用户的「保留」答复落成 .evidence.json（任务ID/会话/登记文档路径三字段齐）
const crypto = require('crypto');
const d8 = mkdir('keep-answer-evidence');
const DOC8 = path.join(DOCS, 'keep-answer.md');
fs.writeFileSync(DOC8, `保留登记：${d8.replace(/\\/g, '/')}\n`);
const markArgs = ['--root', ROOT, '--json', '--task', 'T-18', '--session', 'c988bddc', '--doc', DOC8];
r = run([...markArgs, '--mark-evidence', d8]);
check('格2 写标记 exit 0', r.code === 0, r.out.slice(0, 200));
const marker8 = path.join(d8, '.evidence.json');
check('格2 目录内标记文件数 ≥ 1', fs.existsSync(marker8));
let mj = null; try { mj = JSON.parse(fs.readFileSync(marker8, 'utf8')); } catch (e) {}
check('格2 标记三字段齐（taskId/session/docs）',
  !!(mj && mj.taskId === 'T-18' && mj.session === 'c988bddc' && Array.isArray(mj.docs) && mj.docs.length === 1 && mj.docs[0] === path.resolve(DOC8)),
  JSON.stringify(mj));
r = run([...base, '--apply']);
check('格2 标记生效后 --apply 整棵保留', fs.existsSync(path.join(d8, 'payload.bin')) && fs.existsSync(marker8));
check('格2 保留项进入 recommended.preserve', !!(r.json && r.json.recommended.preserve.some(p => p.endsWith('keep-answer-evidence'))));

// 8a. 负对照①：缺字段必须拒绝且不落标记
const d8b = mkdir('missing-fields');
r = run(['--root', ROOT, '--json', '--mark-evidence', d8b, '--task', 'T-18']);
check('格2 负对照① 缺 --session/--doc → exit 2 且不落标记',
  r.code === 2 && !fs.existsSync(path.join(d8b, '.evidence.json')), `code=${r.code} ${r.out.slice(0, 140)}`);

// 8b. 负对照②：已有他人标记不得改写（字节一致）
const before8 = fs.readFileSync(marker8, 'utf8');
r = run(['--root', ROOT, '--json', '--mark-evidence', d8, '--task', 'OTHER-99', '--session', 'ffffffff', '--doc', DOC8]);
check('格2 负对照② 已有标记不被改写（exit 3 + 字节一致 + 原任务ID保留）',
  r.code === 3 && fs.readFileSync(marker8, 'utf8') === before8 && JSON.parse(fs.readFileSync(marker8, 'utf8')).taskId === 'T-18',
  `code=${r.code}`);

// 8c. 负对照③：临时根外的目录拒绝打标记
const outside = path.join(SB, 'outside-root');
fs.mkdirSync(outside, { recursive: true });
r = run([...markArgs, '--mark-evidence', outside]);
check('格2 负对照③ 根外目录拒绝（exit 1 且无标记）',
  r.code === 1 && !fs.existsSync(path.join(outside, '.evidence.json')), `code=${r.code}`);

// 8d. 负对照④：不与 --apply 同批执行
r = run([...base, '--apply', ...markArgs.slice(2), '--mark-evidence', d8]);
check('格2 负对照④ 与 --apply 同批被拒（exit 2）', r.code === 2, `code=${r.code} ${r.out.slice(0, 140)}`);

// 8e. 格1 负对照：去掉标记后同一目录必须被删
fs.unlinkSync(marker8);
r = run([...base, '--apply']);
check('格1 负对照 去掉 .evidence.json 后同一目录必须被删', !fs.existsSync(d8), r.out.slice(0, 140));

// 9. T-18 格3：真实还原验证——整棵从 .trash 拷回，逐文件核字节数与 sha256
function manifestOf(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(cur, e.name);
      const r2 = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r2); continue; }
      const buf = fs.readFileSync(full);
      out.push({ rel: r2, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    }
  };
  walk(dir, '');
  return out;
}
const sameTree = (a, b) => JSON.stringify(manifestOf(a)) === JSON.stringify(manifestOf(b));
const d9 = mkdir('restore-me', 'RESTORE-PAYLOAD-0123456789');
fs.mkdirSync(path.join(d9, 'nested'), { recursive: true });
fs.writeFileSync(path.join(d9, 'nested', 'deep.bin'), Buffer.from([0, 1, 2, 255, 254, 13, 10]));
const before9 = manifestOf(d9);
r = run([...base, '--apply']);
const tr9 = (r.json && r.json.trashed || []).find(t => path.resolve(t.from) === path.resolve(d9));
check('格3 目录删除先入 .trash（源已移走 + 台账有对应副本）', !fs.existsSync(d9) && !!tr9 && fs.existsSync(tr9.to), JSON.stringify(tr9));
check('格3 删除前清单非空（还原比对不是空断言）', before9.length === 2, JSON.stringify(before9.map(x => x.rel)));
fs.cpSync(tr9.to, d9, { recursive: true });
const after9 = manifestOf(d9);
check('格3 整棵还原：文件数与相对路径一致', after9.length === before9.length && after9.every((f, i) => f.rel === before9[i].rel),
  JSON.stringify(after9.map(x => x.rel)));
check('格3 整棵还原：每个文件字节数与 sha256 一致', after9.every((f, i) => f.bytes === before9[i].bytes && f.sha256 === before9[i].sha256),
  JSON.stringify(after9));
// 9a. 负对照：比对判据必须能抓到 1 字节差异
const neg9 = path.join(SB, 'restore-negative');
fs.cpSync(d9, neg9, { recursive: true });
fs.writeFileSync(path.join(neg9, 'nested', 'deep.bin'), Buffer.from([0, 1, 2, 255, 254, 13, 11]));
check('格3 负对照 1 字节改动必须被判为不一致（判据可失败）', !sameTree(d9, neg9));

// 10. T-18 格5：被文档登记的证据目录不仅要跳过，还要在**人读输出**里说明原因
const d10 = mkdir('registered-hint');
fs.writeFileSync(path.join(DOCS, 'hint.md'), `证据目录：${d10.replace(/\\/g, '/')}\n`);
r = run(['--since', since, '--root', ROOT, '--force', '--apply', '--evidence-docs', DOCS]);
check('格5 登记证据目录被跳过（目录仍在）', fs.existsSync(path.join(d10, 'payload.bin')));
check('格5 人读输出点名「文档登记证据」并给出路径（不是静默保留）',
  /文档登记证据/.test(r.out) && r.out.includes('registered-hint'), r.out.split('\n').filter(l => /registered-hint|文档登记/.test(l)).join(' | ').slice(0, 240));

// 11. F84：证据登记扫描**不完整**必须报出来，且 --apply 失败关闭（一个都不删）。
// 修前：depth>6 直接 return、readdirSync 失败静默跳过 ⇒ 登记保护整片失效，证据被删且退 0
//（2026-11-12 probe-f83-85 A/C/G 实测）。深度上限是相对**传入的文档根**算的，所以夹具必须传外层根。
function f84Fixture(tag, depth) {
  const root = path.join(SB, 'f84-' + tag);
  const evidence = path.join(root, 'evidence-' + tag);
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, '结论.md'), '被文档登记的证据\n');
  const scratch = path.join(root, 'plain-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'x.bin'), 'x');
  const docsOuter = path.join(root, 'docs');
  let docs = docsOuter;
  fs.mkdirSync(docs, { recursive: true });
  for (let i = 0; i < depth; i++) { docs = path.join(docs, 'd' + (i + 1)); fs.mkdirSync(docs, { recursive: true }); }
  fs.writeFileSync(path.join(docs, '登记.md'), `证据目录：${evidence.replace(/\\/g, '/')}\n`);
  return { root, evidence, scratch, docsOuter, docs };
}
const f84Args = (f, docs, extra = []) => ['--since', since, '--root', f.root, '--force', '--evidence-docs', docs, '--json', ...extra];
const inc = (r) => (r.json && r.json.evidenceScan && r.json.evidenceScan.incomplete) || [];

const deep = f84Fixture('deep', 7);
r = run(f84Args(deep, deep.docsOuter, ['--apply']));
check('F84 第 7 层登记 + --apply：失败关闭 exit 2', r.code === 2, `code=${r.code} ${r.out.slice(0, 160)}`);
check('F84 第 7 层登记：证据与普通目录都还在，deleted=0',
  fs.existsSync(deep.evidence) && fs.existsSync(deep.scratch) && ((r.json || {}).deleted || []).length === 0,
  JSON.stringify((r.json || {}).deleted || []));
check('F84 不完整可见（evidenceScan.incomplete 点名 depth-cap）',
  inc(r).some(x => x.kind === 'depth-cap' && x.path.includes('d7')), JSON.stringify(inc(r)).slice(0, 200));
check('F84 拒绝时 recommended.clean 为空（数据层也不许给出删除清单）',
  !!r.json && r.json.refused === 'evidence-scan-incomplete' && r.json.recommended.clean.length === 0
  && r.json.refusedCandidates.length > 0, JSON.stringify(r.json && r.json.recommended));

const d6 = f84Fixture('depth6', 6);
r = run(f84Args(d6, d6.docsOuter, ['--apply']));
check('F84 负对照 第 6 层仍在保护范围内：exit 0 + 证据保住 + 无 incomplete',
  r.code === 0 && fs.existsSync(d6.evidence) && inc(r).length === 0
  && ((r.json || {}).registeredEvidence || []).some(p => p.endsWith('evidence-depth6')),
  `code=${r.code} registered=${JSON.stringify((r.json || {}).registeredEvidence || [])}`);
check('F84 负对照 第 6 层：未登记的普通目录仍被清理（保护没被扩大成"什么都不删"）',
  !fs.existsSync(d6.scratch), `code=${r.code}`);

const fileRoot = f84Fixture('fileroot', 0);
const notDir = path.join(fileRoot.root, 'not-a-dir.md');
fs.writeFileSync(notDir, `证据目录：${fileRoot.evidence.replace(/\\/g, '/')}\n`);
r = run(f84Args(fileRoot, notDir, ['--apply']));
check('F84 文档根是文件：exit 2 + 证据保住 + 报 unreadable-dir',
  r.code === 2 && fs.existsSync(fileRoot.evidence) && inc(r).some(x => x.kind === 'unreadable-dir'),
  `code=${r.code} incomplete=${JSON.stringify(inc(r)).slice(0, 160)}`);

const missing = f84Fixture('missing', 0);
r = run(f84Args(missing, path.join(missing.root, 'no-such-docs'), ['--apply']));
check('F84 负对照 文档根不存在：口径不变（exit 0 + 照常清理 + missingRoots 可见）',
  r.code === 0 && !fs.existsSync(missing.evidence) && !fs.existsSync(missing.scratch)
  && ((r.json.evidenceScan || {}).missingRoots || []).length === 1 && inc(r).length === 0,
  `code=${r.code} scan=${JSON.stringify(r.json && r.json.evidenceScan).slice(0, 200)}`);

const ro = f84Fixture('readonly', 7);
r = run(f84Args(ro, ro.docsOuter));
check('F84 只读扫描：不完整要可见但不阻塞（exit 0 + 不删）',
  r.code === 0 && inc(r).length > 0 && fs.existsSync(ro.evidence) && fs.existsSync(ro.scratch), `code=${r.code}`);

const human = f84Fixture('human', 7);
r = run(['--since', since, '--root', human.root, '--force', '--evidence-docs', human.docsOuter, '--apply']);
check('F84 人读输出：点名「扫描不完整」并给出拒绝理由与改法',
  r.code === 2 && /扫描不完整/.test(r.out) && /已拒绝清理/.test(r.out) && /--evidence-docs/.test(r.out),
  r.out.split('\n').filter(l => /扫描不完整|已拒绝清理|改法/.test(l)).join(' | ').slice(0, 260));

const shallow = f84Fixture('shallow', 0);
r = run(f84Args(shallow, shallow.docsOuter, ['--apply']));
check('F84 负对照 浅层登记：exit 0 + 证据保住 + 扫描完整（mdFiles>0）',
  r.code === 0 && fs.existsSync(shallow.evidence) && inc(r).length === 0 && r.json.evidenceScan.mdFiles > 0,
  `code=${r.code} scan=${JSON.stringify(r.json && r.json.evidenceScan).slice(0, 200)}`);

fs.rmSync(SB, { recursive: true, force: true });
console.log(fail ? `\nT18 FAIL ${fail}` : '\nT18 ALL PASS');
process.exitCode = fail ? 1 : 0;