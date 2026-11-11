#!/usr/bin/env node
// PreToolUse 守卫：拦住"用 pathspec 提交共享追加型文件"这一种提交。
//
// 为什么需要它（证据，不是推测）——2026-09-19 同一晚、同一个会话踩了两次：
//   · 第一次：为了不把并行会话的台账行带进提交，先把"只含我那一行"的 blob 暂存好，
//     然后习惯性写成 `git commit -m … -- 收口清单.md` —— **带 pathspec 的提交取的是工作区内容，
//     把刚做好的 partial blob 整个绕过**，结果提交里多带了对方的行；
//   · 第二次：补救时又对 `art-src/素材缺口清单.md` 用了同样的写法，这次把对方**在途未提交**的
//     改动一起收进我的提交（归属错乱）。两笔都发生在推送前，靠 `reset --soft` 重做才没留下后果。
//   全局规则里"机制化 > 提示词"这一条的意思就是：**提示词写了还踩，就该上 hook**。
//
// 判据不是"文件名黑名单"，而是可核对的事实：**这次要提交的路径，此刻在工作区里还有未提交的改动**。
// 有 ⇒ 这次 pathspec 提交一定会把那些改动一起带走（不管是别人的还是自己的），deny 并给正确做法；
// 没有 ⇒ 正常放行（自己独占的文件用 pathspec 提交是这个仓库的常规做法，不能误伤）。
//
// 输出契约与 fail-open 策略同 huge-output-guard.js：任何异常一律放行，绝不因为守卫自己出问题卡住会话；
// 但每次判定都落台账，"守卫有没有真的在拦"可核对。
'use strict';
require('./hook-crash-guard.js').install('commit-scope-guard'); // 崩溃可见化：仍 fail-open，但写进 hooks-crash.log 供周检
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const STATE_DIR = process.env.COMMIT_SCOPE_GUARD_STATE_DIR || path.join(CLIENT_ROOT, 'tmp', 'commit-scope-guard');
const LEDGER = path.join(STATE_DIR, 'decisions.log');

function log(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    // 台账写不进去不影响判定
  }
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

// 字段名两种都认：认错字段的后果是"守卫永远放行"这种最坏的假绿。
function toolName(payload) {
  return payload.tool_name ?? payload.tool ?? payload.name ?? '';
}

function toolInput(payload) {
  return payload.tool_input ?? payload.input ?? {};
}

// `git commit … -- 路径1 路径2`：取 `--` 之后的部分当 pathspec。
// 只认"命令里确实出现了独立的 --"，否则整条命令都没有 pathspec。
function pathspecsOf(command) {
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || [];
  const dash = tokens.indexOf('--');
  if (dash < 0) return [];
  return tokens.slice(dash + 1)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => !t.startsWith('-'));
}

// git 的全局选项可以出现在 `git` 与子命令之间（`git -C <path> commit …`）。
// 旧实现只看紧邻 token，`-C` 一插入就整条放行 —— 该守卫存在的唯一理由随之失效。
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path']);
const GIT_GLOBAL_FLAG = /^--?(?:no-pager|paginate|bare|no-replace-objects|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs|no-optional-locks)$/;
function gitSubcommandIndex(tokens) {
  const i = tokens.findIndex((t) => t === 'git' || /(^|[\\/])git(?:\.exe)?$/i.test(t));
  if (i < 0) return -1;
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (GIT_GLOBAL_WITH_VALUE.has(t)) { j += 2; continue; }
    if (/^--(?:git-dir|work-tree|namespace|super-prefix|exec-path)=/.test(t)) { j += 1; continue; }
    if (GIT_GLOBAL_FLAG.test(t)) { j += 1; continue; }
    break;
  }
  return j < tokens.length ? j : -1;
}
function isGitCommit(tokens) {
  const j = gitSubcommandIndex(tokens);
  return j >= 0 && tokens[j] === 'commit';
}
// `-C <path>` 改变 git 的工作目录；脏文件必须按它查，否则查错仓库等于放行。
function gitCOption(tokens) {
  const i = tokens.findIndex((t) => t === 'git' || /(^|[\\/])git(?:\.exe)?$/i.test(t));
  if (i < 0) return null;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '-C') return tokens[j + 1] ? tokens[j + 1].replace(/^["']|["']$/g, '') : null;
    if (GIT_GLOBAL_WITH_VALUE.has(t)) { j++; continue; }
    if (/^--(?:git-dir|work-tree|namespace|super-prefix|exec-path)=/.test(t) || GIT_GLOBAL_FLAG.test(t)) continue;
    break;
  }
  return null;
}

// git 默认 `core.quotepath=true`，`diff --name-only` 会把非 ASCII 路径打成八进制转义并带引号
// （`"\345\217\260\350\264\246.md"`），而命令里写的可能是原文，也可能已经是转义形式。
// 不还原就会**漏判**：转义名与原名比不相等 ⇒ 守卫看着像"没有脏文件"，直接放行。
function unquoteGitPath(p) {
  const s = String(p).replace(/^"|"$/g, '');
  if (!/\\[0-7]{3}/.test(s)) return s;
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && /[0-7]{3}/.test(s.slice(i + 1, i + 4))) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(s.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function baseOf(p) {
  return path.basename(unquoteGitPath(p));
}

function unstagedPaths(cwd) {
  const out = execFileSync('git', ['diff', '--name-only'], {
    cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024,
    // git 在这个仓库会往 stderr 打 CRLF 警告；守卫是每轮都跑的，不能靠"往上下文里灌噪音"工作
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
  log(`DENY ${reason.slice(0, 160)}`);
}

function main() {
  const payload = readStdin();
  if (String(toolName(payload)).toLowerCase() !== 'bash') return;
  const input = toolInput(payload);
  const command = String(input.command ?? '');
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || [];
  if (!isGitCommit(tokens)) return;
  const pathspecs = pathspecsOf(command);
  if (pathspecs.length === 0) return;

  const baseCwd = String(input.dir_path ?? input.cwd ?? process.cwd());
  const cOpt = gitCOption(tokens);
  const cwd = cOpt ? path.resolve(baseCwd, cOpt) : baseCwd;
  let dirty;
  try {
    dirty = unstagedPaths(cwd);
  } catch (e) {
    log(`ALLOW(git-failed) ${e.message}`);
    return;
  }
  if (dirty.length === 0) return;

  const dirtyBases = new Set(dirty.map(baseOf));
  const hits = pathspecs.filter((p) => dirtyBases.has(baseOf(p)));
  if (hits.length === 0) return;

  deny(`这条 \`git commit\` 用 pathspec 提交了「工作区里还有未提交改动」的文件：${hits.join('、')}。`
    + ' 带 `-- 路径` 的提交取的是**工作区内容**，会绕过你刚用 `git update-index --cacheinfo` 暂存好的 partial blob，'
    + '于是并行会话（或你自己另一格）的在途改动被扫进这次提交 —— 2026-09-19 同一晚就踩了两次。'
    + ' 正确做法：① `git hash-object -w <只含我改动的副本>` 造 blob；'
    + '② `git update-index --cacheinfo 100644,<sha>,<路径>`；'
    + '③ `git diff --cached --name-only` 确认索引里只有我的路径；'
    + '④ **`git commit` 不带 pathspec**。'
    + ' 落地后立刻 `git show --stat HEAD | tail -2`：只该有插入，出现删除就是删了别人的行。')
}

try {
  main();
} catch (e) {
  log(`ERROR(fail-open) ${e && e.message}`);
}
