#!/usr/bin/env node
/**
 * screenshot.mjs — 小游戏截图
 * 渐进增强策略：
 *  1. 有 miniprogram-automator → 真截图（保存 PNG）
 *  2. 无 automator 但有微信 CLI → 启动自动化端口引导手动截图
 *  3. 无任何工具 → 提示安装
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { checkAvailable, startAuto } from './lib/devtool-cli.mjs';
import { checkAvailable as checkAutomator, launch, screenshot, close } from './lib/automator.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `小游戏截图
用法:
  node screenshot.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --output <路径>     截图保存路径（默认 ./screenshot.png）
  --cli <路径>        微信开发者工具 cli 路径
  --auto-port <端口>  自动化端口（默认 9420）
  --timeout <ms>      连接超时（默认30000）
  --json              以 JSON 格式输出
  --help              显示帮助

截图模式（自动选择）
  真截图模式：已安装miniprogram-automator，自动连接并截图
  引导模式：未安装 automator，启动自动化端口引导手动截图
`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node screenshot.mjs --project <项目路径>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  const outputPath = args.output || join(process.cwd(), 'screenshot.png');
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  // 检查模拟器CLI
  const cliCheck = checkAvailable(args.cli || null);
  if (!cliCheck.found) {
    // 降级到纯知识模式（层级），不报错，返回手动截图指引
    outputSuccess({
      action: 'screenshot',
      project: projectPath,
      output: outputPath,
      method: 'manual',
      status: 'degraded',
      reason: '微信开发者工具未安装',
      hint: '自动截图不可用，需手动截图',
      installHint: '安装微信开发者工具后可启用自动截图',
      manualSteps: [
        '1. 安装微信开发者工具',
        '2. 打开项目并运行预览',
        '3. 在模拟器中到达要截图的画面',
        '4. 右键模拟器 → 截图（或使用快捷键 Ctrl+Shift+S）',
      ],
    }, args.json);
  }

  // 检查 automator
  const autoCheck = await checkAutomator();

  if (autoCheck.available) {
    // 真截图模式
    const launchResult = await launch({
      cliPath: args.cli,
      projectPath,
      timeoutMs: parseInt(args.timeout || '30000', 10),
    });

    if (!launchResult.ok) {
      // automator 连接失败，降级到引导模式
      await fallbackToGuide(projectPath, outputPath, args, launchResult.error);
      return;
    }

    const shotResult = await screenshot(launchResult.automator, outputPath);
    await close(launchResult.automator);

    if (shotResult.ok) {
      outputSuccess({
        action: 'screenshot',
        project: projectPath,
        output: shotResult.path,
        method: shotResult.method,
        status: 'success',
        message: `截图已保存到 ${shotResult.path}`,
      }, args.json);
    } else {
      // 截图失败，降级到引导模式
      await fallbackToGuide(projectPath, outputPath, args, shotResult.error);
    }
  } else {
    // 引导模式（无 automator）
    await fallbackToGuide(projectPath, outputPath, args, autoCheck.error);
  }
}

async function fallbackToGuide(projectPath, outputPath, args, reason) {
  // 启动自动化端口作为降级方案
  const rawPort = parseInt(args['auto-port'] || '9420', 10);
  const autoPort = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 9420;
  const autoResult = await startAuto(projectPath, autoPort, {
    cliPath: args.cli,
    timeoutMs: 8000,
  });

  outputSuccess({
    action: 'screenshot',
    project: projectPath,
    output: outputPath,
    method: 'manual',
    status: 'degraded',
    reason: reason || 'miniprogram-automator 不可用',
    autoPort: autoResult.ok ? autoPort : null,
    autoPortStarted: autoResult.ok,
    hint: '自动截图不可用，需手动截图',
    installHint: '安装 miniprogram-automator 可启用自动截图：npm install miniprogram-automator',
    manualSteps: [
      '1. 打开微信开发者工具，确认已登录',
      '2. 确认自动预览已运行',
      '3. 在模拟器中到达要截图的画面',
      '4. 右键模拟器→截图（或使用快捷键Ctrl+Shift+S）',
    ],
  }, args.json);
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

