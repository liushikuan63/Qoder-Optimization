#!/usr/bin/env node
// scaffold.mjs — 小游戏工程脚手架引擎（1.0.8）
// 目标：从空目录生成「合规骨架」——目录结构 + game.json 合规字段 + game.js 入口骨架
//       + 分包配置模板 + 项目态初始化。非可运行引擎工程（引擎工程由用户用编辑器打开骨架后填充）。
// 依赖：仅 node: 内置模块。无任何外部依赖，无网络。CLI 缺失时优雅降级（仅提示，不中断）。
//
// 用法：
//   node scaffold.mjs --platform wechat|douyin --engine cocos|native \
//       --name "游戏名" --monetization iaa|iap [--genre casual|puzzle|action|board] [--workspace <dir>] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      if (v !== true) i++;
      out[k] = v;
    }
  }
  return out;
}

const VALID = {
  platform: ['wechat', 'douyin'],
  engine: ['cocos', 'native'],
  monetization: ['iaa', 'iap'],
};

function fail(msg) {
  console.error('[scaffold] ERROR: ' + msg);
  process.exit(1);
}

function loadPlatforms() {
  const p = path.join(ROOT, 'references', 'data', 'platforms.json');
  if (!fs.existsSync(p)) fail('找不到 references/data/platforms.json（scaffold 依赖平台元数据）');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail('platforms.json 解析失败：' + e.message);
  }
}

function sanitizeName(name) {
  // 用于目录名/文件名：保留中文与字母数字，替换非法字符
  const s = String(name).trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
  return s || 'minigame';
}

function buildGameJson(plat) {
  const base = {
    deviceOrientation: 'portrait',
    showStatusBar: false,
    networkTimeout: { request: 10000, downloadFile: 10000 },
    subpackages: [{ name: 'sub1', root: 'subpackages/sub1/' }],
  };
  if (plat === 'douyin') {
    // 抖音小游戏 game.json 字段（以官方文档为准，执行期二次核实）
    return {
      deviceOrientation: 'portrait',
      subpackages: [{ name: 'sub1', root: 'subpackages/sub1/' }],
    };
  }
  // 微信小游戏 game.json 字段
  return base;
}

function buildGameJs(engine, prefix) {
  if (engine === 'cocos') {
    return `// game.js —— 微信/Cocos 小游戏入口骨架（1.1.0 生成）
// 说明：本文件为合规骨架入口，真实引擎逻辑由用户用 Cocos Creator 打开工程后填充。
// ${prefix} 为该平台全局对象前缀（微信 wx / 抖音 tt），业务代码须用对应前缀 API。
GameGlobal.canvas = ${prefix}.createCanvas();
GameGlobal.request = ${prefix}.request;

// 引擎启动（示例，需替换为实际 Cocos 构建产物入口）
// require('cocos-creator'); // 由 Cocos 构建后注入，此处仅占位说明

${prefix}.onShow && ${prefix}.onShow(() => {});
${prefix}.onHide && ${prefix}.onHide(() => {});

${prefix}.onLaunch && ${prefix}.onLaunch(() => {
  console.log('[scaffold] 小游戏启动骨架就绪，请填充实际游戏逻辑');
});
`;
  }
  // native（原生 Canvas/WebGL）
  return `// game.js —— 原生小游戏入口骨架（1.1.0 生成）
// 说明：本文件为合规骨架入口，渲染逻辑由用户基于 ${prefix} 全局对象填充。
GameGlobal.canvas = ${prefix}.createCanvas();

let last = 0;
function loop(ts) {
  const dt = ts - last; last = ts;
  // TODO: 渲染与更新逻辑（用户填充）
  ${prefix}.requestAnimationFrame(loop);
}
${prefix}.onLaunch && ${prefix}.onLaunch(() => ${prefix}.requestAnimationFrame(loop));
`;
}

function humanInTheLoopTable() {
  return [
    '# 人类协作边界（human-in-the-loop）',
    '',
    '| 步骤 | 执行方 | 说明 |',
    '|------|--------|------|',
    '| 生成目录结构 / game.json / game.js 骨架 | agent 自动 | 本脚手架完成 |',
    '| 游戏逻辑 / 美术 / 音频 / 关卡填充 | 用户手动 | 编辑器内完成，agent 不直接生成可玩内容 |',
    '| 本地构建为平台包 | 用户手动 / 仅 CLI 存在时 agent 辅助 | 需微信开发者工具或 Cocos Creator 已安装；缺失则降级提示 |',
    '| 真机预览 / 上传 / 提审 | 用户手动 | agent 产出 checklist，不断言"已上架" |',
    '| 合规字段与包体预算预检 | agent 自动 | 本脚手架 + package-analyzer 校验 |',
    '',
  ].join('\n');
}

function viabilityHint(genre) {
  if (!genre) return '';
  return [
    '',
    '## 市场契合提示（参考，非承诺）',
    '',
    `> 品类「${genre}」的选型可行性请交叉阅读 references/knowledge/market-data.md，',
    '> 由 agent 在引导阶段结合目标平台给出 viability 提示。`,
    '> 所有市场结论须标注来源与核实日期，未核实项标"待官方核实"。',
    '',
  ].join('\n');
}

function usage() {
  console.log(`scaffold.mjs — 小游戏工程脚手架引擎（生成「合规骨架」，非可运行引擎工程）

用法：
  node scripts/scaffold.mjs --platform <wechat|douyin> --engine <cocos|native> \\
      --name <游戏名> --monetization <iaa|iap> [--genre <品类>] [--workspace <dir>] [--out <dir>]

必填：
  --platform      目标平台（当前支持 wechat / douyin）
  --engine        技术栈（cocos / native）
  --name          游戏名称（用于目录名与 game.json）
  --monetization  变现模式（iaa 广告 / iap 内购）

可选：
  --genre         品类（自由文本或 casual|puzzle|action|board，仅写入项目态用于市场提示）
  --workspace     工作区根目录，默认当前目录
  --out           骨架输出目录，默认 <workspace>/<sanitize(name)>
  --help          显示本帮助

产出：目录结构 + game.json 合规字段 + game.js 入口骨架 + 分包配置模板 + 项目态初始化。
边界：产出为合规骨架，不是可运行引擎工程；引擎工程由用户在编辑器中打开骨架后填充。
       human-in-the-loop 边界详见 references/knowledge/scaffold.md。`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const platform = String(args.platform || '').toLowerCase();
  const engine = String(args.engine || '').toLowerCase();
  const monetization = String(args.monetization || '').toLowerCase();
  const name = args.name ? String(args.name) : null;
  const genre = args.genre ? String(args.genre).toLowerCase() : null;
  const workspace = args.workspace ? path.resolve(String(args.workspace)) : process.cwd();
  const out = args.out ? path.resolve(String(args.out)) : path.join(workspace, sanitizeName(name || 'minigame'));

  if (!VALID.platform.includes(platform)) fail(`--platform 必填且为 ${VALID.platform.join('|')}`);
  if (!VALID.engine.includes(engine)) fail(`--engine 必填且为 ${VALID.engine.join('|')}`);
  if (!VALID.monetization.includes(monetization)) fail(`--monetization 必填且为 ${VALID.monetization.join('|')}`);
  if (!name) fail('--name 必填（游戏名）');

  const registry = loadPlatforms();
  // platforms.json 结构：{ version, platforms: {...}, globalObjectToPlatform: {...} }
  const platforms = registry.platforms && typeof registry.platforms === 'object' ? registry.platforms : registry;
  const pmeta = platforms[platform];
  if (!pmeta) fail(`platforms.json 无平台「${platform}」元数据`);
  const prefix = pmeta.globalObject || (platform === 'douyin' ? 'tt' : 'wx');
  const limits = pmeta.packageLimitMB || pmeta.packageLimits || {};

  // 创建目录
  const dirs = [
    out,
    path.join(out, 'src'),
    path.join(out, 'subpackages', 'sub1'),
    path.join(out, '.workbuddy', 'minigame-dev'),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });

  // game.json
  fs.writeFileSync(path.join(out, 'game.json'), JSON.stringify(buildGameJson(platform), null, 2) + '\n', 'utf8');
  // game.js
  fs.writeFileSync(path.join(out, 'game.js'), buildGameJs(engine, prefix), 'utf8');
  // 分包入口占位
  fs.writeFileSync(path.join(out, 'subpackages', 'sub1', 'game.js'), '// sub1 分包入口骨架（用户填充）\n', 'utf8');
  // 项目态
  const projectState = {
    schema: 'minigame-dev.project-state/v1',
    name,
    id: sanitizeName(name),
    platforms: [platform],
    engine,
    monetization,
    genre: genre || null,
    createdAt: new Date().toISOString().slice(0, 10),
    stage: 'scaffold',
    scaffoldVersion: '1.1.0',
  };
  fs.writeFileSync(
    path.join(out, '.workbuddy', 'minigame-dev', 'project-state.json'),
    JSON.stringify(projectState, null, 2) + '\n', 'utf8'
  );
  // README（人类协作边界 + 市场提示）
  fs.writeFileSync(
    path.join(out, 'README.md'),
    [
      '# ' + name,
      '',
      `> 平台：${platform}（API 前缀 ${prefix}）｜引擎：${engine}｜变现：${monetization}${genre ? '｜品类：' + genre : ''}`,
      '> 本目录由 scaffold.mjs (1.1.0) 生成的**合规骨架**，非可运行工程。',
      '',
      humanInTheLoopTable(),
      '',
      '## 包体预算预检（参考 platforms.json，非强制拦截）',
      `- 主包上限：${limits.mainPackageMB ?? '待核实'} MB`,
      `- 总包上限：${limits.totalPackageMB ?? '待核实'} MB`,
      `- 独立分包上限：${limits.independentSubPackageMB ?? '待核实'} MB`,
      '- 注：抖音等平台数值以官方文档为准，执行期二次核实，核实前标"待官方核实"。',
      viabilityHint(genre),
    ].join('\n'),
    'utf8'
  );

  console.log('[scaffold] 已生成合规骨架：' + out);
  console.log(`[scaffold] 平台=${platform} 前缀=${prefix} 引擎=${engine} 变现=${monetization}${genre ? ' 品类=' + genre : ''}`);
  console.log('[scaffold] 生成文件：game.json / game.js / subpackages/sub1/game.js / README.md / .workbuddy 项目态');
  console.log('[scaffold] 下一步：用户用编辑器打开并填充游戏逻辑；构建与上传为手动步骤（见 README 人类协作边界）。');
  console.log('[scaffold] 注意：.workbuddy/ 为运行时态，打包发布时须排除，不进交付物。');
  process.exit(0);
}

main();
