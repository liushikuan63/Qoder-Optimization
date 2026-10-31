#!/usr/bin/env node
// Stop 门禁：把 AGENTS.md 中最易被无视的四条提示词规则做成每轮强制拦截。
// 判据来源：最后一条助手文本 + 本轮工具调用记录（transcript）。
// fail-open：任何异常一律静默放行，绝不因为门禁本身出问题而卡住会话。
'use strict';
if (process.argv[2] !== '--report') require('./hook-crash-guard.js').install('stop-gate');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const crypto = require('crypto');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_DIR = process.env.STOP_GATE_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'stop-gate');
const LEDGER = path.join(STATE_DIR, 'violations.log');
const CONFIG = path.join(CLIENT_ROOT, 'stop-gate.json');
const MAX_BLOCKS_PER_RULE = Number(process.env.STOP_GATE_MAX || 2);
const MAX_BLOCKS_PER_SESSION = Number(process.env.STOP_GATE_SESSION_MAX || 3);
// 上限按**滑动时间窗**算，不按"每会话累计"：
// 本机的一次"会话"可以横跨几十个回合、好几天，累计上限一打满，门禁对剩下的回合**全部静默放行** ——
// 「声明下一步却没开工」连过好几轮都没被拦，就是这么来的（2026-09-19 实测：R1b 只在当天早期响过）。
// 窗口内的重复命中仍被压住（防死循环），隔一段时间再犯照样拦。
const BLOCK_WINDOW_MS = Number(process.env.STOP_GATE_WINDOW_MS || 30 * 60 * 1000);
const TAIL_BYTES = Number(process.env.STOP_GATE_TAIL || 2 * 1024 * 1024);

/** 时间窗内的命中时刻。旧状态里的纯数字计数**不参与判定** —— 那正是"打满一次就永久失效"的旧口径。 */
function recentHits(list, now) {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter((t) => typeof t === 'number' && now - t < BLOCK_WINDOW_MS);
}

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

function diag(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'last-invocation.json'), JSON.stringify(obj));
  } catch (e) {}
}

// 拦截台账：追加式，一行一条，只落规则号与文本哈希（不落原文，避免把凭据/内网信息带进日志）
function ledger(ruleId, session, text) {
  try {
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(
      LEDGER,
      `${new Date().toISOString()}|${ruleId}|sess=${session.slice(0, 8)}|hash=${hash}|len=${text.length}\n`,
    );
  } catch (e) {}
}

// node stop-gate.js --report [天数]：按规则汇总近 N 天命中次数
function report() {
  const days = Number(process.argv[3] || 7);
  const since = Date.now() - days * 86400000;
  const counts = {};
  let rows = 0;
  let total = 0;
  try {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
      const [ts, rule] = line.split('|');
      if (!ts || !rule) continue;
      total++;
      if (Date.parse(ts) >= since) {
        counts[rule] = (counts[rule] || 0) + 1;
        rows++;
      }
    }
  } catch (e) {
    console.log(`台账不存在：${LEDGER}\n说明：门禁启用后还没拦到过任何一次（不是脚本坏了）。`);
    return;
  }
  console.log(`台账 ${LEDGER}\n累计 ${total} 条；近 ${days} 天 ${rows} 条：`);
  const list = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!list.length) console.log('  （近 ' + days + ' 天零命中）');
  for (const [rule, c] of list) console.log(`  ${String(c).padStart(3)}  ${rule}`);
}

function json(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

// transcript 只取尾部，解析出：最后一条助手文本 + 最后一条真实用户文本 + 最近一轮的工具调用
function scanTranscript(file, tailBytes) {
  const out = { lastUserText: '', lastAssistantText: '', turnTools: [], parsed: 0, exists: false };
  try {
    const st = fs.statSync(file);
    out.exists = true;
    const start = Math.max(0, st.size - tailBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((x) => x.trim());
    if (start > 0) lines.shift(); // 首行可能被截断
    for (const l of lines) {
      let j;
      try {
        j = JSON.parse(l);
      } catch (e) {
        continue;
      }
      const msg = j.message || j;
      const role = msg.role || j.type;
      const c = msg.content;
      if (role === 'user') {
        if (Array.isArray(c)) {
          for (const result of c.filter((x) => x && x.type === 'tool_result')) {
            const tool = out.turnTools.find((x) => x.id && x.id === result.tool_use_id);
            if (tool) {
              tool.result = result.content;
              const body = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
              tool.success = !result.is_error && !/"success"\s*:\s*false|"isError"\s*:\s*true|"error"\s*:\s*"[^"\n]+"/.test(body || '');
            }
          }
        }
        const rawText = typeof c === 'string' ? c : Array.isArray(c)
          ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n') : '';
        const txt = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        const toolReturn = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result');
        if (txt && !toolReturn && !j.isMeta && !msg.isMeta && !/^\[stop-gate\b|^Base directory for this skill:|^Note: The file|^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/.test(txt)) {
          out.lastUserText = txt;
          out.lastAssistantText = '';
          out.turnTools = [];
        }
      } else if (role === 'assistant') {
        if (typeof c === 'string' && c.trim()) out.lastAssistantText = c;
        else if (Array.isArray(c)) {
          const txt = c
            .filter((x) => x && x.type === 'text' && x.text)
            .map((x) => x.text)
            .join('\n');
          if (txt.trim()) out.lastAssistantText = txt;
          for (const x of c) {
            if (x && x.type === 'tool_use') out.turnTools.push({ id: x.id, name: x.name, input: x.input || {}, success: false });
          }
        }
      }
      out.parsed++;
    }
  } catch (e) {}
  return out;
}

// 会话体积（MB）。读不到就返回 null —— null 的含义是"判不了"，绝不能变成"超线了"。
function transcriptMb(file) {
  try {
    if (!file) return null;
    return fs.statSync(file).size / 1048576;
  } catch (e) {
    return null;
  }
}

// 判"收尾行为"的规则都要先剥掉引用：引用来的违规原文、规则示例不算我自己的陈述。
// 2026-10-27：这段剥离原先只有 R1/R2 用（tailView），R3 只剥围栏代码块 ⇒ 复盘时引用规则原文
// （"只写『界面已完成』就放行"）被当成我自己的交付主张拦下。现抽成公共函数，R1/R2/R3/R9 共用。
function stripQuoted(t) {
  return String(t == null ? '' : t)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]{1,200}`/g, ' ')
    .replace(/"[^"\n]{1,400}"/g, ' ')
    .replace(/“[^”\n]{1,400}”/g, ' ')
    .replace(/「[^」\n]{1,400}」/g, ' ');
}
const TAIL_CHARS = Number(process.env.STOP_GATE_TAIL_CHARS || 500);
function tailView(t) {
  return stripQuoted(t).slice(-TAIL_CHARS);
}

// 工作队列：项目根 `.qoder-work-queue.md`。
// 为什么读文件而不是读汇报文字：文字是我自己写的，任何措辞类判据都能换个说法绕过
// （R1b 上线当天就被"要等 X 才能回答"这种不含关键词的写法绕过去一次）。
// 文件是外部状态：有未做完的格子就是没做完，收尾前必须做完或标成"阻塞：理由"。
// 队列探测的结果要留痕：`null` 的含义是"没有队列，放行"，而"hook 报的 cwd 不是项目根"
// 与"这个项目真的没有队列"看起来一模一样 —— 前者是假绿（门禁看不见待办却报一切正常）。
let lastQueueProbe = { found: false, from: null };

// R6c 用的"队列可接续性"检查：R6 只看有没有 `- [ ]`，看不出**队列本身写得没法接手**
// （缺"下一步"、阻塞没写理由、关键入口指向的文件已经不存在）。判据委托给 work-queue-check.js，
// 退出码 1 = 有问题，其余（0 可接续 / 3 没找到文件）都算通过。
// 结果存模块级缓存：`reason` 在命中之后才被调用，不能依赖 test 的局部变量
// （2026-09-30 实测：reason 里引用不存在的 `currentCtx` → 抛错被 fail-open 吞掉 → 坏队列照样放行，接线等于没接）。
let queueResumeCache = null;
function queueApplies(ctx, text) {
  if (ctx.scope.readOnly || ctx.scope.handoffOnly) return false;
  const task = text.match(/^任务ID[:：]\s*(\S+)/m);
  const owner = text.match(/^责任会话[:：]\s*(\S+)/m);
  if (task && ctx.taskId) return task[1] === ctx.taskId;
  const resumed = /(?:按|接续|继续|完成).{0,12}(?:工作队列|队列任务)|按任务包继续/.test(ctx.lastUserText);
  if (resumed) return true;
  if (owner) return owner[1] === ctx.sessionId;
  return false;
}

function queueResumeProblems(ctx) {
  try {
    const dirs = [];
    for (const d of [ctx && ctx.cwd, process.cwd()]) if (d && dirs.indexOf(d) < 0) dirs.push(d);
    let f = null;
    for (const d of dirs) {
      const cand = path.join(d, '.qoder-work-queue.md');
      if (fs.existsSync(cand)) { f = cand; break; }
    }
    if (!f || !queueApplies(ctx, fs.readFileSync(f, 'utf8'))) { queueResumeCache = null; return null; }
    const r = require('child_process').spawnSync(
      process.execPath, [path.join(__dirname, 'work-queue-check.js'), '--file', f],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (r.status !== 1) { queueResumeCache = null; return null; }
    const lines = String(r.stdout || '').split(String.fromCharCode(10)).filter((l) => l.indexOf('[问题]') >= 0);
    queueResumeCache = lines.length ? lines : ['（校验器判红但没给出明细，请直接跑 work-queue-check.js 看）'];
    return queueResumeCache;
  } catch {
    queueResumeCache = null;
    return null; // fail-open：校验器本身出问题不能卡住会话
  }
}

function openQueueItems(ctx) {
  const path = require('path')
  const dirs = [];
  for (const d of [ctx && ctx.cwd, process.cwd()]) {
    if (d && dirs.indexOf(d) < 0) dirs.push(d);
  }
  try {
    let f = null;
    for (const d of dirs) {
      const cand = path.join(d, '.qoder-work-queue.md');
      if (fs.existsSync(cand)) { f = cand; lastQueueProbe = { found: true, from: d }; break; }
    }
    if (f === null) {
      lastQueueProbe = { found: false, from: dirs.join(' | ') || '(没有候选目录)' };
      return null;
    }
    // 本模块没有 CR/NL 常量，就地取：引用未定义标识符会抛错并被下面的 catch 吞掉，
    // 表现是"判据永远返回 null、门禁永远放行"——这正是最坏的假绿，所以这里不依赖外部常量。
    const content = fs.readFileSync(f, 'utf8');
    if (!queueApplies(ctx, content)) return null;
    const text = content.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10));
    // 不用正则：转义在多层脚本里已经被吃掉过一次（`\\s` 变成 `s`，判据于是恒不命中、静默放行）。
    // 前缀匹配足够，且**看得见**——判据失效最坏的样子就是"永远返回空数组还退 0"。
    //
    // `【…持有】` 是 AGENTS.md「撞车就换格子」里既有的约定（`【另一会话 <id> 持有】`），
    // 这里让它**被门承认**：一个 worktree 里三条会话同时写同一份队列时，
    // 别人正在做的格子会一直是 `- [ ]`，门每轮都把它算成"我停手了"——
    // 要么逼我去双写，要么逼我把别人的在途条目改成 `- [~]`（抹掉对方的判断）。两种都是错的。
    // 只认写在**条目首行**、且是 `【…会话…持有】` 形状的标记（与"阻塞要落首行"同一条口径）。
    // 为什么要求方括号里出现"会话"二字：每条队列项都以 `【B26】`、`【本线】` 这类标签开头，
    // 只查"有没有 持有】"会让任何一句提到"持有"的正文都把门关掉（实测差点如此）。
    // 约定写法：`【社交线会话持有 c81ebff+在途】` —— 括号内点名是谁在写、凭据是哪一个提交，
    // 所以判据是"同一个方括号段里同时出现『会话』与『持有』"，不是"持有"紧邻右括号。
    return text.filter((l) => {
      const t = l.trimStart()
      let heldByOther = false;
      let from = 0;
      for (;;) {
        const close = t.indexOf('】', from);
        if (close < 0) break;
        const open = t.lastIndexOf('【', close);
        if (open >= 0) {
          const seg = t.slice(open + 1, close);
          const owner = seg.match(/会话(?:持有)?\s+([A-Za-z0-9_-]+)/);
          if (owner && !seg.includes('本会话') && owner[1] !== ctx.sessionId) { heldByOther = true; break; }
        }
        from = close + 1;
      }
      return !heldByOther && (t.startsWith('- [ ]')
        || (t.startsWith('- [~]') && t.indexOf('阻塞：') < 0 && t.indexOf('阻塞:') < 0))
    })
  } catch (e) {
    // 出错**不能**返回 null：null 的含义是"没有队列，放行"，
    // 于是"门禁自己坏了"会被读成"没有待办"。这里把它变成一条可见的拦停理由。
    lastQueueProbe = { found: false, from: '读取失败：' + String(e && e.message) };
    return ['（队列读取失败，门禁无法判定，先别收尾）' + String(e && e.message)]
  }
}

/**
 * R6b 的判据：**"阻塞"里引用的文件脏态是否还成立**。
 *
 * <p>为什么要有这一条：2026-09-20 同一会话里两次把"能做的格子"写成"等它干净" ——
 * `AppRoot.ts` 早在两小时前就被并行会话提交释放了，而我按两小时前的读数收尾。
 * R6 只查"有没有写阻塞"，查不出"这条阻塞已经过期"，于是每次都要用户再敲一次继续、门禁再拦一次。
 *
 * <p>判据只在**能确定判错代价低**的方向上收：
 * ① 只看引用了仓库内路径的阻塞（`client/` `contract/` `server/` `scripts/` `tools/` `art-src/`）；
 * ② 阻塞文案里若还提到凭据/端口/进程/上游规格这类 git 查不了的条件，**跳过不判**（宁可漏不许误伤 ——
 *    误伤的门禁会被人关掉，比没有门禁更糟，见 README-rule-enforcement）；
 * ③ git 本身跑不动就跳过（fail-open）。
 */
let staleCache = null;
let staleCacheAt = 0;

function staleBlockers(ctx) {
  const now = Date.now();
  if (staleCache !== null && now - staleCacheAt < 5000) return staleCache;
  const path = require('path')
  const { spawnSync } = require('child_process')
  const out = [];
  try {
    let dir = null;
    let file = null;
    for (const d of [ctx && ctx.cwd, process.cwd()]) {
      if (!d) continue;
      const cand = path.join(d, '.qoder-work-queue.md');
      if (fs.existsSync(cand)) { dir = d; file = cand; break; }
    }
    if (file === null) { staleCache = out; staleCacheAt = now; return out; }
    const content = fs.readFileSync(file, 'utf8');
    if (!queueApplies(ctx, content)) return out;
    const lines = content.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10));
    const PREFIXES = ['client/', 'contract/', 'server/', 'scripts/', 'tools/', 'art-src/'];
    // git 查不了的条件：命中就整条不判，避免把"等凭据/等上游"误判成过期
    const NON_FILE = ['凭据', '令牌', 'token', '端口', '上游', '规格', '审核', '真机', '模拟器', '开发者工具', 'mvn'];
    // 按"条目"而不是按"行"取：路径常写在阻塞的下一行（本仓库的队列就是这么组织的），
    // 只看首行会漏掉真正需要复核的那几条。首行仍必须含"阻塞"，与 R6 同一口径。
    const items = [];
    let tracked = null;
    let cur = null;
    for (const raw of lines) {
      const t = raw.trimStart();
      if (t.startsWith('- [') || t.startsWith('## ')) {
        if (cur !== null) items.push(cur);
        cur = t.startsWith('- [~]') ? { head: t, body: raw } : null;
      } else if (cur !== null) {
        cur.body += '\n' + raw;
      }
    }
    if (cur !== null) items.push(cur);

    // 只复核"**声称某个文件正脏着/被人持有**"的阻塞：数据没造出来、要等关卡产出、要等上游规格
    // 这类阻塞与文件脏态无关，拿"路径干净"去判它就是错的判据（会误伤，而误伤的门禁会被人关掉）。
    const DIRTY_CLAIM = ['脏', '持有', '在途', '未提交', '正被', '正在写', '被并发改', '并行会话'];
    for (const item of items) {
      if (item.head.indexOf('阻塞：') < 0 && item.head.indexOf('阻塞:') < 0) continue;
      let dirtyClaimed = false;
      for (const w of DIRTY_CLAIM) if (item.body.indexOf(w) >= 0) { dirtyClaimed = true; break; }
      if (!dirtyClaimed) continue;
      let skip = false;
      for (const w of NON_FILE) if (item.body.indexOf(w) >= 0) { skip = true; break; }
      if (skip) continue;
      const paths = [];
      const bare = [];
      const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.java', '.md', '.sh', '.ps1', '.png'];
      // 手工切分而不是正则：本文件的既有教训是正则转义在多层脚本里被吃掉过一次，
      // 而这里正则坏掉的形态是"取不到路径 ⇒ 永不拦停"，属于最难发现的静默放行。
      const SEP = ' \t``()（）、，,。;；:：|';
      for (const seg of item.body.split(String.fromCharCode(10))) {
        let tok = '';
        const toks = [];
        for (const ch of seg) {
          if (SEP.indexOf(ch) >= 0) { toks.push(tok); tok = ''; } else { tok += ch; }
        }
        toks.push(tok);
        for (let p of toks) {
          while (p.length > 0 && '\'"*'.indexOf(p.charAt(0)) >= 0) p = p.slice(1);
          for (const pre of PREFIXES) {
            if (p.startsWith(pre) && p.indexOf('.') > 0 && paths.indexOf(p) < 0) paths.push(p);
          }
          if (p.indexOf('/') < 0 && p.indexOf('.') > 0) {
            for (const e of EXTS) {
              if (p.endsWith(e) && bare.indexOf(p) < 0) bare.push(p);
            }
          }
        }
      }
      if (paths.length === 0 && bare.length === 0) continue;
      // 每个提到的文件都必须能在版本清单里找到，**找不到就整条不判**。
      // 真实误伤样本：某格写着「阻塞：要动 `CityPanelView.ts`」（它其实正脏着），
      // 而条目里其它带前缀的路径都是干净的 —— 只查带前缀的那些就会得出"阻塞已过期"的空判。
      let unresolvable = false;
      let checked = [];
      if (tracked === null) {
        const r2 = spawnSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8', timeout: 4000 });
        tracked = r2.status === 0 ? r2.stdout.split(String.fromCharCode(10)) : null;
      }
      if (tracked === null) continue;
      for (const p of paths) {
        if (tracked.indexOf(p) < 0) { unresolvable = true; continue; }
        checked.push(p);
      }
      for (const b of bare) {
        let hit = false;
        for (const f of tracked) {
          if (f === b || f.endsWith(String.fromCharCode(47) + b)) {
            hit = true;
            if (checked.indexOf(f) < 0) checked.push(f);
          }
        }
        if (!hit) unresolvable = true;
      }
      if (unresolvable || checked.length === 0) continue;
      const r = spawnSync('git', ['status', '--porcelain', '--'].concat(checked),
        { cwd: dir, encoding: 'utf8', timeout: 4000 });
      if (r.status !== 0) continue;
      // 只要有一个引用文件还脏着就放行（保守）：阻塞可能仍然成立，误伤比漏报更毒
      if ((r.stdout || '').trim() === '') {
        out.push(item.head.slice(0, 110) + ' …  ← 引用的路径全部干净：' + checked.join(', '));
      }
    }
  } catch (e) {
    // 复核器自己坏了就整体放行（不阻塞收尾），但把原因留在缓存里，便于 --report 时看见
    staleCache = [];
    staleCacheAt = now;
    return out;
  }
  staleCache = out;
  staleCacheAt = now;
  return out;
}

function taskScope(userText) {
  const text = userText || '';
  return {
    readOnly: /只读|仅(?:提供|做|作)?(?:审阅|审查|评审|分析|建议)|只(?:给|提供)(?:方案|建议)|不(?:要|得)?(?:修改|写入|改动)任何文件|在(?:更改|修改)任何文件之前/.test(text),
    handoffOnly: /仅做交接|只(?:做交接|给(?:我)?开工提示词)|我自己新开会话/.test(text),
    noMemory: /不(?:要|得)?(?:写入|保存|更新|使用|读取|新增|写)记忆|不要记住/.test(text),
  };
}

function toolName(tool) {
  return (tool.input.toolName || tool.name || '').split('__').pop().replace(/^functions\./, '');
}

function memoryWritten(ctx) {
  return ctx.turnTools.some((tool) => {
    if (!tool.success || !['Write', 'Edit', 'NotebookEdit'].includes(toolName(tool))) return false;
    const target = tool.input.file_path || tool.input.notebook_path;
    if (typeof target !== 'string' || path.basename(target) === 'MEMORY.md' || !/[\\/]memory[\\/]/.test(target)) return false;
    try {
      if (!fs.statSync(target).isFile() || fs.statSync(target).size === 0) return false;
      const dir = path.dirname(target);
      const leaf = path.basename(target);
      const pending = ['MEMORY.md'];
      const visited = new Set();
      while (pending.length) {
        const name = pending.shift();
        if (visited.has(name)) continue;
        visited.add(name);
        const index = fs.readFileSync(path.join(dir, name), 'utf8');
        if (index.includes('](' + leaf + ')')) return true;
        for (const m of index.matchAll(/\]\(([\w.-]+-index\.md)\)/g)) pending.push(m[1]);
      }
      return false;
    } catch { return false; }
  });
}

function handoffRecorded(ctx) {
  return ctx.turnTools.some((tool) => {
    const file = tool.input.file_path;
    if (!tool.success || !['Write', 'Edit'].includes(toolName(tool)) || typeof file !== 'string' || path.basename(file) !== '.qoder-work-queue.md') return false;
    try {
      const text = fs.readFileSync(file, 'utf8');
      return ['当前状态', '下一步', '阻塞', '关键入口'].every((s) => text.includes(s)) && text.length > 80;
    } catch { return false; }
  });
}

function needsMemory(ctx) {
  if (ctx.scope.readOnly || ctx.scope.handoffOnly || ctx.scope.noMemory) return false;
  if (/未(?:保存|写入).{0,12}记忆|记忆.{0,10}(?:未保存|未写入|失败|无法保存)|(?:无法|未能).{0,8}(?:写入|保存)记忆/.test(ctx.lastAssistantText)
      && /权限|审批|授权/.test(ctx.lastAssistantText)
      && ctx.turnTools.some((tool) => !tool.success && /permission|denied|CONFIRMATION_REQUIRED|TARGET_MISMATCH|权限|拒绝/i.test(JSON.stringify(tool.result || '')))) return false;
  return /(?:请|必须|以后|长期).{0,12}(?:记住|记入记忆|写入记忆|保存.{0,8}偏好)|把.{0,50}(?:写入|保存到|记入)记忆/.test(ctx.lastUserText)
    || /(?:已|已经)(?:将.{0,30})?(?:写入|保存到|记入|更新了?)记忆/.test(ctx.lastAssistantText);
}

function visualEvidence(ctx, text) {
  if (/(?:未|尚未|还未|没有)(?:完成)?比对|(?:截图|比对).{0,8}(?:待补|待做|待验证|未完成)/.test(text)) return false;
  // 只要求"说了比对结论"；"显示正常 / 渲染正确 / 与设计稿一致"同样是结论，不能只认字面的"比对"。
  if (!/比对|对照|符合预期|与预期一致|显示(?:正常|正确)|渲染(?:正常|正确)|与(?:设计稿|原型|预期)一致/.test(text)) return false;
  return ctx.turnTools.some((tool) => {
    if (!tool.success || !/screenshot|get_window_state|get_desktop_state/.test(toolName(tool))) return false;
    const serialized = JSON.stringify(tool.result || '');
    if (/"type"\s*:\s*"image"|data:image\//.test(serialized)) return true;
    const paths = serialized.match(/[A-Za-z]:[^"\n]*?\.(?:png|jpe?g)|\/[^"\n]*?\.(?:png|jpe?g)/gi) || [];
    return paths.some((p) => { try { return fs.statSync(p.replace(/\\\\/g, '\\')).size > 0; } catch { return false; } });
  });
}

// 前端文件扩展名：R3 的"改动面"判据用（本轮真改了这些文件，就不能只凭一句"做完了"收尾）
const UI_FILE = /\.(?:vue|tsx|jsx|svelte|astro|wxml|wxss|wxs|html?|css|scss|sass|less|styl)$/i;
function editedUiFiles(ctx) {
  const out = [];
  for (const tool of ctx.turnTools) {
    if (!tool.success || !['Write', 'Edit', 'NotebookEdit'].includes(toolName(tool))) continue;
    const f = String(tool.input.file_path || tool.input.notebook_path || '');
    if (UI_FILE.test(f) && out.indexOf(f) < 0) out.push(f);
  }
  return out;
}

function ranTestCommand(command) {
  const head = command.trim().replace(/;\s*([A-Za-z_][A-Za-z0-9_]*)=\$\?;\s*exit\s+(?:"\$\1"|\$\1)\s*$/, '');
  if (head.includes('<<') || head.includes('`') || head.includes('$(')) return false;
  const lexer = /[ \t\r]+|#[^\n]*|\d*[<>]&\d+|\d*(?:>>?|<)|&&|(?:[^\s"';&|<>()[\]{}$`\\]+|"(?:\\.|[^"\\$`])*"|'[^']*')+/gy;
  const statements = [[]];
  let offset = 0;
  while (offset < head.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(head);
    if (!match) return false;
    offset = lexer.lastIndex;
    const token = match[0];
    if (/^[ \t\r]+$/.test(token) || token.startsWith('#')) continue;
    if (token === '&&') {
      if (!statements.at(-1).length) return false;
      statements.push([]);
    } else statements.at(-1).push(token);
  }
  if (statements.some(statement => !statement.length)) return false;
  const unquote = value => value.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_, single, double) => single === undefined ? double.replace(/\\([$`"\\\n])/g, '$1') : single);
  const commands = [];
  for (const statement of statements) {
    const words = [];
    for (let i = 0; i < statement.length; i++) {
      const token = statement[i];
      if (/^\d*[<>]&\d+$/.test(token)) continue;
      if (/^\d*(?:>>?|<)$/.test(token)) {
        if (!statement[i + 1] || /^\d*[<>]/.test(statement[i + 1])) return false;
        i++;
      } else words.push(unquote(token));
    }
    let index = words[0] === 'env' ? 1 : 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index++;
    const executable = (words[index] || '').split(/[\\/]/).pop();
    if (!executable || /^(?:exit|return|exec|eval|trap|source|builtin|command|set|shopt|enable|alias|unalias|break|continue|if|then|for|while|until|case|do|else|fi|done|function|\.|!)$/.test(executable)) return false;
    commands.push({ executable, args: words.slice(index + 1) });
  }
  return commands.some(({ executable, args }) => {
    const separator = args.indexOf('--');
    const options = args.slice(0, separator < 0 ? args.length : separator).map(arg => arg.split('=')[0]);
    if (/^node(?:\.exe)?$/i.test(executable)) {
      if (args[0] === '--test' && options.some(arg => ['--help', '-h', '--version', '-v', '--eval', '-e', '--print', '-p', '--check', '-c'].includes(arg))) return false;
      return args[0] === '--test' || /\.test\.(?:js|cjs|mjs|sh)$/i.test(args[0] || '')
        || /(?:^|[\\/])\.github[\\/]run-tests\.js$/.test(args[0] || '');
    }
    if (options.some(arg => ['--help', '-h', '--version'].includes(arg))) return false;
    if (/^npm(?:\.cmd|\.exe)?$/i.test(executable) && args[0] === 'ci') return false;
    if (/^(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?$/i.test(executable)) return !options.includes('-v') && /^(?:test|build|ci|typecheck|lint|e2e)(?::[A-Za-z0-9_.-]+)?$/.test(args[0] === 'run' ? args[1] || '' : args[0] || '');
    if (/^mvn(?:\.cmd|\.exe)?$/i.test(executable)) return !options.includes('-v') && args.some(arg => /^(?:test|verify|package|install|compile)$/.test(arg));
    if (/^gradlew?(?:\.bat|\.exe)?$/i.test(executable)) return !options.includes('-v') && args.some(arg => /^(?:test|build|check|assemble)$/.test(arg));
    if (/^(?:pytest|tox|phpunit)(?:\.cmd|\.exe)?$/i.test(executable)) return true;
    if (/^(?:vitest|jest|tsc)(?:\.cmd|\.exe)?$/i.test(executable)) return !options.includes('-v');
    if (/^(?:python[0-9.]*|py)(?:\.exe)?$/i.test(executable)) return args[0] === '-m' && args[1] === 'pytest';
    if (/^(?:go|cargo)(?:\.exe)?$/i.test(executable)) return args[0] === 'test';
    if (/^dotnet(?:\.exe)?$/i.test(executable)) return ['test', 'build'].includes(args[0]);
    return /^(?:bash|sh)(?:\.exe)?$/i.test(executable) && /\.test\.sh$/.test(args[0] || '');
  });
}
function ranGreenThisTurn(ctx) {
  return ctx.turnTools.some((tool) => tool.success && toolName(tool) === 'Bash'
    && ranTestCommand(String(tool.input.command || '')));
}

// R6 的兜底：项目没有队列文件时，本轮创建却没关掉的 TaskList 条目同样算"还有能做的格子"。
// 只认**本轮**的创建/关闭计数（跨轮的任务状态不在 transcript 尾部可判，跨轮靠队列）。
function inTurnOpenTasks(ctx) {
  // 只读 / 仅交接的任务不因任务清单收尾（与 R6 队列路径的口径一致）
  if (ctx.scope.readOnly || ctx.scope.handoffOnly) return 0;
  let created = 0;
  let closed = 0;
  for (const tool of ctx.turnTools) {
    const n = toolName(tool);
    // 只看**成功**的调用：创建失败不算待办，关闭失败也不算已完成
    if (n === 'TaskCreate' && tool.success) created++;
    else if (n === 'TaskUpdate' && tool.success && ['completed', 'deleted'].includes(String(tool.input.status || ''))) closed++;
  }
  return Math.max(0, created - closed);
}

let taskFallback = 0;
const RULES = [
  {
    id: 'R6-open-work-queue',
    tailOnly: false,
    needsText: false,
    test: (t, ctx) => {
      taskFallback = 0;
      const open = openQueueItems(ctx)
      if (open !== null) return open.length > 0
      // 没有队列文件的会话（临时任务、非项目目录）不能整条空转：
      // 本轮 TaskCreate 了却没 TaskUpdate 关掉的条目，同样说明"还有能做的格子"。
      taskFallback = inTurnOpenTasks(ctx)
      return taskFallback > 0
    },
    reason: () =>
      taskFallback > 0
        ? '本轮用 TaskCreate 建了 ' + taskFallback + ' 个还没关掉的任务条目（没有 completed/deleted 的 TaskUpdate）。按「能进行下一步就不要停」：现在开工，或明确写出被什么外部条件挡住。'
        : '项目根 `.qoder-work-queue.md` 还有未做完的格子（`- [ ]`，或 `- [~]` 但没写"阻塞：理由"）。按全局规则「能进行下一步就不要停」：现在开工做掉，或确实被外部条件挡住时改成 `- [~] … 阻塞：<具体外部条件>` 再收尾。',
  },
  {
    id: 'R6b-blocker-expired',
    tailOnly: false,
    needsText: false,
    test: (t, ctx) => staleBlockers(ctx).length > 0,
    reason: () =>
      '队列里这些格子标了「阻塞」，但**阻塞所引用的文件此刻是干净的**（阻塞已过期）：\n'
      + staleCache.slice(0, 3).map((s) => '  · ' + s).join('\n')
      + '\n按全局规则「能进行下一步就不要停」：现在把它接回来开工；确实仍被挡住就重测后换成新的真实阻塞条件（凭据/进程/上游规格），别拿过期的脏态当理由。',
  },
  {
    id: 'R6c-queue-not-resumable',
    tailOnly: false,
    needsText: false,
    test: (t, ctx) => queueResumeProblems(ctx) !== null,
    reason: () =>
      '队列文件**存在但接手不了**（缺四要素 / 阻塞没写理由 / 关键入口指向的文件已不在）：\n'
      + (queueResumeCache || []).slice(0, 4).map((s) => '  ' + s.trim()).join('\n')
      + '\n按「过程落盘」纪律：把「当前状态 / 下一步 / 阻塞点 / 关键入口」补全（关键入口里指向还没建的东西时标注「待建」），再收尾。检查命令：`node ~/.qoder/scripts/work-queue-check.js`。',
  },
  {
    id: 'R1b-declared-next-step-without-reason',
    tailOnly: true,
    // 声明"下一步做 X"却就此结束回合 = 把下一格的成本转嫁给用户再敲一次"继续"。
    // 放行条件：写明这一格被**裁决或外部条件**挡住。上下文/预算**不是**放行理由——
    //    真装不下就切更小片或交子代理继续，拿耗尽收尾是第四次被点名的原话（2026-09-19）。
    // 判据是"有没有写理由"，不是理由是否充分——写了假理由复盘时照样抓得到。
    test: (t, ctx) =>
      !ctx.scope.readOnly && !ctx.scope.handoffOnly &&
      /下一步|接下来|下一格|下一批/.test(t) &&
      /[^。！？!?]{0,24}(做|出|补|接|按|先|再|重|量|画|生成|推|开工|继续)/.test(t) &&
      !/被.{0,6}(裁决|外部|前置|凭据|条件)(挡住|拦住|卡住)|等(待)?(裁决|回执|审批|外部|数据)|无可(做|继续)|全部(被|依赖)|需要(凭据|口径|拍板)/.test(
        t,
      ),
    reason:
      '按全局规则「能进行下一步就不要停」：汇报里声明了下一步却没做，等于把成本转嫁给用户再敲一次继续。要么现在开工，要么写明这一格此刻为什么做不了。',
  },
  {
    id: 'R1-stop-and-wait',
    tailOnly: true,
    test: (t) =>
      /(要继续[吗呢]|继续吗|继续呢|是否继续|需要我继续|要我继续|要不要我(继续|接着)|继\s*续[^。！？!?\n]{0,14}[吗呢]\s*[？?]|下一步(做|执行)?什么|接下来(做|执行|干)什么|可以继续了吗)/.test(t),
    reason:
      '按全局规则「回合结束前必须过停手检查表」：待办里若还有不依赖裁决、不依赖外部条件的格子，立刻开工，不许用汇报收尾。'
      + '可结束回合的情形按 AGENTS「冲突裁决优先级」的**六项例外**：对外可见 / 不可逆 / 缺只有用户能提供的凭据或对外口径 / 需求缺失到无法定义完成判据 / 同类修复三种不同手段连败 / 触红线须先确认。',
  },
  {
    id: 'R2-decision-without-popup',
    tailOnly: true,
    // 2026-10-27 收窄：不是"出现'确认'字样"就拦——只有**真需要用户拍板**的才拦：
    // ① 明确在要求做选择/裁决；或 ② 让用户确认的是高风险动作（部署/推送/删除/覆盖/回滚/停服/改配置）。
    // 命名、文案、颜色这类内部口径不属于"必须弹窗"，按 AGENTS「内部技术口径自行选定合理值」放行。
    test: (t, ctx) =>
      /(待裁决|需要你(拍板|决定|拿主意|定|确认)|待你定|由你定|等你(确认|决定|拍板|回复|定|示下)|请(拍板|确认|决定|选择|告诉我|示意)|你(选|决定|定)(一|哪)?下|以下方案请选|麻烦确认一下方案)/.test(
        t,
      )
      && /(?:拍板|选择|裁决|决定|拿主意|以下方案|方案[一二三AB]|[A-C][)）.、]|(?:^|\n)\s*[1-3][.、)]|等你(?:确认|回复|示下|定)|待你定|由你定|确认[^。！？\n]{0,12}(?:部署|发布|上线|推送|删除|覆盖|回滚|停止|重启|改配置|切流|审批)|(?:部署|发布|上线|推送|删除|覆盖|回滚|停止|重启|改配置|切流|审批)[^。！？\n]{0,12}确认)/.test(t)
      && !ctx.turnTools.some((x) => x.success && toolName(x) === 'AskUserQuestion')
      // 已经把裁决落成动作的（"先按推荐项继续"）不算踢皮球：它既提了问题，也继续推进了
      && !/(?:先按|按)(?:推荐|默认|最优|保守).{0,12}(?:继续|推进|执行)|先做不依赖.{0,20}(?:部分|工作)/.test(t),
    reason:
      '按全局规则「裁决不阻塞任务」：需要拍板时用 AskUserQuestion 弹窗一次问全（**真实备选 ≥2 + 收益/代价 + 推荐项**，不为凑数制造第三项）；'
      + '未答复时：**只读 / 可逆**的部分按推荐项继续并在汇报里点名假设，**写入类**未答复＝未授权、保持不动；然后继续推进不依赖该裁决的部分。',
  },
  {
    id: 'R3-ui-claim-without-evidence',
    test: (t, ctx) => {
      if (ctx.scope.readOnly) return false;
      const claim = /(已完成|全部完成|已修复|已验证|已跑通|全绿|功能正常|显示正确|渲染正确|可以正常使用|没问题|改好了)/;
      const ui = /(页面|界面|前端|组件|小程序|小游戏|UI|样式|渲染|动效|截图|模拟器|真机)/;
      // 先剥引用再判（2026-10-27 修误报：复盘里引用规则原文曾被当成交付主张拦下）
      const clean = stripQuoted(t);
      const claims = clean.split(/[。！？!?；;\n]+/).filter((s) => claim.test(s) && ui.test(s));
      // 改动面驱动：本轮真的改了前端文件时，不需要正文出现界面类词汇，只要有一条交付主张就得拿证据。
      // 旧判据只认"主张词 + 界面词同句"，于是"改动已完成"这种最典型的说法恰好漏检。
      const touchedUi = editedUiFiles(ctx).length > 0;
      const surfaceClaim = touchedUi && claim.test(clean);
      return (claims.length > 0 || surfaceClaim) && !visualEvidence(ctx, t);
    },
    reason:
      '按全局规则「前台改动必须真跑 + 实际截图比对」：只过单测/构建不算验收。补真实运行证据（dev server / 开发者工具 / 模拟器截图路径与比对结论），拿不到就显式写「未做视觉验证 + 原因」。',
  },
  {
    id: 'R9-claim-without-run',
    tailOnly: false,
    // "测试全绿 / 构建通过"是最容易空口说的一句。判据：本轮有没有**成功跑过**测试或构建命令。
    // 不做语义判断，只认工具记录——transcript 里有 Bash 调用的成功记录才算数，正文里写命令不算。
    test: (t, ctx) => {
      if (ctx.scope.readOnly) return false;
      if (!ctx.turnTools.some((x) => toolName(x) === 'Bash')) return false;
      const clean = stripQuoted(t);
      // 自己已经声明"未运行 / 未验证"的，不算虚假主张
      if (/(?:未|尚未|还没|没有)(?:运行|跑|执行|验证)(?:过)?|无法运行/.test(clean)) return false;
      const claim = /(?:测试|单测|用例|回归|构建|编译|\bbuild\b|\btest\b)[^。！？!?；;\n]{0,14}(?:全绿|全部通过|全过|通过|成功|没问题)|(?:全绿|全部通过|构建成功|编译通过|测试通过)/i;
      if (!claim.test(clean)) return false;
      return !ranGreenThisTurn(ctx);
    },
    reason:
      '按验证纪律「每条断言都要能失败」：正文说的是测试/构建全绿，但本轮没有成功的测试或构建命令记录。'
      + '要么现在真跑一次并把退出码写进汇报，要么把结论改成「未验证 + 原因」（引用的历史结果要写明出处，不能当作本轮证据）。',
  },
  {
    id: 'R4-correction-not-persisted',
    test: (t, ctx) => /(?:以后|长期).{0,40}(?:记住|写入记忆)/.test(ctx.lastUserText) && needsMemory(ctx) && !memoryWritten(ctx),
    reason:
      '本轮明确要求持久保存长期偏好，但未取得成功记录及索引证据；只在当前授权和平台权限范围内完成记录。只读、禁止记忆或仅交接时不要求写入。',
  },
  {
    id: 'R7-session-too-big',
    tailOnly: false,
    needsText: false,
    // 会话体积哨兵。证据（2026-09-19 取证）：本项目 119 MB 与 65.8 MB 两个会话里出现过 9 次
    // 传输层掐断（`Model stream timed out before response headers after 60s` ×3、
    // `The model service rejected this request` ×4、`The request could not be completed` ×2），
    // 而用户看到的正是"任务老中断"。体积越大、单请求 payload 越大，服务端就越可能在 60s 内发不出响应头。
    // 所以体积到线时必须**主动交接**：把接续点落盘（队列/台账），并明说建议开新会话 ——
    // 把"被动被掐断"换成"主动分段"，用户下一次只需说"继续"。
    test: (t, ctx) => {
      const mb = transcriptMb(ctx.transcriptPath);
      ctx.sessionMb = mb;
      return !ctx.scope.readOnly && !ctx.scope.handoffOnly && mb !== null && mb >= Number(process.env.STOP_GATE_SESSION_MB || 25)
        && !handoffRecorded(ctx);
    },
    reason:
      '本会话体积已超过安全线（默认 25MB；实测 119MB/65.8MB 的会话会被传输层按时掐断，' +
      '症状是 Model stream timed out / service rejected）。收尾前必须做完交接三件：' +
      '① 把接续点（做到哪 / 下一步做哪一格 / 关键入口）写进项目根 `.qoder-work-queue.md`；' +
      ' 本轮的工作记录落进台账与 memory/；③ 在回复里给出交接文件路径并明说「建议开新会话继续」。',
  },
  {
    id: 'R8-memory-not-written',
    tailOnly: false,
    needsText: false,
    test: (t, ctx) => needsMemory(ctx) && !memoryWritten(ctx),
    reason:
      '本轮明确要求保存记忆或声称记忆已写入，但缺少成功工具结果、非空目标文件及索引引用。只读审阅、临时纠正和普通重试不强制记忆；被权限拒绝时报告阻塞，不得绕过。',
  },
  {
    id: 'R5-no-stance-punt',
    tailOnly: true,
    // 窄条件：命中"踢皮球句式"且全文无主张词才拦（宁窄勿滥，避免重蹈 R3 误报）
    test: (t) =>
      /(看你要哪个|您决定|你决定|由你(来)?决?定|由您(来)?决?定|都行|随你|看你(怎么)?(选|定)|看您(怎么)?(选|定)|你(选|挑)一个|您(选|挑)一个|您看着办|你看着办)/.test(t) &&
      !/(结论|建议|推荐|我认为|我的判断|判断(是|：)|下一步(做|就|先|是)|我来(做|选|定)|我(选|挑|决定)|就这么办|采用|决定(用|按|采用)|按.{1,8}(执行|推进|进行))/.test(t),
    reason:
      '按全局规则「回复必须携带主张词」（首要纪律第 7 条）：回复要给出明确结论 / 判断 / 推荐，不把决策悬空或踢回用户——把"看你要哪个 / 您决定"改写为"推荐 X（理由…），备选 Y"。',
  },
];

function main() {
  const raw = readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch (e) {
    input = {};
  }
  const event = input.hook_event_name || 'Stop';
  const scan = input.transcript_path ? scanTranscript(input.transcript_path, TAIL_BYTES) : { turnTools: [], lastUserText: '', lastAssistantText: '' };
  const text = typeof input.last_assistant_message === 'string' && input.last_assistant_message
    ? input.last_assistant_message
    : scan.lastAssistantText;
  const session = String(input.session_id || 'unknown');
  diag({ at: new Date().toISOString(), event, keys: Object.keys(input).sort(), session, hasText: !!text, textLen: text.length });

  const cfg = json(CONFIG);
  if (cfg.disabled) return;
  if (event !== 'Stop') return;
  // 上一轮被本门禁拦过、这一轮是"续停"：**不再无条件放行**。
  // 原来这里直接 return，等于"被拦一次之后的所有收尾全部免检"——
  // 2026-09-20 那次五格长回合就是这么停住的：R6 在 15:42 拦过，补完五格再收尾时已经免检。
  // 防死循环交给滑动窗上限（30 分钟内每规则最多拦 N 次，超限写 -SUPPRESSED 台账后放行）：
  // 它保证收敛，同时让"放行"这件事始终留痕。
  const secondStop = Boolean(input.stop_hook_active);
  if (secondStop) ledger('SECOND-STOP', session, text);
  // 拿不到可判文字时只跳过"读措辞"的规则，**不**跳过读外部状态的规则：
  // 否则 R6 恰好在本该起作用的情形（我只写一句汇报就收尾、正文里没有任何关键词）下失效。
  const noText = !text || text.length < 8;

  const ctx = { turnTools: scan.turnTools, lastUserText: scan.lastUserText || '', lastAssistantText: text,
    cwd: input.cwd || process.cwd(), sessionId: session, taskId: input.task_id || null,
    scope: taskScope(scan.lastUserText), transcriptPath: input.transcript_path || null };

  const stateFile = path.join(STATE_DIR, session.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
  const state = json(stateFile);
  state.rules = state.rules || {};
  state.total = state.total || 0;

  for (const rule of RULES) {
    if (noText && rule.needsText !== false) continue;
    let hit = false;
    try {
      hit = rule.test(rule.tailOnly ? tailView(text) : text, ctx);
    } catch (e) {
      hit = false;
    }
    if (!hit) continue;
    const now = Date.now();
    state.ruleHits = state.ruleHits || {};
    state.hits = recentHits(state.hits, now);
    const ruleHits = recentHits(state.ruleHits[rule.id], now);
    if (ruleHits.length >= MAX_BLOCKS_PER_RULE || state.hits.length >= MAX_BLOCKS_PER_SESSION) {
      // 停用必须**可见**：不落一条台账，事后没人分得清"这一段没违规"和"门禁这一段在放行"
      ledger(rule.id + '-SUPPRESSED', session, text);
      return;
    }
    ledger(rule.id, session, text);
    state.ruleHits[rule.id] = ruleHits.concat([now]);
    state.hits = state.hits.concat([now]);
    // 累计计数只留作汇报与复盘，**不再**参与"是否放行"的判定
    state.rules[rule.id] = (state.rules[rule.id] || 0) + 1;
    state.total = (state.total || 0) + 1;
    state.last = rule.id;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch (e) {}
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: `[stop-gate ${rule.id}] ` + (typeof rule.reason === 'function' ? rule.reason() : rule.reason) }) + '\n',
    );
    return;
  }
}

try {
  if (process.argv[2] === '--report') {
    report();
  } else {
    main();
  }
} catch (e) {
  if (process.argv[2] === '--report') {
    console.error('REPORT_FAILED');
    process.exit(2);
  }
  diag({ at: new Date().toISOString(), error: String(e && e.message) });
}
process.exit(0);
