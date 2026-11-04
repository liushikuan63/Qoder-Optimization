---
last_verified: 2026-09-04
verify_cycle: T+90d
next_verify: 2026-12-03
primary_source: 微信小游戏/抖音小游戏资产规范 + 各平台官方素材审核文档（实时联网核验为准）
---

# 资产生产工作流（Asset Production Pipeline）

> 对应工具：`scripts/asset-audit.mjs` + `tests/asset-gate.mjs`。本文件把"资产规格 + 授权"落成可校验闭环。

---

## 1. 范围与边界（Human-in-the-loop）

| 事项 | agent 能做 | 必须由人或平台工具做 | 为什么 |
|------|-----------|-------------------|--------|
| 资产规格审计（命名/格式/尺寸/授权声明） | ✅ 静态扫描 + 规则 | — | 纯本地规则 |
| 未授权 IP 命中识别 | ✅ 文件名线索比对 `copyright-ip.json` | ✅ 人工确权授权 | 文件名线索 ≠ 授权事实，命中即硬违规需确权 |
| 生图 / 生音频（生成式资产） | ❌ 本地不跑 ML | ✅ 平台工具 / 云端出图 | 本地算力不足；与"本地 ComfyUI 生图作废"纪律一致 |
| 资产授权确权 / 真机表现 | ❌ | ✅ 法务 + 美术 QA | agent 不做法律确权与渲染判定 |

**纪律**：本工具只审计规格，不本地生成任何图像/音频 ML。生图/生音频引用平台工具或文档工作流；授权声明缺失仅 warn，未授权 IP 命中为**硬违规**（fail 级，交人工确权，禁止未授权商用）。

## 2. 资产目录与命名规范

```
assets/                 (或 res/ 、 src/assets/)
  art/                  # png/jpg/webp/svg
  music/                # mp3/wav/ogg/m4a
  font/                 # ttf/otf/woff/woff2
  data/                 # json/atlas/plist/skel
  asset-spec.json       # 资产授权登记
```

- 命名：`^[a-z0-9_]+(\.[a-z0-9]+)?$`（小写+下划线/连字符，无空格/中文）。
- 格式白名单：art=png/jpg/jpeg/webp/svg；music=mp3/wav/ogg/m4a；font=ttf/otf/woff/woff2；data=json/atlas/plist/skel。
- 尺寸建议上限：art 2MB / music 5MB / font 10MB / data 1MB（超限 warn）。

## 3. 授权声明（asset-spec.json）

```json
{
  "assets": {
    "hero_bg.png": { "license": "CC0", "source": "自绘" },
    "bgm_loop.mp3": { "license": "商用授权", "source": "网易云商用曲库 #ID" }
  }
}
```

- 每个**需商用授权/开源许可**的资产类（按 `copyright-ip.json` 的 `assetTypes.requireLicense`）须在 `asset-spec.json` 登记 `license` + `source`。
- 缺失声明 → warn（不阻断）；登记但两者均无 → warn。

## 4. 未授权 IP 红线

- `references/data/copyright-ip.json` 的 `unauthorizedIpHints` 提供未授权 IP/品牌角色**文件名线索**（如知名 IP 角色名）。
- 文件名命中 → 硬违规，asset-gate 直接 `fail`（exit 1），交人工确权；确权前**禁止发布**。
- 诚实标注：文件名线索 ≠ 授权事实，工具只做信号，确权在人工/法务。

## 5. 资产生产工作流（生成式资产）

1. 产出方向：引用 `../art-audio.md` 的风格/配色/图标规范定稿。
2. 生图/生音频：用平台工具或云端出图（本地不跑 ML），导出满足第 2 节格式/尺寸。
3. 入库：放入对应 `assets/<类>/`，命名合规，登记 `asset-spec.json` 授权。
4. 交付前：`node tests/asset-gate.mjs --project <项目>` —— 无硬违规 + 授权齐备。

## 6. 引用

- 美术/音频风格总指南：`../art-audio.md`
- IP/版权红线：`../../data/copyright-ip.json` + `compliance/compliance-rules.md`
- 合规扫描联动：`sensitive-word-gate.mjs` / `ip-compliance-check.mjs`
