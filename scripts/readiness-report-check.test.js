'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verify, checklistIds, DEFAULT_CHECKLIST, resolveDefaultChecklist, CHECKLIST_ROOTS } = require('./readiness-report-check.cjs');

const CLI = path.join(__dirname, 'readiness-report-check.cjs');
const CHECKLIST = ['| ID | 检查项 |', '| --- | --- |', '| AAA-01 | a |', '| AAA-02 | b |', '| BBB-01 | c |'].join('\n');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-readiness-'));
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function product(root) {
  write(root, 'src/a.ts', 'line1\nline2\nline3\n');
  write(root, 'src/b.ts', 'ok\n');
  return root;
}

function baseReport(root, overrides = {}) {
  return {
    schema: 1,
    product: { name: '示例产品', kind: 'saas', root },
    items: [
      { id: 'AAA-01', verdict: 'finding', severity: 'critical', risk: 'data-leak', note: '换 id 可读他人订单', evidence: [{ path: 'src/a.ts', line: 2 }] },
      { id: 'AAA-02', verdict: 'pass', evidence: [{ path: 'src/b.ts' }] },
      { id: 'BBB-01', verdict: 'not-applicable', reason: '本产品无该形态' },
    ],
    top: ['AAA-01'],
    ...overrides,
  };
}

const run = (report, checklist = CHECKLIST) => verify(report, { checklist });
const red = (result, fragment) => {
  assert.strictEqual(result.ok, false, '期望判红但通过了');
  assert.ok(result.violations.some(v => v.includes(fragment)), `违约里没有「${fragment}」：${JSON.stringify(result.violations)}`);
};

test('完整且诚实的报告通过', () => fixture(root => {
  product(root);
  const result = run(baseReport(root));
  assert.strictEqual(result.ok, true, JSON.stringify(result.violations));
  assert.strictEqual(result.readings.finding, 1);
  assert.strictEqual(result.readings.evidenceChecked, 2);
  assert.strictEqual(result.readings.checklistIds, 3);
}));

test('漏项判红：清单里有一条没定性', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items = report.items.slice(0, 2);
  red(run(report), '未定性');
}));

test('清单外的 ID 判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[2].id = 'ZZZ-99';
  red(run(report), '不在清单内');
}));

test('重复 ID 判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[1] = { ...report.items[0] };
  red(run(report), 'ID 重复');
}));

test('finding 无证据判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  delete report.items[0].evidence;
  red(run(report), 'finding 必须给证据');
}));

test('变异对照：把绿报告里的证据路径改成不存在的文件即判红', () => fixture(root => {
  product(root);
  const green = baseReport(root);
  assert.strictEqual(run(green).ok, true);
  const mutated = JSON.parse(JSON.stringify(green));
  mutated.items[0].evidence[0].path = 'src/does-not-exist.ts';
  red(run(mutated), '文件不存在');
}));

test('证据越出被审查仓库判红', () => fixture(root => {
  product(root);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-readiness-outside-'));
  try {
    write(outside, 'secret.txt', 'outside\n');
    const report = baseReport(root);
    report.items[0].evidence = [{ path: path.relative(root, path.join(outside, 'secret.txt')) }];
    red(run(report), '越出被审查仓库');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('证据行号超出文件行数判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[0].evidence[0].line = 99;
  red(run(report), '超出文件行数');
}));

test('证据行号为 0 判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[0].evidence[0].line = 0;
  red(run(report), '≥1 的整数');
}));

test('仓库内的绝对路径证据可以通过', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[0].evidence = [{ path: path.join(root, 'src', 'a.ts'), line: 1 }];
  assert.strictEqual(run(report).ok, true);
}));

test('pass 无证据判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  delete report.items[1].evidence;
  red(run(report), 'pass 必须给证据');
}));

test('not-applicable 缺理由判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  delete report.items[2].reason;
  red(run(report), '为什么不适用');
}));

test('not-applicable 带严重度判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[2].severity = 'low';
  red(run(report), 'not-applicable 不许带 severity');
}));

test('unverified 缺理由判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[2] = { id: 'BBB-01', verdict: 'unverified' };
  red(run(report), '为什么无法确认');
}));

test('unverified 带严重度判红：没查的项不能排严重度', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.items[2] = { id: 'BBB-01', verdict: 'unverified', reason: '缺客户环境信息', severity: 'critical' };
  red(run(report), 'unverified 不许带 severity');
}));

test('前十顺序被人为调换判红', () => fixture(root => {
  product(root);
  const checklist = CHECKLIST + '\n| BBB-02 | d |';
  const report = baseReport(root, {
    items: [
      { id: 'AAA-01', verdict: 'finding', severity: 'high', risk: 'other', note: '次要问题', evidence: [{ path: 'src/a.ts' }] },
      { id: 'AAA-02', verdict: 'finding', severity: 'critical', risk: 'money-loss', note: '重复扣款', evidence: [{ path: 'src/b.ts' }] },
      { id: 'BBB-01', verdict: 'not-applicable', reason: '无该形态' },
      { id: 'BBB-02', verdict: 'pass', evidence: [{ path: 'src/b.ts' }] },
    ],
    top: ['AAA-01', 'AAA-02'],
  });
  red(run(report, checklist), '顺序不符合');
}));

test('同严重度按风险类别排序：data-leak 先于 money-loss', () => fixture(root => {
  product(root);
  const checklist = CHECKLIST + '\n| BBB-02 | d |';
  const items = [
    { id: 'AAA-01', verdict: 'finding', severity: 'critical', risk: 'money-loss', note: '重复扣款', evidence: [{ path: 'src/a.ts' }] },
    { id: 'AAA-02', verdict: 'finding', severity: 'critical', risk: 'data-leak', note: '越权读', evidence: [{ path: 'src/b.ts' }] },
    { id: 'BBB-01', verdict: 'not-applicable', reason: '无该形态' },
    { id: 'BBB-02', verdict: 'not-applicable', reason: '无该形态' },
  ];
  const report = baseReport(root, { items, top: ['AAA-02', 'AAA-01'] });
  assert.strictEqual(run(report, checklist).ok, true);
  const swapped = baseReport(root, { items, top: ['AAA-01', 'AAA-02'] });
  red(run(swapped, checklist), '顺序不符合');
}));

test('前十只取 10 条：12 个 finding 时给 9 条判红', () => fixture(root => {
  product(root);
  const ids = Array.from({ length: 12 }, (_, i) => 'AAA-' + String(i + 1).padStart(2, '0'));
  const checklist = ['| ID | 检查项 |', ...ids.map(id => `| ${id} | x |`)].join('\n');
  const items = ids.map((id, i) => ({ id, verdict: 'finding', severity: 'high', risk: 'other', note: '问题 ' + i, evidence: [{ path: 'src/a.ts' }] }));
  const expected = ids.slice(0, 10);
  assert.strictEqual(run(baseReport(root, { items, top: expected }), checklist).ok, true);
  red(run(baseReport(root, { items, top: ids.slice(0, 9) }), checklist), '应为 10 条');
}));

test('前十含非 finding 项判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.top = ['AAA-01', 'AAA-02'];
  red(run(report), '非 finding 项');
}));

test('top 不是数组判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  delete report.top;
  red(run(report), 'top 必须是数组');
}));

test('没有问题时 top 为空数组即通过', () => fixture(root => {
  product(root);
  const report = baseReport(root, {
    items: [
      { id: 'AAA-01', verdict: 'pass', evidence: [{ path: 'src/a.ts' }] },
      { id: 'AAA-02', verdict: 'pass', evidence: [{ path: 'src/b.ts' }] },
      { id: 'BBB-01', verdict: 'not-applicable', reason: '无该形态' },
    ],
    top: [],
  });
  assert.strictEqual(run(report).ok, true);
}));

test('空 items 判红：空报告不算审查过', () => fixture(root => {
  product(root);
  red(run(baseReport(root, { items: [] })), '非空数组');
}));

test('schema 不是 1 判红', () => fixture(root => {
  product(root);
  red(run(baseReport(root, { schema: 2 })), 'schema 必须是 1');
}));

test('product.kind 非法判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.product.kind = 'mainframe';
  red(run(report), 'product.kind 非法');
}));

test('product.root 是相对路径判红', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.product.root = 'relative/dir';
  red(run(report), '必须是绝对路径');
}));

test('product.root 不存在判红并给提示', () => fixture(root => {
  product(root);
  const report = baseReport(root);
  report.product.root = path.join(root, 'missing-dir');
  const result = run(report);
  red(result, '不是存在的目录');
  assert.ok(result.advisory.some(a => a.includes('证据存在性未核对')));
}));

test('无法确认占比超 30% 给 advisory 但不阻断', () => fixture(root => {
  product(root);
  const report = baseReport(root, {
    items: [
      { id: 'AAA-01', verdict: 'unverified', reason: '缺权限' },
      { id: 'AAA-02', verdict: 'unverified', reason: '缺环境' },
      { id: 'BBB-01', verdict: 'pass', evidence: [{ path: 'src/b.ts' }] },
    ],
    top: [],
  });
  const result = run(report);
  assert.strictEqual(result.ok, true);
  assert.ok(result.advisory.some(a => a.includes('结论覆盖不足')));
}));

test('清单解析不出 ID 时抛错，不静默通过', () => fixture(root => {
  product(root);
  assert.throws(() => run(baseReport(root), '# 没有表格的清单'), error => error.code === 'CHECKLIST_UNPARSEABLE');
}));

test('清单重号时抛错', () => fixture(root => {
  product(root);
  assert.throws(() => run(baseReport(root), CHECKLIST + '\n| AAA-01 | 重号 |'), error => error.code === 'CHECKLIST_DUPLICATE_ID');
}));

test('随包清单真源可用：147 项全判不适用则通过，漏一项即判红', () => fixture(root => {
  product(root);
  const markdown = fs.readFileSync(DEFAULT_CHECKLIST, 'utf8');
  const ids = checklistIds(markdown);
  assert.ok(ids.length >= 140, '随包清单 ID 数异常：' + ids.length);
  assert.strictEqual(new Set(ids).size, ids.length, '随包清单有重号');
  const items = ids.map(id => ({ id, verdict: 'not-applicable', reason: '集成夹具：逐项定性以验证覆盖判据' }));
  const report = baseReport(root, { items, top: [] });
  const green = verify(report, { checklist: markdown });
  assert.strictEqual(green.ok, true, JSON.stringify(green.violations));
  assert.strictEqual(green.readings.checklistIds, ids.length);
  const dropped = baseReport(root, { items: items.slice(1), top: [] });
  red(verify(dropped, { checklist: markdown }), '未定性');
}));

function cli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('CLI：绿报告 exit 0、红报告 exit 1、缺文件与坏 JSON exit 2', () => fixture(root => {
  product(root);
  const checklistFile = write(root, 'checklist.md', CHECKLIST);
  const greenFile = write(root, 'green.json', JSON.stringify(baseReport(root)));
  const bad = baseReport(root);
  delete bad.items[0].evidence;
  const redFile = write(root, 'red.json', JSON.stringify(bad));
  const brokenFile = write(root, 'broken.json', '{invalid');

  const green = cli([greenFile, '--checklist', checklistFile, '--json']);
  assert.strictEqual(green.status, 0, green.stdout + green.stderr);
  assert.strictEqual(JSON.parse(green.stdout).verdict, 'OK');

  const redRun = cli([redFile, '--checklist', checklistFile, '--json']);
  assert.strictEqual(redRun.status, 1, redRun.stdout + redRun.stderr);
  assert.strictEqual(JSON.parse(redRun.stdout).verdict, 'VIOLATIONS');

  assert.strictEqual(cli([path.join(root, 'nope.json'), '--checklist', checklistFile]).status, 2);
  const broken = cli([brokenFile, '--checklist', checklistFile]);
  assert.strictEqual(broken.status, 2);
  assert.strictEqual(JSON.parse(broken.stdout).code, 'REPORT_INVALID_JSON');
  assert.strictEqual(cli([]).status, 2);
}));

test('CLI：默认清单就是随包清单，未知参数 exit 2', () => fixture(root => {
  product(root);
  assert.strictEqual(fs.existsSync(DEFAULT_CHECKLIST), true);
  const reportFile = write(root, 'r.json', JSON.stringify(baseReport(root)));
  assert.strictEqual(cli([reportFile, '--bogus']).status, 2);
}));

// 安装分层覆盖：catalog 声明 tier=library，安装后清单在 skills-library/ 而非 skills/。
// 沙箱把脚本复制到 <root>/scripts/，只建对应层，验证「默认路径」在真实安装形态下可用。
function tierSandbox(root, tier) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const cliCopy = path.join(scriptsDir, 'readiness-report-check.cjs');
  fs.copyFileSync(CLI, cliCopy);
  const markdown = fs.readFileSync(DEFAULT_CHECKLIST, 'utf8');
  if (tier) write(root, path.join(tier, 'production-readiness-audit', 'references', 'checklist.md'), markdown);
  const reportFile = write(root, 'r.json', '[]');
  const r = spawnSync(process.execPath, [cliCopy, reportFile, '--json'], { encoding: 'utf8' });
  return { r, markdown, ids: checklistIds(markdown).length };
}

test('分层解析：library 优先、core 回退、两层皆无返回首选而不静默兜底', () => fixture(root => {
  const rel = path.join('production-readiness-audit', 'references', 'checklist.md');
  assert.deepStrictEqual(CHECKLIST_ROOTS, ['skills-library', 'skills']);
  assert.strictEqual(resolveDefaultChecklist(root), path.join(root, 'skills-library', rel));
  write(root, path.join('skills', rel), 'core');
  assert.strictEqual(resolveDefaultChecklist(root), path.join(root, 'skills', rel));
  write(root, path.join('skills-library', rel), 'library');
  assert.strictEqual(resolveDefaultChecklist(root), path.join(root, 'skills-library', rel));
}));

test('library 层安装形态：只有 skills-library 时默认调用读到随包清单（不再 ENOENT）', () => fixture(root => {
  const { r, ids } = tierSandbox(root, 'skills-library');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.verdict, 'VIOLATIONS');
  assert.strictEqual(out.readings.checklistIds, ids);
  assert.ok(ids >= 140, '随包清单 ID 数异常：' + ids);
}));

test('core 层安装形态：只有 skills 时默认调用同样可用', () => fixture(root => {
  const { r, ids } = tierSandbox(root, 'skills');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).readings.checklistIds, ids);
}));

test('负对照：两层皆无时默认调用必须 exit 2 ENOENT，不得静默通过', () => fixture(root => {
  const { r } = tierSandbox(root, null);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.code, 'ENOENT');
  assert.ok(String(out.message).includes('skills-library'), out.message);
}));