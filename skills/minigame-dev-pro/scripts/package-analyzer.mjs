#!/usr/bin/env node
/**
 * package-analyzer.mjs — 包体分析优化（质量自检工具）
 * 用法：
 *   node package-analyzer.mjs --project <项目路径> [--json] [--top 20]
 *
 * 能力：
 *  - 分析项目包体构成（按文件类型、按目录）
 *  - 列出 Top N 大文件
 *  - 主包 vs 分包大小分析
 *  - 给出具体优化建议
 */

import { existsSync, statSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { detectProject, listFiles } from './lib/project-detector.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `包体分析优化

用法:
  node package-analyzer.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --top <数量>        显示最大文件数量（默认 20）
  --json              以 JSON 格式输出
  --help              显示帮助

输出内容:
  1. 总体概况（主包大小、分包大小、是否超标）
  2. 按文件类型统计（js/png/mp3/json 等）
  3. Top N 大文件列表
  4. 优化建议（哪些文件可压缩/CDN化移入分包）`;

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  const projectPath = args.project || args._[0];
  if (!projectPath) {
    outputError('缺少必填参数 --project', { hint: '用法: node package-analyzer.mjs --project <项目路径>' }, args.json);
  }

  if (!existsSync(projectPath)) {
    outputError(`项目路径不存在: ${projectPath}`, {}, args.json);
  }

  const topN = parseInt(args.top || '20', 10);
  const project = detectProject(projectPath);

  // 收集所有文件（listFiles 已排除 node_modules/.git 等目录）
  const allFiles = listFiles(projectPath, [], ['node_modules', '.git', 'miniprogram_npm', 'typings']);

  // 主包文件（排除分包目录）
  const mainFiles = allFiles.filter((f) => {
    const relPath = f.relPath;
    return !project.info.subpackages.some((s) => {
      const root = s.root || s.name;
      return relPath.startsWith(root + '/');
    });
  });

  // 按类型统计
  const byType = {};
  for (const f of allFiles) {
    if (!byType[f.ext]) byType[f.ext] = { count: 0, totalSize: 0 };
    byType[f.ext].count++;
    byType[f.ext].totalSize += f.size;
  }

  // Top N 大文件
  const topFiles = [...allFiles].sort((a, b) => b.size - a.size).slice(0, topN).map((f) => ({
    path: f.relPath,
    sizeBytes: f.size,
    sizeKB: +(f.size / 1024).toFixed(1),
    sizeMB: +(f.size / 1024 / 1024).toFixed(2),
    ext: f.ext,
  }));

  // 主包大小
  const mainSize = mainFiles.reduce((sum, f) => sum + f.size, 0);
  const mainSizeMB = +(mainSize / 1024 / 1024).toFixed(2);

  // 分包大小
  const subpackageSizes = project.info.subpackages.map((s) => {
    const root = s.root || s.name;
    const subFiles = allFiles.filter((f) => f.relPath.startsWith(root + '/'));
    const size = subFiles.reduce((sum, f) => sum + f.size, 0);
    return {
      name: s.name,
      root,
      fileCount: subFiles.length,
      sizeBytes: size,
      sizeMB: +(size / 1024 / 1024).toFixed(2),
    };
  });

  // 优化建议
  const suggestions = generateSuggestions(mainSizeMB, byType, topFiles, subpackageSizes);

  // 状态判断
  const mainOverLimit = mainSizeMB > 4;
  const status = mainOverLimit ? 'over_limit' : 'ok';

  outputSuccess({
    action: 'package_analyzer',
    project: projectPath,
    status,
    summary: {
      totalFiles: allFiles.length,
      totalSizeMB: +(allFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2),
      mainPackageSizeMB: mainSizeMB,
      mainPackageLimit: 4,
      mainPackageOverLimit: mainOverLimit,
      subpackageCount: subpackageSizes.length,
      subpackages: subpackageSizes,
      totalPackageSizeMB: +(allFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2),
      totalPackageLimitMB: 30,
      totalPackageOverLimit: allFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024 > 30,
      largeSubpackages: subpackageSizes.filter((s) => s.sizeMB > 4),
    },
    byType: Object.entries(byType).map(([ext, info]) => ({
      ext: ext || '(无扩展名)',
      fileCount: info.count,
      totalSizeKB: +(info.totalSize / 1024).toFixed(1),
      totalSizeMB: +(info.totalSize / 1024 / 1024).toFixed(2),
    })).sort((a, b) => b.totalSizeKB - a.totalSizeKB),
    topFiles,
    suggestions,
  }, args.json);
}

function generateSuggestions(mainSizeMB, byType, topFiles, subpackages) {
  const suggestions = [];

  // 主包超标
  if (mainSizeMB > 4) {
    const overflow = +(mainSizeMB - 4).toFixed(2);
    suggestions.push({
      priority: 'P0',
      type: 'main_package_over_limit',
      description: `主包 ${mainSizeMB}MB 超标 ${overflow}MB`,
      actions: [
        '将非首屏资源移入分包',
        '大图/音频上传 CDN',
        '压缩图片（TinyPNG）和音频',
        '字体子集化',
      ],
    });
  }

  // 大体积分包（平台规则：单个普通分包无硬性大小限制，仅独立分包≤4MB；大分包主要影响加载体验）
  const overLimitSubs = subpackages.filter((s) => s.sizeMB > 4);
  if (overLimitSubs.length > 0) {
    suggestions.push({
      priority: 'P1',
      type: 'large_subpackage',
      description: `${overLimitSubs.length} 个分包超过 4MB（普通分包无硬性限制，主要是加载体验；独立分包则超出 4MB 限制）`,
      subpackages: overLimitSubs.map((s) => ({ name: s.name, sizeMB: s.sizeMB })),
      actions: ['拆分超大分包为更小的分包', '将分包内大资源 CDN 化', '压缩分包内资源'],
    });
  }

  // 总包超标（平台规则：总包 ≤ 30MB，含主包+所有分包）
  const totalSizeMB = mainSizeMB + subpackages.reduce((s, p) => s + p.sizeMB, 0);
  if (totalSizeMB > 30) {
    suggestions.push({
      priority: 'P0',
      type: 'total_package_over_limit',
      description: `总包 ${totalSizeMB.toFixed(2)}MB 超过 30MB 限制`,
      actions: ['大幅精简资源', '按需下载（首玩后下载扩展包）', '资源全面 CDN 化'],
    });
  }

  // 图片过大
  const pngInfo = byType['png'] || { totalSize: 0 };
  const jpgInfo = byType['jpg'] || byType['jpeg'] || { totalSize: 0 };
  if ((pngInfo.totalSize + jpgInfo.totalSize) / 1024 / 1024 > 2) {
    suggestions.push({
      priority: 'P1',
      type: 'images_too_large',
      description: '图片资源超过 2MB',
      actions: ['使用 TinyPNG 压缩', '无透明通道的转 JPG', '大图切小或上传CDN', '使用纹理压缩格式（ETC2/ASTC）'],
    });
  }

  // 音频过大
  const mp3Info = byType['mp3'] || { totalSize: 0 };
  const wavInfo = byType['wav'] || { totalSize: 0 };
  if ((mp3Info.totalSize + wavInfo.totalSize) / 1024 / 1024 > 1) {
    suggestions.push({
      priority: 'P1',
      type: 'audio_too_large',
      description: '音频资源超过 1MB',
      actions: ['WAV 转 MP3/AAC', '降低采样率', 'BGM 用流式播放', '音效控制在100KB 内'],
    });
  }

  // Top 大文件建议
  const largeFiles = topFiles.filter((f) => f.sizeKB > 200);
  if (largeFiles.length > 0) {
    suggestions.push({
      priority: 'P2',
      type: 'large_files',
      description: `${largeFiles.length} 个文件超过200KB`,
      files: largeFiles.slice(0, 5).map((f) => f.path),
      actions: ['检查这些文件是否必须放在主包', '考虑移入分包或 CDN', '压缩或裁剪'],
    });
  }

  // JS 代码过大
  const jsInfo = byType['js'] || { totalSize: 0 };
  if (jsInfo.totalSize / 1024 / 1024 > 1.5) {
    suggestions.push({
      priority: 'P2',
      type: 'js_too_large',
      description: 'JS 代码超过 1.5MB',
      actions: ['代码分包加载（require.async，微信小游戏异步分包）', 'Tree-shaking 移除无用代码', '压缩混淆代码（terser）', '按需加载非首屏逻辑'],
    });
  }

  return suggestions;
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));
