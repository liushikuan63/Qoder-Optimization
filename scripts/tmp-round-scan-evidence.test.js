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

fs.rmSync(SB, { recursive: true, force: true });
console.log(fail ? `\nT18 FAIL ${fail}` : '\nT18 ALL PASS');
process.exitCode = fail ? 1 : 0;