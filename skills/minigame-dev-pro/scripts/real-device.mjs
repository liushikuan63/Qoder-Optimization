#!/usr/bin/env node
/**
 * real-device.mjs — 真机预览
 * 用法：
 *   node real-device.mjs --project <项目路径> [--qr-format terminal|image] [--json]
 *
 * 能力：
 *  - 调用微信开发者工具 CLI 生成真机预览二维码
 *  - 支持终端 ASCII 二维码或图片二维码
 *  - 输出二维码路径供用户扫码
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { autoPreview, checkAvailable } from './lib/devtool-cli.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `真机预览

用法:
  node real-device.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --qr-format <格式>  二维码格式：terminal | image（默认terminal）
  --cli <路径>        微信开发者工具 cli 路径
  --timeout <ms>      超时毫秒数（默认 120000）
  --json              以 JSON 格式输出
  --help              显示帮助

说明:
  真机预览会生成二维码，用手机微信扫码即可在真机上运行游戏。
  terminal 格式直接在终端输出 ASCII 二维码；
  image 格式生成二维码图片文件。`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node real-device.mjs --project <项目路径>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  const check = checkAvailable(args.cli || null);
  if (!check.found) {
    outputError(check.error, {
      hint: '1. 确认微信开发者工具已安装\n2. 或用 --cli 指定 cli 路径',
    }, args.json);
  }

  // 真机预览使用 preview 命令生成二维码（image 格式需指定保存路径）
  const qrFormat = args['qr-format'] || 'terminal';
  const result = await autoPreview(projectPath, {
    cliPath: args.cli,
    qrFormat,
    qrOutput: qrFormat === 'image' ? join(process.cwd(), 'preview-qrcode.jpg') : null,
    timeoutMs: parseInt(args.timeout || '120000', 10),
  });

  if (result.ok) {
    outputSuccess({
      action: 'real_device_preview',
      project: projectPath,
      qrPath: result.qrPath,
      qrFormat,
      message: '真机预览二维码已生成，用手机微信扫码即可在真机运行',
      warning: '二维码有效期约 25 分钟，过期需重新生成',
    }, args.json);
  } else {
    outputError(result.error || '真机预览失败', {
      action: 'real_device_preview',
      project: projectPath,
      stderr: result.stderr?.slice(0, 1000),
    }, args.json);
  }
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

