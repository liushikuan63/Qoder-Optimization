---
name: svg-scene-animation
description: 单文件 HTML+SVG+CSS keyframes 的 2D 循环场景动画交付与真机取证。触发词：SVG 动画、CSS keyframes、轮速与地面速度、视差平铺、旋转轴心、dashoffset、连杆 IK、相位贴合、animation-play-state、reduced-motion、Playwright、animationName/animationDuration 断言。含静态图纸清单与引擎级负对照。不用于 SMIL、视频生成或普通页面动效。
---

# SVG / CSS 场景动画：从建模到真机取证

## 适用

单文件 HTML + SVG + CSS keyframes 的循环场景（车轮、地面、角色、次级动效）。目标不是“能跑”，而是**物理一致、图纸正确、引擎真的在跑**。

## 1. 先定运动模型，再画

1. **轮速与地面**：轮缘速度 `2πr/T` 必须等于地面平移速度 `位移/周期`；写好公式后用数值校验（实测容差可到 0.2%）。
2. **方向**：车轮转向、地面移动方向、角色朝向三者同向；倍率方向写反会导致“倒骑”。
3. **视差平铺**：每层瓦片首尾同高、端点切线水平；虚线周期必须整除瓦片宽；副本整体偏移一个瓦片宽，接缝才不会跳。
4. **dashoffset 周期**：关键帧位移必须是 `dasharray` 周期的整数倍；不同 `dasharray` 用不同关键帧类，不能共用海浪/虚线动画。
5. 把可复用图形放进 `defs` + `<use>`，减少重复节点。

## 2. 机构：IK 脚本 → keyframes

- 连杆/曲柄用脚本按角度采样生成关键帧，不手调。
- **近腿/远腿的相位偏移与曲柄臂符号是两个独立参数**：叠加后远腿可能与近腿完全相同（静默失效：不报错、动画照跑、两条腿同步）。生成后断言两侧数值不同。
- **旋转轴心**：
  - 优先 `transform-box: fill-box; transform-origin: 0 0`，并把图形绘制成“枢轴即包围盒左上角”（所有坐标 ≥ 0）。
  - 祖先链有 transform 时，`transform-box: view-box` 的原点会失真；静态位移交给外层 wrapper 的 `transform` 属性。
  - 只有祖先链无 transform 时才用 view-box 坐标。
- 嵌套 transform 下，子件的 `computed` 角度不等于屏幕合成方向；判断“脚踏是否水平”要用元素在屏幕上的 AABB 高宽，不要读自身 `rotate`。

## 3. 图纸与层序静态清单

逐项对照，缺一项就可能在真机上暴露：

- 遮挡：帽檐是否压住眼睛、围巾/翅膀是否遮住枢轴、后轮是否被车架压住。
- 层序：前后景、角色肢体、阴影、尘土的前后关系。
- 默认态：眼皮等元素要有默认 `opacity:0`，否则在 reduced-motion 下会变成永久闭眼。
- 暂停：用 `animation-play-state: paused`，不要靠移除类；`animation` 简写会把 `animation-play-state` 重置回 `running`，统一暂停要用 `*{ animation-play-state: paused !important }` 或等价写法。
- reduced-motion：提供静态降级，但降级态也要自洽（不是把所有动画删掉导致画面缺件）。
- SMIL 不吃 CSS `play-state`；若使用 SMIL，暂停方案要单独验证。

## 4. 真机取证（引擎级）

用本机浏览器内核（Playwright + 本机 Edge `executablePath`，避免版本缓存不匹配）驱动页面，逐条可失败断言：

| 断言 | 做法 | 典型假绿 |
|---|---|---|
| 动画已注册 | `getAnimations()` / computed `animationName !== 'none'` 且 `animationDuration > 0` | `calc(500px/(250*var(--speed)))` 得到 `<length>`，整条 animation 被丢弃 |
| 真的在推进 | 两次采样 `getBoundingClientRect`/`dashoffset` 位移非零 | 只查 bbox 覆盖，背景静止也判绿 |
| 暂停有效 | `canvas` 像素 diff == 0 | 用 PNG 字节相等，编码差异造成假红 |
| 速度正确 | `2πr/T` vs 地面平移速度 | 只看“有动画” |
| 相位贴合 | 运行态按固定间隔采样 ≥20 点一整圈 | 只在静止帧看位置 |
| reduced-motion | `reducedMotion:'reduce'` 上下文断言仍 running 或静态降级自洽 | 不测该上下文 |

工程坑：

- `strokeDasharray` 返回 `'36px, 14px'`，要 `match(/[\d.]+/g)` 解析。
- `getBBox()` 不含 transform；要屏幕坐标用 `getScreenCTM()` 映射 `DOMPoint`。
- `defs` 内元素 `getBoundingClientRect()` 恒 0×0；`getAnimations()` 不枚举 `<use>` 影子树。
- `<use>` 上的 CSS `transform` 会覆盖 `transform` 属性。
- 不要用 `Animation.currentTime` 定相位（running 态会漂移）；用固定间隔采样。
- 量具自身要配 3 个负对照：不存在的 class、只留 1 份 tile、人为冻结一层；三个都必须判红。

## 5. 相位贴合量法（驱动件 vs 跟随件）

1. 不暂停，按固定间隔采样一整圈 ≥20 点。
2. 每点同时读：驱动件 computed 角度、目标件 rect 中心、跟随件末端经 `getScreenCTM` 映射的屏幕点。
3. 算 `gap`，按驱动角归档成曲线。
4. 反推：`gap ≈ 2R·sin(Δφ/2)` ⇒ 相位差；圆心偏移或半径不足会呈现不同曲线形状。
5. CSS 4 点线性插值的骨链轨迹与圆周不同形，纯 IK 反解或关键帧循环平移都可能收不进阈值；先量曲线再决定压半径还是调相位。

## 6. 交付口径

- 静态自检只证明**结构完整**（占位符 0 残留、标签配平、引用存在），不证明画面或动画正确。
- 用户禁止测试时：做静态/几何自检，汇报里写「未做运行时视觉验证 + 原因」，不得把静态自检当验收。
- 真机取证要保留可复跑的命令、断言与负对照结果。

## 相关

- 前端动效交付基线：本机 `rules/frontend.md` 的动效章节；分享包内见 `Qoder-AI编码通用规则.md` 的对应节，以及 `verify-ui-in-browser`。
- 浏览器真实运行验收：`verify-ui-in-browser`。
- 长单文件分块写入：`safe-text-editing`。
