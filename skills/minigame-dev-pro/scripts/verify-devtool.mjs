#!/usr/bin/env node
/**
 * verify-devtool.mjs — 微信开发者工具环境验证
 * 用法：
 *   node verify-devtool.mjs [--cli <路径>] [--project <路径>] [--json]
 *
 * 能力：
 *  - 验证微信开发者工具是否安装
 *  - 验证 CLI 是否可行
 *  - 验证登录态（通过 CLI 命令测试）
 *  - 验证自动化端口是否可用
 *  - 验证 miniprogram-automator 是否安装
 *  - 输出结构化验证报告
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findCli, findInstallDir, execCli } from './lib/devtool-cli.mjs';
import { checkAvailable as checkAutomator } from './lib/automator.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `微信开发者工具环境验证
用法:
  node verify-devtool.mjs [选项]

选项:
  --cli <路径>        指定 cli 路径（可选）
  --project <路径>    项目路径（可选，用于项目级验证）
  --json              以 JSON 格式输出
  --help              显示帮助

验证项：
  1. 微信开发者工具安装目录
  2. CLI 可执行文件
  3. CLI 可行性（实际执行 --help）
  4. 登录态检查
  5. 项目配置有效性（如指定 --project）
  6. miniprogram-automator 可用态`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const checks = [];

  // 1. 安装目录
  const installDir = findInstallDir();
  checks.push({
    id: 'install-dir',
    name: '安装目录',
    status: installDir.found ? 'pass' : 'fail',
    detail: installDir.found ? installDir.path : installDir.error,
  });

  // 2. CLI 可执行文件
  const cliFind = findCli(args.cli || null);
  checks.push({
    id: 'cli-path',
    name: 'CLI 可执行文件',
    status: cliFind.found ? 'pass' : 'fail',
    detail: cliFind.found ? cliFind.cliPath : cliFind.error,
  });

  // 3. CLI 可执行性
  if (cliFind.found) {
    const execResult = await execCli(['--help'], { cliPath: args.cli, timeoutMs: 10000 });
    checks.push({
      id: 'cli-executable',
      name: 'CLI 可执行性',
      status: execResult.ok ? 'pass' : 'fail',
      detail: execResult.ok ? 'CLI 可正常执行' : execResult.error,
    });
  } else {
    checks.push({
      id: 'cli-executable',
      name: 'CLI 可执行性',
      status: 'skip',
      detail: 'CLI 未找到，跳过',
    });
  }

  // 4. 登录态检测（通过 islogin 命令）
  if (cliFind.found) {
    const loginResult = await execCli(['islogin'], { cliPath: args.cli, timeoutMs: 10000 });
    // islogin 输出 JSON（{"login":true/false}）或中文提示；命令执行成功不等于已登录，仅按输出内容判定
    const loginOut = loginResult.stdout || '';
    const isLoggedIn =
      !/false|未登录|not\s*logged/i.test(loginOut) &&
      (loginOut.includes('true') || loginOut.includes('已登录') || /"login"\s*:\s*true/i.test(loginOut));
    checks.push({
      id: 'login-status',
      name: '登录态',
      status: isLoggedIn ? 'pass' : 'fail',
      detail: isLoggedIn ? '已登录' : '未登录，请打开微信开发者工具并扫码登录',
    });
  } else {
    checks.push({
      id: 'login-status',
      name: '登录态',
      status: 'skip',
      detail: 'CLI 未找到，跳过',
    });
  }

  // 5. 项目配置有效性
  if (args.project) {
    if (!existsSync(args.project)) {
      checks.push({
        id: 'project-config',
        name: '项目配置',
        status: 'fail',
        detail: `项目路径不存在 ${args.project}`,
      });
    } else {
      const projectConfigPath = join(args.project, 'project.config.json');
      if (!existsSync(projectConfigPath)) {
        checks.push({
          id: 'project-config',
          name: '项目配置',
          status: 'fail',
          detail: '缺少 project.config.json',
        });
      } else {
        try {
          const cfg = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
          const appId = cfg.appid || cfg.appId;
          const hasValidAppId = appId && appId !== 'touristappid' && appId.length > 10;
          checks.push({
            id: 'project-config',
            name: '项目配置',
            status: hasValidAppId ? 'pass' : 'warn',
            detail: hasValidAppId
              ? `AppID: ${appId}`
              : 'AppID 无效或为游客模式，请配置正式 AppID',
          });
        } catch (e) {
          checks.push({
            id: 'project-config',
            name: '项目配置',
            status: 'fail',
            detail: `project.config.json 解析失败: ${e.message}`,
          });
        }
      }
    }
  } else {
    checks.push({
      id: 'project-config',
      name: '项目配置',
      status: 'skip',
      detail: '未指定--project，跳过',
    });
  }

  // 6. miniprogram-automator 可用性
  const autoCheck = await checkAutomator();
  checks.push({
    id: 'automator',
    name: 'miniprogram-automator',
    status: autoCheck.available ? 'pass' : 'warn',
    detail: autoCheck.available
      ? `已安装(v${autoCheck.version})，可启用真截图和实时日志`
      : '未安装，真截图实时日志将降级。安装：npm install miniprogram-automator',
  });

  // 汇总
  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const skipped = checks.filter((c) => c.status === 'skip').length;

  const overall = failed > 0 ? 'fail' : (warnings > 0 ? 'warn' : 'pass');

  const result = {
    action: 'verify_devtool',
    overall,
    totalChecks: checks.length,
    passed,
    failed,
    warnings,
    skipped,
    ready: failed === 0,
    checks,
    recommendation: failed > 0
      ? `${failed} 项验证失败，需修复后才能使用执行层`
      : warnings > 0
        ? `${warnings} 项警告，执行层可使用但部分功能将降级`
        : '环境验证通过，所有执行层功能可用',
  };

  if (overall === 'fail') {
    if (args.json) {
      // JSON 模式：先输出完整结果，再以失败码退出
      process.stdout.write(JSON.stringify({ ok: false, ...result }, null, 2) + '\n');
      process.exit(1);
    }
    // 文本模式输出失败详情
    process.stdout.write(`✗ 环境验证失败（${failed} 项失败）\n\n`);
    for (const c of checks) {
      if (c.status === 'fail') {
        process.stdout.write(`  [${c.id}] ${c.name}: ${c.detail}\n`);
      }
    }
    process.stdout.write('\n' + result.recommendation + '\n');
    process.exit(1);
  }

  outputSuccess(result, args.json);
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

