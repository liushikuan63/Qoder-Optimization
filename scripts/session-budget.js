#!/usr/bin/env node
// 会话体积与接续守卫（补 stop-gate R7 的"太晚"缺口）
//
// 为什么需要它——R7 在 **Stop** 判会话体积，但**被传输层掐断的回合根本到不了 Stop**：
// 掐断发生在"服务端 60s 内发不出响应头"那一刻，Stop hook 还没机会跑。
// 所以 R7 只能拦住"侥幸活下来的回合"，拦不住它真正要防的那件事（2026-09-19 取证：
// 121MB / 66MB 两个会话里 9 次 `Model stream timed out before response headers after 60s`）。
//
// 本守卫把同一个判据**前移到回合开始之前**（UserPromptSubmit），并把"要不要收尾"
// 换成可执行的分档动作：降速 → 先交接 → 强制交接。另在 SessionStart 负责**接续**：
// 若项目根有未完成的 `.qoder-work-queue.md`，把"下一步"注入开局上下文，
// 这样"被中断"的代价从"用户重新交代一遍"降到"新会话开局就知道做到哪"。
//
// 判据依赖两个**互相独立**的可观测量：
//   ① transcript 文件大小（字节）= 单请求 payload 的主要成分 → 防传输层掐断；
//   ② 本会话累计**事件条数**（qodercli 运行日志里的 session_message）= 渲染进程时间线的条数
//      → 防渲染进程卡死。实测两者不相关（见下方 2026-10-28 取证），所以必须分开分档。
// 取法：优先用 hook 给的 transcript_path；给不到就按 cwd 推导项目目录、取最近改动的 .jsonl。
// 取值失败一律静默放行（fail-open），但**每次判定都落台账**，便于核对与看趋势。
//
// 卡死取证（2026-10-28）：会话 ff0caa09 正文只有 **2MB / 1283 行**——按字节判它完全健康；
// 但它的 qodercli 运行日志里有 **136797 条** `inbound session_message received`（98% 的日志行都是事件），
// 主进程按 64 条/批往渲染进程推、积压 1693 条后渲染进程陷入 React #185 更新循环、界面"看起来死了"。
// 同批对照：健康会话 4590 条，次高 33298 / 14593 条。**只看字节的哨兵永远预测不到这次卡死。**
//
// 用法：脚本由 settings.json 的 hooks 调用，不手工跑。
//   UserPromptSubmit → 体积 + 事件流分档注入；SessionStart → 未完成队列注入
// 关闭：~/.qoder/session-budget.json 写 {"disabled":true}
// 调档：环境变量 SB_YELLOW_MB / SB_ORANGE_MB / SB_RED_MB（默认 8 / 15 / 25）
//   事件流档位 SB_EVENT_YELLOW / SB_EVENT_ORANGE / SB_EVENT_RED（默认 8000 / 20000 / 50000 条）
//   事件扫描范围 SB_APPLOG_ROOT（测试夹具）/ SB_APPLOG_BOOTS（默认回溯 12 个启动目录）
// 台账：~/.qoder/tmp/session-budget/checks.log
'use strict';
require('./hook-crash-guard.js').install('session-budget'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_DIR = process.env.SB_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'session-budget');
const LEDGER = path.join(STATE_DIR, 'checks.log');
const CONFIG = path.join(CLIENT_ROOT, 'session-budget.json');
// The selected client is the scope. A custom/CN binding must never sample a
// different client's transcript merely because it shares a session id.
const PROJECT_ROOTS = [path.join(CLIENT_ROOT, 'projects')];

const YELLOW_MB = Number(process.env.SB_YELLOW_MB || 8);
const ORANGE_MB = Number(process.env.SB_ORANGE_MB || 15);
const RED_MB = Number(process.env.SB_RED_MB || 25);

// —— 事件流分档（渲染进程侧）：阈值定标在"本次启动累计事件条数"这一维 ——
// 卡死实测（2026-10-28，时间戳是 UTC，北京 13:16 = 05:16Z）：卡死那一刻本启动累计 **127,366 条**；
// 同日同启动 33,298 / 20,618 / 14,209 条的会话都正常 ⇒ 黄档必须**高于**已实测正常的 33k，取三档 40k / 75k / 110k。
// **速率不是判据**（已否证）：卡死前 12 分钟（05:05–05:17Z）一条事件都没有，界面是"累积太长后静止挂住"；
// 而当天峰值 6,529 条/分（02:22）反而没卡。所以只做累计分档，不做 burst 告警——别看出发烟就装火警。
// **为什么不累加跨启动**：渲染进程挂的是"这次启动收到的事件流"，把历史启动的条数加进来
// 会把普通会话误判（实测同一会话本启动 803 条、累加 12,598 条），既报假警又白扫几十 MB 拖慢 hook。
const EVENT_YELLOW = Number(process.env.SB_EVENT_YELLOW || 40000);
const EVENT_ORANGE = Number(process.env.SB_EVENT_ORANGE || 75000);
const EVENT_RED = Number(process.env.SB_EVENT_RED || 110000);
const EVENT_SCAN_CAP = Number(process.env.SB_EVENT_SCAN_CAP_BYTES || 64 * 1048576); // 单文件最多扫这么多
const APPLOG_BOOTS = Number(process.env.SB_APPLOG_BOOTS || 4);                      // 最多回溯几个启动目录
const EVENT_MARK = 'inbound session_message received';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    try {
      let r;
      while ((r = fs.readSync(0, buf, 0, buf.length, null)) > 0) chunks.push(Buffer.from(buf.subarray(0, r)));
    } catch (e2) {}
    return Buffer.concat(chunks).toString('utf8');
  }
}

function ledger(fields) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, `${new Date().toISOString()}|${fields.join('|')}\n`);
  } catch (e) {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; }
}

// cwd → harness 的项目目录名（实测：`C:\Users\x\proj` → `C--Users-x-proj`）
function projectDirName(cwd) {
  return String(cwd || '').replace(/[\\/:]/g, '-').replace(/^--/, '--');
}

function sizeOf(p) {
  try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch (e) { return null; }
}

// 取本会话 transcript 体积（字节）。返回 {bytes, src} 或 null。
// 只认三个来源，**不做全库扫描**：满 projects 树找"最近改动的 .jsonl"会拿别的会话的体积
// 给本会话判档（实测过：transcript_path 指向不存在的文件时，会误取真实活跃会话的体积）。
// 顺序：transcript_path（权威）→ session_id 全库精确定位（同名 .jsonl，不会认错会话）→ cwd 推导项目目录。
function transcriptBytes(payload) {
  const tp = payload.transcript_path || payload.transcriptPath;
  if (tp) {
    const n = sizeOf(tp);
    if (n !== null) return { bytes: n, src: 'transcript_path', file: tp };
    return null;   // 宿主给了路径却读不到 ⇒ 判不了，不要猜
  }

  // session_id 是精确键：projects/<任意项目>/<session_id>.jsonl。没有它就只能靠 cwd 猜目录。
  const sid = payload.session_id || payload.sessionId;
  if (sid) {
    for (const root of PROJECT_ROOTS) {
      let dirs = [];
      try { dirs = fs.readdirSync(root); } catch (e) { continue; }
      for (const d of dirs) {
        const full = path.join(root, d, `${sid}.jsonl`);
        const n = sizeOf(full);
        if (n !== null) return { bytes: n, src: 'session_id', file: full };
      }
    }
  }

  const cwd = payload.cwd || '';
  if (!cwd) return null;
  const name = projectDirName(cwd);
  let best = null;
  for (const root of PROJECT_ROOTS) {
    const d = path.join(root, name);
    let entries = [];
    try { entries = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(d, f);
      const n = sizeOf(full);
      if (n === null) continue;
      let mt = 0;
      try { mt = fs.statSync(full).mtimeMs; } catch (e) {}
      if (!best || mt > best.mt) best = { n, mt, file: full };
    }
  }
  return best ? { bytes: best.n, src: 'newest-jsonl-in-project', file: best.file } : null;
}

// —— 事件流计数：渲染进程按"条"渲染整条时间线，所以它的工作量是事件条数，不是字节 ——
// 数据源是宿主自己写的 per-session 运行日志（`%APPDATA%\com.qoder*.app.stable\logs\<启动>\qodercli\sessions\<sid>.log`）。
// 从**最新往旧**找启动目录，一旦某个目录里有本会话的日志就只数那一个目录（= 本会话最近一次活动启动的条数），
// 到红线即早退，不为"更准"去扫满 64MB。
// 没有 session_id 一律返回 null：按 cwd 猜会把**别的会话**的事件数算到本会话头上（正是体积守卫踩过的坑）。
function appLogRoots() {
  if (process.env.SB_APPLOG_ROOT) return [process.env.SB_APPLOG_ROOT];
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  let names = [];
  try { names = fs.readdirSync(appData); } catch (e) { return []; }
  return names
    .filter((n) => /^com\.qoder.*\.stable$/.test(n))
    .map((n) => path.join(appData, n, 'logs'));
}

// 在单个文件里数 mark。返回 {count, capped} 或 null（读不到）。
// carry 只留 mark.length-1 字节：跨块的命中在下一块补全，块内的命中不会被重复计一次。
function countMark(p, stopAt) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch (e) { return null; }
  try {
    const carryLen = EVENT_MARK.length - 1;
    const buf = Buffer.alloc(1024 * 1024);
    let scanned = 0, hits = 0, carry = '';
    while (scanned < EVENT_SCAN_CAP) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) return { count: hits, capped: false };
      scanned += n;
      const chunk = carry + buf.toString('utf8', 0, n);
      let from = 0, c = 0;
      while (true) {
        const i = chunk.indexOf(EVENT_MARK, from);
        if (i < 0) break;
        c++; from = i + EVENT_MARK.length;
      }
      hits += c;
      if (stopAt > 0 && hits >= stopAt) return { count: hits, capped: true };
      carry = chunk.slice(-carryLen);
    }
    return { count: hits, capped: true };   // 扫到上限：只能报"至少这么多"
  } catch (e) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
}

function sessionEvents(sid) {
  const key = String(sid || '').trim();
  if (!/^[A-Za-z0-9-]{8,}$/.test(key)) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fileRe = new RegExp(`^${escaped}(\\.\\d+)?\\.log$`);   // 含滚动出的 <sid>.1.log
  let total = 0, files = 0, capped = false;
  for (const root of appLogRoots()) {
    let boots = [];
    try {
      boots = fs.readdirSync(root).filter((d) => /^\d{8}-/.test(d)).sort().reverse().slice(0, APPLOG_BOOTS);
    } catch (e) { continue; }
    for (const b of boots) {
      const dir = path.join(root, b, 'qodercli', 'sessions');
      let hits = [];
      try { hits = fs.readdirSync(dir).filter((f) => fileRe.test(f)); } catch (e) { continue; }
      for (const f of hits) {
        const r = countMark(path.join(dir, f), EVENT_RED - total);
        if (!r) continue;
        files++;
        total += r.count;
        if (r.capped) capped = true;
      }
      // 只认"最近一次活动启动"那一个目录：更旧的启动属于上一次挂载，加进来就是假警
      if (files) return { count: total, files, capped };
    }
  }
  return null;
}

function eventTier(ev) {
  if (!ev) return null;
  const n = ev.count;
  const shown = `${n.toLocaleString('en-US')}${ev.capped ? '+' : ''}`;
  if (n >= EVENT_RED) {
    return {
      tier: 'ev-red',
      ctx:
        `【本会话事件流 ${shown} 条 ≥ ${EVENT_RED} · 换会话，别再往这里加活】渲染进程要按条挂载整条时间线，` +
        `卡死的判据就是这一维（实测卡死会话 127,366 条事件，而正文只有 2MB——按字节完全看不出问题）。\n` +
        `**动作**：手头这一格做完就落盘 \`.qoder-work-queue.md\`，然后 \`mcp__builtin__create_chat_session\` 换新会话接着跑；` +
        `本会话不再开新工作线。**界面一卡先点窗口/切前台等 90–120 秒**——积压事件会自己排空、循环自己退出，` +
        `别急着发关闭信号（强杀才有会话损坏风险）。`,
    };
  }
  if (n >= EVENT_ORANGE) {
    return {
      tier: 'ev-orange',
      ctx:
        `【本会话事件流 ${shown} 条 ≥ ${EVENT_ORANGE} · 省事件并准备换会话】渲染时间线按条挂载，堆到卡死实测是 127,366 条。\n` +
        `事件量的量纲要看清：**分片数 ∝ 模型输出长度**（实测每条 assistant 回复 ≈ 248 个 stream_event，98% 的事件都是分片），` +
        `一次失败重试 = 一整条回复 + 一段拒绝文本。所以真正省事件的是三个动作：\n` +
        `① 长内容落盘，上下文只留路径与结论；回复别复述已经打过的大段内容；` +
        `② **同一处失败不要重复撞**（改路径前先确认在工作区内、改锚点前先 Read）——反复撞同一堵墙是本档位最常见的爆量来源；` +
        `③ 把交接写进 \`.qoder-work-queue.md\`，这一格做完就 \`mcp__builtin__create_chat_session\` 换新会话接着跑（任务不停，只是换个地方跑）。`,
    };
  }
  if (n >= EVENT_YELLOW) {
    return {
      tier: 'ev-yellow',
      ctx:
        `【本会话事件流 ${shown} 条 ≥ ${EVENT_YELLOW} · 节约事件】渲染进程按条挂载整条时间线，事件量 ≈ 输出分片数` +
        `（实测每条回复约 248 个分片）。本回合起：少刷屏、命令一律限流、长内容进文件只回路径与结论；` +
        `同一处失败别反复重试。到 ${EVENT_ORANGE} 条会要求落盘并准备换会话，${EVENT_RED} 条要求立即换会话。`,
    };
  }
  return null;
}

function tiers(mb) {
  if (mb >= RED_MB) {
    return {
      tier: 'red',
      ctx:
        `【会话体积 ${mb.toFixed(1)}MB ≥ ${RED_MB}MB · 立即落盘 + 把任务接到新会话】本会话已在传输层的掐断区间内：` +
        `实测 121MB/66MB 的会话里出现过 9 次 \`Model stream timed out before response headers after 60s\`，` +
        `而**被掐断的回合到不了 Stop**，所以不能指望收尾门禁兜底。\n` +
        `**先把四件事完整落盘**（① 做到哪；② 下一步第一件事；③ 阻塞点；④ 关键入口＝文件路径与命令），写进项目根 \`.qoder-work-queue.md\`（未完成项用 \`- [ ]\`；写完跑 \`node ~/.qoder/scripts/work-queue-check.js\` 自检"能不能被接手"）。\n` +
        `**然后不要把任务停在这里**：不再开启无关的新工作线，但当前任务要继续推进；本会话已不可靠，就把任务**搬到新会话接着跑**——` +
        `交接的意义是"任务不断"，不是"收工"。**换会话自行执行，别让用户手动开**：` +
        `用 \`mcp__builtin__create_chat_session\`，prompt 自包含（工作目录 / 要做哪一格 / 关键命令与必填环境变量 / 仓库约束 / 可验证的完成标准），` +
        `且**不要把"再开一个会话"写进任务**（新会话不许再委托一次）；开完把队列里那一格**首行**标成 \`- [ ] **【会话 <id 前 8 位> 持有】** …\`（归属标记只认首行方括号内那段）。`,
    };
  }
  if (mb >= ORANGE_MB) {
    return {
      tier: 'orange',
      ctx:
        `【会话体积 ${mb.toFixed(1)}MB ≥ ${ORANGE_MB}MB · 先落盘再继续】payload 越大，服务端越可能在 60s 内发不出响应头而被掐断。` +
        `**动作两个，顺序不能换**：① 立刻把「做到哪 / 下一步第一件事 / 阻塞点 / 关键入口」写进项目根 \`.qoder-work-queue.md\`（未完成项用 \`- [ ]\`），保证随时可续（自检 \`node ~/.qoder/scripts/work-queue-check.js\`）；` +
        `② **然后继续推进任务**——落盘是保险，不是收工信号，做完手头这一格接着做下一格。` +
        `若本会话已经不稳（已压缩 ≥2 次或接近红线），就把任务**搬到新会话继续**（自行 \`mcp__builtin__create_chat_session\`，开完把那一格首行标 \`【会话 <id> 持有】\`）：同一份队列接着做，**任务不停，只是换个地方跑**。`,
    };
  }
  if (mb >= YELLOW_MB) {
    return {
      tier: 'yellow',
      ctx:
        `【会话体积 ${mb.toFixed(1)}MB ≥ ${YELLOW_MB}MB · 节约模式】本回合按省上下文打：` +
        `① 调研 / 广搜交只读子代理，只要结论（≤300 字）；② 不整读文件，先 grep 定位再带 offset/limit 读；` +
        `③ 命令一律限流（\`> /tmp/x.log 2>&1; tail -30\` 或 \`| head\`）；④ 长内容落盘，上下文里只留路径。`,
    };
  }
  return null;
}

// 压缩次数：与"体积"相互独立的信号——体积说的是"会不会被掐断"，压缩次数说的是
// "已经丢过几次上下文"（context rot 是连续恶化的，没有安全悬崖）。阈值上要前置：
// 已经被压过 2 次就不该再靠继续压缩硬撑，而应交接后开新会话（研究共识：不要一路 compaction）。
// 成本控制：只找前 3 个标记就早退，且最多扫 40MB —— 大文件上"≥2"这个结论足够，不必扫全。
const COMPACT_CAP_BYTES = 40 * 1024 * 1024;
function countCompactions(p) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch (e) { return null; }
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let scanned = 0, hits = 0, tail = '';
    while (scanned < COMPACT_CAP_BYTES) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      scanned += n;
      const chunk = tail + buf.toString('utf8', 0, n);
      hits += (chunk.match(/"isCompactSummary":true/g) || []).length;
      if (hits >= 3) return 3;
      tail = chunk.slice(-40);
    }
    return hits;
  } catch (e) {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch (e) {}
  }
}

// 压缩信号独立于体积：体积没到档但已经压过 2 次，同样要提醒（这时的问题是"变笨"，不是"被掐断"）。
function compactionNote(n) {
  if (n === null || n < 1) return null;
  const common = `（context rot 是连续恶化的，没有安全悬崖：早压早交接，别靠一路压缩硬撑。）`;
  if (n >= 2) {
    return `【本会话已压缩 ${n} 次 · 落盘并继续】上下文已被压缩过 ${n} 次，早期细节已经丢了 —— 继续压缩只会越做越糊涂。` +
      `**先把交接写下来**（项目根 \`.qoder-work-queue.md\`：做到哪 / 下一步第一件事 / 阻塞点 / 关键入口），（写完跑 \`node ~/.qoder/scripts/work-queue-check.js\` 自检）**再继续推进任务**；` +
      `若后续还要压缩，就把任务**搬到新会话接着做**（同一份队列），而不是在越做越糊涂的上下文里硬撑。${common}`;
  }
  return `【本会话已压缩 ${n} 次】早期上下文已被摘要替换，关键结论与决策请**落盘**（项目文档 / 记忆），别只留在对话里。${common}`;
}

// 返回侧入账：只拦"读取侧"（整读/无上限命令）不够——真正决定会话涨多快的是**每回合实际吃进去多少**。
// 这一层没有 PostToolUse 的单工具粒度，但 transcript 体积的**回合间增量**恰好就是"上一回合总共灌了多少"
// （工具返回 + 自己的输出），是能稳定拿到的最贴近返回侧的实测量。增量过大 ⇒ 上一回合有限流漏网。
const GROWTH_MB = Number(process.env.SB_TURN_GROWTH_MB || 2);
const SIZE_STATE = path.join(STATE_DIR, 'last-size.json');

function readSizeState() {
  try { return JSON.parse(fs.readFileSync(SIZE_STATE, 'utf8')); } catch (e) { return {}; }
}
function writeSizeState(obj) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(SIZE_STATE, JSON.stringify(obj)); } catch (e) {}
}

// 返回 {deltaMb, grew} —— 首次见到该会话时没有基线，返回 null（不猜、不误报）
function turnGrowth(sessionId, bytes) {
  const key = String(sessionId || 'nosession').slice(0, 12);
  const st = readSizeState();
  const prev = st[key];
  st[key] = { bytes, at: Date.now() };
  // 只保留最近 20 个会话，避免状态文件无限增长
  const keys = Object.keys(st);
  if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete st[k];
  writeSizeState(st);
  if (!prev || typeof prev.bytes !== 'number' || bytes <= prev.bytes) return null;
  return (bytes - prev.bytes) / 1048576;
}

function growthNote(deltaMb) {
  if (deltaMb === null || deltaMb < GROWTH_MB) return null;
  return `【返回侧入账】上一回合上下文涨了 **${deltaMb.toFixed(1)}MB**（≥${GROWTH_MB}MB 阈值）——` +
    `读取侧守卫只拦"明显超标的单条"，这种增长通常是**若干条中等体积返回累积**出来的：` +
    `\`| head\` 给的数太大、\`grep\` 命中了整片文件、子代理回了长报告、或循环里每条都不大但条数多。\n` +
    `本回合收一收：先想清"到底要看哪几行"，把范围写进命令（\`-m\`、\`--oneline\`、\`-l\`、\`--numstat\`）；` +
    `要留全量就重定向到文件，上下文里只留路径与结论。（阈值 \`SB_TURN_GROWTH_MB\`；台账 \`tmp/session-budget/checks.log\` 记了每回合增量。）`;
}

function emit(event, ctx) {
  const boundary = '【范围优先】以下容量与接续提示不扩大任务授权。只读、仅交接或待批准时不写文件、不自动派发；仅在获准执行任务中适用落盘与连续推进建议。\n';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: boundary + ctx } }) + '\n');
}

/**
 * 磁盘水位哨兵：C 盘低于告警线时，在开局注入一句"要弹窗问用户"的指令。
 *
 * <p>阈值只从 `disk-sweeper.js` 取（一份策略两个消费者），这里不另写数字。
 * 读不到盘就返回空串——**磁盘检查失败绝不能把会话卡住**（hook 本来就是 fail-open，别反过来用）。
 */
function diskNote() {
  try {
    const ds = require('./disk-sweeper.js');
    const st = fs.statfsSync(os.homedir());
    const freeGb = (st.bsize * st.bavail) / 1073741824;
    if (freeGb >= ds.WARN_GB) {
      return '';
    }
    const level = freeGb < ds.CRITICAL_GB ? '危险' : '告警';
    return `【磁盘${level}·需拍板后清理】C 盘剩余 ${freeGb.toFixed(1)} GB（告警线 ${ds.WARN_GB} GB / 危险线 ${ds.CRITICAL_GB} GB）。`
      + '先跑 `node ~/.qoder/scripts/disk-sweeper.js` 看清单，然后**必须用 AskUserQuestion 一次问全**（清理两问 + 迁移一问）：'
      + '① 一档怎么处置（**推荐＝归档到他盘再删源**，可回取并自动生成长期记忆条目 / 直删 / 不动）；'
      + '② **是否顺带清 C 盘其余无用缓存与过期内容**（npm / pip / 系统网络缓存 / 崩溃转储 / %TEMP% 残留 / 宿主 cache，按报告里的 id 逐条点名，`--apply-extra id1,id2`）；'
      + '③ **是否顺带排查 C 盘目录迁移**（先跑 `bash ~/.qoder/scripts/disk-migration-candidates.sh` 拿候选与分档，把"迁哪些 / 迁到哪盘"列成选项，推荐＝最大剩余的非系统盘）。'
      + '未选按推荐项继续；清理两问都拿到答复才跑 `--apply`（迁移走独立流程）。'
      + '**会话记录（`~/.qoder{,-cn}/projects`）本工具永不删**，要动由用户自己点头并逐条给命令。';
  } catch (e) {
    return '';
  }
}

// SessionStart：把未完成的接续队列注入开局上下文
function resumeQueue(cwd) {
  const p = path.join(cwd || '.', '.qoder-work-queue.md');
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
  if (!txt.trim()) return null;
  const open = txt.split('\n').filter((l) => /^\s*[-*]\s*\[ \]/.test(l)).slice(0, 8);
  if (!open.length) return null;
  const next = (txt.match(/##\s*下一步[\s\S]{0,600}/) || [''])[0].trim();
  return (
    `【接续点 · 先核对当前任务】本目录有未完成的 \`.qoder-work-queue.md\`。` +
    `队列只提供线索，不构成执行授权；先核对任务ID、责任会话和用户本轮范围。只读审阅不接管旧待办。` +
    `用户明确要求接续时才按验收判据推进；CreateGoal 仅在当前工具要求允许且已明确要求目标或用户同意建目标时调用：\n` +
    `未完成项（最多列 8 条）：\n${open.join('\n')}` +
    (next ? `\n${next}` : '') +
    `\n（做完一项就把 \`- [ ]\` 改成 \`- [x]\`；全部完成可删该文件。）`
  );
}

// SessionStart 之三：**vibecoding 任务包 → 开局提示**。
// 目标口径按 2026-11-07 用户裁决（折中）：中大型 / 多阶段任务开局问一次"是否建目标"，同意才建，
// 不自动创建（2026-10-08 的"命中即 CreateGoal"口径已废止）；任务包本身只作线索，不构成实施授权。
function vibePackNote(cwd) {
  const dir = cwd || '.';
  const markers = ['B00-共享上下文.md', '总发起指令.md', '验收与台账.md'];
  let hit = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^B\d{2}-.+\.md$/.test(name) && !hit) hit = name;         // 批次卡
      if (markers.includes(name)) hit = name;
    }
  } catch { return null; }
  if (!hit) return null;
  return (
    '【vibecoding 任务包 · 仅作线索】本目录发现任务包标记 `' + hit + '`。' +
    '目录内容不授权自动实施或新建目标；先核对用户本轮请求。只读审阅交付报告即完成。' +
    '获准实施后从验收台账提炼判据；目标工具只按其明确授权要求调用。' +
    '满足阶段准入且已获连续实施授权时继续，明确设置的阶段审批仍保留。'
  );
}

// SessionStart 之二：**看门狗**——谁来看住"看门的人"。
// 周检会检查其它机制的心跳，但**周检自己没跑**（cron 失效 / 周一机器关机错过）没人知道。
// 会话开台是与 cron 完全独立的一条通道（用户一工作就会触发），拿它查"周检上次成功是多久前"，
// 才补得上这个盲区。阈值默认 10 天（允许漏掉一轮不报，避免噪声把告警变成背景音）。
const AUDIT_LEDGER = path.join(CLIENT_ROOT, 'tmp', 'rules-audit', 'history.log');
const AUDIT_STALE_DAYS = Number(process.env.SB_AUDIT_STALE_DAYS || 10);
const AUDIT_SCRIPT = path.join(CLIENT_ROOT, 'scripts', 'rules-weekly-audit.js');

function watchdogNote() {
  if (!fs.existsSync(AUDIT_SCRIPT)) return null;          // 周检没装，不是它能管的事
  if (!fs.existsSync(AUDIT_LEDGER)) {
    return `【看门狗】周检脚本在，但 \`tmp/rules-audit/history.log\` 不存在 —— **周检从未成功跑过一次**（cron 可能没生效）。` +
      `手工跑一次：\`node ~/.qoder/scripts/rules-weekly-audit.js\`（退 0=健康 / 1=有告警）。`;
  }
  let last = '';
  try {
    const lines = fs.readFileSync(AUDIT_LEDGER, 'utf8').split('\n').filter(Boolean);
    last = lines[lines.length - 1] || '';
  } catch (e) { return null; }
  const ts = Date.parse(last.split('|')[0]);
  if (!Number.isFinite(ts)) return null;
  const days = (Date.now() - ts) / 86400000;
  if (days <= AUDIT_STALE_DAYS) return null;
  return `【看门狗】周检已 **${days.toFixed(1)} 天**没成功跑过（阈值 ${AUDIT_STALE_DAYS} 天，上次 ${last.slice(0, 10)}）—— ` +
    `可能 cron 失效或机器在计划时间关机。手工跑一次确认：\`node ~/.qoder/scripts/rules-weekly-audit.js\`。`;
}

// SessionStart 之四：**超期临时产物提醒**（2026-11-09）。
// /clean-temp 默认只列不删、删除必须弹窗确认——没有提醒就没人触发（实测：127 个超期件
// 11 天无一次 APPLY，周检只出 INFO）。这里只提醒、不删除；7 天节流，避免每次开台都刷。
const SWEEPER_SCRIPT = path.join(CLIENT_ROOT, 'scripts', 'tmp-sweeper.js');
const TMP_REMIND_STATE = path.join(CLIENT_ROOT, 'tmp', 'tmp-sweeper', 'last-reminded.json');
const TMP_REMIND_DAYS = Number(process.env.SB_TMP_REMIND_DAYS || 7);
const TMP_USAGE_REMIND_STATE = path.join(CLIENT_ROOT, 'tmp', 'tmp-sweeper', 'usage-reminded.json');
const TMP_USAGE_REMIND_HOURS = Number(process.env.SB_TMP_USAGE_REMIND_HOURS || 24);

function tmpOverdueNote() {
  if (!fs.existsSync(SWEEPER_SCRIPT)) return null;        // 清理器没装，不是它能管的事
  let sweeper;
  try { sweeper = require(SWEEPER_SCRIPT); } catch (e) { return null; }
  let res;
  try {
    res = typeof sweeper.scan === 'function'
      ? sweeper.scan({ maxMs: 800 })                       // 开台预算：0.8s 内扫到多少报多少
      : (() => { const f = []; sweeper.walk(sweeper.defaultRoot(), f); return { stale: f, partial: false }; })();
  } catch (e) { return null; }
  const found = res.stale || [];
  if (!found.length) return null;
  try {
    const st = JSON.parse(fs.readFileSync(TMP_REMIND_STATE, 'utf8'));
    const days = (Date.now() - Date.parse(st.at)) / 86400000;
    if (Number.isFinite(days) && days <= TMP_REMIND_DAYS) return null;
  } catch (e) { /* 没有状态文件 ⇒ 第一次提醒 */ }
  try {
    fs.mkdirSync(path.dirname(TMP_REMIND_STATE), { recursive: true });
    fs.writeFileSync(TMP_REMIND_STATE, JSON.stringify({ at: new Date().toISOString(), stale: found.length, partial: !!res.partial }));
  } catch (e) { /* 状态写不进去最多重复提醒，不影响清理本身 */ }
  return `【清理提醒 · 超期临时产物】多根临时目录共扫到 **${found.length} 个**超期件（图/文 >3 天、脚本 >15 天）${res.partial ? '（扫描预算内，数量为下限）' : ''}，` +
    `其中可能有已用完的截图 / 探针 / 日志。按 /clean-temp 流程：先 \`node ~/.qoder/scripts/tmp-sweeper.js --json\` 列清单，` +
    `再用 AskUserQuestion 一次问全（推荐清理），确认后才 \`--apply\`，最后复验清单为空。默认只列不删。`;
}

// SessionStart 之五：**临时根水位**（2026-11-11）。年龄策略管不到"总量失控"：
// 大量未超期文件照样能把 D:/tmp 撑大。这里只看字节/顶层条目，超阈值才提醒，24h 节流。
function tmpUsageNote() {
  if (!fs.existsSync(SWEEPER_SCRIPT)) return null;
  let sweeper;
  try { sweeper = require(SWEEPER_SCRIPT); } catch (e) { return null; }
  if (typeof sweeper.usageScan !== 'function') return null;
  let usage;
  try {
    usage = sweeper.usageScan(sweeper.resolveRoots([]), 800);
  } catch (e) { return null; }
  if (!usage || !usage.roots || !usage.roots.length) return null;
  const cfg = sweeper.loadConfig ? sweeper.loadConfig() : {};
  const warnGb = Number.isFinite(cfg.usageWarnGb) ? cfg.usageWarnGb : 5;
  const warnEntries = Number.isFinite(cfg.usageWarnEntries) ? cfg.usageWarnEntries : 2000;
  const level = usage.bytes >= warnGb * 1024 * 1024 * 1024 || usage.topEntries >= warnEntries ? 'warn' : 'ok';
  if (level !== 'warn') return null;
  try {
    const st = JSON.parse(fs.readFileSync(TMP_USAGE_REMIND_STATE, 'utf8'));
    const hours = (Date.now() - Date.parse(st.at)) / 3600000;
    if (Number.isFinite(hours) && hours <= TMP_USAGE_REMIND_HOURS) return null;
  } catch (e) { /* 没有状态文件 ⇒ 第一次提醒 */ }
  try {
    fs.mkdirSync(path.dirname(TMP_USAGE_REMIND_STATE), { recursive: true });
    fs.writeFileSync(TMP_USAGE_REMIND_STATE, JSON.stringify({ at: new Date().toISOString(), bytes: usage.bytes,
      topEntries: usage.topEntries, partial: !!usage.partial }));
  } catch (e) { /* 状态写不进去最多重复提醒 */ }
  return `【临时根水位】${usage.roots.join('、')} 已用 **${(usage.bytes / 1048576).toFixed(1)}MB** / `
    + `${usage.files} 个文件（顶层 ${usage.topEntries} 项；阈值 ${warnGb}GB 或 ${warnEntries} 项）`
    + `${usage.partial ? '（预算内，数值为下限）' : ''}。先 \`node ~/.qoder/scripts/tmp-sweeper.js --json\` 看清单，`
    + `再用 AskUserQuestion 定清理范围；按年龄的 /clean-temp 照样适用。`;
}

function main() {
  let payload;
  try { payload = JSON.parse(readStdin()); } catch (e) { return; }
  if (loadConfig().disabled === true) return;

  const event = payload.hook_event_name || payload.hookEventName || '';
  const cwd = payload.cwd || '';

  // 首次运行记录 stdin 字段集，用来核实"这个事件到底给了什么"（免得靠猜字段名）
  try {
    const marker = path.join(STATE_DIR, `keys-${event || 'unknown'}.json`);
    if (!fs.existsSync(marker)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(payload) }, null, 2));
    }
  } catch (e) {}

  if (event === 'SessionStart') {
    // tmpOverdueNote 有副作用（写节流状态），只算一次；算两次第二次会被自己节流掉
    const tmpNote = tmpOverdueNote();
    const usageNote = tmpUsageNote();
    const parts = [resumeQueue(cwd), vibePackNote(cwd), watchdogNote(), diskNote(), tmpNote, usageNote].filter(Boolean);
    if (parts.length) {
      // 台账记"注入了哪几路"，而不是只记条数：几路里少一路时必须能看出来少的是哪路
      const tags = [resumeQueue(cwd) ? 'resume-queue' : null, vibePackNote(cwd) ? 'vibe-pack' : null,
        watchdogNote() ? 'watchdog' : null, diskNote() ? 'disk' : null, tmpNote ? 'tmp-overdue' : null,
        usageNote ? 'tmp-usage' : null].filter(Boolean).join('+');
      ledger(['SessionStart', tags, String(cwd).slice(0, 60)]);
      emit('SessionStart', parts.join('\n\n'));
    }
    return;
  }

  if (event && event !== 'UserPromptSubmit') return;

  const ev = sessionEvents(payload.session_id);
  const evTier = eventTier(ev);
  const evField = 'ev=' + (ev ? ev.count.toLocaleString('en-US') + (ev.capped ? '+' : '') : '?');
  // 台账列序不变（体积档仍独占第 4 列），事件维新开两列追加在尾部——老断言与已有核对脚本按列位取值，
  // 把两维合成一个字符串会让"体积到没到档"这个问题再也读不出来。
  const tierField = evTier ? evTier.tier : 'ev-ok';

  const t = transcriptBytes(payload);
  if (!t) {
    // 体积取不到 ≠ 事件维也取不到：渲染卡死跟 payload 无关，这一路要独立成立
    ledger(['UserPromptSubmit', 'unknown', 'size-unavailable', '-', '-', '-', evField, evTier ? 'red?' : tierField]);
    if (evTier) emit('UserPromptSubmit', evTier.ctx);
    return;
  }
  const mb = t.bytes / 1048576;
  const comps = t.file ? countCompactions(t.file) : null;
  const deltaMb = turnGrowth(payload.session_id, t.bytes);
  const g = tiers(mb);
  const note = compactionNote(comps);
  const grow = growthNote(deltaMb);
  ledger(['UserPromptSubmit', mb.toFixed(1) + 'MB', g ? g.tier : 'ok',
    'comp=' + (comps === null ? '?' : comps),
    'Δ=' + (deltaMb === null ? '-' : deltaMb.toFixed(1) + 'MB'),
    t.src, String(payload.session_id || '').slice(0, 8), evField, tierField]);
  const parts = [g && g.ctx, note, grow, evTier && evTier.ctx].filter(Boolean);
  if (parts.length) emit('UserPromptSubmit', parts.join('\n\n'));
}

try { main(); } catch (e) { /* fail-open：守卫自己出错绝不阻塞会话 */ }
process.exit(0);
