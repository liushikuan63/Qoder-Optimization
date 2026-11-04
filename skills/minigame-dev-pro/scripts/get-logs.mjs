#!/usr/bin/env node
/**
 * get-logs.mjs — 获取小游戏运行日志
 *
 * 渐进增强策略：
 *  1. 有 miniprogram-automator → 实时日志采集（监听 console 事件）
 *  2. 无 automator → 从项目日志文件 + 微信开发者工具日志目录读取
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkAvailable } from './lib/devtool-cli.mjs';
import { checkAvailable as checkAutomator, launch, collectLogs, close } from './lib/automator.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `获取小游戏运行日志
用法:
  node get-logs.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --lines <数量>      文件日志最多返回行数（默认 100）
  --filter <关键词>   只返回包含关键词的行
  --duration <ms>     实时日志采集时长（默认 5000，仅 automator 模式）
  --cli <路径>        微信开发者工具 cli 路径
  --json              以 JSON 格式输出
  --help              显示帮助

日志来源（按优先级）：
  1. miniprogram-automator 实时日志（最准确，需安装）
  2. 项目目录下的 .log 文件
  3. 微信开发者工具的日志目录
`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node get-logs.mjs --project <项目路径>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  const maxLines = parseInt(args.lines || '100', 10);
  const filter = args.filter || null;
  const durationMs = parseInt(args.duration || '5000', 10);

  const autoCheck = await checkAutomator();
  const cliCheck = checkAvailable(args.cli || null);

  // 优先尝试 automator 实时日志
  if (autoCheck.available && cliCheck.found) {
    const launchResult = await launch({
      cliPath: args.cli,
      projectPath,
      timeoutMs: 30000,
    });

    if (launchResult.ok) {
      const logResult = await collectLogs(launchResult.automator, { durationMs, filter });
      await close(launchResult.automator);

      if (logResult.ok) {
        outputSuccess({
          action: 'get_logs',
          project: projectPath,
          source: 'automator-realtime',
          method: 'miniprogram-automator',
          realtime: true,
          durationMs,
          totalFound: logResult.logs.length,
          truncated: false,
          lines: logResult.logs.slice(-maxLines).map((l) => `[${l.type}] ${l.text}`),
          devtoolAvailable: true,
        }, args.json);
        return;
      }
      // automator 日志采集失败，降级到文件日志
    }
    // automator 连接失败，降级到文件日志
  }

  // 降级：文件日志
  const logs = collectFileLogs(projectPath, maxLines, filter);

  outputSuccess({
    action: 'get_logs',
    project: projectPath,
    source: logs.source,
    method: 'file-scan',
    realtime: false,
    lines: logs.lines,
    totalFound: logs.total,
    truncated: logs.total > logs.lines.length,
    devtoolAvailable: cliCheck.found,
    automatorAvailable: autoCheck.available,
    automatorHint: autoCheck.available ? null : autoCheck.error,
  }, args.json);
}

function collectFileLogs(projectPath, maxLines, filter) {
  const allLines = [];
  let source = 'none';

  const projectLogs = scanLogFiles(projectPath);
  if (projectLogs.length > 0) {
    source = 'project-log-files';
    for (const logFile of projectLogs.slice(0, 3)) {
      try {
        const content = readFileSync(logFile, 'utf-8');
        const fileLines = content.split('\n').filter(Boolean);
        allLines.push(...fileLines.map((l) => ({ text: l, file: logFile })));
      } catch (_) { /* ignore */ }
    }
  }

  if (allLines.length === 0) {
    const devtoolLogs = scanDevtoolLogs();
    if (devtoolLogs.length > 0) {
      source = 'devtool-log-dir';
      for (const logFile of devtoolLogs.slice(0, 3)) {
        try {
          const content = readFileSync(logFile, 'utf-8');
          const fileLines = content.split('\n').filter(Boolean);
          allLines.push(...fileLines.map((l) => ({ text: l, file: logFile })));
        } catch (_) { /* ignore */ }
      }
    }
  }

  if (allLines.length === 0) source = 'none';

  let filtered = allLines;
  if (filter) {
    filtered = allLines.filter((l) => l.text.includes(filter));
  }

  const total = filtered.length;
  const lines = filtered.slice(-maxLines).map((l) => l.text);

  return { lines, total, source };
}

function scanLogFiles(dir) {
  const results = [];
  function walk(d) {
    try {
      for (const entry of readdirSync(d)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.log')) {
          results.push(full);
        }
      }
    } catch (_) { /* ignore */ }
  }
  walk(dir);
  return results.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function scanDevtoolLogs() {
  const devtoolLogDirs = [
    join(homedir(), 'AppData', 'Local', '微信开发者工具', 'User Data', 'Default'),
    join(homedir(), 'AppData', 'Local', 'wechat-devtools', 'User Data', 'Default'),
    join(homedir(), 'Library', 'Application Support', '微信开发者工具', 'Default'),
    join(homedir(), 'Library', 'Application Support', 'wechat-devtools', 'Default'),
  ];
  for (const d of devtoolLogDirs) {
    if (existsSync(d)) return scanLogFiles(d);
  }
  return [];
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

