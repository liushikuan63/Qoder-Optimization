#!/usr/bin/env node
// 接续队列可恢复性校验：`.qoder-work-queue.md` 到底能不能被下一个人（或下一次会话）接着做。
//
// 背景：stop-gate 的 R6 只查"有没有未完成的 `- [ ]`"，查不出**队列本身写得不可恢复**——
// 缺"下一步"、阻塞没写理由、关键入口指向的文件已经不存在，都会让接续方白跑一轮。
// 这把"落盘"从"写了就行"变成"能被机器检查"。
//
// 用法：
//   node work-queue-check.js [--file <路径>] [--json]
//   node work-queue-check.js --selftest
// 退出码：0 = 可接续；1 = 有问题（消息里逐条说明）；2 = 用法错误；3 = **没找到队列文件**（调用方自行决定是否放行）
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// HOME 解析：本机 Git Bash 里 HOME 可能是 /tmp（MSYS 口径），拿它拼 `~/...` 会全部判成不存在。
// 所以按"哪个候选下有客户端目录（.qoder 或 .qoder-cn）就用哪个"来定，顺序 USERPROFILE → os.homedir() → HOME。
const HOME = [process.env.USERPROFILE, os.homedir(), process.env.HOME]
  .filter(Boolean)
  .find((h) => { try { return fs.existsSync(path.join(h, '.qoder')) || fs.existsSync(path.join(h, '.qoder-cn')); } catch (e) { return false; } }) || os.homedir();
const QUEUE_NAME = '.qoder-work-queue.md';

// 四要素：写成"关键词任一命中"而不是固定标题，避免为配合检查而改标题
const SECTIONS = [
  ['当前状态（做到哪）', /(当前状态|已完成|做到哪|进度)/],
  ['下一步（下一件事）', /(下一步|待办|待做)/],
  ['阻塞点', /(阻塞|卡点)/],
  ['关键入口（文件 / 命令）', /(关键入口|入口|路径与命令|验证命令)/],
];
// 暂时不该存在的路径：行里带这些标注就跳过存在性检查
const PENDING_MARK = /(待建|待生成|待创建|TBD|计划中)/;

function findQueue(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const d of [process.cwd(), HOME]) {
    const p = path.join(d, QUEUE_NAME);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function expand(p) {
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

function checkText(text, baseDir) {
  const errors = [], warns = [];
  const lines = text.split(/\r?\n/);

  for (const [label, re] of SECTIONS) {
    const hit = lines.some((l) => /^#{1,4}\s/.test(l) && re.test(l));
    if (!hit) errors.push(`缺「${label}」小节（标题里要能看出这一节是干什么的）`);
  }

  lines.forEach((l, i) => {
    const n = i + 1;
    if (/^\s*-\s*\[ \]/.test(l)) {
      const body = l.replace(/^\s*-\s*\[ \]\s*/, '').trim();
      if (body.length < 8) errors.push(`第 ${n} 行：未完成项没说清做什么（太短）`);
      if (/(阻塞|blocked)/i.test(body) && !/阻塞[:：]\s*\S{4,}/.test(body)) {
        errors.push(`第 ${n} 行：标了阻塞但没写「阻塞：<具体外部条件>」`);
      }
    }
  });

  // 关键入口里的路径存在性：只查这一节，且带"待建"标注的跳过
  const start = lines.findIndex((l) => /^#{1,4}\s/.test(l) && /(关键入口|入口|路径与命令|验证命令)/.test(l));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^#{1,4}\s/.test(lines[i])) { end = i; break; }
    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      if (PENDING_MARK.test(line)) continue;
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const raw = m[1].trim();
        if (!/^(~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(raw)) continue; // 只查明显是路径的
        if (/[*?<>]/.test(raw)) continue;                                  // 通配/占位不查
        // 入口属于队列；从其它 cwd 运行 --file 不应改变检查结果。
        const p = path.resolve(baseDir, expand(raw));
        if (!fs.existsSync(p)) errors.push(`第 ${i + 1} 行：关键入口指向的路径不存在 → ${raw}`);
      }
    }
  }
  return { errors, warns };
}

// ── selftest ─────────────────────────────────────────────────────────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-check-'));
  let pass = 0, fail = 0;
  const ok = (c, msg) => { if (c) pass++; else { fail++; console.error('  FAIL ' + msg); } };
  const write = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };
  const run = (file) => {
    const r = require('child_process').spawnSync(process.execPath, [__filename, '--file', file], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const realPath = path.join(tmp, 'exists.md');
  fs.writeFileSync(realPath, 'x');

  const good = write('good.md', [
    '# 交接', '', '## 当前状态', '- 已完成 A', '', '## 下一步', '- [ ] 做 B（先读 C）', '',
    '## 阻塞点', '- 无', '', '## 关键入口', `- \`${realPath}\``, '',
  ].join('\n'));
  const r1 = run(good); ok(r1.code === 0, '正例应 exit 0（实际 ' + r1.code + '）' + r1.out.slice(0, 120));

  const noNext = write('no-next.md', ['## 当前状态', '- A', '', '## 阻塞点', '- 无', '', '## 关键入口', '- 无'].join('\n'));
  ok(run(noNext).code === 1, '缺「下一步」应 exit 1');

  const badBlocker = write('bad-blocker.md', ['## 当前状态', '- A', '', '## 下一步', '- [ ] 做 B', '', '## 阻塞点', '- [~] 卡在外部依赖 阻塞：', '', '## 关键入口', '- 无'].join('\n'));
  ok(run(badBlocker).code === 1, '阻塞没写理由应 exit 1');

  const badPath = write('bad-path.md', ['## 当前状态', '- A', '', '## 下一步', '- [ ] 做 B', '', '## 阻塞点', '- 无', '', '## 关键入口', '- `~/definitely/not/here.md`'].join('\n'));
  ok(run(badPath).code === 1, '关键入口指向不存在的路径应 exit 1');

  const pending = write('pending.md', ['## 当前状态', '- A', '', '## 下一步', '- [ ] 做 B 这件事（先读 C 那一段）', '', '## 阻塞点', '- 无', '', '## 关键入口', '- `~/definitely/not/here.md`（待建）'].join('\n'));
  ok(run(pending).code === 0, '标注「待建」的不存在路径应放行（exit 0，实际 ' + run(pending).code + '）');

  // 短条目
  const shortItem = write('short.md', ['## 当前状态', '- A', '', '## 下一步', '- [ ] x', '', '## 阻塞点', '- 无', '', '## 关键入口', '- 无'].join('\n'));
  ok(run(shortItem).code === 1, '未完成项过短应 exit 1');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nwork-queue-check 自测：${pass} 通过 / ${fail} 失败`);
  return fail ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────
let explicit = null, asJson = false, runSelftest = false;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') asJson = true;
    else if (flag === '--selftest') runSelftest = true;
    else if (flag === '--file') {
      const value = args[++i];
      if (explicit !== null || !value || !value.trim() || value.startsWith('--')) throw new Error('--file 需要一个明确路径');
      explicit = value;
    } else throw new Error('未知参数：' + flag);
  }
  if (runSelftest && (explicit !== null || asJson)) throw new Error('--selftest 不能与其它模式混用');
} catch (error) { console.error('参数错误：' + error.message); process.exit(2); }
if (runSelftest) process.exit(selftest());
const file = findQueue(explicit);
if (!file) {
  console.log('未找到 ' + QUEUE_NAME + '（没有队列，视为无需接续）');
  process.exit(3);
}
const { errors, warns } = checkText(fs.readFileSync(file, 'utf8'), path.dirname(path.resolve(file)));
if (asJson) console.log(JSON.stringify({ file, ok: errors.length === 0, errors, warns }, null, 2));
else {
  console.log('检查 ' + file);
  for (const w of warns) console.log('  [提示] ' + w);
  for (const e of errors) console.log('  [问题] ' + e);
  if (!errors.length) console.log('可接续：四要素齐全，未完成项与关键入口都可用');
}
process.exit(errors.length ? 1 : 0);
