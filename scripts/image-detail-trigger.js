#!/usr/bin/env node
'use strict';
// PostToolUse hook: after a Read of an IMAGE, nudge proactive precise recognition.
// Fires only for Read + image extension; silent otherwise; fail-open on any error.
// Contract: {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext}} (see continuity.cjs).
const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;

function done(ctx) {
  if (ctx) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx },
    }));
  }
  process.exit(0);
}

let raw = '';
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(raw || '{}');
    const event = p.hook_event_name || p.hookEventName || '';
    if (event !== 'PostToolUse') return done('');
    const tool = p.tool_name || p.toolName || '';
    const input = p.tool_input || p.toolInput || {};
    const path = String(input.file_path || input.path || '');
    if (tool !== 'Read' || !IMG.test(path)) return done('');
    done('【精确识图·主动触发】刚 Read 了图片 ' + path + '。若对其细节/小字/纹理/色彩/光影拿不准'
      + '（在猜、存疑、读不出），或任务要求精确识图：主动加载 image-detail-inspect'
      + '（skill-load 关键词 imgdetail），用 crop/zoom 裁剪放大细读 + stats 量化 + compare 局部采样放大对比'
      + '后再下结论；不得以模糊整图读数汇报。模型视觉为主读者，OCR 仅可选交叉核对（离线可用 bundle）。');
  } catch (e) {
    done('');
  }
});