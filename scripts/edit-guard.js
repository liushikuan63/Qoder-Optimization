#!/usr/bin/env node
// PreToolUse 守卫：给"改已有文件前先备份"这条纪律补上机制（此前它只靠提示词）。
//
// 为什么不拦所有写入——**噪声会让人忽略告警**（本项目实测教训），所以只堵真正不可恢复的那一格：
//   ① 工具是 Write（**整文件覆盖**；Edit 是局部修改，风险不同级）
//   ② 目标文件**已存在**（新建文件无可备份）且 ≥ 2KB（小文件重写代价低）
//   ③ 一路向上找不到 `.git` ⇒ **没有版本库兜底**（有 git 时 git 就是备份，不该再吵）
//   ④ 不在临时/备份路径下（/tmp、AppData/Local/Temp、vibe_images、含 .bak）
//   ⑤ 同一会话对同一文件只提醒一次（不重复刷）
// 动作是 **allow + 提示**（advisory，不阻塞）：备份是低成本动作，让人知道"这里没人兜底"就够了；
// 真拦下来反而会因为误判挡住正常工作。每次判定落台账，可核对是否真在跑。
//
// 关掉：~/.qoder/edit-guard.json 写 {"disabled":true}
// 台账：~/.qoder/tmp/edit-guard/decisions.log
'use strict';
require('./hook-crash-guard.js').install('edit-guard'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_DIR = process.env.EDIT_GUARD_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'edit-guard');
const LEDGER = path.join(STATE_DIR, 'decisions.log');
const CONFIG = path.join(CLIENT_ROOT, 'edit-guard.json');
const MIN_BYTES = Number(process.env.EDIT_GUARD_MIN_BYTES || 2048);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    try { let r; while ((r = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, r))); } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}
function ledger(fields) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, `${new Date().toISOString()}|${fields.join('|')}\n`);
  } catch (e) {}
}
function allow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason },
  }) + '\n');
}

// 从文件所在目录向上找 .git（Git 用文件形式表示 worktree，所以两者都认）
function hasGit(dir) {
  let d = dir, hops = 0;
  while (d && hops++ < 12) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}

function isTempish(p) {
  const s = String(p).replace(/\\/g, '/').toLowerCase();
  const os = require('os');
  // 临时根按**前缀**判，不用 substring：合法项目目录名恰为 tmp 时旧实现会误判为临时，
  // 使「覆盖已存在大文件且无 git 兜底」拿不到备份提醒（实测）。
  const roots = [os.tmpdir(), '/tmp', '/var/tmp', '/var/folders', process.env.TMPDIR, process.env.TEMP, process.env.TMP]
    .filter(Boolean)
    .map((r) => String(r).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') + '/');
  for (const t of roots) if (t !== '/' && s.startsWith(t)) return true;
  if (/^[a-z]:\/users\/[^/]+\/appdata\/local\/temp\//.test(s)) return true;
  const seg = s.split('/');
  if (seg.includes('vibe_images')) return true;
  // 备份后缀只看**文件名**且只认「结尾」或「接时间戳/日期」：notes.bak.md 是真实文档，不是备份。
  const base = seg[seg.length - 1] || '';
  if (/\.(bak|orig|rej)$/i.test(base)) return true;
  if (/\.(bak|orig|rej)[._-]\d/i.test(base)) return true;
  return false;
}

// 新增载体前的预检提醒：技能 / 规则 / 记忆 / hook / agent / MCP 都是"加了就长期生效"的载体。
// 只对载体路径提示，普通源码与文档不吵；新文件也提示（新建载体正是最需要 preflight 的时点）。
const CARRIER = /[\\/](skills|skills-library|rules|commands|agents|memory|hooks|mcp)[\\/]|[\\/]scripts[\\/][^\\/]*(?:guard|hook|reminder|gate|budget|ledger|trigger)[^\\/]*$/i;
function carrierType(target) {
  const s = String(target).replace(/\\/g, '/');
  if (/[\\/]skills(?:-library)?[\\/]/i.test(s)) return 'skill';
  if (/[\\/]memory[\\/]/i.test(s)) return 'memory';
  if (/[\\/]agents[\\/]/i.test(s)) return 'agent';
  if (/[\\/]mcp[\\/]/i.test(s)) return 'mcp';
  if (/[\\/](rules|commands)[\\/]/i.test(s)) return 'rule';
  if (/[\\/]hooks[\\/]|[\\/]scripts[\\/]/i.test(s)) return 'hook';
  return 'rule';
}
function carrierNote(target) {
  if (!CARRIER.test(target)) return '';
  const type = carrierType(target);
  return `\n【载体预检提醒】目标位于载体目录（${type}）。新增/修改规则、技能、记忆、hook、MCP 或 agent 前先运行：`
    + `\n  node ~/.qoder/scripts/carrier-preflight.cjs --type ${type} --name <名称>`
    + `\n查同类、冲突与限额，并把方案交用户确认后再落盘；修改既有载体同样先查重与冲突。`;
}

function main() {
  let payload;
  try { payload = JSON.parse(readStdin()); } catch (e) { return; }
  try { if (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).disabled === true) return; } catch (e) {}

  const event = payload.hook_event_name || payload.hookEventName || '';
  if (event && event !== 'PreToolUse') return;
  const tool = payload.tool_name || payload.tool || '';
  if (tool !== 'Write') return;                       // 只管整文件覆盖
  const input = payload.tool_input || payload.input || {};
  const p = input.file_path || input.path;
  if (!p) return;

  const target = path.resolve(String(p));
  const note = carrierNote(target);
  const carrierOnly = () => { if (note) { ledger(['carrier-existing', path.basename(target)]); allow(note.trim()); } };
  let st;
  try { st = fs.statSync(target); } catch (e) {
    ledger(['new-file', path.basename(target)]);
    if (note) {
      ledger(['carrier-new', path.basename(target)]);
      allow(note.trim());
    }
    return;
  }
  if (!st.isFile()) return;
  // 备份豁免只影响备份提醒；载体变更仍需预检，即使文件很小或已有 Git 兜底。
  if (st.size < MIN_BYTES) { carrierOnly(); return; }
  if (isTempish(target)) { ledger(['temp-skip', path.basename(target)]); carrierOnly(); return; }
  if (hasGit(path.dirname(target))) { ledger(['git-covered', path.basename(target)]); carrierOnly(); return; }

  const sid = String(payload.session_id || 'nosession').slice(0, 12);
  const marker = path.join(STATE_DIR, `advised-${sid}.json`);
  let advised = {};
  try { advised = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) {}
  if (advised[target]) { ledger(['repeat-skip', path.basename(target)]); carrierOnly(); return; }
  advised[target] = new Date().toISOString();
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(marker, JSON.stringify(advised)); } catch (e) {}

  const kb = (st.size / 1024).toFixed(0);
  ledger(['advise', `${path.basename(target)} ${kb}KB`]);
  allow(
    `【备份提醒】这次是**整文件覆盖**一个已存在、${kb}KB、且**不在任何 git 仓库里**的文件（没有版本库兜底，覆盖后不可恢复）：\n` +
    `  ${target}\n` +
    `先备份再写：\`node ~/.qoder/scripts/backup-file.js "${target}"\`（自动按"至多 3 份 / 删 7 天前的 / 至少留 1 份"裁剪）。\n` +
    `（本条是提示不拦截；同一会话同一文件只提醒一次。若这个目录本该受版本控制，` +
    `\`git init && git add -A && git commit\` 之后就不再提醒。）`
    + note
  );
}

try { main(); } catch (e) { /* fail-open：守卫自己出错绝不阻塞写入 */ }
process.exit(0);
