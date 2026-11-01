// 自测：hook-crash-guard 的 fail-open + 崩溃可见是否同时成立。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const GUARD = path.join(__dirname, 'hook-crash-guard.js');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-crash-test-'));
const LOG = path.join(TEMP, 'hooks-crash.log');
const NODE = process.execPath;
process.env.HOOK_CRASH_LOG = LOG;

const countLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0);
const run = (code) => {
  try { execFileSync(NODE, ['-e', code], { stdio: 'pipe', timeout: 15000 }); return 0; }
  catch (e) { return e.status === null ? -1 : e.status; }
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name + ' ' + extra); } };

try {
  const before = countLines();
  const code1 = `require(${JSON.stringify(GUARD)}).install('__selftest__'); throw new Error('boom-selftest');`;
  const rc1 = run(code1);
  const after1 = countLines();
  check('接守卫后崩溃仍放行（exit 0）', rc1 === 0, 'rc=' + rc1);
  check('崩溃写入日志（+1 行）', after1 === before + 1, `${before} -> ${after1}`);
  const lastLine = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').pop() : '';
  check('日志含 hook 名与错误信息', /__selftest__/.test(lastLine) && /boom-selftest/.test(lastLine), lastLine.slice(0, 120));

  const rc2 = run(`throw new Error('boom-control');`);
  const after2 = countLines();
  check('对照组（无守卫）非 0 退出', rc2 !== 0, 'rc=' + rc2);
  check('对照组不写日志（行数不变）', after2 === after1, `${after1} -> ${after2}`);

  const g = require(GUARD);
  const c = g.readCrashes(3600 * 1000);
  check('readCrashes 统计到失败记录', c.count >= 1 && /__selftest__/.test(c.samples.join(' ')), JSON.stringify(c).slice(0, 160));
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
