# OCR 可选增强（rapidocr，实测口径）

核心裁剪/放大**不依赖** OCR。OCR 只在"纯文字图、要批量抽字符串"或"给视觉读法做独立交叉核对"时加分。
未安装时 `imgdetail.py ocr` 以 exit 5 退出并提示降级，不静默失败。

下文 `<PY>`＝你本机装了 Pillow 的 Python，`<OCR_LIB>`＝你选定的 OCR 库目录（示例 `D:/tools/image-detail-libs`），
`<TMP>`＝一个非系统盘临时目录（示例 `D:/tmp`）。按本机习惯替换，避免写满系统盘。

## 安装（官方 PyPI，装到指定目录）

```
TMPDIR=<TMP> TEMP=<TMP> TMP=<TMP> PIP_CACHE_DIR=<TMP>/pip-cache \
  "<PY>" -m pip install --no-cache-dir --target <OCR_LIB> rapidocr onnxruntime
```

- 实测 cp314 win_amd64 可解析：rapidocr 3.10.0 + onnxruntime 1.31.1（均有对应轮子）；其他平台以实际轮子为准。
- `rapidocr` 3.10 **不提供** `[onnxruntime]` extra，后端要单独装 onnxruntime。
- 模型落在 `<OCR_LIB>/rapidocr/models/`。
- `--target` 目录里会带一份 pillow/numpy；`imgdetail.py` 只在 `ocr` 子命令内
  `sys.path.insert(0, <OCR_LIB>)`，核心命令仍用系统 Pillow，互不污染。
- 运行时用 `IMGDETAIL_OCR_LIB=<OCR_LIB>` 告诉脚本库目录（默认 `~/.qoder/image-detail-libs`）。

## 实测返回结构（不要猜接口）

rapidocr 3.10 返回 `RapidOCROutput`，字段：`.boxes .txts .scores .elapse .to_json .to_markdown .word_results …`。
**不是**元组列表。取法：

```
r = engine(np_array_rgb)
boxes, txts, scores = r.boxes, r.txts, r.scores   # 可能是 numpy 数组
```

坑：`boxes` 是 numpy 数组时 `boxes or []` 会抛
`ValueError: truth value of an array ... is ambiguous`。必须显式 `None` 判断再 `list(...)`。

## 裁紧再 OCR（漏检的真因与修法）

大面积空白的大裁剪里只有一小条文字时，检测模型把整图降采样，字太小→`count=0` 漏检。
**修法＝先裁到文字行附近再 OCR**（本技能主线"裁剪去掉降采样"的同一原理）：

```
"<PY>" imgdetail.py crop 图.png --bbox 105,132,220,156 --scale 8 --name tight --out <TMP>/imgdetail
"<PY>" imgdetail.py ocr <TMP>/imgdetail/tight.png
```

实测：6px/8px 小字裁紧×8 后 OCR 命中（score 0.91 / 0.99）；同字在大空白裁剪里 count=0。

## 交叉核对协议（降幻觉）

- OCR 是**独立第二读者**，不是权威。与视觉放大读法一致→高置信；不一致→标存疑、列两种读法，不选边。
- 实测例：某 6px 串视觉读 `…R0O9A`、OCR 读 `…ROOMA`、真值 `…ROO9A`——两读者各错不同字符，
  正确处置是标存疑而非采信任一方。
- 空白区 OCR 应 `count=0`；若 OCR 在空白区"读出"文字，视为误检，不得进描述。
- OCR 输出的框是**裁剪局部坐标**；`imgdetail.py ocr --bbox` 已自动加偏移换算回源坐标（`box_source`），
  描述时引用源坐标。

## 离线 / 内网替代方案（分享后不可下载）

运行时 rapidocr **优先读本地模型**（日志 `File exists and is valid`），仅缺失才下载。
因此只要模型与依赖在本地，OCR 全程零网络。分享包带脚本与说明、不带大模型；模型用 bundle 传递。

**联网机打包**（官方 PyPI + 本地模型）：

```
"<PY>" scripts/build-ocr-offline-bundle.py --out <TMP>/image-detail-offline-bundle
```

产物：`bundle/wheels/*.whl`（pip download 官方源）＋ `bundle/models/*.onnx`（3 个）＋ `bundle/manifest.json`。
模型源目录默认取 `IMGDETAIL_OCR_LIB` 下的 `rapidocr/models`，也可用 `--models-src` 指定。

**内网零网络安装**：

```
"<PY>" scripts/install-ocr-offline.py --bundle <TMP>/image-detail-offline-bundle --target <OCR_LIB>
```

内部用 `pip install --no-index --find-links <bundle>/wheels --target <target>`，再布模型到
`<target>/rapidocr/models/`。**不触网**；`--no-index` 保证只认本地 wheels。

**隔离验证**（R11）：`--target` 指向一个空目录，装完后
`IMGDETAIL_OCR_LIB=<target> "<PY>" imgdetail.py ocr <图>` 应跑通且模型日志为本地命中；
把 `IMGDETAIL_OCR_LIB` 指向不存在目录则 exit 5 降级（负对照）。

**无 OCR 兜底**：核心裁剪/放大/统计/对比全不依赖 OCR；模型视觉为主读者，离线仍完整可用。