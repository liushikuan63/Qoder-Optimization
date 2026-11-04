#!/usr/bin/env node
/**
 * perf-profiler.mjs — 性能打点注入/读取（质量自检工具）
 * 用法：
 *   node perf-profiler.mjs --project <项目路径> --mode inject [--json]
 *   node perf-profiler.mjs --project <项目路径> --mode read [--json]
 *   node perf-profiler.mjs --project <项目路径> --mode revert [--json]
 *
 * 能力：
 *  - inject: 向 game.js 注入性能监控代码（FPS/DrawCall/内存），自动备份原文件
 *  - read: 解析日志提取性能数据
 *  - revert: 恢复原始 game.js
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `性能打点注入/读取

用法:
  node perf-profiler.mjs --project <项目路径> --mode <模式> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --mode <模式>       inject | read | revert（必填）
  --target <文件>     注入目标文件（默认game.js）
  --json              以 JSON 格式输出
  --help              显示帮助

模式说明:
  inject  向目标文件注入 FPS/内存监控代码（自动备份原文件为 .bak）
  read    扫描项目日志，提取已注入打点输出的性能数据
  revert  恢复 .bak 备份文件
`;

const PERF_SNIPPET = `
// === [PERF PROFILER INJECTED] ===
(function() {
  if (typeof wx === 'undefined' && typeof GameGlobal === 'undefined') return;
  var _perfFrames = 0;
  var _perfLastTime = Date.now();
  var _perfFps = 60;
  var _perfMinFps = 60;
  var _perfMaxFps = 60;
  var _perfStartTime = Date.now();
  var _perfRafAvailable = typeof requestAnimationFrame !== 'undefined';
  var _perfLogEnabled = typeof globalThis.__PERF_LOG_ENABLED !== 'undefined' ? globalThis.__PERF_LOG_ENABLED : false;

  function _perfGetMem() {
    // 尝试多种内存 API
    try {
      if (typeof wx !== 'undefined' && wx.getPerformance) {
        var perf = wx.getPerformance();
        if (perf && perf.memory) return Math.round(perf.memory.usedJSHeapSize / 1024 / 1024);
      }
    } catch (e) {}
    try {
      if (typeof performance !== 'undefined' && performance.memory) {
        return Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
      }
    } catch (e) {}
    return 'N/A';
  }

  function _perfReport() {
    var now = Date.now();
    var delta = now - _perfLastTime;
    if (delta >= 1000) {
      _perfFps = Math.round((_perfFrames * 1000) / delta);
      _perfMinFps = Math.min(_perfMinFps, _perfFps);
      _perfMaxFps = Math.max(_perfMaxFps, _perfFps);
      var memUsed = _perfGetMem();
      if (_perfLogEnabled) {
        console.log('[PERF] fps=' + _perfFps + ' min=' + _perfMinFps + ' max=' + _perfMaxFps + ' mem=' + memUsed + 'MB uptime=' + Math.round((now - _perfStartTime) / 1000) + 's');
      }
      _perfFrames = 0;
      _perfLastTime = now;
    }
  }

  function _perfTick() {
    _perfFrames++;
    _perfReport();
    if (_perfRafAvailable) {
      requestAnimationFrame(_perfTick);
    }
  }

  // 单计数源启动：小游戏引擎多通过 canvas.requestAnimationFrame 驱动渲染循环，
  // 优先 Hook Canvas.prototype.requestAnimationFrame（仅此一路计数，避免与全局 rAF 同时计数导致 FPS 虚高）；
  // 引擎使用全局 requestAnimationFrame 时退化为全局 rAF；两者均不可用时以 setInterval 兜底。
  var _perfCanvasRaf = false;
  try {
    if (typeof Canvas !== 'undefined' && Canvas.prototype.requestAnimationFrame) {
      var _origRaf = Canvas.prototype.requestAnimationFrame;
      Canvas.prototype.requestAnimationFrame = function(cb) {
        var _wrappedCb = function(ts) {
          _perfFrames++;
          _perfReport();
          return cb(ts);
        };
        return _origRaf.call(this, _wrappedCb);
      };
      _perfCanvasRaf = true;
    }
  } catch (e) {}

  if (!_perfCanvasRaf && _perfRafAvailable) {
    requestAnimationFrame(_perfTick);
  } else if (!_perfCanvasRaf) {
    setInterval(function() {
      _perfFrames++;
      _perfReport();
    }, 16); // 约 60fps
  }

  if (_perfLogEnabled) {
    console.log('[PERF] profiler started (raf=' + _perfRafAvailable + ')');
  }
})();
// === [END PERF PROFILER] ===
`;

const PERF_MARKER_START = '// === [PERF PROFILER INJECTED] ===';
const PERF_MARKER_END = '// === [END PERF PROFILER] ===';

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', {}, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在 ${projectPath}`, {}, args.json);
  }

  const mode = args.mode;
  if (!mode || !['inject', 'read', 'revert'].includes(mode)) {
    outputError('缺少或无效的 --mode 参数', { hint: '可选 inject | read | revert' }, args.json);
  }

  const targetFile = args.target || 'game.js';
  const targetPath = join(projectPath, targetFile);
  const backupPath = targetPath + '.bak';

  if (mode === 'inject') {
    doInject(targetPath, backupPath, args.json);
  } else if (mode === 'read') {
    doRead(projectPath, args.json);
  } else if (mode === 'revert') {
    doRevert(targetPath, backupPath, args.json);
  }
}

function doInject(targetPath, backupPath, json) {
  if (!existsSync(targetPath)) {
    outputError(`目标文件不存在 ${targetPath}`, {}, json);
  }

  const original = readFileSync(targetPath, 'utf-8');

  // 检查是否已注入
  if (original.includes(PERF_MARKER_START)) {
    outputError('性能打点已存在，请先 --mode revert 恢复', {}, json);
  }

  // 安全检查：.bak 已存在说明上次注入未正常 revert，拒绝覆盖以免丢失原文件
  if (existsSync(backupPath)) {
    outputError(`备份文件已存在 ${backupPath}`, {
      hint: '上次注入可能未正常恢复。请先 --mode revert 清理 .bak，再 inject。如确认 .bak 可弃，手动删除后再试。',
    }, json);
  }

  // 智能选择注入位置（避免破坏 ESM import 和 'use strict'）
  const injectResult = smartInject(original, PERF_SNIPPET);
  const injected = injectResult.code;

  // 原子写入：先写临时文件，备份成功后再替换目标
  // 步骤1：备份原文件到.bak（如果这一步失败，目标文件未动，安全）
  try {
    writeFileSync(backupPath, original);
  } catch (e) {
    outputError(`备份失败，已中止注入: ${e.message}`, { hint: '检查磁盘空间和目录权限' }, json);
  }

  // 步骤2：写入临时文件，成功后 rename 替换目标（原子操作）
  const tmpPath = targetPath + '.perf_tmp';
  try {
    writeFileSync(tmpPath, injected);
    renameSync(tmpPath, targetPath);
  } catch (e) {
    // 写入失败，恢复原文件（备份已在.bak）
    try { unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    try { writeFileSync(targetPath, original); } catch (_) { /* 尽力恢复 */ }
    outputError(`注入失败，已恢复原文件 ${e.message}`, { hint: `原文件已恢复，备份在 ${backupPath}` }, json);
  }

  outputSuccess({
    action: 'perf_inject',
    target: targetPath,
    backup: backupPath,
    injectPosition: injectResult.position,
    message: '性能打点已注入。注入代码为本地调试用途，默认不会向控制台输出性能日志。若需记录到日志，请在运行环境显式设置全局变量 __PERF_LOG_ENABLED = true 以开启输出。',
    metrics: ['FPS (当前/最小/最大)', '内存使用 (MB)', '运行时长 (秒)'],
    nextStep: '若启用日志输出，运行游戏后使用 --mode read 扫描日志获取性能数据；注入仅用于本地分析，切勿在生产环境长期保留',
    warning: '注入的打点代码仅用于本地调试，请在完成分析后务必执行 --mode revert 恢复原始文件，避免将调试代码提交/发布',
  }, json);
}

/**
 * 智能注入：根据文件类型选择安全的注入位置 * - ESM（有 import）：注入到所有import 之后（支持多个 import） * - 'use strict' 开头：注入到 'use strict' 之后
 * - 普通文件：注入到文件开头 *
 * 多行 import 处理：跟踪 inImport 状态，遇到 import 开始进入块） * 直到遇到含 `;` 或 `from '...'` 的行才视为块结束。 * 修复旧版 bug：旧版遇 `import {` 不含 `;`/`from` 不更新 insertLine（ * 下一行非 import 立即 break，导致注入到 import 块之前 → ESM 语法报错。 */
function smartInject(original, snippet) {
  const lines = original.split('\n');
  let insertLine = 0;

  // 检查 'use strict'
  if (lines[0] && /^\s*['"]use strict['"]/.test(lines[0])) {
    insertLine = 1;
  }

  // 检查 ESM import：找到最后一个 import 语句的结束行
  if (lines.some((l) => /^\s*import\s/.test(l))) {
    let i = insertLine;
    let inImport = false;
    while (i < lines.length) {
      const line = lines[i];
      const isImportStart = /^\s*import\s/.test(line);
      // 判断当前行是否为 import 语句的结束行（以 ; 结尾，或 from '...' 结尾）
      const isImportEnd = /;\s*$/.test(line) || /from\s+['"][^'"]+['"]\s*;?\s*$/.test(line);

      if (isImportStart) {
        inImport = true;
        if (isImportEnd) {
          // 单行 import：如 import foo from 'x';
          insertLine = i + 1;
          inImport = false;
        }
        // 否则多行 import，继续往下找结束行
      } else if (inImport) {
        // 处于多行 import 块内部，找结束行
        if (isImportEnd) {
          insertLine = i + 1;
          inImport = false;
        }
      } else {
        // 非 import 行且不在 import 块内：遇到第一个非空非注释行停止
        if (line.trim() && !/^\s*\/\//.test(line)) break;
      }
      i++;
    }
  }

  const before = lines.slice(0, insertLine).join('\n');
  const after = lines.slice(insertLine).join('\n');
  const position = insertLine === 0 ? 'file-start'
    : /^\s*['"]use strict['"]/.test(lines[0]) ? 'after-strict' : 'after-imports';

  return {
    code: before + '\n' + snippet + '\n' + after,
    position,
  };
}

function doRead(projectPath, json) {
  // 扫描日志文件中的 [PERF] 行  // perf 数据的 console.log 输出的，不会写回 game.js，只扫日志文件
  const perfLines = [];

  function scan(dir) {
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          scan(full);
        } else if (entry.endsWith('.log') || entry.endsWith('.txt')) {
          // 只扫日志文件，不扫game.js（性能数据不会写回源码）
          try {
            const content = readFileSync(full, 'utf-8');
            const lines = content.split('\n').filter((l) => l.includes('[PERF]'));
            perfLines.push(...lines);
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }
  scan(projectPath);

  // 同时尝试扫描微信开发者工具的日志目录
  const devtoolLogs = scanDevtoolLogs();
  perfLines.push(...devtoolLogs);

  if (perfLines.length === 0) {
    outputSuccess({
      action: 'perf_read',
      status: 'no_data',
      message: '未找到性能打点数据',
      hint: '请先 --mode inject 注入打点，运行游戏后再 --mode read',
    }, json);
  }

  // 解析性能数据
  const dataPoints = perfLines.map((line) => parsePerfLine(line)).filter(Boolean);
  if (dataPoints.length === 0) {
    outputSuccess({
      action: 'perf_read',
      status: 'no_valid_data',
      message: '找到 [PERF] 行但无法解析',
    }, json);
  }

  const fpsValues = dataPoints.map((d) => d.fps).filter((f) => f > 0);
  const memValues = dataPoints.map((d) => d.mem).filter((m) => m > 0);

  const analysis = {
    action: 'perf_read',
    status: 'ok',
    sampleCount: dataPoints.length,
    fps: fpsValues.length > 0 ? {
      avg: +(fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length).toFixed(1),
      min: Math.min(...fpsValues),
      max: Math.max(...fpsValues),
      stable: Math.max(...fpsValues) - Math.min(...fpsValues) <= 15,
    } : null,
    memory: memValues.length > 0 ? {
      avg: +(memValues.reduce((a, b) => a + b, 0) / memValues.length).toFixed(1),
      min: Math.min(...memValues),
      max: Math.max(...memValues),
    } : null,
    verdict: '',
    suggestions: [],
  };

  // 生成评估
  if (analysis.fps) {
    if (analysis.fps.avg >= 55) {
      analysis.verdict = '帧率优秀';
    } else if (analysis.fps.avg >= 30) {
      analysis.verdict = '帧率合格';
      analysis.suggestions.push('帧率偏低，检查DrawCall 和渲染优化');
    } else {
      analysis.verdict = '帧率不合格';
      analysis.suggestions.push('帧率低于 30fps，需紧急优化');
    }
    if (!analysis.fps.stable) {
      analysis.suggestions.push('帧率波动大，检查是否有 GC 卡顿或复杂计算');
    }
  }
  if (analysis.memory && analysis.memory.max > 256) {
    analysis.suggestions.push('内存峰值偏高，检查纹理和资源释放');
  }

  outputSuccess(analysis, json);
}

function doRevert(targetPath, backupPath, json) {
  if (!existsSync(backupPath)) {
    outputError(`备份文件不存在 ${backupPath}`, { hint: '可能未注入过或备份已删除' }, json);
  }

  const backup = readFileSync(backupPath, 'utf-8');

  // 原子恢复：先写临时文件再 rename
  const tmpPath = targetPath + '.perf_tmp';
  try {
    writeFileSync(tmpPath, backup);
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    outputError(`恢复失败: ${e.message}`, { hint: `备份文件仍在 ${backupPath}，可手动覆盖` }, json);
  }

  // 恢复后清理.bak，避免用户后续手动编辑 game.js 后误 revert 覆盖
  let bakCleaned = true;
  let bakCleanError = null;
  try {
    unlinkSync(backupPath);
  } catch (e) {
    bakCleaned = false;
    bakCleanError = e.message;
  }

  outputSuccess({
    action: 'perf_revert',
    target: targetPath,
    bakCleaned,
    message: bakCleaned
      ? '已恢复原始文件，性能打点已移除，备份已清理' : '已恢复原始文件，但.bak 清理失败，建议手动删除以免下次inject 误覆盖',
    ...(bakCleaned ? {} : { warning: `备份残留: ${backupPath}（${bakCleanError}）` }),
  }, json);
}

/**
 * 扫描微信开发者工具的日志目录
 * 路径：Win:%APPDATA%/微信开发者工具Default/; macOS:~/Library/Application Support/微信开发者工具Default/
 */
function scanDevtoolLogs() {
  const lines = [];
  const candidates = [];
  if (platform() === 'win32') {
    candidates.push(join(homedir(), 'AppData', 'Roaming', '微信开发者工具', 'Default'));
    candidates.push(join(homedir(), 'AppData', 'Local', '微信开发者工具', 'Default'));
  } else if (platform() === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', '微信开发者工具', 'Default'));
  }
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith('.log') || entry.endsWith('.txt')) {
          try {
            const content = readFileSync(join(dir, entry), 'utf-8');
            const matched = content.split('\n').filter((l) => l.includes('[PERF]'));
            lines.push(...matched);
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }
  return lines;
}

function parsePerfLine(line) {
  const match = line.match(/fps=(\d+)\s+min=(\d+)\s+max=(\d+)\s+mem=(\d+|N\/A)MB\s+uptime=(\d+)s/);
  if (!match) return null;
  return {
    fps: parseInt(match[1], 10),
    minFps: parseInt(match[2], 10),
    maxFps: parseInt(match[3], 10),
    mem: match[4] === 'N/A' ? null : parseInt(match[4], 10),
    uptime: parseInt(match[5], 10),
  };
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

