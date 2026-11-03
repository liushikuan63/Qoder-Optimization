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
  --yes             不询问，直接启用（含新会话自动绑定）
  --no              不询问，跳过
  --no-auto-bind    只安装并接线，不开启新会话自动绑定（保留按会话手工 enable）
  --dry-run         只显示计划，不写盘
  --client-root <目录>  指定客户端配置目录（默认按 client-root.js 解析）
  --help            显示本说明

本机支持（Node 24.16+ 且带 node:sqlite + FTS5 trigram）时写 auto-bind.json，新会话首个提示自动绑定；
显式 disable 过的会话不会被重开；不支持时保持原有按会话手工 enable 方式。`);
}

function parseArgs(argv) {
  const options = { mode: 'prompt' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '--enable') options.mode = 'enable';
    else if (arg === '--no' || arg === '--skip' || arg === '--non-interactive') options.mode = 'skip';
    else if (arg === '--no-auto-bind') options.autoBind = false;
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

function planFor(client, nodePath, store) {
  const target = path.join(client, 'scripts', SCRIPT_NAME);
  const settings = path.join(client, 'settings.json');
  const command = '"' + nodePath + '" "' + target + '" hook';
  const hooks = EVENTS.map(({ event, matcher }) => ({
    event,
    matcher,
    group: { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10 }] },
  }));
  return { client, target, settings, store, command, hooks };
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

function applyAutoBindPolicy(plan, options) {
  const file = path.join(plan.store, 'auto-bind.json');
  if (options.autoBind === false) return { state: 'skipped', file };
  let current = null;
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = null; }
    if (current && current.enabled === false) return { state: 'preserved-disabled', file };
    if (current && current.schema === 1 && current.enabled === true) return { state: 'unchanged', file };
  }
  if (options.dryRun) return { state: current ? 'update' : 'create', file };
  try {
    if (current) backup(file);
    writeFile(file, JSON.stringify({ schema: 1, enabled: true }, null, 2) + '\n');
    return { state: current ? 'update' : 'create', file };
  } catch (error) {
    return { state: 'failed', file, error: error.message };
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
  const result = { scriptState, settingsState: settingsChanged ? (settingsText === null ? 'create' : 'update') : 'unchanged', added, updated, existing, autoBind: null, backups: [], wrote: false };
  if (options.dryRun) {
    result.autoBind = applyAutoBindPolicy(plan, options);
    return result;
  }
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
  result.autoBind = applyAutoBindPolicy(plan, options);
  result.wrote = true;
  return result;
}

function printPlan(plan, options) {
  console.log('客户端目录：' + plan.client);
  console.log('Node.js：' + process.version + '（' + process.execPath + '）');
  console.log('脚本落点：' + plan.target);
  console.log('hooks 落点：' + plan.settings);
  console.log('接续存储：' + plan.store);
  console.log('自动绑定：' + (options.autoBind === false ? '不开启（--no-auto-bind）' : '开启（写 auto-bind.json，新会话首个提示自动绑定）'));
  console.log('接线事件：' + plan.hooks.map(hook => hook.event).join(' / '));
  if (options.dryRun) console.log('（dry-run：只显示计划，不写盘）');
}

function printResult(plan, result) {
  const labels = { create: '新建', update: '更新', upgrade: '更新', unchanged: '已是最新' };
  console.log('脚本：' + labels[result.scriptState] + ' ' + plan.target);
  console.log('hooks：' + labels[result.settingsState] + (result.added.length ? '，新增 ' + result.added.join(' / ') : '') + (result.updated.length ? '，更新 ' + result.updated.join(' / ') : ''));
  if (result.existing.length) console.log('完整接线已匹配（未改动）：' + result.existing.join(' / '));
  const policy = result.autoBind || {};
  const policyLabels = {
    create: '已开启（新会话首个提示自动绑定）',
    update: '原策略无效，已重写并开启',
    unchanged: '已开启（保持不变）',
    'preserved-disabled': '保留此前的显式关闭（不重开）',
    skipped: '未开启（--no-auto-bind）',
    failed: '写入失败，已降级为按会话手工 enable' + (policy.error ? '：' + policy.error : ''),
  };
  console.log('自动绑定：' + (policyLabels[policy.state] || '未变更') + (policy.file ? '（' + policy.file + '）' : ''));
  for (const file of result.backups) console.log('备份：' + file);
  if (!result.wrote) return;
  const auto = ['create', 'update', 'unchanged'].includes(policy.state);
  console.log('\n下一步：');
  if (auto) {
    console.log('  新会话：首个提示自动绑定并采集，任务ID形如 AUTO-<日期>-<目录名>');
    console.log('  单会话关闭：node "' + plan.target + '" disable --cwd "<工作目录>" --session <真实会话ID>（关闭后不会被自动重开）');
    console.log('  全局关闭：把 ' + path.join(plan.store, 'auto-bind.json') + ' 的 enabled 改为 false 或删除该文件');
  } else {
    console.log('  按会话开启：node "' + plan.target + '" enable --cwd "<工作目录>" --session <真实会话ID> --task <任务ID>');
    console.log('  任务结束：node "' + plan.target + '" disable --cwd "<工作目录>" --session <真实会话ID>');
  }
  console.log('\n采集边界不变：只存用户正文与 决策：/已否证：/验证结论：/证据引用：/授权边界： 前缀的助手段落；本地脱敏存储、不读 Qoder 内部数据库、不上传。');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return 0; }
  const support = sqliteSupport();
  if (!support.ok) {
    console.error('当前 Node ' + process.version + ' 不支持 node:sqlite + FTS5 trigram，无法启用 SQLite 接续记忆与追回（需要 Node.js 24.16+）。');
    const nodeInstaller = path.join(__dirname, 'install-node.ps1');
    const canOfferInstall = options.mode === 'prompt' && !options.dryRun && process.platform === 'win32' && fs.existsSync(nodeInstaller) && process.stdin.isTTY && process.stdout.isTTY;
    if (canOfferInstall) {
      const choice = await choose('当前 Node 缺少接续记忆所需的 node:sqlite + FTS5，如何处理？', [
        '安装 Node.js LTS（运行 scripts\\install-node.ps1）',
        '保持原有方式（先不启用接续）',
      ]);
      if (choice.index === 0) {
        const shell = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'pwsh', 'powershell'].find(exe => exe.includes('\\') ? fs.existsSync(exe) : true);
        const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nodeInstaller], { stdio: 'inherit' });
        if (run.error) console.error('无法启动 PowerShell：' + run.error.message);
        else console.error('Node.js 安装流程结束（退出码 ' + (run.status === null ? 'unknown' : run.status) + '）。安装成功后请重新运行本安装器。');
        return 3;
      }
    }
    console.error('保持原有方式：本机先不启用接续记忆。Windows 可运行 scripts\\install-node.ps1 安装 Node.js 后重试。');
    return 3;
  }
  const { defaultStore } = require('./continuity.cjs');
  const plan = planFor(path.resolve(options.clientRoot || clientRoot()), process.execPath, defaultStore());
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
