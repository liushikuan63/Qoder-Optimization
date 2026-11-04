#!/usr/bin/env node
/**
 * publish.mjs — 上传发布小游戏（对应官方 publish）
 * 用法：
 *   node publish.mjs --project <项目路径> --version <版本号> [--desc <描述>] [--json]
 *
 * 能力：
 *  - 调用微信开发者工具 CLI 的 upload 命令上传代码
 *  - 支持指定版本号、描述
 *  - 上传后需在微信公众平台提交审核
 */

import { existsSync } from 'node:fs';
import { upload, checkAvailable } from './lib/devtool-cli.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `上传发布小游戏
用法:
  node publish.mjs --project <项目路径> --version <版本号> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --version <版本>    版本号，如1.0.0（必填）
  --confirm yes       显式确认上传（必填，上传不可逆，覆盖同版本号代码+消耗当日上传配额）
  --desc <描述>       版本描述（可选，默认空）
  --cli <路径>        微信开发者工具 cli 路径
  --timeout <ms>      超时毫秒数（默认 180000）
  --json              以 JSON 格式输出
  --help              显示帮助

上传后流程
  1. 上传成功后，代码进入微信公众平台的版本管理
  2. 在 mp.weixin.qq.com → 管理 → 版本管理 中找到刚上传的版本
  3. 点击"提交审核"，填写审核信息
  4. 等待微信团队审核（通常 2-7 天）
  5. 审核通过后，点击"发布"正式上线

注意:
  - 上传会覆盖同版本号的已有代码
  - 上传频次受平台当日配额限制（如遇限制，以开发者工具提示为准）
  - 上传前建议先跑 readiness-check.mjs 自检
`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node publish.mjs --project <项目路径> --version <版本号>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  const version = args.version;
  if (!version) {
    outputError('缺少必填参数 --version', { hint: '版本号格式如 1.0.0' }, args.json);
  }

  // 版本号格式校验（严格 semver：主.次.修[-预发布]，结尾必须闭合，防止注入）
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    outputError(`版本号格式不正确: ${version}`, { hint: '建议格式: 主版本次版本修订号，如1.0.0 或1.0.0-rc1' }, args.json);
  }

  // 上传是不可逆操作（覆盖同版本号代码、消耗当日上传配额），要求显式确认
  if (args.confirm !== 'yes') {
    outputError('上传是不可逆操作，需显式确认', {
      hint: '请加 --confirm yes 确认上传。上传会覆盖同版本号代码且消耗当日配额。建议上传前先跑 readiness-check + compliance-scan + package-analyzer。',
    }, args.json);
  }

  const check = checkAvailable(args.cli || null);
  if (!check.found) {
    outputError(check.error, {
      hint: '1. 确认微信开发者工具已安装并登录\n2. 或用 --cli 指定路径',
    }, args.json);
  }

  // 执行上传（机器人编号为第三方平台/CI 能力，普通账号 CLI 上传无需也不支持 --robot）
  const uploadResult = await upload(projectPath, {
    version,
    desc: args.desc || '',
    cliPath: args.cli,
    timeoutMs: parseInt(args.timeout || '180000', 10),
  });

  if (!uploadResult.ok) {
    outputError(`上传失败: ${uploadResult.error}`, {}, args.json);
  }

  outputSuccess({
    action: 'publish',
    project: projectPath,
    version,
    desc: args.desc || '',
    status: 'uploaded',
    message: `代码已上传，版本号 ${version}。请前往微信公众平台提交审核。`,
    nextSteps: [
      '1. 登录 mp.weixin.qq.com → 管理 → 版本管理',
      '2. 找到刚上传的版本，点击"提交审核"',
      '3. 填写审核信息并提交',
      '4. 等待微信团队审核（通常 2-7 天）',
      '5. 审核通过后，点击"发布"正式上线',
    ],
  }, args.json);
}

main().catch((e) => outputError(`未捕获异常: ${e.message}`, {}, false));