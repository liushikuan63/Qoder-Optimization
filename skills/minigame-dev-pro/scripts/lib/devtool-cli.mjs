/**
 * 微信开发者工具 CLI 封装（自研实现）
 *
 * 能力：
 *  - 探测微信开发者工具 CLI 路径（Win/macOS/Linux）
 *  - 自动预览（auto-preview）
 *  - 真机预览（auto-preview + qr-format）
 *  - 上传代码（upload）
 *  - 自动化端口连接（auto + auto-port，用于日志/截图）
 *
 * 设计原则：
 *  - 幂等：重复调用不崩溃
 *  - 保守：找不到 CLI 时返回结构化错误，不抛异常
 *  - JSON 优先：所有方法支持返回结构化结果
 *  - 跨平台：Win/macOS/Linux 路径自动探测
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

// ---- CLI 路径探测 ----

const WIN_INSTALL_DIRS = [
  join(homedir(), 'AppData', 'Local', '微信开发者工具'),
  join(homedir(), 'AppData', 'Local', 'wechat-devtools'),
  'C:\\Program Files (x86)\\微信开发者工具',
  'C:\\Program Files (x86)\\wechat-devtools',
  'C:\\Program Files\\微信开发者工具',
  'C:\\Program Files\\wechat-devtools',
  'D:\\微信开发者工具',
  'D:\\wechat-devtools',
];

const MAC_INSTALL_DIRS = [
  '/Applications/wechatwebdevtools.app',
  '/Applications/微信开发者工具.app',
  join(homedir(), 'Applications', 'wechatwebdevtools.app'),
  join(homedir(), 'Applications', '微信开发者工具.app'),
];

const LINUX_INSTALL_DIRS = [
  '/opt/wechat-devtools',
  join(homedir(), '.config', 'wechat-devtools'),
  join(homedir(), 'wechat-devtools'),
];

/**
 * 获取微信开发者工具安装根目录
 * @returns {{found: boolean, path: string|null, error: string|null}}
 */
export function findInstallDir() {
  const dirs = platform() === 'win32' ? WIN_INSTALL_DIRS
    : platform() === 'darwin' ? MAC_INSTALL_DIRS
    : LINUX_INSTALL_DIRS;

  for (const d of dirs) {
    if (existsSync(d)) {
      return { found: true, path: d, error: null };
    }
  }
  return {
    found: false,
    path: null,
    error: `未在默认路径找到微信开发者工具（已尝试: ${dirs.join('; ')}）。请用 --cli 指定 cli 路径，或在环境变量 WX_DEVTOOL_CLI 中设置。`,
  };
}

/**
 * 获取 CLI 可执行文件路径
 * @param {string|null} override 用户指定的路径
 * @returns {{found: boolean, cliPath: string|null, error: string|null}}
 */
export function findCli(override = null) {
  // 优先级：参数 > 环境变量 > 默认探测
  if (override) {
    if (existsSync(override)) {
      return { found: true, cliPath: override, error: null };
    }
    return { found: false, cliPath: null, error: `指定的 cli 路径不存在: ${override}` };
  }

  const envCli = process.env.WX_DEVTOOL_CLI;
  if (envCli && existsSync(envCli)) {
    return { found: true, cliPath: envCli, error: null };
  }

  const install = findInstallDir();
  if (!install.found) {
    return { found: false, cliPath: null, error: install.error };
  }

  let cliPath;
  if (platform() === 'win32') {
    // Windows: cli.bat 可能在安装根目录或 bin 子目录
    const winCliPaths = [
      join(install.path, 'cli.bat'),
      join(install.path, 'bin', 'cli.bat'),
    ];
    cliPath = winCliPaths.find((p) => existsSync(p)) || winCliPaths[0];
  } else if (platform() === 'darwin') {
    // macOS: 可能在 Contents/MacOS/cli 或 Contents/Resources/app.nw/bin/cli
    const macPaths = [
      join(install.path, 'Contents', 'MacOS', 'cli'),
      join(install.path, 'Contents', 'Resources', 'app.nw', 'bin', 'cli'),
    ];
    cliPath = macPaths.find((p) => existsSync(p)) || macPaths[0];
  } else {
    // Linux: 可能在 bin/cli 或直接 cli
    cliPath = existsSync(join(install.path, 'bin', 'cli'))
      ? join(install.path, 'bin', 'cli')
      : join(install.path, 'cli');
  }

  if (existsSync(cliPath)) {
    return { found: true, cliPath, error: null };
  }

  return {
    found: false,
    cliPath: null,
    error: `在安装目录 ${install.path} 下未找到 cli 可执行文件（期望: ${cliPath}）。`,
  };
}

// ---- 通用执行器 ----

/**
 * 执行 CLI 命令
 * @param {string[]} args 命令参数
 * @param {object} opts { cliPath, cwd, timeoutMs }
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string, error: string|null}>}
 */
export function execCli(args, opts = {}) {
  return new Promise((resolve) => {
    const cliFind = findCli(opts.cliPath || null);
    if (!cliFind.found) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: cliFind.error });
      return;
    }

    const timeoutMs = opts.timeoutMs || 60000;
    // Windows 下通过 shell 执行 .bat，需要对自由文本参数做字符白名单过滤，避免命令注入
    const sanitizedArgs = args.map((a) => sanitizeArg(a));
    const child = spawn(cliFind.cliPath, sanitizedArgs, {
      cwd: opts.cwd || process.cwd(),
      windowsHide: true,
      shell: platform() === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          code: -1,
          stdout,
          stderr,
          error: `执行超时（${timeoutMs}ms）。命令: ${args.join(' ')}`,
        });
      } else {
        resolve({
          ok: code === 0,
          code,
          stdout,
          stderr,
          error: code === 0 ? null : `CLI 退出码 ${code}。stderr: ${stderr.slice(0, 500)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr,
        error: `进程启动失败: ${err.message}`,
      });
    });
  });
}

// ---- 业务命令 ----

/**
 * 自动预览（编译并生成预览二维码）
 * @param {string} projectPath 项目路径
 * @param {object} opts { cliPath, qrFormat: 'terminal'|'image'|'base64', qrOutput, timeoutMs }
 * @returns {Promise<object>}
 */
export async function autoPreview(projectPath, opts = {}) {
  if (!existsSync(projectPath)) {
    return { ok: false, error: `项目路径不存在: ${projectPath}`, qrPath: null };
  }

  // 官方 CLI：预览/真机预览二维码使用 preview 命令（--qr-format/--qr-output/--project）
  const args = ['preview', '--project', projectPath];
  if (opts.qrFormat) args.push('--qr-format', opts.qrFormat);
  if (opts.qrOutput) args.push('--qr-output', opts.qrOutput);

  const result = await execCli(args, {
    cliPath: opts.cliPath,
    timeoutMs: opts.timeoutMs || 120000,
  });

  return {
    ok: result.ok,
    qrPath: result.ok ? extractQrPath(result.stdout) : null,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * 上传代码
 * @param {string} projectPath
 * @param {object} opts { cliPath, version, desc, robot, timeoutMs }
 * @returns {Promise<object>}
 */
export async function upload(projectPath, opts = {}) {
  if (!existsSync(projectPath)) {
    return { ok: false, error: `项目路径不存在: ${projectPath}` };
  }

  const args = ['upload', '--project', projectPath];
  if (opts.version) args.push('--version', opts.version);
  if (opts.desc) args.push('--desc', opts.desc);

  const result = await execCli(args, {
    cliPath: opts.cliPath,
    timeoutMs: opts.timeoutMs || 180000,
  });

  return {
    ok: result.ok,
    version: opts.version || null,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * 启动自动化端口（用于日志采集、截图等）
 * @param {string} projectPath
 * @param {number} autoPort 自动化端口（如 9420）
 * @param {object} opts { cliPath, timeoutMs }
 * @returns {Promise<object>}
 */
export async function startAuto(projectPath, autoPort, opts = {}) {
  if (!existsSync(projectPath)) {
    return { ok: false, error: `项目路径不存在: ${projectPath}` };
  }

  const args = ['auto', '--project', projectPath, '--auto-port', String(autoPort)];
  // auto 命令会持续运行，这里只做启动检测（5秒内无错误视为启动成功）
  const result = await execCli(args, {
    cliPath: opts.cliPath,
    timeoutMs: opts.timeoutMs || 8000,
  });

  // auto 命令正常会持续运行直到超时，超时但无 stderr 错误视为启动成功
  if (result.code === -1 && result.error && result.error.includes('执行超时') && !result.stderr) {
    return { ok: true, autoPort, stdout: result.stdout, stderr: '', error: null };
  }

  return {
    ok: result.ok,
    autoPort,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

// ---- 辅助函数 ----

/**
 * 过滤 shell 特殊字符，防止 Windows shell 模式下命令注入
 * 只保留常见的安全字符（路径、版本号、描述文本等）
 */
function sanitizeArg(value) {
  if (typeof value !== 'string') return value;
  // 过滤：& | ; < > ( ) $ ` " ' ^ % ! 换行 制表符 等 shell 元字符
  // 注意：反斜杠是 Windows 路径分隔符，必须保留（如 D:\mygame），否则绝对路径会被破坏
  return value.replace(/[&|;<>()$`"'^%!\r\n\t]/g, '');
}

/**
 * 从 stdout 中提取二维码图片路径
 */
function extractQrPath(stdout) {
  if (!stdout) return null;
  // 微信 CLI 输出格式：二维码图片位于 xxx 路径，或直接输出路径
  const match = stdout.match(/(?:二维码|QR|qr)[^\n]*?[:：]?\s*([^\s]+\.(?:png|jpg|jpeg))/i);
  return match ? match[1] : null;
}

/**
 * 检查 CLI 是否可用（不执行任何命令，只检测路径）
 */
export function checkAvailable(override = null) {
  return findCli(override);
}

export default {
  findInstallDir,
  findCli,
  execCli,
  autoPreview,
  upload,
  startAuto,
  checkAvailable,
};
