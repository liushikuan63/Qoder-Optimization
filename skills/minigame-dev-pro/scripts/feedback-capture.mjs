#!/usr/bin/env node
// feedback-capture.mjs — 捕获用户反馈信号（1.0.8）
// 用法：node feedback-capture.mjs --signal <invalid|outdated|rejected|launched> --context "<文本>"
// 写入 <workspace>/.workbuddy/minigame-dev/feedback-log.json（追加）。
import { appendFeedback } from './lib/user-profile.mjs';

const VALID = ['invalid', 'outdated', 'rejected', 'launched'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--signal') out.signal = argv[++i];
    else if (argv[i] === '--context') out.context = argv[++i];
    else if (argv[i] === '--source') out.source = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.signal || !VALID.includes(args.signal)) {
    console.error(`[feedback-capture] 错误：--signal 必须是 ${VALID.join('|')}`);
    process.exit(1);
  }
  const ok = appendFeedback({
    signal: args.signal,
    context: args.context || '',
    source: args.source || '',
  });
  if (!ok) {
    console.error('[feedback-capture] 写入失败');
    process.exit(1);
  }
  console.log(`[feedback-capture] 已记录信号 ${args.signal}`);
}

main();
