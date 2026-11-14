---
name: image-detail-inspect
description: "图像细节增强读取：大图先被降采样导致小字/小目标读不出时，用网格总览定位→按 bbox 裁剪放大→逐块读→按源坐标拼回整图。Pillow 零依赖，单块压到 1.5MB 内避开 Read 守卫；坐标往返与可读性 A/B 有自测。触发词：看不清、精确识图、识别不准、小字、放大图片、读细节、裁剪放大、图像细读、拼细节、imgdetail。不用于生成图验收→image-result-visual-verify；加密文档→encrypted-office-visual-inspection；SPA 截图→headless-spa-screenshot。"
---

# 图像细节增强读取（总览→定位→放大→逐块读→坐标拼接）

## §0 何时用 / 何时不用

**用**：一张图整体能看但局部读不出——小字、序列号、表格单元格、细线、小图标、远处物体。
整图 Read 后你发现自己在"猜"某个字符串，就是该用本技能的信号。

**不用**（边界，避免同域第 N 份泛化版）：

- 生成图（imagegen 产物）的成图验收 → `image-result-visual-verify`（它管缩图/JPEG/提示词分句比对）。
- 企业透明加密 Office 打不开、要逐页截图取证 → `encrypted-office-visual-inspection`。
- 异步渲染 SPA 截到白壳、要拖 load 事件 → `headless-spa-screenshot`。
- 真实交互验收（点按钮/提交）→ `verify-ui-in-browser`；本技能只读像素，不证明交互。

本技能与它们的分工：**它们负责"拿到一张能看的图"，本技能负责"把已拿到的图读细"**。

## §1 机制（为什么有效，别夸大）

大图进视觉管线前会被降采样/切块，小字在降采样那一刻就被毁掉了。
**裁剪一个区域单独送，该区域就不再被整图降采样**——这是收益的真正来源。

放大（`--scale`）是插值，**不产生新信息**；它的作用是把小字形放大到可读尺寸。
所以：先裁剪（去掉降采样），再按需放大（放大字形）。只放大不裁剪＝把糊图放大，依旧糊。

诚实边界：源图只有 6px 的字形信息时，放大后仍可能有个别同形字符（0/O、1/l）拿不准。
本技能把"读不出"变成"读得出大部分＋明确标出存疑字符"，不承诺 100% 复原。

## §2 环境（零新依赖）

用你本机**装了 Pillow 的 Python**（`python` / `py`）。若 PATH 里的 `python` 是商店空壳或别的
profile，改用其绝对路径。核心只依赖 Pillow（实测 12.x）。

产物目录由 `--out` 或环境变量 `IMGDETAIL_OUT` 指定，默认 `<系统临时目录>/imgdetail`；
按本机习惯可固定到非系统盘（例如 `IMGDETAIL_OUT=D:/tmp/imgdetail`），避免写满系统盘。
**模型自身视觉是主读者**（允许调用模型能力）：裁剪放大后由模型直接 Read 逐块读，这是效果的主要来源；
OCR 仅作可选的第二读者交叉核对。**离线/内网无 OCR 时，纯模型视觉流程完整可用**，不降级核心能力。
OCR 为可选增强，见 §7 与 `references/ocr.md`（含离线 bundle 方案）；未装时核心命令完全不受影响。

## §3 主流程

1. **probe**：看尺寸/字节/是否超 Read 守卫，决定要不要分块。
2. **overview**：出带网格标号（A1…C3）的总览图＋manifest，先定位"哪一格有问题"。
3. **crop / tile**：对目标格按 bbox 裁剪＋放大；整图都要读细就用 `tile` 一次切全。
4. **逐块 Read**：一次读一块，记录读到的内容与存疑字符。
5. **map 拼接**：把块内坐标换回源图坐标，结论才能落回整图位置（"第几行第几列的值是多少"）。

## §4 命令

`--max-bytes` 是**顶层参数，必须放在子命令前面**。

```
PY="python"   # 或你本机装了 Pillow 的 Python 绝对路径
S="<技能目录>/scripts/imgdetail.py"
OUT="${IMGDETAIL_OUT:-<临时目录>/imgdetail}"

"$PY" "$S" probe 图.png
"$PY" "$S" overview 图.png --grid 3x3 --out "$OUT"
"$PY" "$S" crop 图.png --bbox 100,100,620,300 --scale 4 --name r6 --out "$OUT"
"$PY" "$S" tile 图.png --grid 3x3 --scale 2 --overlap 0.08 --out "$OUT"
"$PY" "$S" map "$OUT/tiles.json" --tile B2 --point 120,80
"$PY" "$S" stats 图.png --bbox 100,100,620,300
"$PY" "$S" compare 源.png 成果.png --bbox 100,100,620,300 --scale 3 --name pair --out "$OUT"
```

- `--bbox` 用**源图像素**坐标 x0,y0,x1,y1；越界/反序/缺值都会非 0 报错。
- `--scale` 默认 1（原生裁剪）。小字建议 3–4；>12 会被拒（纯插值浪费上下文）。
- `--enhance none|contrast|sharpen|both`：增强图**只作线索**，锐化会造出假边缘，
  最终结论以未增强的原生/放大裁剪为准。
- `tile --overlap` 默认 0.08，防止目标正好压在格边界被切断。
- 每个产物旁有同名 `.json` sidecar，记录 bbox、**实测 scale**、字节、格式。

## §5 体积与 Read 守卫

`huge-output-guard.js` 对 >1.5MB 的图片直接拦 Read。本脚本把每块压到 ≤1.5MB：
先 PNG，超了走 JPEG 质量梯（92→62），再超就按 0.85 逐次缩。
**坐标映射用的 scale 是从实际输出尺寸量出来的**（`scale = 输出宽 / bbox 宽`），
所以即使被体积预算缩过，`map` 仍然正确——不要拿请求的 scale 去算坐标。

## §6 验证（判据要能失败）

```
"$PY" "<技能目录>/scripts/selftest.py"                 # R2 负对照 / R3 体积 / R4 坐标往返
"$PY" "<技能目录>/scripts/selftest.py" --ab-readings <读数.json>   # R1 可读性 A/B 计分
```

自测夹具目录由 `IMGDETAIL_SELFTEST_WORK` 指定（默认临时目录）；字体自动探测常见系统字体，
也可用 `IMGDETAIL_FONT` 指定一个 TTF。

- R2：缺失路径/越界 bbox/反序/零字节/不可解码/坏 grid/坏 point 必须非 0；正常输入 exit 0 且尺寸=bbox×scale。
- R3：所有产物 ≤1.5MB。
- R4：标记点坐标往返误差 ≤1px，且**有效测量数 >0**（零测量报绿＝假绿，已防）。
- R1（model-in-the-loop）：selftest 只**准备**三臂（整图 / 原生裁剪 / 放大裁剪）并把真值写进
  `expected.json`。**先 Read 三臂、记下读数，最后才开 expected.json 对答案**；
  先开真值会污染测试。判绿条件＝至少一个区域"整图读错、放大后读对"。
- R9（降幻觉负对照）：夹具含一块**空白区**；读数必须报空白，编造任何字符串即红。
- R10（非文字属性正负对照）：`compare` 同图自比必须 diff=0；真实差异图必须 diff>0 且
  饱和/纹理/对比差值显著；`stats` 能区分高饱和/有纹理与灰底/无纹理。

## §7 OCR（可选增强，含离线方案）

见 `references/ocr.md`。核心裁剪/放大不依赖 OCR；OCR 只在"纯文字图、要批量抽字符串"或
"给模型视觉读法做独立交叉核对"时加分。**模型视觉为主、OCR 为辅**；两者不一致标存疑不选边。

**离线/内网（分享后不可下载）**：用 `scripts/build-ocr-offline-bundle.py` 在联网机把官方
wheels＋本地模型打成 bundle；内网用 `scripts/install-ocr-offline.py --bundle <dir> --target <dir>`
以 `--no-index --find-links` 零网络安装。运行时 rapidocr 优先读本地模型、不触网。
未安装时 `ocr` 子命令 exit 5 并提示降级到纯模型视觉，不静默失败。
OCR 库目录由 `IMGDETAIL_OCR_LIB` 指定（隔离测试可用它覆盖）。

## §8 已知坑

- 6px 级小字放大后仍可能有 0/O、1/l 同形歧义：标存疑，别硬猜。
- 只放大不裁剪＝放大糊图，无收益。
- `--max-bytes` 放子命令后面会被 argparse 当未知参数报错。
- 增强（锐化/对比）会造假边缘，结论以未增强裁剪为准。
- 坐标一律用 sidecar 的实测 scale，别用请求 scale。

## §9 描述协议（降幻觉：看得清还要说得准、说得细）

读细只是第一步；**描述必须可核对**，否则放大反而给了幻觉更多素材。逐条遵守：

1. **逐字转录＋逐字符置信度**。读不全不补全；同形字符（0/O、1/l、8/B、5/S）标存疑，不硬猜。
2. **每个断言绑定位置**：tile id＋源坐标（用 `map` 回写）。"左上角那行"不算位置，`A1 bbox(100,100,620,300)` 才算。
3. **计数必须实数**：线条/格子/对象个数要真的数（放大后数），不写"若干/大约"。
4. **空白必须报空白**：没内容的区域写"无"，不得编造（R9 负对照就是查这条）。
5. **双读者交叉**：视觉放大读法与 OCR 读法不一致时，标存疑、列出两种读法，不选边站。
   一致时才给高置信。
6. **非文字属性用测量值支撑**（纹理/色彩/色相/饱和度/对比度/光影）：先 `stats` 拿数字，
   描述词必须对应测量值。例："高饱和红"→`saturation_mean≈155, hue_mean≈0`；
   "强纹理"→`texture_edge_energy` 显著高于邻区；"硬光/高对比"→`contrast_rms` 高＋`highlight_frac`/`shadow_frac` 两极。
   没有数字支撑的形容词（"质感细腻""光影柔和"）一律降级为"推断"或删除。
7. **三层分离**：看到的（像素直接支持）／推断的（由看到推出，标明）／读不出的（明确列出）。
   汇报时三层分开写，不混成一段"看起来像"。

描述模板（每区域一条）：

```
[区域 A1 | bbox 100,100,620,300 | scale 4]
看到: 文本 "SU21-TDM6Q"(逐字符高置信); 竖线 12 条(实数); 底色 rgb_mean≈[245,247,250]
测量: saturation_mean=… contrast_rms=… texture_edge_energy=… highlight_frac=…
推断: …(标明依据)
存疑/读不出: 第 6 字符 0/O 同形; …
```

## §10 最终视觉检验（局部采样放大对比，确保成果与效果一致）

收尾**不得只看全局缩略图**下"一致/没问题"的结论。必须做局部采样放大对比：

1. 抽 N 个局部样本，覆盖：文字区、纹理区、色彩/光影区、**空白区**（负对照）。
2. 对每个样本用 `compare 源 成果 --bbox … --scale …` 出同倍率 A/B 并排图，
   读它的 `diff_pixels` 与 `metric_delta`（饱和/对比/纹理/光影差）。
3. 判据（能失败）：声称"一致"的样本必须 `diff_pixels≈0` 且属性差≈0；
   声称"有改动"的样本必须 `diff_pixels>0` 且对应属性差显著。两者反了即红。
4. **Read compare 并排图目视确认**，与 §9 描述逐条比对；目视与数字冲突时信目视并复查坐标。
5. 空白样本不得"看出"内容；看出即幻觉，整轮描述作废重读。

这条已上收为通用验证纪律（见 `verify-before-claim` / `verify-ui-in-browser`），
本技能提供它的可执行工具（`compare`/`stats`）。