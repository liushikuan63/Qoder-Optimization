#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { clientRoot } = require('./client-root.js');

const SCRIPT_NAME = 'continuity.cjs';
const EVENTS = [
  { event: 'PreCompact' },
  { event: 'PostCompact' },
  { event: 'UserPromptSubmit' },
  { event: 'SessionStart', matcher: 'compact|resume' },
  { event: 'PostToolUse', matcher: '^(Write|Edit|Bash)$' },
];

function usage() {
  console.log(`用法：node scripts/install-continuity.cjs [选项]

  （无参数）        交互询问是否启用 SQLite 接续记忆与追回
  --yes             不询问，直接启用
  --no              不询问，跳过
  --dry-run         只显示计划，不写盘
  --client-root <目录>  指定客户端配置目录（默认按 client-root.js 解析）
  --help            显示本说明

只安装脚本并接线 hooks；采集仍需在目标会话中显式 enable。`);
}

function parseArgs(argv) {
  const options = { mode: 'prompt' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '--enable') options.mode = 'enable';
    else if (arg === '--no' || arg === '--skip' || arg === '--non-interactive') options.mode = 'skip';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--client-root') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--client-root 缺少路径');
      options.clientRoot = argv[++i];
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('未知参数：' + arg);
  }
  return options;
}

function sqliteSupport() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { db.exec("CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')"); } finally { db.close(); }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function choose(title, labels) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve({ index: labels.length - 1, interactive: false });
  return new Promise(resolve => {
    let index = 0;
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    const render = () => {
      process.stdout.write('\x1b[2J\x1b[H' + title + '\n\n' + labels.map((label, i) => i === index ? '  \x1b[36m> ' + label + '\x1b[0m' : '    ' + label).join('\n') + '\n\n↑/↓ 选择，Enter 确认，Esc 跳过\n');
    };
    const done = value => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve({ index: value, interactive: true });
    };
    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') done(labels.length - 1);
      else if (key.name === 'up') { index = (index - 1 + labels.length) % labels.length; render(); }
      else if (key.name === 'down') { index = (index + 1) % labels.length; render(); }
      else if (key.name === 'return' || key.name === 'enter') done(index);
      else if (key.name === 'escape') done(labels.length - 1);
    };
    stdin.on('keypress', onKey);
    render();
  });
}

function planFor(client, nodePath) {
  const target = path.join(client, 'scripts', SCRIPT_NAME);
  const settings = path.join(client, 'settings.json');
  const command = '"' + nodePath + '" "' + target + '" hook';
  const hooks = EVENTS.map(({ event, matcher }) => ({
    event,
    matcher,
    group: { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10 }] },
  }));
  return { client, target, settings, command, hooks };
}

function mergeHooks(settings, hooks, target) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(settings)) throw new Error('settings.json 顶层必须是对象');
  if (settings.hooks === undefined) settings.hooks = {};
  if (!object(settings.hooks)) throw new Error('settings.hooks 必须是对象');
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !object(hook)))) {
      throw new Error('settings.hooks.' + event + ' 接线结构无效，未做任何修改');
    }
  }
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const added = [];
  const updated = [];
  const existing = [];
  for (const { event, group } of hooks) {
    const groups = settings.hooks[event] || [];
    const found = groups.flatMap(item => item.hooks.filter(hook => String(hook.command || '').includes('continuity.cjs')).map(hook => ({ item, hook })));
    if (!found.length) {
      settings.hooks[event] = [...groups, group];
      added.push(event);
      continue;
    }
    const { item, hook } = found[0];
    const command = String(hook.command || '').match(/^\s*(?:"([^"\r\n]+)"|([^\s"'`|&;<>$()]+))\s+(?:"([^"\r\n]+)"|([^\s"'`|&;<>$()]+))\s+hook\s*$/);
    if (found.length !== 1 || !command || normalize(command[3] || command[4]) !== normalize(target)
        || item.matcher !== group.matcher || hook.type !== 'command' || hook.timeout !== 10) {
      throw new Error('settings.hooks.' + event + ' 已有 continuity 接线与完整命令/matcher/type/timeout 不匹配，未做任何修改');
    }
    if (hook.command === group.hooks[0].command) existing.push(event);
    else {
      hook.command = group.hooks[0].command;
      updated.push(event);
    }
  }
  return { added, updated, existing };
}

function backup(file) {
  const helper = path.join(__dirname, 'backup-file.js');
  if (!fs.existsSync(helper)) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const target = file + '.bak.' + stamp;
    fs.copyFileSync(file, target);
    return target;
  }
  const result = spawnSync(process.execPath, [helper, file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('备份失败：' + (result.stderr || result.stdout || '未知错误').trim());
  const match = String(result.stdout).match(/\[备份\]\s+(.+)/);
  return match ? match[1].trim() : file + '.bak.*';
}

function writeFile(file, data, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    if (exclusive) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
    return fs.lstatSync(file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function install(plan, options) {
  const source = path.join(__dirname, 'continuity.cjs');
  if (!fs.existsSync(source)) throw new Error('缺少随包脚本：' + source + '（请从解压包目录运行本安装器）');
  const sourceBytes = fs.readFileSync(source);
  for (const file of [plan.target, plan.settings]) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装目标必须是普通文件：' + file);
  }
  const priorBytes = fs.existsSync(plan.target) ? fs.readFileSync(plan.target) : null;
  const scriptState = priorBytes === null ? 'create' : priorBytes.equals(sourceBytes) ? 'unchanged' : 'upgrade';
  let settingsText = null;
  let settings = {};
  if (fs.existsSync(plan.settings)) {
    settingsText = fs.readFileSync(plan.settings, 'utf8');
    try { settings = JSON.parse(settingsText); }
    catch (error) { throw new Error('settings.json 不是有效 JSON，未做任何修改：' + error.message); }
  }
  const { added, updated, existing } = mergeHooks(settings, plan.hooks, plan.target);
  const settingsChanged = added.length > 0 || updated.length > 0;
  const result = { scriptState, settingsState: settingsChanged ? (settingsText === null ? 'create' : 'update') : 'unchanged', added, updated, existing, backups: [], wrote: false };
  if (options.dryRun) return result;
  if (scriptState === 'upgrade') result.backups.push(backup(plan.target));
  if (settingsChanged && settingsText !== null) result.backups.push(backup(plan.settings));
  let owned;
  try {
    if (scriptState !== 'unchanged') owned = writeFile(plan.target, sourceBytes);
    if (settingsChanged) writeFile(plan.settings, JSON.stringify(settings, null, 2) + '\n');
  } catch (error) {
    if (owned) {
      const moved = plan.target + '.rollback-' + process.pid + '-' + Date.now();
      try {
        // Verify the file actually moved, then restore by exclusive creation rather than overwriting a recreated path.
        fs.renameSync(plan.target, moved);
        const stat = fs.lstatSync(moved);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== owned.ino || stat.dev !== owned.dev || !fs.readFileSync(moved).equals(sourceBytes)) {
          fs.linkSync(moved, plan.target);
          throw new Error('脚本存在并发变更，保留目标与恢复资料：' + moved);
        }
        if (priorBytes !== null) writeFile(plan.target, priorBytes, true);
        fs.unlinkSync(moved);
      } catch (rollbackError) { error.message += '；回滚未完成：' + rollbackError.message + '；恢复路径：' + moved; }
    }
    throw error;
  }
  result.wrote = true;
  return result;
}

function printPlan(plan, options) {
  console.log('客户端目录：' + plan.client);
  console.log('Node.js：' + process.version + '（' + process.execPath + '）');
  console.log('脚本落点：' + plan.target);
  console.log('hooks 落点：' + plan.settings);
  console.log('接线事件：' + plan.hooks.map(hook => hook.event).join(' / '));
  if (options.dryRun) console.log('（dry-run：只显示计划，不写盘）');
}

function printResult(plan, result) {
  const labels = { create: '新建', update: '更新', upgrade: '更新', unchanged: '已是最新' };
  console.log('脚本：' + labels[result.scriptState] + ' ' + plan.target);
  console.log('hooks：' + labels[result.settingsState] + (result.added.length ? '，新增 ' + result.added.join(' / ') : '') + (result.updated.length ? '，更新 ' + result.updated.join(' / ') : ''));
  if (result.existing.length) console.log('完整接线已匹配（未改动）：' + result.existing.join(' / '));
  for (const file of result.backups) console.log('备份：' + file);
  if (!result.wrote) return;
  console.log('\n下一步（按会话开启采集）：');
  console.log('  node "' + plan.target + '" enable --cwd "<工作目录>" --session <真实会话ID> --task <任务ID>');
  console.log('  任务结束：node "' + plan.target + '" disable --cwd "<工作目录>" --session <真实会话ID>');
  console.log('\n安装只代表“可用”，不会自动采集；只在 enable 的会话里保存用户正文与指定助手段落，不读 Qoder 内部数据库、不上传。');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return 0; }
  const support = sqliteSupport();
  if (!support.ok) {
    console.error('当前 Node ' + process.version + ' 不支持 node:sqlite + FTS5 trigram，无法启用 SQLite 接续记忆与追回。');
    console.error('需要 Node.js 24.16+；Windows 可运行 scripts\\install-node.ps1，或升级 Node 后重试。');
    return 3;
  }
  const plan = planFor(path.resolve(options.clientRoot || clientRoot()), process.execPath);
  console.log('Qoder-Optimization：SQLite 接续记忆与追回\n');
  printPlan(plan, options);
  let mode = options.mode;
  if (mode === 'prompt') {
    if (options.dryRun) mode = 'enable';
    else {
      const choice = await choose('检测到可用的 Node.js。是否启用 SQLite 接续记忆与追回模式？', ['启用（安装脚本并接线 hooks）', '暂不启用（跳过）']);
      if (!choice.interactive) console.log('\n非交互环境：默认跳过；如需启用请加 --yes。');
      mode = choice.index === 0 ? 'enable' : 'skip';
    }
  }
  if (mode === 'skip') { console.log('已跳过，未修改任何文件。'); return 0; }
  const result = install(plan, options);
  printResult(plan, result);
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error('CONTINUITY_INSTALL_ERROR: ' + error.message);
  process.exitCode = 1;
});
