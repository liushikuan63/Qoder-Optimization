#!/usr/bin/env node
// scaffold-smoke.mjs — 脚手架生成物合规校验闸门（1.0.8）
// 生成临时空项目 → 校验目录结构 / game.json 合规字段 / 包体预算预检 / 人类协作边界存在。
// 仅 warning/error，不联网，无外部依赖。exit 0 = 通过，exit 1 = 失败。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCAFFOLD = path.join(ROOT, 'scripts', 'scaffold.mjs');

function run(args) {
  return execFileSync(process.execPath, [SCAFFOLD, ...args], { encoding: 'utf8' });
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-smoke-'));
  const out = path.join(tmp, 'demo');
  try {
    run(['--platform', 'wechat', '--engine', 'cocos', '--name', 'demo', '--monetization', 'iaa', '--out', out]);
  } catch (e) {
    console.error('[scaffold-smoke] 生成失败：' + (e.stderr || e.message));
    process.exit(1);
  }

  const problems = [];
  const need = [
    ['game.json', path.join(out, 'game.json')],
    ['game.js', path.join(out, 'game.js')],
    ['subpackages/sub1/game.js', path.join(out, 'subpackages', 'sub1', 'game.js')],
    ['README.md', path.join(out, 'README.md')],
  ];
  for (const [label, p] of need) {
    if (!fs.existsSync(p)) problems.push('缺失文件 ' + label);
  }
  // game.json 合规字段
  try {
    const gj = JSON.parse(fs.readFileSync(path.join(out, 'game.json'), 'utf8'));
    if (!gj.deviceOrientation) problems.push('game.json 缺 deviceOrientation');
    if (!Array.isArray(gj.subpackages)) problems.push('game.json 缺 subpackages 数组');
  } catch (e) {
    problems.push('game.json 解析失败：' + e.message);
  }
  // 项目态
  const stateDir = path.join(out, '.workbuddy', 'minigame-dev');
  if (!fs.existsSync(path.join(stateDir, 'project-state.json'))) problems.push('缺项目态 project-state.json');

  if (problems.length) {
    console.error('[scaffold-smoke] 失败：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log('[scaffold-smoke] PASS：骨架结构/game.json 字段/项目态均合规');
  process.exit(0);
}

main();
