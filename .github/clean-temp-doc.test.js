'use strict';
// /clean-temp 文档 ↔ 真实判据一致性（F72）。
// 两个可失败判据：① 文档写的三个自测条数必须等于实跑条数（曾经写 63、实际 142，过期很久没人发现）；
// ② 文档里每条点名 tmp-round-scan.cjs 的 --apply 命令都必须带 --evidence-docs，
//    否则「文档登记证据」这层保护在照文档执行时永不生效。
// 两条都配负对照：改坏的文档副本必须被判红，防止校验器自己恒真。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const DOC = path.join(root, 'commands', 'clean-temp.md');
const SCRIPTS = ['tmp-sweeper.test.js', 'tmp-round-scan.test.js', 'tmp-round-scan-evidence.test.js'];

/** 实跑一个自测并取回真实条数；退出码非 0 直接失败（不拿崩溃冒充条数）。 */
function measuredTally(script) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { encoding: 'utf8', timeout: 300000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  assert.equal(r.status, 0, script + ' 必须全绿才谈得上比对条数：\n' + out.slice(-1500));
  const m = out.match(/通过 (\d+)，失败 (\d+)/);
  if (m) {
    assert.equal(Number(m[2]), 0, script + ' 有失败判据');
    return Number(m[1]);
  }
  // evidence 自测只打 PASS/FAIL 行 + 收尾标记：数 PASS 行，并要求标记存在且非空集。
  assert.match(out, /T18 ALL PASS/, script + ' 缺少收尾标记 T18 ALL PASS');
  const passes = [...out.matchAll(/^PASS\s/gm)].length;
  assert.ok(passes > 0, script + ' 一条 PASS 都没有（空集会让比对恒真）');
  return passes;
}

/** 文档里对每个自测声明的条数；命中次数必须恰好 1，否则「没写」会被当成「写对」。 */
function claimedCounts(doc) {
  return SCRIPTS.map((script) => {
    const re = new RegExp(script.replace(/\./g, '\\.') + '`（(\\d+) 条', 'g');
    const hits = [...doc.matchAll(re)];
    return { script, hits: hits.length, claimed: hits.length === 1 ? Number(hits[0][1]) : null };
  });
}

/** 文档里点名脚本的完整命令（反引号内）；只挑带 --apply 的，检查是否带 --evidence-docs。 */
function applyCommands(doc) {
  const cmds = [...doc.matchAll(/`[^`]*tmp-round-scan\.cjs[^`]*`/g)].map((m) => m[0]);
  return cmds.filter((c) => c.includes('--apply'))
    .map((cmd) => ({ cmd, guarded: cmd.includes('--evidence-docs') }));
}

const doc = fs.readFileSync(DOC, 'utf8');
const actual = new Map();
const tallyOf = (script) => {
  if (!actual.has(script)) actual.set(script, measuredTally(script));
  return actual.get(script);
};

test('文档声明的三个自测条数＝实跑条数（每处恰好命中 1 次）', () => {
  const claims = claimedCounts(doc);
  for (const c of claims) {
    assert.equal(c.hits, 1, `${c.script} 的条数声明在文档里应恰好出现 1 次，实测 ${c.hits} 次`);
    assert.equal(c.claimed, tallyOf(c.script), `${c.script} 文档写 ${c.claimed} 条，实跑 ${tallyOf(c.script)} 条`);
  }
});

test('文档里每条 --apply 命令都带 --evidence-docs（否则文档登记保护永不生效）', () => {
  const cmds = applyCommands(doc);
  assert.ok(cmds.length >= 3, `点名脚本的 --apply 命令应至少 3 条，实测 ${cmds.length}（清单为空会让本判据恒真）`);
  for (const c of cmds) assert.equal(c.guarded, true, `缺少 --evidence-docs：${c.cmd}`);
});

test('负对照：条数写错必须被判红（不是校验器恒真）', () => {
  const claims = claimedCounts(doc);
  const target = claims.find((c) => c.script === 'tmp-round-scan.test.js');
  assert.equal(target.hits, 1);
  const real = tallyOf(target.script);
  const broken = doc.replace(`tmp-round-scan.test.js\`（${target.claimed} 条`, `tmp-round-scan.test.js\`（${real - 1} 条`);
  assert.notEqual(broken, doc, '负对照必须真的改到文档副本');
  const brokenClaim = claimedCounts(broken).find((c) => c.script === 'tmp-round-scan.test.js');
  assert.equal(brokenClaim.claimed, real - 1);
  assert.notEqual(brokenClaim.claimed, real, '改错的条数必须与实跑不符');
  // 删掉整处声明也要被抓到（hits=0），不能因为「没写」而放行。
  const missing = doc.replace(/tmp-round-scan\.test\.js`（\d+ 条/, 'tmp-round-scan.test.js`（若干条');
  assert.equal(claimedCounts(missing).find((c) => c.script === 'tmp-round-scan.test.js').hits, 0);
});

test('负对照：漏掉 --evidence-docs 的 --apply 命令必须被判红', () => {
  const cmds = applyCommands(doc);
  assert.ok(cmds.length >= 3);
  const broken = doc.replace('--apply --evidence-docs <证据登记目录> --json', '--apply --json');
  assert.notEqual(broken, doc, '负对照必须真的改到文档副本');
  const bad = applyCommands(broken).filter((c) => !c.guarded);
  assert.ok(bad.length >= 1, '去掉开关后必须至少有一条命令被判为无保护');
});