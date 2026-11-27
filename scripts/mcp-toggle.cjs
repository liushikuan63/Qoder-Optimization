#!/usr/bin/env node
// MCP server 开关：默认只读列表，--apply 才写 settings.json。
// 用法：node mcp-toggle.cjs [--list] [--enable <name> | --disable <name>] [--apply]
//                           [--config-dir <dir> | --both] [--json]
// 退出码：0 成功 / 1 运行错误 / 2 用法错误。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { clientRoot, counterpart } = require('./client-root.js');

const USAGE = '用法：node mcp-toggle.cjs [--list] [--enable <name> | --disable <name>] [--apply] [--config-dir <dir> | --both] [--json]';
const HINT = '改后需 /mcp reload 或新会话/重启生效；本脚本不能卸载当前会话已加载的工具。';

function usageError(message) {
  const error = new Error(message || USAGE);
  error.exitCode = 2;
  return error;
}

function parseArgs(argv) {
  const options = { action: 'list', name: null, apply: false, configDir: null, both: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') options.action = 'list';
    else if (arg === '--enable' || arg === '--disable') {
      options.action = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw usageError(`${arg} 需要 server 名称`);
      options.name = value;
      i += 1;
    } else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--both') options.both = true;
    else if (arg === '--config-dir') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw usageError('--config-dir 需要目录路径');
      options.configDir = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw usageError(`未知参数：${arg}`);
  }
  if (options.configDir && options.both) throw usageError('--config-dir 与 --both 不能同时使用');
  return options;
}

function targetRoots(options) {
  if (options.configDir) return [path.resolve(options.configDir)];
  const root = clientRoot();
  if (!options.both) return [root];
  const other = counterpart(root);
  return other ? [root, other] : [root];
}

function readSide(root) {
  const file = path.join(root, 'settings.json');
  if (!fs.existsSync(file)) return { root, file, missing: true, raw: '', data: null, servers: {} };
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`settings.json 解析失败（${file}）：${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`settings.json 顶层不是对象：${file}`);
  const servers = data.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error(`mcpServers 不是对象：${file}`);
  }
  return { root, file, missing: false, raw, data, servers: servers || {} };
}

function summarize(name, server) {
  return {
    name,
    type: server && server.type ? String(server.type) : (server && server.url ? 'http' : 'stdio'),
    disabled: Boolean(server && server.disabled),
    includeTools: Array.isArray(server && server.includeTools) ? server.includeTools : [],
    excludeTools: Array.isArray(server && server.excludeTools) ? server.excludeTools : [],
  };
}

function withDisabled(server, disabled) {
  const copy = { ...server };
  if (disabled) copy.disabled = true;
  else delete copy.disabled;
  return copy;
}

function ensureBackup(file) {
  const tool = path.join(__dirname, 'backup-file.js');
  if (!fs.existsSync(tool)) throw new Error(`缺少备份脚本：${tool}`);
  const result = spawnSync(process.execPath, [tool, file, '--label', 'mcp-toggle'], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`备份失败（退出 ${result.status}）：${(result.stderr || result.stdout || '').trim()}`);
}

function writeSide(side) {
  const eol = side.raw.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(side.data, null, 2).replace(/\n/g, eol) + eol;
  fs.writeFileSync(side.file, text);
}

function listSides(options) {
  const sides = targetRoots(options).map(readSide);
  if (options.json) {
    console.log(JSON.stringify({
      action: 'list',
      hint: HINT,
      sides: sides.map((side) => ({
        root: side.root,
        settings: side.file,
        missing: side.missing,
        servers: Object.entries(side.servers).map(([name, server]) => summarize(name, server)),
      })),
    }, null, 2));
    return 0;
  }
  for (const side of sides) {
    console.log(`[settings] ${side.file}${side.missing ? '（不存在）' : ''}`);
    const rows = Object.entries(side.servers).map(([name, server]) => summarize(name, server));
    if (!rows.length && !side.missing) console.log('  （未配置 mcpServers）');
    for (const row of rows) {
      const filters = [];
      if (row.includeTools.length) filters.push('include=' + row.includeTools.join(','));
      if (row.excludeTools.length) filters.push('exclude=' + row.excludeTools.join(','));
      console.log(`  ${row.name}\t${row.type}\t${row.disabled ? 'disabled' : 'enabled'}${filters.length ? '\t' + filters.join(' ') : ''}`);
    }
  }
  console.log(HINT);
  return 0;
}

function toggleSides(options) {
  const sides = targetRoots(options).map(readSide);
  const changes = [];
  for (const side of sides) {
    if (side.missing) throw new Error(`settings.json 不存在：${side.file}`);
    if (!Object.prototype.hasOwnProperty.call(side.servers, options.name)) {
      throw new Error(`server 不存在：${options.name}（${side.file}）`);
    }
    const current = side.servers[options.name];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`server 配置不是对象：${options.name}（${side.file}）`);
    }
    const next = withDisabled(current, options.action === 'disable');
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    const entry = {
      side,
      root: side.root,
      settings: side.file,
      before: summarize(options.name, current),
      after: summarize(options.name, next),
      changed,
    };
    if (changed) side.servers[options.name] = next;
    changes.push(entry);
  }
  return changes;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.action === 'list') return listSides(options);

  const changes = toggleSides(options);
  const changed = changes.filter((entry) => entry.changed);
  if (options.apply) {
    for (const entry of changed) {
      ensureBackup(entry.side.file);
      writeSide(entry.side);
    }
    for (const entry of changed) {
      const verify = readSide(entry.side.root);
      const actual = summarize(options.name, verify.servers[options.name]);
      if (actual.disabled !== entry.after.disabled) {
        throw new Error(`写入后校验失败：${options.name}（${entry.side.file}）`);
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      action: options.action,
      name: options.name,
      apply: options.apply,
      hint: HINT,
      sides: changes.map((entry) => ({
        root: entry.root,
        settings: entry.settings,
        changed: entry.changed,
        applied: options.apply && entry.changed,
        before: entry.before,
        after: entry.after,
      })),
    }, null, 2));
    return 0;
  }

  for (const entry of changes) {
    const label = !entry.changed ? '[无需修改]' : options.apply ? '[已写入]' : '[预览]';
    const tail = entry.changed && !options.apply ? '（未写入，加 --apply 生效）' : '';
    console.log(`${label} ${entry.settings}：${options.name} ${entry.before.disabled ? 'disabled' : 'enabled'} -> ${entry.after.disabled ? 'disabled' : 'enabled'}${tail}`);
  }
  if (options.apply && changed.length) console.log('备份已生成在同目录 settings.json.bak.*。');
  console.log(HINT);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = error.exitCode || 1;
}
