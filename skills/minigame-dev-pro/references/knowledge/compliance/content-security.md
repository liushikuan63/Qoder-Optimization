---
title: 内容安全与敏感词（L3）
last_updated: 2026-09-03
last_verified: 2026-09-03
verify_cycle: 30d
next_verify: 2026-10-03
primary_source: 各平台内容安全接口 + 网信办公开清单
platform: national
---

# 内容安全与敏感词（L3）

> 内容安全属国家层统一要求 + 平台层接口落地的交叉维度。须建立**本地分类词库**并定期更新，同时接入对应平台官方内容安全接口。

## 一、敏感词七分类（本地词库）

分类：政治 / 色情 / 暴力 / 宗教 / 民族 / 地域歧视 / 赌博。

- 本地词库见 `references/data/sensitive-words.json`，供 `scripts/sensitive-word-scan.mjs` 预检。
- 词库须定期更新，来源参考网信办公开清单与各平台内容安全规范。
- 命中即人工复核，不得直接判定违规；政治类须特别谨慎，避免误伤正常表述。

## 二、各平台内容安全接口路由

- **微信**：由自有服务端调用 `security.msgSecCheck` / `security.imgSecCheck`（小游戏客户端无直接调用接口，须经开发者服务器）。详见 `references/data/spec-registry.json` SP-017。
- **抖音**：对应 tt 体系内容安全接口（路径待执行期核实，标 `pending-verify`）。详见 SP-018。

> 路由纪律：内容安全接口按目标平台取子集，禁止把微信 `security.*` 当通用接口陈述。

## 三、UGC 接入要求

- 用户生成内容（昵称、头像、聊天、评论）须接入官方内容安全接口。
- 未接入即上线属违规（对应 compliance-scan RULE-013）。

## 四、地图与领土合规（硬要求）

- 地图素材须包含**台湾、南海九段线**，且来源合法。
- 合法来源：自然资源部标准地图服务（详见 `references/data/spec-registry.json` SP-019）。
- 网上下载地图 90% 以上存在领土标注问题，禁止使用未核实地图。由 `tests/map-territory-check.mjs` 拦截缺台湾 / 南海九段线素材。

## 五、自检

- 文本：`scripts/sensitive-word-scan.mjs`
- 地图：`tests/map-territory-check.mjs`
- 接口接入：`scripts/compliance-scan.mjs` RULE-013
