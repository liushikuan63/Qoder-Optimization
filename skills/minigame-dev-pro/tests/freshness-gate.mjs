#!/usr/bin/env node
// freshness-gate.mjs — 时效闸门（1.0.5）
// 运行 verify-specs + freshness-check，任一 fail 即阻断发布。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const node = process.execPath;

function run(script) {
  try {
    execFileSync(node, [path.join(ROOT, 'scripts', script)], { stdio: 'inherit', cwd: ROOT });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

const a = run('verify-specs.mjs');
const b = run('freshness-check.mjs');
const ok = a === 0 && b === 0;
console.log(`\nfreshness-gate=${ok ? 'PASS' : 'FAIL'} (verify-specs=${a}, freshness-check=${b})`);
process.exit(ok ? 0 : 1);
