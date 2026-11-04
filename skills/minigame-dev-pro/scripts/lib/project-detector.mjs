/**
 * 项目检测器（自研）
 *
 * 检测一个目录是否为有效的微信小游戏项目，并提取关键信息：
 *  - 项目类型（小游戏 / 小程序 / 未知）
 *  - AppID
 *  - 项目名称
 *  - 主包大小估算
 *  - 基础库版本
 *  - 是否有分包
 *  - 是否有云开发
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';

/**
 * 检测项目
 * @param {string} projectPath
 * @returns {{valid: boolean, type: string, appId: string|null, projectName: string|null, errors: string[], info: object}}
 */
export function detectProject(projectPath) {
  const errors = [];

  if (!existsSync(projectPath)) {
    return {
      valid: false,
      type: 'unknown',
      appId: null,
      projectName: null,
      errors: [`项目路径不存在: ${projectPath}`],
      info: {},
    };
  }

  // 检测关键文件
  const gameJsonPath = join(projectPath, 'game.json');
  const gameJsPath = join(projectPath, 'game.js');
  const projectConfigPath = join(projectPath, 'project.config.json');
  const appJsonPath = join(projectPath, 'app.json');

  const hasGameJson = existsSync(gameJsonPath);
  const hasGameJs = existsSync(gameJsPath);
  const hasProjectConfig = existsSync(projectConfigPath);
  const hasAppJson = existsSync(appJsonPath);

  // 判断类型
  let type = 'unknown';
  if (hasGameJson && hasGameJs) {
    type = 'minigame';
  } else if (hasAppJson) {
    type = 'miniprogram';
  }

  if (type === 'unknown') {
    errors.push('未找到 game.json/game.js 或 app.json，不是有效的微信小游戏/小程序项目');
  }

  // 解析 project.config.json
  let appId = null;
  let projectName = null;
  let libVersion = null;
  if (hasProjectConfig) {
    try {
      const cfg = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
      appId = cfg.appid || cfg.appId || null;
      projectName = cfg.projectname || cfg.projectName || null;
      libVersion = cfg.libVersion || cfg.lib_version || null;
    } catch (e) {
      errors.push(`project.config.json 解析失败: ${e.message}`);
    }
  }

  // 解析 game.json
  let deviceOrientation = null;
  let subpackages = [];
  let openDataContext = null;
  if (hasGameJson) {
    try {
      const cfg = JSON.parse(readFileSync(gameJsonPath, 'utf-8'));
      deviceOrientation = cfg.deviceOrientation || null;
      subpackages = cfg.subpackages || cfg.subPackages || [];
      openDataContext = cfg.openDataContext || null;
    } catch (e) {
      errors.push(`game.json 解析失败: ${e.message}`);
    }
  }

  // 估算主包大小（排除分包目录、node_modules、.git）
  const mainPackageSize = calcDirSize(projectPath, [
    'node_modules', '.git', 'miniprogram_npm', 'typings',
    ...subpackages.map((s) => s.root || s.name),
  ]);

  // 检测云开发
  const hasCloudFunctions = existsSync(join(projectPath, 'cloudfunctions'))
    || existsSync(join(projectPath, 'cloud'))
    || existsSync(join(projectPath, 'functions'));

  // 检测开放数据域（game.json 中 openDataContext 可能是布尔值 true 或子目录名）
  let hasOpenDataContext = false;
  if (typeof openDataContext === 'string' && openDataContext) {
    hasOpenDataContext = existsSync(join(projectPath, openDataContext));
  } else if (openDataContext === true) {
    hasOpenDataContext = true;
  }

  // 推断引擎与版本（1.0.7 新增）
  const engineInfo = inferEngine(projectPath);

  return {
    valid: type !== 'unknown' && errors.length === 0,
    type,
    appId,
    projectName,
    errors,
    info: {
      hasGameJson,
      hasGameJs,
      hasProjectConfig,
      libVersion,
      deviceOrientation,
      subpackageCount: subpackages.length,
      subpackages,
      mainPackageSizeBytes: mainPackageSize,
      mainPackageSizeMB: +(mainPackageSize / 1024 / 1024).toFixed(2),
      hasCloudFunctions,
      hasOpenDataContext,
      engine: engineInfo.engine,
      engineVersion: engineInfo.engineVersion,
      engineConfidence: engineInfo.confidence,
      engineSignals: engineInfo.signals,
    },
  };
}

/**
 * 计算目录大小（排除指定子目录）
 */
export function calcDirSize(dir, excludeDirs = []) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (excludeDirs.includes(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        total += calcDirSize(full, []);
      } else {
        total += stat.size;
      }
    }
  } catch (_) {
    // 忽略无权限目录
  }
  return total;
}

/**
 * 列出项目中指定类型的文件
 */
export function listFiles(projectPath, extensions = [], excludeDirs = ['node_modules', '.git', 'miniprogram_npm']) {
  const results = [];
  if (!existsSync(projectPath)) return results;

  function walk(dir) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (excludeDirs.includes(entry)) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else {
          const ext = extname(entry).toLowerCase().slice(1);
          if (extensions.length === 0 || extensions.includes(ext)) {
            results.push({
              path: full,
              relPath: relative(projectPath, full).split(sep).join('/'),
              size: stat.size,
              ext,
            });
          }
        }
      }
    } catch (_) {
      // 忽略
    }
  }

  walk(projectPath);
  return results;
}

/**
 * 推断项目使用的引擎与版本（1.0.7 新增）
 *
 * 依据工程标记判定引擎：
 *  - Cocos Creator：settings/ library/ assets/（.meta）目录、jsb-adapter、
 *    package.json 含 cocos-creator/@cocos/*、源码含 `cc` 命名空间（require('cc')/cc.Class/cc.game）。
 *  - Laya Air：package.json 含 layaair/laya、源码含 `Laya.` 命名空间。
 *  - 原生：game.js 含 GameGlobal/wx.createCanvas/canvas/requestAnimationFrame，且无 Cocos/Laya 标记。
 *
 * 版本检测：读 package.json 依赖版本 / settings/project.json engineVersion；无法检测则 null（诚实标"待执行期核实"）。
 * 原生无引擎版本概念，固定返回 null。
 *
 * @param {string} projectPath
 * @returns {{engine: 'cocos'|'laya'|'native'|null, engineVersion: string|null, confidence: 'high'|'medium'|'low', signals: string[]}}
 */
export function inferEngine(projectPath) {
  const signals = [];
  const isDir = (p) => {
    try { return existsSync(join(projectPath, p)) && statSync(join(projectPath, p)).isDirectory(); }
    catch { return false; }
  };

  const hasSettings = isDir('settings');
  const hasLibrary = isDir('library');
  const hasAssets = isDir('assets');
  const hasJsb = isDir('jsb-adapter') || existsSync(join(projectPath, 'jsb-adapter.js'));
  if (hasSettings) signals.push('cocos:settings/');
  if (hasLibrary) signals.push('cocos:library/');
  if (hasAssets) signals.push('cocos:assets/');
  if (hasJsb) signals.push('cocos:jsb-adapter');

  // package.json 依赖
  let pkg = null;
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
  }
  const deps = { ...(pkg && pkg.dependencies ? pkg.dependencies : {}), ...(pkg && pkg.devDependencies ? pkg.devDependencies : {}) };
  const depKeys = Object.keys(deps);
  const cocosDep = depKeys.find((k) => k === 'cocos-creator' || k.startsWith('@cocos/') || k === 'cc' || k.startsWith('cocos-creator'));
  const layaDep = depKeys.find((k) => k === 'layaair' || k === 'laya' || k.startsWith('laya'));
  if (cocosDep) signals.push('cocos:dep:' + cocosDep);
  if (layaDep) signals.push('laya:dep:' + layaDep);

  // 扫描源码命名空间（限制样本量避免大工程卡顿）
  const srcFiles = listFiles(projectPath, ['js', 'ts'], ['node_modules', '.git', 'miniprogram_npm', 'typings', 'library', 'assets']).slice(0, 60);
  let hasCcNs = false;
  let hasLayaNs = false;
  for (const f of srcFiles) {
    let content = '';
    try { content = readFileSync(f.path, 'utf8'); } catch { continue; }
    if (/require\(['"]cc['"]\)|from ['"]cc['"]|import\s+\*\s+as\s+cc\b|cc\.Class|cc\.game|cc\.sys/.test(content)) { hasCcNs = true; signals.push('cocos:ns:cc'); break; }
  }
  if (!hasCcNs) {
    for (const f of srcFiles) {
      let content = '';
      try { content = readFileSync(f.path, 'utf8'); } catch { continue; }
      if (/Laya\.|from ['"]laya['"]|layaair|import\s*\{[^}]*\}\s*from ['"]laya/.test(content)) { hasLayaNs = true; signals.push('laya:ns:Laya'); break; }
    }
  }

  // 原生标记
  let hasNative = false;
  const gameJs = join(projectPath, 'game.js');
  if (existsSync(gameJs)) {
    try {
      const c = readFileSync(gameJs, 'utf8');
      if (/GameGlobal|wx\.createCanvas|createCanvas\(\)|requestAnimationFrame|canvas/.test(c)) { hasNative = true; signals.push('native:game.js canvas/GameGlobal'); }
    } catch { /* ignore */ }
  }

  // 判定引擎
  let engine = null;
  let confidence = 'low';
  if (hasSettings || hasLibrary || hasJsb || cocosDep || hasCcNs) {
    engine = 'cocos';
    confidence = (hasSettings && hasCcNs) || (hasLibrary && hasCcNs) || hasJsb ? 'high' : (hasSettings || hasLibrary ? 'high' : 'medium');
  } else if (layaDep || hasLayaNs) {
    engine = 'laya';
    confidence = layaDep ? 'high' : 'medium';
  } else if (hasNative) {
    engine = 'native';
    confidence = 'low';
  }

  // 版本检测
  let engineVersion = null;
  if (engine === 'cocos') {
    if (cocosDep && deps[cocosDep]) engineVersion = deps[cocosDep];
    if (!engineVersion && pkg && pkg.versions && pkg.versions['cocos-creator']) engineVersion = pkg.versions['cocos-creator'];
    const sp = join(projectPath, 'settings', 'project.json');
    if (!engineVersion && existsSync(sp)) {
      try { const s = JSON.parse(readFileSync(sp, 'utf8')); engineVersion = s.engineVersion || s.version || null; } catch { /* ignore */ }
    }
  } else if (engine === 'laya') {
    if (layaDep && deps[layaDep]) engineVersion = deps[layaDep];
  }
  // 原生无引擎版本概念 → 保持 null（诚实标注"待执行期核实"）

  return { engine, engineVersion, confidence, signals };
}

export default { detectProject, calcDirSize, listFiles, inferEngine };
