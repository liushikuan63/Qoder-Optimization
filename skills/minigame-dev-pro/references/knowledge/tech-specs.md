---
last_verified: 2026-09-03
verify_cycle: 90
next_verify: 2026-12-02
primary_source: 对应平台官方文档（构建期逐一核实，过期须重核）
---


# 微信小游戏技术规格库

> 平台口径：本文以**微信小游戏**为准（全局对象前缀 `wx.`）。基于2026年微信官方文档整理，具体限制以官方最新公告为准。抖音/QQ/快手等平台包体与接口不同，详见 `references/data/platforms.json` 与 `references/data/spec-registry.json`，禁止套用微信数值。

---

## 代码包大小限制（2026年最新）

### 官方限制（来源：Cocos Creator 3.8官方文档 + 微信开放文档）
- 主包：≤ 4MB（硬性限制，不可突破）
- 所有分包合计：≤ 30MB（Cocos 3.8官方文档数据）
- 单个分包：不限制大小
- 分包数量：无明确上限

### 实际建议值（来源：2026年开发者实战经验）
- 主包安全值：≤ 3.8MB（留余量）
- 总包建议值：≤ 16-20MB（用户体验最优）
- 首屏加载资源：≤ 10MB
- 启动核心内容应尽可能小

### 为什么建议值比官方限制小？
- 包体越大→下载越慢→用户流失越多
- 微信搜索排名可能受包体影响
- 低端机下载和解压更慢
- 审核时包体过大可能引起额外关注

⚠️ 注意：官方限制可能随版本更新调整，开发前请在微信开发者工具中确认当前限制。

### 1.2 分包规则
- 主包：游戏入口、核心框架、首屏必需资源
- 分包：按关卡/场景/功能模块拆分
- 分包之间不能互相引用，只能引用主包
- 分包异步化：支持 `wx.loadSubpackage()` 按需加载
- 独立分包：可不依赖主包独立运行（适合多入口场景）

### 1.3 远程资源
- 不计入包体大小
- 必须使用 HTTPS 协议
- 域名需在微信后台配置白名单（request合法域名 / downloadFile合法域名）
- 单个域名每月可修改次数有限（5次），谨慎配置

---

## 2. 资源协议要求

### 2.1 HTTPS 强制
- 所有网络请求必须使用 HTTPS（开发阶段可在开发者工具中关闭校验）
- WebSocket 必须使用 WSS
- 不支持自签名证书（需受信任CA签发）

### 2.2 域名白名单配置
- 路径：微信公众平台 → 开发管理 → 开发设置 → 服务器域名
- request合法域名：wx.request 使用
- socket合法域名：WebSocket 使用
- uploadFile合法域名：上传文件使用
- downloadFile合法域名：下载文件使用
- 每月最多修改5次，需提前规划

### 2.3 CDN 建议
- 使用国内CDN节点（腾讯云CDN、云服务商CDN、七牛云）
- 资源版本号管理（URL带hash或version参数）
- 开启Gzip/Brotli压缩
- 设置合理的Cache-Control（静态资源建议1年）

---

## 3. 基础库版本要求

### 3.1 版本策略
- 基础库由微信客户端内置，用户无需手动更新
- 开发者在 `game.json` 中设置最低基础库版本
- 建议设置：不低于当前最新版前3个版本（兼顾覆盖率和新API）

### 3.2 关键API对应版本
| API | 最低基础库版本 |
|-----|--------------|
| wx.createRewardedVideoAd | 2.0.4 |
| wx.createInterstitialAd | 2.6.0 |
| wx.getFileSystemManager | 1.9.9 |
| wx.createInnerAudioContext | 1.6.0 |
| Canvas 2D（新版） | 2.9.0 |
| WebGL | 1.0.0 |
| wx.createUDPSocket | 2.18.0 |
| 分包异步化 | 2.17.3 |
| 实时语音 | 2.7.0 |

### 3.3 兼容性处理
```javascript
// 检查API是否可用
if (wx.createRewardedVideoAd) {
  // 使用激励视频
} else {
  // 降级方案
}

// 检查基础库版本
const version = wx.getSystemInfoSync().SDKVersion;
if (compareVersion(version, '2.9.0') >= 0) {
  // 使用新版Canvas 2D
}
```

---

## 4. API 能力清单

### 4.1 文件系统
- `wx.getFileSystemManager()` - 文件管理器
- 本地文件存储上限：200MB（单个小游戏）
- 支持读写、追加、复制、移动、删除
- 支持 ArrayBuffer / Base64 读写
- 用户文件路径：`wx.env.USER_DATA_PATH`

### 4.2 网络
- `wx.request` - HTTP请求（并发上限10个）
- `wx.uploadFile` / `wx.downloadFile` - 文件上传下载
- `wx.connectSocket` - WebSocket（并发上限5个）
- `wx.createUDPSocket` - UDP通信
- 请求超时默认60s，可设置

### 4.3 存储
- `wx.setStorageSync` / `wx.getStorageSync` - 同步存储
- `wx.setStorage` / `wx.getStorage` - 异步存储
- 单个key上限：1MB
- 总存储上限：10MB
- 数据加密存储（用户维度隔离）

### 4.4 音频
- `wx.createInnerAudioContext()` - 音频播放器
- 支持格式：MP3、AAC、M4A、WAV（推荐MP3/AAC）
- 同时播放数量：建议 ≤ 10个
- 支持：播放、暂停、跳转、循环、音量、速率
- 后台音频：`wx.getBackgroundAudioManager()`（需配置）
- 录音：`wx.getRecorderManager()`

### 4.5 Canvas / 渲染
- Canvas 2D：`<canvas type="2d">`（新版，推荐）
- 旧版Canvas：`wx.createCanvasContext()`（已不推荐）
- WebGL：`<canvas type="webgl">`
- 离屏Canvas：`wx.createOffscreenCanvas()`
- 帧率控制：`canvas.requestAnimationFrame()`
- 支持创建 Image、ImageData、Path2D 对象

### 4.6 其他重要API
- 开放数据域（排行榜）：`wx.getOpenDataContext()`
- 分享：`wx.shareAppMessage()` / `wx.onShareAppMessage()`
- 支付：`wx.requestPayment()`（需企业主体）
- 登录：`wx.login()` → code → 后端换session
- 用户信息：头像昵称填写能力（`wx.chooseAvatar` + `input type="nickname"`）【`wx.getUserInfo` 已废弃，2022年10月起不再返回昵称/头像】
- 系统信息：`wx.getSystemInfoSync()`
- 性能监控：`wx.getPerformance()`
- 振动/陀螺仪/加速度计

---

## 性能基准（2026年标准）

### 帧率
- 高端机目标：60fps（稳定55-60）
- 低端机目标：30fps（稳定28-32）
- 帧率波动：不超过20%

### 内存
- 低端机峰值：≤ 700MB
- 高端机峰值：≤ 1000MB
- 不超设备内存上限的70%

### 渲染批次（DrawCall）
- 首屏：≤ 100
- 局内（游戏中）：≤ 200
- 极端情况：≤ 350

### 加载时间
- 首屏完成：≤ 3000ms
- 理想首屏：≤ 1500ms
- 进度条建议显示80%以上再进入游戏

### 稳定性
- 闪退率：< 2%
- 安装成功率：> 99%
- 转屏切换（如支持）：≤ 500ms且界面不错位

### 适配
- 设计稿：720×1280 或 750×1334
- 竖屏按高度适配，横屏按宽度适配
- 覆盖比例：16:9、18:9、19.5:9
- 重要控件离顶部/底部至少50px
- 必须读取安全区（safeArea）

### 资源压缩参考
- 无透明图片转JPG：省50-70%
- WAV转OGG：省65-70%
- 字体子集化：省80-90%

---

## 6. 引擎兼容性矩阵

### 6.1 主流引擎支持情况（2026年）

| 引擎 | 安卓 | iOS | 鸿蒙(HarmonyOS NEXT) | 备注 |
|------|------|-----|---------------------|------|
| Cocos Creator 3.8+ | 完全支持 | 完全支持 | 支持（3.8.2+） | 首选推荐，生态最完善 |
| Cocos Creator 2.4.x | 完全支持 | 完全支持 | 部分支持 | 老项目维护可用 |
| Unity（小游戏转换方案） | 支持 | 支持 | 有限支持 | 包体大，需深度优化 |
| Phaser 3 | 完全支持 | 完全支持 | 需适配 | 轻量H5引擎，适合休闲 |
| GameMaker | 有限支持 | 有限支持 | 不支持 | 社区方案，非官方 |
| Laya 3.x | 完全支持 | 完全支持 | 支持 | 国产引擎，性能不错 |
| Egret（白鹭） | 支持 | 支持 | 有限 | 已停止大版本更新 |
| 原生Canvas/WebGL | 完全支持 | 完全支持 | 完全支持 | 最轻量，适合极简游戏 |

### 6.2 引擎选择建议
- **个人开发者/休闲游戏**：Cocos Creator 3.x 或原生Canvas
- **中重度游戏**：Cocos Creator 3.x 或 Laya
- **Unity团队转型**：Unity小游戏方案（注意包体优化）
- **H5游戏移植**：Phaser 3（改动最小）

---

## 7. 已知平台Bug和限制

### 7.1 常见限制
- iOS 上 WebGL 不支持 `gl.readPixels` 的部分格式
- 安卓部分机型 Canvas 2D 的 `filter` 属性不生效
- 开放数据域不能直接访问主域资源
- 后台运行超过5分钟会被挂起（音频除外）
- 同屏音频播放数量过多会导致卡顿（建议≤10）
- `wx.request` 并发上限10个，超出排队
- 本地存储10MB上限，大量数据需用文件系统
- iOS 虚拟支付未开放（微信小游戏仅 Android 支持，API `wx.requestMidasPayment`；iOS 状态以官方小游戏文档为准），未开通前不展示付费入口

### 7.2 已知问题（持续更新）
- 部分安卓机型（低端联发科芯片）WebGL渲染异常
- iOS 15以下 Canvas 2D 的 `roundRect` 不支持
- 鸿蒙系统部分机型字体渲染差异
- 开发者工具与真机表现不一致（以真机为准）
- 分享图片在部分安卓机型上尺寸异常

### 7.3 应对策略
- 始终在真机上测试，开发者工具仅供参考
- 对关键API做能力检测（feature detection）
- 准备降级方案（WebGL → Canvas 2D）
- 关注微信开放社区的问题反馈

---

## 8. 微信开发者工具使用要点

### 8.1 安装和配置
- 下载地址：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 选择"稳定版"用于发布，"RC版"体验新功能
- 登录需使用有该小游戏开发权限的微信号
- 项目目录选择游戏代码根目录（含 game.json）

### 8.2 核心功能
- **模拟器**：预览游戏运行效果（不代表真机性能）
- **调试器**：Console、Sources断点、Network、Storage
- **代码依赖分析**：分析包体构成，找出大文件
- **真机调试**：扫码在真机上运行并远程调试
- **预览**：生成二维码供手机扫码体验
- **上传**：上传代码到微信后台（提审前最后一步）

### 8.3 调试技巧
- 开启"不校验合法域名"用于本地开发
- 使用 `vConsole` 在真机上查看日志
- Performance面板录制帧率曲线
- 内存面板查看内存使用趋势
- 条件编译：区分开发/生产环境

### 8.4 常见工具问题
- 工具卡顿：关闭不必要的模拟器功能、降低模拟器分辨率
- 编译失败：清除缓存（工具→清除缓存→全部清除）
- 真机调试断连：确保手机和电脑同一WiFi
- 上传失败：检查AppID是否正确、是否有上传权限

---

## 附录：game.json 基础配置参考

```json
{
  "deviceOrientation": "portrait",
  "showStatusBar": false,
  "networkTimeout": {
    "request": 10000,
    "connectSocket": 10000,
    "uploadFile": 10000,
    "downloadFile": 10000
  },
  "subpackages": [
    {
      "name": "levels",
      "root": "levels/"
    }
  ],
  "workers": "workers/",
  "openDataContext": "opendata",
  "navigateToMiniProgramAppIdList": []
}
```
