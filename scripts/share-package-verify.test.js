'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('child_process');

// 自测条数不写死：写死的数字会随判据增加而过期（同族缺陷已在 clean-temp.md 与 README-rule-enforcement.md 上咬过）。
// 这里的判据是「自报条数 == 实际打出的用例标签数」，两边都能失败：漏跑用例或虚报条数都会判红。
function selftestTally(stdout) {
  const m = /SELFTEST=PASS \((\d+) 正例 \/ (\d+) 负例\)/.exec(stdout);
  assert.ok(m, '自测必须打出 SELFTEST=PASS (N 正例 / M 负例)：\n' + stdout);
  const labels = [...stdout.matchAll(/\[(正例|负例)·[^\]]+\] exit=\d+/g)].map((x) => x[1]);
  const pos = labels.filter((k) => k === '正例').length;
  const neg = labels.filter((k) => k === '负例').length;
  assert.ok(pos > 0 && neg > 0, '正例与负例都必须非空（空集会让比对恒真）');
  assert.equal(Number(m[1]), pos, `自报正例 ${m[1]} 条，实际打出 ${pos} 条`);
  assert.equal(Number(m[2]), neg, `自报负例 ${m[2]} 条，实际打出 ${neg} 条`);
  return { pos, neg };
}

test('share-package-verify 自测全过（自报条数＝实际用例数）', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'share-package-verify.cjs'), '--selftest'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SELFTEST=PASS/);
  selftestTally(r.stdout);
});

// T-01 变异负对照：把执行器的 descOf 改回「裸正则取原始行」后，
// 解码后恰好 300 的 quoted 边界用例必须判红（exit 2）；
// 负对照＝unquoted 300 与其余全部负例的结论必须一字不变，否则说明变异打歪了。
// 变异只发生在临时沙箱副本里，仓库文件零写入；selftest 的子进程用 __filename 启动，
// 所以必须整份复制（含 skill-description.cjs / skills-doctor.cjs）才能让子进程也吃到变异。
test('mutant: bare-regex descOf must fail the quoted 300 boundary and leave every negative control intact', t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgverify-mutant-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const target = path.join(__dirname, 'share-package-verify.cjs');
  const src = fs.readFileSync(target, 'utf8');
  const SHARED = "  try { return require('./skill-description.cjs').descriptionOfFile(file); } catch (e) { return null; }";
  const BARE = "  try { const t = fs.readFileSync(file, 'utf8'); return (t.match(/^description:\\s*(.+)$/m) || [])[1] || null; } catch (e) { return null; }";
  const hits = src.split(SHARED).length - 1;
  assert.equal(hits, 1, `变异锚点必须命中恰好 1 次，实测 ${hits}；锚点漂移时本对照不得静默通过`);
  for (const dep of ['skill-description.cjs', 'skills-doctor.cjs']) {
    fs.copyFileSync(path.join(__dirname, dep), path.join(sandbox, dep));
  }
  fs.writeFileSync(path.join(sandbox, 'share-package-verify.cjs'), src.replace(SHARED, BARE));

  const exitsOf = (stdout) => {
    const map = {};
    for (const m of stdout.matchAll(/\[([^\]]+)\] exit=(\d+)/g)) map[m[1]] = Number(m[2]);
    return map;
  };
  const run = (script) => spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 120000 });

  const real = run(target);
  const mutant = run(path.join(sandbox, 'share-package-verify.cjs'));
  const realExits = exitsOf(real.stdout);
  const mutantExits = exitsOf(mutant.stdout);

  assert.equal(real.status, 0, real.stdout + real.stderr);
  assert.match(real.stdout, /SELFTEST=PASS/);
  assert.equal(realExits['正例·quoted300'], 0, '真源：quoted 解码后 300 应判绿');
  assert.equal(realExits['正例·unquoted300'], 0, '真源：unquoted 300 应判绿');

  assert.equal(mutant.status, 2, '变异后自测必须整体判红\n' + mutant.stdout + mutant.stderr);
  assert.match(mutant.stdout, /SELFTEST=FAIL/);
  assert.equal(mutantExits['正例·quoted300'], 2, '变异后 quoted 300 边界必须 exit 2（含引号多算 2 字符）');

  // 负对照：变异只该打到 quoted 边界，其余结论必须与真源完全一致
  assert.equal(mutantExits['正例·unquoted300'], 0, '负对照：unquoted 300 不受变异影响');
  assert.equal(mutantExits['正例·干净包'], 0, '负对照：短描述正例不受变异影响');
  const negatives = Object.keys(realExits).filter(k => k.startsWith('负例'));
  // 负例条数取自真源实跑（不写死）：新增负例时这里自动跟上，漏跑用例则条数对不上而判红。
  const expectedNeg = selftestTally(real.stdout).neg;
  assert.equal(negatives.length, expectedNeg, `负例数量应为 ${expectedNeg}，实测 ${negatives.length}`);
  assert.equal(Object.keys(mutantExits).length, Object.keys(realExits).length, '变异后用例数不得减少（少跑＝对照失效）');
  for (const k of negatives) {
    assert.equal(realExits[k], 2, `真源负例 ${k} 应判红`);
    assert.equal(mutantExits[k], 2, `负对照：变异后 ${k} 仍应判红`);
  }
  const flipped = Object.keys(realExits).filter(k => realExits[k] !== mutantExits[k]);
  assert.deepEqual(flipped, ['正例·quoted300'], `变异只应翻转 quoted300 一格，实测翻转 ${JSON.stringify(flipped)}`);
});

for (const [name, scriptCount, includeDirectory, exitCode] of [
  ['count a directory script once regardless of nested files', 2, true, 0],
  ['reject catalog counts that omit a directory script', 1, true, 2],
  ['reject a missing directory script', 2, false, 2],
]) {
  test(name, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgverify-directory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, text) => {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    for (const file of ['VERSION', 'skills-manifest.json', 'Qoder-AI编码通用规则.md', 'README-安装说明.md', 'INDEX.md']) write(file, '{}\n');
    write('catalog.json', JSON.stringify({ counts: { skill: 0, command: 0, agent: 0, script: scriptCount } }));
    write('scripts/plain.cjs', 'module.exports = true;\n');
    if (includeDirectory) {
      write('scripts/runtime/package.json', '{"main":"index.cjs"}\n');
      write('scripts/runtime/package-lock.json', '{"lockfileVersion":3}\n');
      write('scripts/runtime/index.cjs', "module.exports = require('./lib/part.cjs');\n");
      write('scripts/runtime/lib/part.cjs', 'module.exports = true;\n');
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, 'share-package-verify.cjs'), root], { encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, exitCode, result.stdout + result.stderr);
    assert.match(result.stdout, exitCode === 0 ? /script=2/ : /catalog 计数不符/);
  });
}
