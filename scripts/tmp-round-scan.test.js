#!/usr/bin/env node
// tmp-round-scan 离线用例：本轮条目要能列出、旧条目/证据目录要排除。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCAN = path.join(__dirname, 'tmp-round-scan.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'round-scan-test-'));
const HOME = path.join(ROOT, 'home');
const TMPROOT = path.join(ROOT, 'tmp');
fs.mkdirSync(path.join(HOME, '.qoder'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.qoder', 'tmp-sweeper.json'),
  JSON.stringify({ canonicalRoot: TMPROOT, excludeTopPrefixes: ['QO-REL-', 'evidence-'] }));
fs.mkdirSync(TMPROOT, { recursive: true });

let n = 0;
const results = [];
function check(name, got, want) {
  n++;
  const ok = got === want;
  results.push((ok ? 'PASS ' : 'FAIL ') + name + ' got=' + got + ' want=' + want);
  return ok;
}

function scan(extra = []) {
  const out = execFileSync(process.execPath, [SCAN, '--json', ...extra], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HOME, USERPROFILE: HOME }),
  });
  return JSON.parse(out);
}

const since = Date.now() - 60000;
const freshDir = path.join(TMPROOT, 'pkg-round');
fs.mkdirSync(freshDir, { recursive: true });
fs.writeFileSync(path.join(freshDir, 'a.json'), 'x'.repeat(100));
const freshFile = path.join(TMPROOT, 'pkg.zip');
fs.writeFileSync(freshFile, 'z');
const excludedDir = path.join(TMPROOT, 'QO-REL-keep');
fs.mkdirSync(excludedDir, { recursive: true });
fs.writeFileSync(path.join(excludedDir, 'evidence.log'), 'y');
const oldFile = path.join(TMPROOT, 'old.log');
fs.writeFileSync(oldFile, 'o');
const oldT = new Date(Date.now() - 3 * 86400000);
fs.utimesSync(oldFile, oldT, oldT);
const staleText = path.join(TMPROOT, 'stale.txt');
fs.writeFileSync(staleText, 's');
fs.utimesSync(staleText, new Date(Date.now() - 5 * 86400000), new Date(Date.now() - 5 * 86400000));

const r = scan(['--since', String(since)]);
const names = r.entries.map((e) => e.name).sort();
check('本轮新增条目被发现', names.includes('pkg-round') && names.includes('pkg.zip'), true);
check('早于 since 的条目不在本轮清单', names.includes('old.log'), false);
check('证据前缀被标记保留', r.entries.find((e) => e.name === 'QO-REL-keep')?.excluded, true);
check('证据目录不在推荐清理清单', r.recommended.clean.some((p) => p.includes('QO-REL-keep')), false);
check('超期件被带上', r.stale.some((f) => f.path.endsWith('stale.txt')), true);
check('超期件只作参考且不混入推荐清理清单', r.staleNote.includes('reference-only') && r.recommended.clean.some((p) => p.endsWith('stale.txt')), false);
check('目录体积被统计', (r.entries.find((e) => e.name === 'pkg-round')?.bytes || 0) >= 100, true);

const empty = path.join(ROOT, 'empty');
fs.mkdirSync(empty);
const r2 = scan(['--root', empty, '--since', String(since)]);
check('空目录返回零条目', r2.entries.length, 0);

console.log(results.join('\n'));
const failed = results.filter((x) => x.startsWith('FAIL')).length;
console.log(`\n=== tmp-round-scan 自测：通过 ${n - failed}，失败 ${failed} ===`);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
process.exit(failed ? 1 : 0);
