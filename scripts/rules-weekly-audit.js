#!/usr/bin/env node
// 每周规则维护体检（供 qoder_cron 定时调用，也可手工跑）
//
// 定位：global-config-guard.js 只在**会话开台**做轻量体检（漂移 + 悬空引用），
// 本脚本是**深度周检**——补足开台体检不查、也没法定时查的部分：
//   一致性：两侧配置 / 记忆（复用既有同步脚本，不重复实现）
//   健全性：rules frontmatter 有效性、AGENTS.md 篇幅、hook 接线完整性、机制存活新鲜度
//   适用性：悬空文件引用、失效技能引用
//   无冲突：**冲突回归门禁**——已裁决的定论被写回旧措辞、或领域规则放宽通用纪律
//
// 周检只报告配置差异；内容同步必须经批准并指定真源。
//
// 用法：
//   node rules-weekly-audit.js           深度体检，产出报告 + 台账；0=健康 1=有告警
//   node rules-weekly-audit.js --quiet   只出摘要行（供 hook / 管道）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot, counterpart } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const { spawnSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const A = CLIENT_ROOT;                          // 本机实际存在的客户端侧（单端时就是唯一一侧）
const B = counterpart(A) || path.join(HOME, '.qoder-cn'); // 另一侧；不存在时 HAS_B=false 拦掉，绝不新建
const SCRIPTS = path.join(A, 'scripts');
const OUT_DIR = path.join(A, 'tmp', 'rules-audit');
const HISTORY = path.join(OUT_DIR, 'history.log');
// bash 路径按候选表探测（可用 QODER_BASH 覆盖）：写死单一路径在别人机器上会静默失效（同 global-config-guard.js）。
const BASH = (() => {
  const cands = [process.env.QODER_BASH, 'C:/Program Files/Git/bin/bash.exe', 'D:/software/Git/bin/bash.exe'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return 'bash';
})();
const QUIET = process.argv.includes('--quiet');
// 单端（只装了 Qoder、没有 ~/.qoder-cn）是**合法安装形态**：所有"另一侧"的检查都跳过，
// 不能报成"读不到 / 解析失败"——那是把正常安装判成故障（2026-09-23 用假 HOME 实测出来的）。
const HAS_B = fs.existsSync(B);

const findings = [];   // {level:'warn'|'info'|'fixed', area, msg, action}
const add = (level, area, msg, action) => findings.push({ level, area, msg, action });

// 交给 bash 的路径必须统一成前斜杠：HOME 若是 Windows 形式（用户目录写法，定时任务从
// cmd/PowerShell 启动时就是这样），path.join 会产出反斜杠，bash 直接报 127「No such file」，
// 于是所有子检查都变成假告警。
const toPosix = (p) => String(p).replace(/\\/g, '/');
function sh(script, args, timeoutMs = 20000) {
  const t0 = Date.now();
  try {
    const r = spawnSync(BASH, [toPosix(script), ...args.map(toPosix)], { encoding: 'utf8', timeout: timeoutMs });
    const timedOut = r.status === null && r.error && r.error.code === 'ETIMEDOUT';
    return { code: r.status === null ? -1 : r.status, out: ((r.stdout || '') + (r.stderr || '')).trim(), ms: Date.now() - t0, timedOut: !!timedOut };
  } catch (e) {
    return { code: -1, out: String(e && e.message), ms: Date.now() - t0, timedOut: false };
  }
}
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function listRules(dir) { try { return fs.readdirSync(path.join(dir, 'rules')).filter(f => f.endsWith('.md')); } catch { return []; } }
function daysAgo(t) { return (Date.now() - t) / 86400000; }

// 内联检查的耗时预算：脚本以子进程形式被 hook 调用时，调用方的超时若小于脚本耗时，
// 这个检查就**永远超时、等于没做**（且可能拖慢每次开台）。改动任一侧都要同步核这张表。
const PERF_BUDGETS = [
  { script: 'sync-memory.sh', args: [], budgetMs: 8000, consumer: 'global-config-guard.js（SessionStart hook 内联调用）' },
  { script: 'sync-global-config.sh', args: ['--check'], budgetMs: 8000, consumer: 'global-config-guard.js（SessionStart hook 内联调用）' },
];

/**
 * 消费者的**总**预算（不是单项相加）：串行检查只看单项会漏一种洞 ——
 * 两项各 8s 相加 16s，而 hook 只给 15s 时被掐死的是整个检查，一段提醒都不输出，
 * 看起来反倒像"体检正常"。2026-09-20 就是这么漏过一次记忆分叉。
 * `totalMs` 必须与消费者脚本里的 BUDGET_MS 一致（改一边就改另一边）。
 */
const CONSUMER_BUDGETS = [
  { consumer: 'global-config-guard.js', hookEvent: 'SessionStart', totalMs: 11000, scripts: ['sync-memory.sh', 'sync-global-config.sh'] },
];

// ── 1. 一致性：两侧配置 + 记忆（复用既有脚本）──────────────────────────────
function checkConsistency() {
  const chk = sh(path.join(SCRIPTS, 'sync-global-config.sh'), ['--check'], 60000);
  if (chk.code === 1) {
    add('warn', '一致性', 'AGENTS.md / rules 两侧漂移：' + (chk.out.split('\n').filter(l => /^(DRIFT|MISSING|ONLY-)/.test(l)).join('; ') || '见 --check'),
      '先比较差异；获准后指定 --from-qoder 或 --from-qoder-cn，覆盖前备份；周检不自动覆盖');
  } else if (chk.code !== 0) {
    add('warn', '一致性', `sync-global-config.sh --check 未能执行（${chk.timedOut ? `超时 >${60000}ms` : '退出码 ' + chk.code}）：` + chk.out.slice(0, 120), '检查 bash 路径与脚本是否存在');
  }

  // 记忆检查 2026-09-19 重写后约 1s（曾因逐文件 spawn 实测 41.5s）；180s 超时留作异常兜底，防卡死
  const mem = sh(path.join(SCRIPTS, 'sync-memory.sh'), [], 180000);
  if (mem.code === 1) {
    const lines = mem.out.split('\n').filter(l => /分叉|只在|索引不/.test(l)).slice(0, 4);
    add('warn', '一致性', '记忆两侧不一致：' + (lines.join(' | ') || '跑 sync-memory.sh 看明细'), '单边文件用 --copy-missing；分叉必须手工合');
  } else if (mem.code !== 0) {
    add('warn', '一致性', `sync-memory.sh 未能执行（${mem.timedOut ? `超时 >180s，耗时异常` : '退出码 ' + mem.code}）：` + mem.out.slice(0, 100), '手工跑一次看卡在哪；它变慢会连带把调用它的 hook 拖死');
  }

  // 耗时预算核对：复用上面实测到的时间，不重跑
  const measured = new Map([
    ['sync-global-config.sh', { ms: chk.ms, timedOut: chk.timedOut }],
    ['sync-memory.sh', { ms: mem.ms, timedOut: mem.timedOut }],
  ]);
  for (const b of PERF_BUDGETS) {
    const r = measured.get(b.script);
    if (!r) continue;
    if (r.timedOut || r.ms > b.budgetMs) {
      add('warn', '健全性', `${b.script} 实测 ${(r.ms / 1000).toFixed(1)}s，超出调用方预算 ${(b.budgetMs / 1000).toFixed(0)}s → ${b.consumer} 里的这项检查**永远超时、等于没做**，还会拖慢每次开会话`,
        '二选一：把调用方超时调大，或让该脚本支持快速模式（只报不逐文件比对）');
    }
  }

  // 总预算核对（静态 + 动态两把）：见 CONSUMER_BUDGETS 的注释。
  // 静态那把查"声明的总预算是否已越过 hook 超时"，动态那把查"实测合计是否已吃掉总预算"——
  // 吃掉了就意味着开台时后一路检查会被跳过，那一半体检等于没做。
  for (const c of CONSUMER_BUDGETS) {
    let hookSec = null;
    for (const p of [path.join(A, 'settings.json'), ...(HAS_B ? [path.join(B, 'settings.json')] : [])]) {
      let cfg;
      try { cfg = JSON.parse(readText(p)); } catch (e) { continue; }
      for (const g of (cfg.hooks || {})[c.hookEvent] || []) {
        for (const h of g.hooks || []) {
          if (String(h.command || '').includes(c.consumer)) hookSec = Math.min(hookSec ?? Infinity, h.timeout ?? Infinity);
        }
      }
    }
    if (hookSec === null || !Number.isFinite(hookSec)) {
      add('warn', '健全性', `${c.consumer} 在两侧 settings.json 的 ${c.hookEvent} 里读不到超时值 ⇒ 总预算核对失效`, '检查接线是否被改名或摘掉');
      continue;
    }
    if (c.totalMs >= hookSec * 1000) {
      add('warn', '健全性', `${c.consumer} 声明的总预算 ${(c.totalMs / 1000).toFixed(0)}s ≥ hook 超时 ${hookSec}s ⇒ 慢的时候整个 hook 被掐死、连提醒都不输出`,
        '把总预算压到 hook 超时的一半以下，或把检查挪出 SessionStart');
    }
    let sum = 0;
    let seen = 0;
    for (const s of c.scripts) {
      const r = measured.get(s);
      if (r) { sum += r.ms; seen++; }
    }
    if (seen === c.scripts.length && sum > c.totalMs) {
      add('warn', '健全性', `${c.consumer} 内实测合计 ${(sum / 1000).toFixed(1)}s 已超总预算 ${(c.totalMs / 1000).toFixed(0)}s ⇒ 开台时后一路检查会被跳过（它会明说"未检查"，但那一半体检等于没做）`,
        '让慢的那个脚本支持快速模式（只报不逐文件比对）');
    }
  }
}

// ── 2. 健全性 ────────────────────────────────────────────────────────────
const VALID_TRIGGERS = new Set(['glob', 'model_decision', 'manual', 'always_on']);
function checkSoundness() {
  // 2a. frontmatter
  const bad = [];
  for (const side of [A, B]) {
    for (const f of listRules(side)) {
      const txt = readText(path.join(side, 'rules', f));
      const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) { bad.push(`${f}: 无 frontmatter`); continue; }
      const fm = m[1];
      const trig = (fm.match(/^trigger:\s*(\S+)/m) || [])[1];
      if (!trig) bad.push(`${f}: 缺 trigger`);
      else if (!VALID_TRIGGERS.has(trig)) bad.push(`${f}: 非法 trigger=${trig}`);
      if (trig === 'glob' && !/^glob:/m.test(fm)) bad.push(`${f}: trigger=glob 但缺 glob 列表`);
      if (trig === 'model_decision' && !/^description:\s*\S/m.test(fm)) bad.push(`${f}: model_decision 缺 description`);
    }
  }
  if (bad.length) add('warn', '健全性', '子规则 frontmatter 有问题：' + [...new Set(bad)].join('; '), '修 frontmatter；触发器不生效该规则就不会被加载');

  // 2b. 篇幅：AGENTS.md 越写越长会稀释约束（目标 ≤160，硬线 190）
  for (const [name, p, warn, hard] of [
    ['AGENTS.md（非 CN）', path.join(A, 'AGENTS.md'), 160, 190],
    ...(HAS_B ? [['AGENTS.md（CN）', path.join(B, 'AGENTS.md'), 160, 190]] : []),
  ]) {
    const t = readText(p);
    if (!t) { add('warn', '健全性', name + ' 读不到', '确认路径与权限'); continue; }
    // 用换行计数，与 `wc -l` 口径一致（split('\n') 在有尾换行时会多算 1 行，容易与手工核对打架）
    const n = t.split(String.fromCharCode(10)).length - 1;
    if (n > hard) add('warn', '健全性', `${name} 已 ${n} 行（硬线 ${hard}）`, '按层级优先级转索引（先技能流程与记忆、再 rules/ 领域细则）；主文件只留一句判据 + 指针，不得删判据');
    else if (n > warn) add('info', '健全性', `${name} ${n} 行（预警线 ${warn}）`, '按层级优先级把低优先级内容转成索引（rules/ / references/ / 主题子索引）');
  }

  // 2b-2. 记忆索引红线：MEMORY.md 超 200 行，客户端只加载一部分（条目会静默丢）
  {
    const mp = path.join(A, 'memory', 'MEMORY.md');
    if (fs.existsSync(mp)) {
      const t = readText(mp);
      const n = t.split(String.fromCharCode(10)).length - 1;
      if (n > 200) add('warn', '健全性', `MEMORY.md 已 ${n} 行（红线 200）`, '按层级优先级把低优先级条目并入主题子索引，主索引只留指针；不得删指针');
    }
  }

  // 2c. hook 接线完整性：两侧三个事件都要挂
  const hookCmds = {};
  for (const [label, p] of [['非 CN', path.join(A, 'settings.json')], ...(HAS_B ? [['CN', path.join(B, 'settings.json')]] : [])]) {
    let cfg;
    try { cfg = JSON.parse(readText(p)); } catch (e) { add('warn', '健全性', `${label} settings.json 解析失败：${e.message}`, '修 JSON'); continue; }
    const hooks = cfg.hooks || {};
    for (const ev of ['UserPromptSubmit', 'Stop', 'SessionStart', 'PreToolUse']) {
      const cmds = (hooks[ev] || []).flatMap(g => (g.hooks || []).map(h => h.command)).filter(Boolean);
      hookCmds[label] = hookCmds[label] || {};
      hookCmds[label][ev] = cmds;
      // 完整性（每侧都要挂）与一致性（两侧要挂成一样）是**两件事**，都得查：
      // 只查一致 → "两侧都漏挂"会通过；只查非空 → "只挂一侧"会通过。（踩过：补一致性时把完整性删了，自测立刻红。）
      if (cmds.length === 0) add('warn', '健全性', `${label} settings.json 缺 ${ev} 接线`, '规则强制层少一路，对应机制不会触发');
    }
  }
  // 2d. 两侧 hook 清单必须一致——只查"某侧非空"会让**单边接线**静默通过（2026-09-19 补）
  const norm = (c) => String(c).replace(/[\\/]\.qoder-cn[\\/]/g, '/.qoder/').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  if (hookCmds['非 CN'] && hookCmds['CN']) {
    for (const ev of ['UserPromptSubmit', 'Stop', 'SessionStart', 'PreToolUse']) {
      const a = new Set((hookCmds['非 CN'][ev] || []).map(norm));
      const b = new Set((hookCmds['CN'][ev] || []).map(norm));
      const onlyA = [...a].filter(x => !b.has(x));
      const onlyB = [...b].filter(x => !a.has(x));
      if (onlyA.length || onlyB.length) {
        add('warn', '健全性', `${ev} 两侧接线不一致：` +
          (onlyA.length ? `仅非 CN 有 ${onlyA.map(x => path.basename(x)).join(', ')}；` : '') +
          (onlyB.length ? `仅 CN 有 ${onlyB.map(x => path.basename(x)).join(', ')}` : ''),
          '把缺的那侧补上（同一份脚本两侧都要挂），否则该侧静默失效');
      }
    }
  }

  // 2d-ter. hook 指向的脚本必须真实存在——接线在、事件对、两侧一致，唯独路径是另一台机器的
  // 用户目录（2026-10-06 实测事故：CN 重装后 hook 指向不存在的脚本；hook 失败是 fail-open
  // ⇒ 台账零行，前面几道检查全都看不见）。必须单独查路径存在性。
  {
    const seen = new Set();
    for (const [label, byEv] of Object.entries(hookCmds)) {
      for (const [ev, cmds] of Object.entries(byEv)) {
        for (const c of cmds) {
          const m = String(c).match(/node(?:\.exe)?\s+"?((?:[A-Za-z]:[\\/]|~[\\/]|\/)[^"\s]+\.(?:js|cjs|mjs|sh))"?/i);
          if (!m) continue;
          let p = m[1].replace(/^~(?=[\\/])/, os.homedir()).replace(/[\\/]/g, path.sep);
          if (p.includes('$') || p.includes('%')) continue;   // 含环境变量的路径无法解析，不判
          if (seen.has(label + '|' + p)) continue;
          seen.add(label + '|' + p);
          if (!fs.existsSync(p)) {
            add('warn', '健全性', `${label} 的 ${ev} hook 指向不存在的脚本（${p}）→ 该机制从未运行过`,
              '修 settings.json 里的路径（常见于从别的机器拷来的配置）；hook 失败是 fail-open，不查路径就发现不了');
          }
        }
      }
    }
  }

  // 2d-bis. BYOK 自伤配置：settings 顶层的 modelConfigs.customModels 会把全部 custom provider 清掉
  // （provider 键与 catalog 用户条目冲突 → runtime 全有或全无地丢 provider）。2026-09-30 就是它把 BYOK 打死的。
  for (const [label, p] of [['非 CN', path.join(A, 'settings.json')], ...(HAS_B ? [['CN', path.join(B, 'settings.json')]] : [])]) {
    let cfg;
    try { cfg = JSON.parse(readText(p)); } catch (e) { continue; } // 解析失败上面 2c 已报，这里不重复
    const cm = cfg && cfg.modelConfigs && cfg.modelConfigs.customModels;
    if (cm) add('warn', '健全性', `${label} settings.json 有 modelConfigs.customModels（${(cm || []).length} 条）→ BYOK provider 会被整体丢弃`,
      'node <scripts>/byok-modelconfigs-guard.js --apply 清除，然后重启客户端');
  }

  // 2e. 临时产物水位：规则承诺"超期件由 tmp-sweeper 兜底、周检带出清单"——这里兑现它。
  // 默认只列不删（`--apply` 才动，见 /clean-temp）；**没超期件时保持静默**（健康时零输出）。
  if (fs.existsSync(path.join(SCRIPTS, 'tmp-sweeper.js'))) {
    const r = runNode(path.join(SCRIPTS, 'tmp-sweeper.js'), [], 30000);
    if (r.code === 0 || r.code === 1) {
      if (!/没有超期/.test(r.out)) {
        const brief = r.out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 4).join(' / ');
        add('info', '健全性', '临时产物有超期件：' + brief.slice(0, 240), '确认后跑 `/clean-temp`（即 `tmp-sweeper.js --apply`）；默认只列不删');
      }
    } else {
      add('warn', '健全性', `tmp-sweeper.js 未能执行（退出码 ${r.code}）：` + r.out.slice(0, 120), '规则承诺的兜底检查没跑起来——要么修它，要么把 AGENTS.md 里那句承诺删掉');
    }
  }

  // 2f. 机制存活：心跳 / 台账新鲜度（>14 天没动静 = 机制可能已失效）
  const beats = [
    ['每轮规则提醒', path.join(SCRIPTS, 'rules-reminder.log')],
    ['停手门禁台账', path.join(A, 'tmp', 'stop-gate', 'violations.log')],
  ];
  for (const [name, p] of beats) {
    if (!fs.existsSync(p)) { add('info', '健全性', `${name}：还没有日志（机制可能从未触发过）`, '确认接线并新开一次会话'); continue; }
    const age = daysAgo(fs.statSync(p).mtime);
    if (age > 14) add('warn', '健全性', `${name}：日志已 ${age.toFixed(1)} 天没更新`, '机制可能已停：查 hooks 接线与该脚本能否手工跑通');
  }

  // 2g. 记忆 frontmatter：每份记忆要有 name/description，type 只能是四类（user/feedback/project/reference）。
  // 2026-09-23 实测抓到两份写成 `type: tooling`——"有 frontmatter"本身照样为真，
  // 值非法要单独查白名单，否则下游按类型取用的逻辑会静默漏读。
  const MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference']);
  const MEMORY_SKIP = new Set(['MEMORY.md', 'rules-summary.md', 'CREDENTIALS-TEMPLATE.md']);
  const badMem = [];
  for (const side of HAS_B ? [A, B] : [A]) {
    const dir = path.join(side, 'memory');
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names.filter((n) => n.endsWith('.md') && !n.endsWith('-index.md') && !MEMORY_SKIP.has(n))) {
      const m = readText(path.join(dir, f)).match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) { badMem.push(`${f}: 无 frontmatter`); continue; }
      if (!/^name:\s*\S/m.test(m[1])) badMem.push(`${f}: 缺 name`);
      if (!/^description:\s*\S/m.test(m[1])) badMem.push(`${f}: 缺 description`);
      const t = (m[1].match(/^\s+type:\s*(\S+)/m) || [])[1];
      if (!t) badMem.push(`${f}: 缺 type`);
      else if (!MEMORY_TYPES.has(t)) badMem.push(`${f}: 非法 type=${t}`);
    }
  }
  if (badMem.length) add('warn', '健全性', '记忆 frontmatter 有问题：' + [...new Set(badMem)].join('; '), '补 name/description，type 只能是 user/feedback/project/reference');

  // 2h. 关键目录对等（2026-10-06）：两侧的 scripts/ 与 skills/ 是否存在。只有一侧有 ⇒ 报 warn；
  // 两侧同缺 ⇒ 静默（单能力 / 单端是合法形态，不能判红）。动机：CN 侧 10-04 重装后这两个目录
  // 整个消失（CN 客户端零技能），而 sync-global-config.sh 只管 AGENTS.md/rules/commands，
  // 这两个目录不在任何同步机制覆盖面内 ⇒ 没有任何检查出声。
  if (HAS_B) {
    for (const [dir, name] of [['scripts', '机制脚本目录'], ['skills', '技能库']]) {
      const a = fs.existsSync(path.join(A, dir));
      const b = fs.existsSync(path.join(B, dir));
      if (a === b) continue;
      add('warn', '健全性', `${name}「${dir}」两侧不对等：仅${a ? '非 CN' : 'CN'} 有`,
        '另一侧补上（可用链接合并共享）；该目录不在 sync-global-config 的覆盖面内，不查就无人发现');
    }
  }

  // 2i. 已装工具的版本检查（2026-10-14）：cua-driver 的 daemon 自带版本探针（version_check.json），
  // "有新版未升"要出声——自动更新纪律（AGENTS.md「工具版本自动更新」/ rules/cua-automation.md §4）
  // 不能只靠提示词。口径：releases/ 里最大的 semver = 已装版本；latest_version 更大 ⇒ warn。
  // 文件缺失静默（该工具没装 / 没探测过是合法形态）。
  {
    const cuaHome = path.join(HOME, '.cua-driver');
    try {
      const vc = JSON.parse(fs.readFileSync(path.join(cuaHome, 'version_check.json'), 'utf8'));
      const latest = String(vc.latest_version || '');
      const cmp = (x, y) => {
        const X = x.split('.').map(Number), Y = y.split('.').map(Number);
        for (let i = 0; i < 3; i++) { if ((X[i] || 0) !== (Y[i] || 0)) return (X[i] || 0) - (Y[i] || 0); }
        return 0;
      };
      const installed = fs.readdirSync(path.join(cuaHome, 'packages', 'releases'))
        .map((n) => (n.match(/^(\d+\.\d+\.\d+)/) || [])[1]).filter(Boolean)
        .sort(cmp).pop() || '';
      if (latest && installed && cmp(latest, installed) > 0) {
        add('warn', '健全性', `cua-driver 有新版未升：${installed} → ${latest}`,
          '按 rules/cua-automation.md §4 升级（备份 → 本地资产通道 → 官方安装器 → 重启 daemon → 复验；升级后复查守卫是否覆盖新工具）');
      }
    } catch (e) { /* 未安装 / 未探测：不报 */ }
  }
}

// ── 3. 适用性：引用是否还存在 ─────────────────────────────────────────────
function checkApplicability() {
  const files = [path.join(A, 'AGENTS.md')];
  for (const f of listRules(A)) files.push(path.join(A, 'rules', f));
  const dangling = [];
  // 技能目录按"实际存在"收敛：本机是 D:\qoder-cn-skills，别人可能装在别处。一个都找不到时
  // **跳过**这项并说一声，而不是把规则里每个技能名都判成悬空——那是噪声，不是发现。
  // 技能分层（2026-10-22）：按需技能在 skills-library/，规则引用它们不算悬空
  const SKILL_DIRS = ['D:/qoder-cn-skills', path.join(A, 'skills'), path.join(B, 'skills'),
    path.join(A, 'skills-library'), path.join(B, 'skills-library'),
    path.join(A, 'skills-disabled'), path.join(B, 'skills-disabled')].filter((d) => fs.existsSync(d));
  let noSkillDirNoted = false;
  for (const f of files) {
    const txt = readText(f);
    if (!txt) continue;
    for (const m of txt.matchAll(/`((?:rules|memory|scripts)\/[\w.\-]+\.(?:md|sh|js|ps1))`/g)) {
      const rel = m[1];
      if (!fs.existsSync(path.join(A, rel))) dangling.push(`${rel}（引用于 ${path.basename(f)}）`);
    }
    // 技能引用：**只查「技能 `X`」这种上下文锚定的写法**——凡是这么写的 X 必须真实存在。
    // 早前这里只有一份写死的短名单（i-have-adhd / ship-clean-pr / spring-boot-* …），名单外的悬空技能名一律漏检
    // （2026-09-20 实测有三处，如 `write-repowiki`）。
    // 反例警告：试过"凡 kebab-case 反引号名都要存在"的宽判据，立刻误报一堆——记忆条目名 / 插件名 / 技术术语
    // （`interruption-root-cause`、`open-code-review`、`prefers-reduced-motion`）。**守卫噪声多就会被忽略**，宁窄勿宽。
    if (SKILL_DIRS.length === 0) {
      if (!noSkillDirNoted) {
        noSkillDirNoted = true;
        add('info', '适用性', '没找到技能目录，跳过技能引用检查', '确认技能装在哪（如 ~/.qoder/skills）；装好后本项自动恢复');
      }
      continue;
    }
    const skillExists = (name) => SKILL_DIRS.some((d) => fs.existsSync(path.join(d, name)));
    for (const m of txt.matchAll(/技能\s*[`「]([a-z0-9][a-z0-9-]{2,})[`」]/g)) {
      const sk = m[1];
      if (!skillExists(sk)) dangling.push(`技能 ${sk}（引用于 ${path.basename(f)}，技能目录里没有）`);
    }
  }
  if (dangling.length) add('warn', '适用性', '规则引用的东西已不存在：' + [...new Set(dangling)].slice(0, 6).join('; '), '改引用或恢复文件；悬空引用会让规则无法执行');
}

// ── 4. 无冲突：冲突回归门禁 ──────────────────────────────────────────────
// 每项 = 一条**已裁决的定论**（见 AGENTS.md「冲突裁决优先级」）+ 会被重新写回来的旧措辞。
// requires 必须在**命中点就近窗口内**出现才算已修好——整文件范围找会被文件里别处的正确措辞满足，
// 于是"验证一节的旧措辞还在、裁决表里写着正确版"这种情况被判成绿的（2026-09-19 实测漏检，改成窗口判定）。
const PROXIMITY = 260;
function regressionHit(txt, r) {
  const re = new RegExp(r.pattern.source, r.pattern.flags.includes('g') ? r.pattern.flags : r.pattern.flags + 'g');
  for (const m of txt.matchAll(re)) {
    const win = txt.slice(m.index, m.index + PROXIMITY);
    if (!r.requires.test(win)) return m[0].slice(0, 60);
  }
  return null;
}

const REGRESSIONS = [
  {
    id: 'C1-提交前全绿',
    // 旧措辞：把"完整检验"挂到"提交"上（已裁定：只有推送/开 PR/部署/发布才是硬门槛）
    pattern: /提交\s*[／/]\s*部署前必须完整检验|提交前必须完整检验/,
    requires: /配比|影响面|推送/,
    hint: '已裁定：本地增量提交按影响面配比，推送/开 PR/部署/发布才要完整全绿',
  },
  {
    id: 'C2-交付语言写死英文',
    pattern: /(commit message|PR 标题)[^\n]{0,30}(用英文|英文说明)/,
    requires: /跟随(目标)?仓库惯例|内网[^\n]{0,20}沿用|沿用团队/,
    hint: '已裁定：说明语言跟随目标仓库惯例（上游英文 / 内网沿用团队语言）',
  },
  {
    id: 'C3-停机例外清单不封闭',
    pattern: /除非必须用户确认[^\n]{0,40}（[^）]{0,40}）/,
    requires: /六种|六项|封闭/,
    hint: '已裁定：可停下的例外是封闭六项，别写成 3-4 项',
  },
  {
    id: 'C4-预算不足当停手理由',
    pattern: /预算不足/,
    requires: /开工前|切小单元/,
    hint: '已裁定：预算判断只在开工前；开工后不许以此停手，改切小单元',
  },
  {
    id: 'C5-结束回合单一判据',
    pattern: /允许结束回合的只有三种情形/,
    requires: /两把尺子|停下问/,
    hint: '已裁定：要注明"可停下问"与"可结束回合"是两把尺子，否则会被当成第五种停机借口',
  },
  {
    id: 'C6-视觉验证降级当常规',
    pattern: /拿不到截图[^\n]{0,30}(跳过|忽略|可以接受)/,
    requires: /客观不可得|必须显式标注|未做视觉验证/,
    hint: '已裁定：降级仅限客观不可得且必须显式标注，不得当常规路径',
  },
];

// 领域规则放宽通用纪律：出现这类"松绑"措辞就要人工确认（rules/ 只能加严或细化）
const RELAX_PATTERNS = [
  /不必(验证|备份|截图|测试)/,
  /可以跳过(备份|验证|测试)/,
  /无需(备份|验证|截图)/,
  /(允许|可以)直接(删除|覆盖|推送)/,
  /跳过(验证|测试|备份)[^\n]{0,10}(即可|也行)/,
];

function checkConflicts() {
  const targets = [['AGENTS.md', path.join(A, 'AGENTS.md')]];
  for (const f of listRules(A)) targets.push(['rules/' + f, path.join(A, 'rules', f)]);

  for (const [label, p] of targets) {
    const txt = readText(p);
    if (!txt) continue;
    for (const r of REGRESSIONS) {
      const hit = regressionHit(txt, r);
      if (hit) add('warn', '冲突回归', `${label} 出现旧措辞「${r.id}」：${hit}`, r.hint);
    }
    if (label.startsWith('rules/')) {
      for (const re of RELAX_PATTERNS) {
        const m = txt.match(re);
        if (m) add('warn', '冲突回归', `${label} 出现可能放宽通用纪律的措辞：${JSON.stringify(m[0])}`, '领域规则只能加严或细化，不能放宽（见 AGENTS.md 冲突裁决优先级）');
      }
    }
  }
}

// ── 5. 遵守率：A 静态覆盖审查 + D 违规台账趋势（2026-09-19 用户拍板的口径）──
// A 的思路：与其造几十次会话去测"模型守不守"，先测"每条纪律**有没有人管**"——
// 逐条查它挂的机制是否存在、机制里的判据是否还在（探针正则）。机制丢了 = 这条纪律没人兜底，
// 比"遵守率 68%"这种数更可行动。D 复用已有台账看趋势，零额外成本。
// 注意：探针要挂在**承载它的那个机制**上（踩过：把 stop-gate 的规则号 R1b- 挂到 rules-reminder.js 上探，
// 于是永远报"机制掉了"——门把自己判红就是这种假红）。每条机制各自一条正则。
const ADHERENCE = [
  { d: '回复中文 / commit 语言跟随仓库惯例', mech: [{ f: 'rules-reminder.js', p: /简体中文/ }] },
  { d: '不随意停止（例外封闭六项）', mech: [{ f: 'rules-reminder.js', p: /不随意停止/ }, { f: 'stop-gate.js', p: /R1b?-/ }] },
  { d: '需拍板：≥3 方案 + 弹窗不阻塞', mech: [{ f: 'stop-gate.js', p: /R2-/ }] },
  { d: '验证要能失败 / 前台须真跑截图', mech: [{ f: 'stop-gate.js', p: /R3-/ }] },
  { d: '测试 / 构建全绿须有本轮运行证据', mech: [{ f: 'stop-gate.js', p: /R9-claim-without-run/ }] },
  { d: '同类操作连败 3 次即停（构建 / 测试 / 部署）', mech: [{ f: 'attempt-lock-core.js', p: /连败|连续失败/ }] },
  { d: '回复携带主张词、不踢皮球', mech: [{ f: 'stop-gate.js', p: /R5-/ }] },
  { d: '落盘后继续（体积 / 压缩分档）', mech: [{ f: 'session-budget.js', p: /compactionNote/ }] },
  { d: '改文件前备份（整文件覆盖 · 无 git 兜底）', mech: [{ f: 'edit-guard.js', p: /备份提醒/ }] },
  { d: '凭据 / 内网地址不入分享包', mech: [{ f: 'export-memory.sh', p: /scan_gate/ }] },
];

function runNode(script, args, timeoutMs = 30000) {
  const t0 = Date.now();
  try {
    const r = spawnSync(process.execPath, [toPosix(script), ...args], { encoding: 'utf8', timeout: timeoutMs });
    return { code: r.status === null ? -1 : r.status, out: ((r.stdout || '') + (r.stderr || '')).trim(), ms: Date.now() - t0 };
  } catch (e) {
    return { code: -1, out: String(e && e.message), ms: Date.now() - t0 };
  }
}

function checkAdherence() {
  const uncovered = [];
  for (const a of ADHERENCE) {
    if (!a.mech.length) { uncovered.push(a.d); continue; }
    let ok = true, why = '';
    for (const m of a.mech) {
      const p = path.join(SCRIPTS, m.f);
      if (!fs.existsSync(p)) { ok = false; why = `机制缺失 ${m.f}`; break; }
      if (m.p && !m.p.test(readText(p))) { ok = false; why = `${m.f} 里已找不到对应判据（探针 ${m.p}）`; break; }
    }
    if (!ok) add('warn', '遵守率', `纪律「${a.d}」的机制掉了：${why}`, '补回机制或判据；机制掉了等于这条纪律只剩提示词');
  }
  if (uncovered.length) {
    add('info', '遵守率', `以下纪律**只靠提示词、没有机制兜底**：${uncovered.join('；')}`,
      '要么机制化（hook/lint），要么明确接受"靠自觉"——别假装它有保障');
  }

  // D：违规台账趋势（复用 stop-gate --report，不重复实现统计）
  const r = runNode(path.join(SCRIPTS, 'stop-gate.js'), ['--report', '7']);
  if (r.code === 0 || r.code === 1) {
    const head = r.out.split('\n').filter(l => l.trim()).slice(0, 8).join(' / ');
    add('info', '遵守率', '近 7 天门禁台账：' + head.slice(0, 300), '命中集中在哪条纪律，就说明那条的提示词版本没兜住，考虑加严机制');
  } else {
    add('info', '遵守率', `stop-gate --report 未能执行（退出码 ${r.code}）`, '周检看不到门禁趋势，但不影响其它检查');
  }
}

function checkDisk() {
  // 周检只**报告**水位与可释放量，绝不在这里删任何东西——删除必须用户在弹窗里点头（见 /clean-disk）。
  // 阈值与档位都取自 disk-sweeper.js，这里不另写一份数字（两份副本必然漂移）。
  const r = runNode(path.join(SCRIPTS, 'disk-sweeper.js'), ['--json'], 120000);
  if (r.code !== 0 && r.code !== 1) {
    add('warn', '磁盘水位', `disk-sweeper.js --json 未能执行（退出码 ${r.code}）：${r.out.slice(0, 120)}`,
      '手工跑一次看卡在哪；它挂了低水位就没人提醒');
    return;
  }
  let j;
  try { j = JSON.parse(r.out); } catch (e) {
    add('warn', '磁盘水位', 'disk-sweeper.js 输出不是 JSON，周检读不到水位', '检查 --json 分支是否被改坏');
    return;
  }
  const gb = (n) => (n / 1073741824).toFixed(2) + ' GB';
  const msg = `C 盘剩余 ${j.freeGb.toFixed(1)} GB（${j.level}）；一档 ${j.tier1Files} 个文件 ${gb(j.tier1Bytes)}，`
    + `三档（无用缓存 / 过期内容）${j.extraFiles} 个 ${gb(j.extraBytes)}，可归档到 ${j.archiveSuggested || '（无非系统盘可选）'}`;
  if (j.level === 'ok') add('info', '磁盘水位', msg + ' ⇒ 无需清理', '不必动；这条只是让"上次查过"有记录');
  else add('warn', '磁盘水位', msg, '跑 /clean-disk：一次问全（清理两问〔一档处置 + 三档点名〕+ 迁移一问〔先跑 disk-migration-candidates.sh 拿候选〕），清理两问确认后才 --apply');
}

// ── 7. hook 健康：崩溃必须被看见 ─────────────────────────────────────────────
// hook 抛错是**静默放行**的（fail-open，见 README 的拦截语义）——没有这条日志，一个坏掉的守卫
// 可以连着几周"看着没事"（台账不涨、守卫不响，但也没在干活）。guard 由各 hook 顶部 install()，这里只读日志。
function checkHookCrashes() {
  let g = null;
  try { g = require('./hook-crash-guard.js'); } catch (e) { add('info', 'hook 健康', 'hook-crash-guard.js 不在，跳过崩溃日志检查', '恢复该文件后本项自动生效'); return; }
  const c = g.readCrashes(7 * 24 * 3600 * 1000);
  if (c.count > 0) {
    add('warn', 'hook 健康', `近 7 天 hook 崩溃 ${c.count} 次（最近 ${c.last}）：${c.samples.join(' | ')}`,
      '崩溃是静默放行的（fail-open），按样本修脚本；日志 ' + g.LOG);
  } else {
    add('info', 'hook 健康', '近 7 天无 hook 崩溃记录', '无需处理');
  }
}

function main() {
  if (!QUIET) console.log('=== 全局规则周体检 ===\n');
  checkConsistency();
  checkSoundness();
  checkApplicability();
  checkConflicts();
  checkAdherence();
  checkDisk();
  checkHookCrashes();

  const warns = findings.filter(f => f.level === 'warn');
  const fixed = findings.filter(f => f.level === 'fixed');
  const infos = findings.filter(f => f.level === 'info');

  // 台账：一行一次，便于看趋势（连续告警 / 长期健康）
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(HISTORY, `${new Date().toISOString()}|warn=${warns.length}|fixed=${fixed.length}|info=${infos.length}\n`);
  } catch (e) { /* 报告失败不影响结论 */ }

  if (!QUIET) {
    if (fixed.length) console.log('已自动修复：');
    for (const f of fixed) console.log(`  [FIX] ${f.area} — ${f.msg}`);
    if (warns.length) console.log('\n需要处理：');
    for (const f of warns) console.log(`  [WARN] ${f.area} — ${f.msg}\n         建议：${f.action}`);
    if (infos.length) console.log('\n提示：');
    for (const f of infos) console.log(`  [INFO] ${f.area} — ${f.msg}`);
  }

  if (warns.length === 0) {
    console.log(`\n规则体检：健康（0 告警${fixed.length ? `，自动修复 ${fixed.length} 项` : ''}）`);
  } else {
    console.log(`\n规则体检：${warns.length} 项待处理${fixed.length ? `，自动修复 ${fixed.length} 项` : ''}`);
    console.log('提醒：内容类告警不自动改——规则是长期约束，静默改写比不修更危险。');
  }
  process.exit(warns.length === 0 ? 0 : 1);
}

try { main(); } catch (e) {
  console.error('规则体检脚本自身出错：' + String(e && e.message));
  process.exit(2);
}
