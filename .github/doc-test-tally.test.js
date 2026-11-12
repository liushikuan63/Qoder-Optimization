'use strict';
// 文档里声明的「自测条数」必须等于实跑条数（F72 起，2026-11-12 扩到第二份文档）。
// 为什么值得一条常驻判据：同一族缺陷已经咬了两次——
//   · commands/clean-temp.md 写 63 条，实跑 142 条（tmp-round-scan.test.js 涨了两轮没人回写）；
//   · scripts/README-rule-enforcement.md 写 23 条，实跑 90 条（huge-output-guard.test.js 涨了四轮）。
// 文档是照它执行的入口，条数过期＝读者以为覆盖到位，实际差着一大截。
// 附带第二条判据：clean-temp.md 里每条点名 tmp-round-scan.cjs 的 --apply 命令都必须带 --evidence-docs，
// 否则「文档登记证据」这层保护在照文档执行时永不生效。
// 每条判据都配负对照：改坏的文档副本必须被判红，防止校验器自己恒真。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// 一份文档一组声明；reSrc 每次现建 RegExp，避免 /g 的 lastIndex 在多次比对间串味。
const DOCS = [
  {
    rel: 'commands/clean-temp.md',
    applyGuard: true,
    claims: [
      { script: 'tmp-sweeper.test.js', reSrc: 'tmp-sweeper\\.test\\.js`（(\\d+) 条' },
      { script: 'tmp-round-scan.test.js', reSrc: 'tmp-round-scan\\.test\\.js`（(\\d+) 条' },
      { script: 'tmp-round-scan-evidence.test.js', reSrc: 'tmp-round-scan-evidence\\.test\\.js`（(\\d+) 条' },
    ],
  },
  {
    rel: 'scripts/README-rule-enforcement.md',
    applyGuard: false,
    claims: [
      { script: 'huge-output-guard.test.js', reSrc: 'huge-output-guard\\.test\\.js`（\\*\\*(\\d+) 条\\*\\*' },
    ],
  },
];

/** 实跑一个自测并取回真实条数；退出码非 0 直接失败（不拿崩溃冒充条数）。 */
function measuredTally(script) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script)], { encoding: 'utf8', timeout: 300000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  assert.equal(r.status, 0, script + ' 必须全绿才谈得上比对条数：\n' + out.slice(-1500));
  const m = out.match(/通过 (\d+)，失败 (\d+)/);
  if (m) {
    assert.equal(Number(m[2]), 0, script + ' 有失败判据');
    assert.ok(Number(m[1]) > 0, script + ' 一条判据都没有（空集会让比对恒真）');
    return Number(m[1]);
  }
  // huge-output-guard 自测收尾打 `N PASS / M FAIL`。
  const h = out.match(/(\d+) PASS \/ (\d+) FAIL/);
  if (h) {
    assert.equal(Number(h[2]), 0, script + ' 有失败判据');
    assert.ok(Number(h[1]) > 0, script + ' 一条 PASS 都没有（空集会让比对恒真）');
    return Number(h[1]);
  }
  // evidence 自测只打 PASS/FAIL 行 + 收尾标记：数 PASS 行，并要求标记存在且非空集。
  assert.match(out, /T18 ALL PASS/, script + ' 缺少收尾标记 T18 ALL PASS');
  const passes = [...out.matchAll(/^PASS\s/gm)].length;
  assert.ok(passes > 0, script + ' 一条 PASS 都没有（空集会让比对恒真）');
  return passes;
}

const actual = new Map();
const tallyOf = (script) => {
  if (!actual.has(script)) actual.set(script, measuredTally(script));
  return actual.get(script);
};

/** 文档里对某个自测声明的条数；命中次数必须恰好 1，否则「没写」会被当成「写对」。 */
function claimOf(docText, claim) {
  const hits = [...docText.matchAll(new RegExp(claim.reSrc, 'g'))];
  return { script: claim.script, hits: hits.length, claimed: hits.length === 1 ? Number(hits[0][1]) : null };
}
const readDoc = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** 文档里的 --apply 命令（反引号内）。
 *  旧写法要求反引号内**同时点名脚本**，于是 clean-temp.md:9 的简写
 *  `--apply --include-share-package --json` 整条漏检（F81，2026-11-12 第八段）：
 *  文档自身在第 32 行声明「本文所有 --apply 命令都带它」，而照第 9 行执行时保护永不生效。
 *  现在的口径：含 --apply 且「不止一个 flag **或** 点名脚本」就算一条命令；
 *  单独的 `--apply` 是名词提及（文档里有 8 处），不算命令——否则守卫会把正常文档判红而被关掉。 */
function applyCommands(docText) {
  const spans = [...docText.matchAll(/`[^`]*`/g)].map((m) => m[0]);
  return spans
    .filter((s) => s.includes('--apply'))
    .filter((s) => (s.match(/--[a-z][a-z-]*/g) || []).length >= 2 || /tmp-round-scan\.cjs/.test(s))
    .map((cmd) => ({ cmd, guarded: cmd.includes('--evidence-docs') }));
}

/** 按配置决定查不查这份文档：applyGuard=false ⇒ null（跳过）。
 *  旧实现里 DOCS 的 applyGuard 字段**从未被读过**，两条判据硬编码 clean-temp.md，
 *  等于配置是装饰品；这里让它真的决定行为，并配一条能失败的判据证明它被读了。 */
function applyFindings(cfg, docText) {
  if (!cfg.applyGuard) return null;
  const cmds = applyCommands(docText);
  return { cmds, unguarded: cmds.filter((c) => !c.guarded) };
}

for (const cfg of DOCS) {
  test(`${cfg.rel}：声明的自测条数＝实跑条数（每处恰好命中 1 次）`, () => {
    const docText = readDoc(cfg.rel);
    assert.ok(cfg.claims.length > 0, '声明清单为空会让本判据恒真');
    for (const claim of cfg.claims) {
      const c = claimOf(docText, claim);
      assert.equal(c.hits, 1, `${claim.script} 的条数声明在 ${cfg.rel} 里应恰好出现 1 次，实测 ${c.hits} 次`);
      assert.equal(c.claimed, tallyOf(claim.script),
        `${claim.script} 文档写 ${c.claimed} 条，实跑 ${tallyOf(claim.script)} 条`);
    }
  });

  test(`负对照：${cfg.rel} 条数写错或整处删掉都必须被判红`, () => {
    const docText = readDoc(cfg.rel);
    for (const claim of cfg.claims) {
      const c = claimOf(docText, claim);
      assert.equal(c.hits, 1);
      const real = tallyOf(claim.script);
      const wrong = docText.replace(new RegExp(claim.reSrc), (m0, n) => m0.replace(n, String(real - 1)));
      assert.notEqual(wrong, docText, '负对照必须真的改到文档副本：' + claim.script);
      const wc = claimOf(wrong, claim);
      assert.equal(wc.claimed, real - 1);
      assert.notEqual(wc.claimed, real, '改错的条数必须与实跑不符：' + claim.script);
      // 删掉整处声明也要被抓到（hits=0），不能因为「没写」而放行。
      const missing = docText.replace(new RegExp(claim.reSrc), (m0) => m0.replace(/\d+ 条/, '若干条'));
      assert.notEqual(missing, docText, '负对照必须真的删掉数字：' + claim.script);
      assert.equal(claimOf(missing, claim).hits, 0, '去掉数字后不应再命中声明：' + claim.script);
    }
  });
}

const guardedDocs = DOCS.filter((d) => d.applyGuard);

test('applyGuard 配置真的决定行为（false 跳过 / true 查出无保护命令）', () => {
  assert.ok(guardedDocs.length > 0, 'applyGuard=true 的文档一个都没有，这组判据会恒真');
  assert.ok(DOCS.some((d) => !d.applyGuard), 'DOCS 里没有 applyGuard=false 的条目，无法证明该字段被读过');
  const sample = '改用 `--apply --include-share-package --json` 自动清理。\n';
  assert.equal(applyFindings({ applyGuard: false }, sample), null, 'applyGuard=false 必须跳过');
  const on = applyFindings({ applyGuard: true }, sample);
  assert.equal(on.cmds.length, 1, 'applyGuard=true 必须认出这条简写命令');
  assert.equal(on.unguarded.length, 1, '缺 --evidence-docs 必须被判为无保护');
});

for (const cfg of guardedDocs) {
  test(`${cfg.rel} 里每条 --apply 命令都带 --evidence-docs（否则文档登记保护永不生效）`, () => {
    const f = applyFindings(cfg, readDoc(cfg.rel));
    assert.ok(f.cmds.length >= 3, `--apply 命令应至少 3 条，实测 ${f.cmds.length}（清单为空会让本判据恒真）`);
    for (const c of f.unguarded) assert.fail(`缺少 --evidence-docs：${c.cmd}`);
  });

  test(`负对照：${cfg.rel} 漏掉 --evidence-docs 的 --apply 命令必须被判红`, () => {
    const docText = readDoc(cfg.rel);
    const f = applyFindings(cfg, docText);
    assert.ok(f.cmds.length >= 3);
    const broken = docText.replace('--apply --evidence-docs <证据登记目录> --json', '--apply --json');
    assert.notEqual(broken, docText, '负对照必须真的改到文档副本');
    const bad = applyFindings(cfg, broken).unguarded;
    assert.ok(bad.length >= 1, '去掉开关后必须至少有一条命令被判为无保护');
  });
}

test('负对照：省略脚本名的 --apply 简写必须被认出，而名词提及不算命令（F81 的洞）', () => {
  const synthetic = '改用 `--apply --include-share-package --json` 自动清理。\n';
  const cmds = applyCommands(synthetic);
  assert.equal(cmds.length, 1, '简写命令必须被认出');
  assert.equal(cmds[0].guarded, false);
  // 差分：旧判据（反引号内必须点名脚本）对同一段文本认不出任何命令 —— 证明这条判据真的变强了。
  const old = [...synthetic.matchAll(/`[^`]*tmp-round-scan\.cjs[^`]*`/g)]
    .map((m) => m[0]).filter((c) => c.includes('--apply'));
  assert.equal(old.length, 0, '旧判据本应漏掉它（否则这条负对照没有鉴别力）');
  // 名词提及不是命令：文档里 8 处单独的 `--apply` 不该被判红。
  assert.equal(applyCommands('本文所有 `--apply` 命令都带它；`tmp-round-scan --apply` 同理。').length, 0);
});