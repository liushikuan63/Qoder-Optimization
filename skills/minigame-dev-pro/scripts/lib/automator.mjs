/**
 * automator.mjs — miniprogram-automator 渐进增强模块
 *
 * 设计理念：
 *  - 零依赖优雅降级：无 miniprogram-automator 时返回 { available: false }，不崩溃
 *  - 有依赖时增强：动态 import miniprogram-automator 实现真截图/实时日志
 *  - 统一接口：无论是否有依赖，调用方式一致
 *
 * 能力：
 *  - launch(): 启动自动化连接（连接微信开发者工具的自动化端口）
 *  - screenshot(): 真截图（保存 PNG）
 *  - getRealtimeLogs(): 实时日志采集（监听 console 事件）
 *  - close(): 关闭连接
 */

let automatorModule = null;
let checkPromise = null;

/**
 * 检查 miniprogram-automator 是否可用
 * @returns {Promise<{available: boolean, version: string|null, error: string|null}>}
 */
export async function checkAvailable() {
  if (checkPromise) return checkPromise;

  checkPromise = (async () => {
    try {
      // 尝试动态 import
      const mod = await import('miniprogram-automator');
      automatorModule = mod.default || mod;
      return {
        available: true,
        version: automatorModule.VERSION || 'unknown',
        error: null,
      };
    } catch (importErr) {
      // 尝试从项目 node_modules 加载
      try {
        const { createRequire } = await import('node:module');
        const { pathToFileURL } = await import('node:url');
        const req = createRequire(import.meta.url);
        const modPath = req.resolve('miniprogram-automator');
        const mod = await import(pathToFileURL(modPath).href);
        automatorModule = mod.default || mod;
        return {
          available: true,
          version: automatorModule.VERSION || 'unknown',
          error: null,
        };
      } catch (resolveErr) {
        return {
          available: false,
          version: null,
          error: 'miniprogram-automator 未安装。安装后可启用真截图和实时日志：npm install miniprogram-automator',
        };
      }
    }
  })();

  return checkPromise;
}

/**
 * 启动自动化连接
 * @param {object} opts { projectPath, cliPath, autoPort, timeoutMs }
 * @returns {Promise<{ok: boolean, automator: object|null, error: string|null}>}
 */
export async function launch(opts = {}) {
  const check = await checkAvailable();
  if (!check.available) {
    return { ok: false, automator: null, error: check.error };
  }

  try {
    const automator = await automatorModule.launch({
      cliPath: opts.cliPath,
      projectPath: opts.projectPath,
      timeout: opts.timeoutMs || 30000,
    });
    return { ok: true, automator, error: null };
  } catch (e) {
    return {
      ok: false,
      automator: null,
      error: `自动化连接失败: ${e.message}。请确保微信开发者工具已打开并登录，且安全模式已开启（设置→安全设置→服务端口开启）。`,
    };
  }
}

/**
 * 真截图
 * @param {object} automator 已连接的 automator 实例
 * @param {string} outputPath 截图保存路径
 * @returns {Promise<{ok: boolean, path: string|null, error: string|null}>}
 */
export async function screenshot(automator, outputPath) {
  if (!automator) {
    return { ok: false, path: null, error: 'automator 未连接' };
  }

  try {
    // 小游戏用 system.compileSnapshot 或 page.screenshot
    // miniprogram-automator 的 miniProgram 对象支持 screenshot
    const miniProgram = automator;
    // 尝试多种截图方法
    if (typeof miniProgram.screenshot === 'function') {
      const data = await miniProgram.screenshot({ path: outputPath });
      return { ok: true, path: outputPath, error: null, method: 'screenshot' };
    }
    // 某些版本需要先获取页面
    if (typeof miniProgram.currentPage === 'function') {
      const page = await miniProgram.currentPage();
      if (page && typeof page.screenshot === 'function') {
        await page.screenshot({ path: outputPath });
        return { ok: true, path: outputPath, error: null, method: 'page.screenshot' };
      }
    }
    return {
      ok: false,
      path: null,
      error: 'automator 不支持截图方法。请检查 miniprogram-automator 版本。',
    };
  } catch (e) {
    return { ok: false, path: null, error: `截图失败: ${e.message}` };
  }
}

/**
 * 采集实时日志
 * @param {object} automator 已连接的 automator 实例
 * @param {object} opts { durationMs, filter }
 * @returns {Promise<{ok: boolean, logs: array, error: string|null}>}
 */
export async function collectLogs(automator, opts = {}) {
  if (!automator) {
    return { ok: false, logs: [], error: 'automator 未连接' };
  }

  const durationMs = opts.durationMs || 5000;
  const filter = opts.filter || null;
  const logs = [];

  try {
    // 监听 console 事件
    automator.on('console', (msg) => {
      const text = typeof msg === 'string' ? msg : (msg?.text || msg?.args?.join(' ') || JSON.stringify(msg));
      if (!filter || text.includes(filter)) {
        logs.push({
          time: new Date().toISOString(),
          type: msg?.type || 'log',
          text,
        });
      }
    });

    // 等待指定时长
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    return { ok: true, logs, error: null };
  } catch (e) {
    return { ok: false, logs, error: `日志采集失败: ${e.message}` };
  }
}

/**
 * 关闭自动化连接
 * @param {object} automator
 */
export async function close(automator) {
  if (!automator) return;
  try {
    await automator.close();
  } catch (_) {
    // 忽略关闭错误
  }
}

export default { checkAvailable, launch, screenshot, collectLogs, close };
