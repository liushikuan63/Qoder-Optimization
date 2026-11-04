---
last_verified: 2026-09-04
verify_cycle: T+90d
next_verify: 2026-12-03
primary_source: 微信/抖音/Google Play 出海合规文档（实时联网核验为准，见 ip-compliance-check / sensitive-word-gate）
---

# 出海本地化闭环（Localization Lifecycle）

> 对应工具：`scripts/localize-check.mjs` + `tests/i18n-gate.mjs`。本文件把"出海本地化"从口号落成可校验的工程闭环。

---

## 1. 范围与边界（Human-in-the-loop）

| 事项 | agent 能做 | 必须由人或专业服务做 | 为什么 |
|------|-----------|-------------------|--------|
| i18n 资源完整性校验 | ✅ 缺键/空值/疑似未翻译/敏感词预检 | — | 纯静态解析 |
| 文案翻译 | ❌ | ✅ 专业译员/母语审校 | 机翻质量不可控、文化误差风险 |
| 跨语言敏感词判定 | ⚠️ 仅本地词库预检（源语言） | ✅ 结合各平台官方最新清单 + 母语复核 | 词库有限、语境依赖强，命中即人工复核 |
| 真机/母语 UI 走查 | ❌ | ✅ 本地化 QA | agent 不做渲染判定 |

**纪律**：本工具只校验完整性，不翻译、不生成任何文案。命中敏感词**不直接判定违规**，一律交人工复核。

## 2. 资源结构约定

```
locales/                (或 i18n/ 、 src/locales/ 、 assets/i18n/)
  zh.json               # 默认/源语言（必含全量键）
  en.json
  ja.json
  ...
```

- 任意层级扁平化后，目标语言必须**全量含默认语言的键**（缺键 = i18n-gate warn）。
- 空字符串 / `null` = empty（warn）。
- 目标语言值**等于**默认语言同键字符串 = 疑似未翻译（warn）——真漏译信号。

## 3. 校验流程（与闸门联动）

1. 开发期：每加一个 UI 文案键，先在 `zh.json` 落地。
2. 提测前：跑 `node scripts/localize-check.mjs --project <项目>` 看缺口。
3. 交付前：`node tests/i18n-gate.mjs --project <项目>` 必须非空 `fail`（本闸门最佳结果 `skip`，绝不 `pass`）。
4. 翻译由专业服务/人工完成后，重跑至缺口清零。

## 4. 跨语言敏感词预检

- 复用 `references/data/sensitive-words.json` 七分类词库（政治/暴恐/色情/赌博/辱骂/违法/医疗）。
- **局限性（诚实标注）**：本地词库为中文分类示例词，仅覆盖**源语言字符串命中**；其他语言须结合平台官方最新清单补充。正式发布前须母语复核 + 平台官方清单双保险。

## 5. 目标语言取舍

- 首出海建议：`en`（通用）+ 区域强市场（ja/ko/zh-TW 视市场）。
- 各平台审核语言清单以官方实时文档为准（见 `ip-compliance-check.mjs` / `sensitive-word-gate.mjs` 联动）。

## 6. 引用

- 通用美术/音频风格参考：`../art-audio.md`
- 合规红线总览：`compliance/compliance-rules.md`
- 付费/版号联动：`game-design/economy-balance.md`
