#!/usr/bin/env node
/**
 * run-game.mjs — 运行小游戏预览
 * 用法：
 *   node run-game.mjs --project <项目路径> [--cli <cli路径>] [--qr-format terminal|image|base64] [--json] [--timeout 120000]
 *
 * 能力：
 *  - 调用微信开发者工具 CLI 的 auto-preview 命令
 *  - 生成预览二维码
 *  - 幂等：重复调用安全
 *  - 超时控制：默认 120 秒
 */

import { autoPreview, checkAvailable } from './lib/devtool-cli.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `运行小游戏预览
用法:
  node run-game.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --cli <路径>        微信开发者工具 cli 路径（可选，默认自动探测）
  --qr-format <格式>  二维码格式：terminal | image | base64（默认 terminal）
  --timeout <ms>      超时毫秒数（默认 120000）
  --json              以 JSON 格式输出结果
  --help              显示帮助

示例:
  node run-game.mjs --project ./my-game --json
  node run-game.mjs --project ./my-game --qr-format image
`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node run-game.mjs --project <项目路径>' }, args.json);
  }

  // 先检查CLI 是否可用
  const check = checkAvailable(args.cli || null);
  if (!check.found) {
    outputError(check.error, {
      hint: '1. 确认微信开发者工具已安装\n2. 或用 --cli 指定 cli 路径\n3. 或设置环境变量 WX_DEVTOOL_CLI',
    }, args.json);
  }

  const result = await autoPreview(projectPath, {
    cliPath: args.cli,
    qrFormat: args['qr-format'] || 'terminal',
    timeoutMs: parseInt(args.timeout || '120000', 10),
  });

  if (result.ok) {
    outputSuccess({
      action: 'run_game',
      project: projectPath,
      qrPath: result.qrPath,
      message: result.qrPath ? `预览二维码已生成: ${result.qrPath}` : '预览已启动（二维码见开发者工具）',
    }, args.json);
  } else {
    outputError(result.error || '预览失败', {
      action: 'run_game',
      project: projectPath,
      stdout: result.stdout?.slice(0, 1000),
      stderr: result.stderr?.slice(0, 1000),
    }, args.json);
  }
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

