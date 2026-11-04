# 工程脚手架引擎（Scaffold · 1.0.8）

> 最后更新：2026-09-03
> 最后核实：2026-09-03（引擎能力；平台包体数值以 platforms.json 为准，执行期二次核实）
> 核实周期：90d
> 下次核实：2026-12-02
> 主要来源：微信/抖音官方开发者文档（包体限制、game.json 字段）、本 Skill 工程实践

## 定位

脚手架引擎 `scripts/scaffold.mjs` 用于从**空目录**生成小游戏的**合规骨架**——不是可运行引擎工程，而是"合规的起点"。

它能生成：
- 标准目录结构（`src/`、`subpackages/sub1/`、`.workbuddy/minigame-dev/<项目>/`）
- `game.json` 合规字段（平台口径：微信 `deviceOrientation`/`subpackages`；抖音 `subpackages`）
- `game.js` 入口骨架（按平台 API 前缀 `wx`/`tt` 生成全局对象绑定，渲染逻辑由用户填充）
- 分包入口占位
- 项目态 `project-state.json`（供 project-detector / user-profile 续接）
- `README.md`（含人类协作边界表 + 包体预算预检 + 市场契合提示）

## 调用方式

```bash
node scripts/scaffold.mjs \
  --platform wechat|douyin \
  --engine cocos|native \
  --monetization iaa|iap \
  --name "游戏名" \
  [--genre casual|puzzle|action|board] \
  [--workspace <dir>] [--out <dir>]
```

参数校验：platform / engine / monetization / name 为必填；缺项即报错退出（exit 1），不静默生成半成品。

## 人类协作边界（human-in-the-loop）

脚手架明确划清"agent 自动 / 用户手动"，不承诺做不到的闭环：

| 步骤 | 执行方 | 说明 |
|------|--------|------|
| 生成目录结构 / game.json / game.js 骨架 | agent 自动 | 本引擎完成 |
| 游戏逻辑 / 美术 / 音频 / 关卡填充 | 用户手动 | 编辑器内完成，agent 不直接生成可玩内容 |
| 本地构建为平台包 | 用户手动 / 仅 CLI 存在时 agent 辅助 | 需微信开发者工具或 Cocos Creator 已安装；缺失则降级提示 |
| 真机预览 / 上传 / 提审 | 用户手动 | agent 产出 checklist，不断言"已上架" |
| 合规字段与包体预算预检 | agent 自动 | 本引擎 + package-analyzer 校验 |

## 市场契合集成（深化⑧）

引导阶段（onboarding）第 1 问采集"目标品类"，脚手架生成后 agent 交叉 `references/knowledge/market-data.md` 给出该平台该品类的 viability 提示。所有市场结论须标注来源与核实日期，未核实项标"待官方核实"，不得当作确定性承诺。

## 验证

`tests/scaffold-smoke.mjs`：生成临时空项目 → 校验目录结构 / game.json 合规字段 / 项目态 / 人类协作边界存在，exit 0 通过。该闸门纳入 1.0.6 全量自检。

## 注意

`.workbuddy/` 为运行时态，**打包发布时须排除，不进交付物**（深化⑦）。
