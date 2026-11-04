#!/usr/bin/env node
/**
 * asset-check.mjs 素材版权检查（质量自检工具）
 *
 * 用法：
 *   node asset-check.mjs --project <项目路径> [--json]
 *
 * 能力：
 *  - 扫描项目中的图片/音频文件
 *  - 检查EXIF 元数据中是否有AI 生成标记
 *  - 检查文件名是否含已知版权关键词
 *  - 输出疑似风险清单
 *  - 提醒确认商用授权
 */

import { existsSync, readFileSync } from 'node:fs';
import { listFiles } from './lib/project-detector.mjs';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const HELP = `素材版权检查
用法:
  node asset-check.mjs --project <项目路径> [选项]

选项:
  --project <路径>    小游戏项目根目录（必填）
  --json              以 JSON 格式输出
  --help              显示帮助

检查内容
  1. 扫描图片（png/jpg/webp/gif）和音频（mp3/wav/ogg/m4a）
  2. 检查 EXIF 元数据中的 AI 生成标记
  3. 检查文件名是否含版权敏感词
  4. 输出风险等级和建议`;

// 已知版权敏感词（文件名中出现需警惕）——仅用于扫描【待审项目】素材文件名，用于风险提示，不代表本包自身内容
const COPYRIGHT_KEYWORDS = [
  'disney', 'marvel', 'pokemon', 'mario', 'sonic', 'naruto', 'onepiece',
  'genshin', 'honkai', '原神', '崩坏', '王者荣耀', '和平精英', '皮卡丘',
  '米老鼠', '唐老鸭', '蜘蛛侠', '蝙蝠侠', '海贼王', '火影',
];

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

  // 收集素材文件
  const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
  const allAssets = listFiles(projectPath, [...imageExts, ...audioExts], ['node_modules', '.git']);

  const images = allAssets.filter((f) => imageExts.includes(f.ext));
  const audios = allAssets.filter((f) => audioExts.includes(f.ext));

  // 检查每个文件
  const assetReports = [];
  const risks = [];

  for (const asset of [...images, ...audios]) {
    const report = checkAsset(asset, projectPath);
    assetReports.push(report);
    if (report.riskLevel !== 'safe') {
      risks.push(report);
    }
  }

  // 汇总
  const stats = {
    totalAssets: allAssets.length,
    images: images.length,
    audios: audios.length,
    safe: assetReports.filter((r) => r.riskLevel === 'safe').length,
    lowRisk: assetReports.filter((r) => r.riskLevel === 'low').length,
    mediumRisk: assetReports.filter((r) => r.riskLevel === 'medium').length,
    highRisk: assetReports.filter((r) => r.riskLevel === 'high').length,
  };

  let overallStatus = 'safe';
  if (stats.highRisk > 0) overallStatus = 'high_risk';
  else if (stats.mediumRisk > 0) overallStatus = 'medium_risk';
  else if (stats.lowRisk > 0) overallStatus = 'low_risk';

  const recommendations = [];
  if (stats.highRisk > 0) {
    recommendations.push('存在高风险素材，必须确认版权或替换');
  }
  if (stats.mediumRisk > 0) {
    recommendations.push('存在中风险素材，建议确认商用授权');
  }
  // 推荐记录所有素材来源与授权凭证，便于合规审查
  recommendations.push('建议记录所有素材来源与授权凭证（如 credits.txt / 版权说明）');
  if (recommendations.length === 0) {
    recommendations.push('素材版权检查通过，建议保留所有授权记录');
  }

  outputSuccess({
    action: 'asset_check',
    project: projectPath,
    status: overallStatus,
    stats,
    recommendations,
    risks: risks.slice(0, 50),
    totalScanned: allAssets.length,
  }, args.json);
}

function checkAsset(asset, projectPath) {
  const report = {
    path: asset.relPath,
    type: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(asset.ext) ? 'image' : 'audio',
    sizeKB: +(asset.size / 1024).toFixed(1),
    riskLevel: 'safe',
    issues: [],
  };

  // 检查：文件名版权关键词
  const lowerName = asset.relPath.toLowerCase();
  for (const kw of COPYRIGHT_KEYWORDS) {
    if (lowerName.includes(kw.toLowerCase())) {
      report.riskLevel = 'high';
      report.issues.push({
        type: 'copyright_keyword_in_name',
        description: `文件名含版权敏感词 ${kw}`,
        severity: 'high',
      });
      break;
    }
  }

  // 检查：图片EXIF（检查是否有 AI 生成标记）
  if (report.type === 'image' && ['png', 'jpg', 'jpeg'].includes(asset.ext)) {
    try {
      const content = readFileSync(asset.path);
      const exifCheck = checkExifForAI(content, asset.ext);
      if (exifCheck.hasAIMarker) {
        report.riskLevel = report.riskLevel === 'safe' ? 'medium' : report.riskLevel;
        report.issues.push({
          type: 'ai_generated_marker',
          description: `检测到 AI 生成标记: ${exifCheck.marker}`,
          severity: 'medium',
        });
      }
    } catch (_) { /* ignore read errors */ }
  }

  // 检查：超大文件（可能含未压缩版权信息）
  if (asset.size > 5 * 1024 * 1024) {
    report.riskLevel = report.riskLevel === 'safe' ? 'low' : report.riskLevel;
    report.issues.push({
      type: 'large_file',
      description: `文件较大 (${report.sizeKB}KB)，建议确认来源和授权`,
      severity: 'low',
    });
  }

  // 检查：文件名含临时下载标记
  if (lowerName.includes('untitled') || lowerName.includes('temp') || lowerName.includes('download')) {
    report.riskLevel = report.riskLevel === 'safe' ? 'low' : report.riskLevel;
    report.issues.push({
      type: 'temporary_name',
      description: '文件名含临时标记，建议重命名并记录来源',
      severity: 'low',
    });
  }

  return report;
}

function checkExifForAI(buffer, ext) {
  // 简化检测：检查 PNG 的tEXt chunk 或 JPEG 的 EXIF
  try {
    if (ext === 'png') {
      // PNG tEXt chunk 检查
      const content = buffer.toString('latin1');
      if (content.includes('AI generated') || content.includes('Midjourney')
        || content.includes('Stable Diffusion') || content.includes('DALL-E')
        || content.includes('software:AUTOMATIC1111')) {
        return { hasAIMarker: true, marker: 'AI生成工具标记' };
      }
      // 检查software 字段
      const swMatch = content.match(/Software\x00([^\x00]+)/);
      if (swMatch && /midjourney|stable.diffusion|dall|automatic1111|comfyui/i.test(swMatch[1])) {
        return { hasAIMarker: true, marker: swMatch[1] };
      }
    } else if (ext === 'jpg' || ext === 'jpeg') {
      // JPEG EXIF 检查
      const content = buffer.toString('latin1');
      if (content.includes('Midjourney') || content.includes('Stable Diffusion')
        || content.includes('DALL-E')) {
        return { hasAIMarker: true, marker: 'AI生成工具标记' };
      }
    }
  } catch (_) { /* ignore */ }
  return { hasAIMarker: false, marker: null };
}

// 入口：错误兜底输出
main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));


