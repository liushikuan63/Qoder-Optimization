# 机型适配实战指南

> 覆盖安卓、iOS、鸿蒙三大平台的屏幕适配和兼容性问题。

---

## 1. 安卓适配

### 1.1 屏幕比例
| 比例 | 代表机型 | 适配要点 |
|------|---------|---------|
| 16:9 | 老款机型（2018前） | 标准设计比例 |
| 18:9 / 18.5:9 | 中端主流 | 上下多出一些空间 |
| 19:9 / 19.5:9 | 刘海屏主流 | 注意刘海区域 |
| 20:9 / 21:9 | 新款/带鱼屏 | 超长屏，UI布局注意 |

### 1.2 刘海屏适配
```javascript
// 获取安全区域信息
const systemInfo = wx.getSystemInfoSync();
const { safeArea, screenHeight, screenWidth } = systemInfo;

// 安全区域偏移
const topOffset = safeArea.top;           // 顶部刘海高度
const bottomOffset = screenHeight - safeArea.bottom; // 底部导航栏高度

// 安卓刘海屏 topOffset 通常为：
// - 水滴屏：约 25-35px
// - 挖孔屏：约 30-45px
// - 药丸屏：约 40-55px
```

**适配策略**：
- 游戏内容区域限制在安全区域内
- 背景图可以延伸到刘海区域（全屏背景）
- 顶部UI（分数、设置按钮）下移 topOffset
- 底部UI（操作按钮）上移 bottomOffset

### 1.3 虚拟按键适配
- 安卓虚拟导航栏（底部三键/手势条）会占用屏幕空间
- `safeArea.bottom` 已排除虚拟按键区域
- 部分机型用户可隐藏虚拟按键（此时safeArea变化）
- 监听 `wx.onWindowResize` 处理动态变化

### 1.4 安卓碎片化应对
```javascript
// 设备分级策略
function getDeviceLevel() {
  const { benchmarkLevel, platform } = wx.getSystemInfoSync();

  // benchmarkLevel: 微信提供的设备性能等级（-1为未知）
  if (benchmarkLevel >= 30) return 'high';    // 高端
  if (benchmarkLevel >= 15) return 'medium';  // 中端
  return 'low';                                // 低端
}

// 根据设备等级调整画质
function adjustQuality(level) {
  switch (level) {
    case 'high':
      // 全特效、60fps、高清纹理
      break;
    case 'medium':
      // 关闭部分粒子效果、60fps
      break;
    case 'low':
      // 关闭粒子、降低分辨率、30fps
      break;
  }
}
```

---

## 2. iOS 适配

### 2.1 安全区域
| 设备 | 顶部安全距离 | 底部安全距离 | 特点 |
|------|------------|------------|------|
| 刘海屏机型 | 44pt | 34pt | 刘海+Home Indicator |
| 药丸屏机型 | 47-59pt | 34pt | 刘海/药丸 |
| 灵动岛机型 | 59pt | 34pt | 灵动岛 |
| 传统Home键机型 | 20pt | 0pt | 传统Home键 |
| iPad | 20-24pt | 20pt | 无Home Indicator |

### 2.2 状态栏处理
```javascript
// game.json 中隐藏状态栏
{
  "showStatusBar": false
}

// 或代码中控制
wx.setStatusBarStyle({ style: 'light' }); // light / dark

// 获取状态栏高度
const { statusBarHeight } = wx.getSystemInfoSync();
```

### 2.3 iOS 特有问题
- **音频自动播放限制**：必须在用户交互事件中首次播放
- **内存限制更严格**：低端iOS设备（2GB RAM）容易OOM
- **WebGL兼容性**：iOS 15以下部分扩展不支持
- **橡皮筋效果**：触摸边缘有回弹（游戏场景通常已禁用）
- **键盘弹出**：会压缩可视区域（输入框场景注意）
- **虚拟支付**：微信小游戏 iOS **未开放**（仅 Android 支持，API `wx.requestMidasPayment`）；`requestVirtualPayment` 等为小程序 API，不适用于小游戏。iOS 开放状态以官方小游戏文档为准

### 2.4 iOS 性能注意
- 低端iOS设备（SE/8）是最低保障机型
- 老款iOS设备（6s/7）可能无法流畅运行重度游戏
- 纹理内存限制：单张纹理 ≤ 4096×4096
- 同屏DrawCall建议 ≤ 50（老款iOS设备）

---

## 3. 鸿蒙适配

### 3.1 HarmonyOS NEXT 概况
- 2024年起华为推出纯血鸿蒙（HarmonyOS NEXT），不再兼容安卓
- 微信已适配鸿蒙原生版本
- 小游戏在鸿蒙微信中运行，底层渲染有差异

### 3.2 已知问题
| 问题 | 影响 | 应对方案 |
|------|------|---------|
| 部分Shader不兼容 | 自定义着色器渲染异常 | 使用引擎内置Shader |
| 字体渲染差异 | 文字显示模糊/偏移 | 使用BMFont位图字体 |
| 音频延迟偏高 | 音效不同步 | 提前预加载、补偿延迟 |
| 部分CSS动画不支持 | H5引擎适配问题 | 使用Canvas/WebGL渲染 |
| 性能调度差异 | 帧率波动 | 做好帧率监控和降级 |

### 3.3 Shader兼容建议
```
鸿蒙Shader注意事项：
- 避免使用 GL_OES_standard_derivatives 扩展
- 避免使用 gl_FragDepth（部分GPU不支持）
- 精度声明必须明确（highp/mediump/lowp）
- 避免动态循环（for循环次数需为常量）
- 纹理采样数量控制在8个以内
- 使用 Cocos Creator 3.8.2+ 内置的兼容处理
```

### 3.4 鸿蒙测试方法
- 使用华为真机（Mate 60/Pura 70系列）
- 安装鸿蒙原生版微信
- 通过微信开发者工具的"真机调试"连接
- 关注：渲染正确性、帧率、音频、触摸响应

---

## 4. 屏幕适配方案

### 4.1 适配策略选择

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| FIT_WIDTH | 宽度撑满，高度裁切 | 竖屏游戏（推荐） |
| FIT_HEIGHT | 高度撑满，宽度裁切 | 横屏游戏（推荐） |
| SHOW_ALL | 完整显示，可能留黑边 | 不允许裁切的场景 |
| EXACT_FIT | 拉伸填满（会变形） | 不推荐 |
| NO_BORDER | 无边框裁切 | 全屏背景 |

### 4.2 竖屏游戏适配方案（推荐）
```
设计分辨率：720 × 1280
适配策略：FIT_WIDTH

效果：
- 宽度始终铺满（不变形）
- 高度根据屏幕比例裁切或扩展
- 16:9屏幕：上下少显示一些
- 21:9屏幕：上下多显示一些

关键UI处理：
- 顶部UI：锚点设为(0.5, 1)，跟随顶边
- 底部UI：锚点设为(0.5, 0)，跟随底边
- 中间内容：居中，不被裁切
- 背景：比设计尺寸大20%，允许裁切
```

### 4.3 安全区域通用处理
```javascript
// 通用安全区域适配工具
class SafeAreaAdapter {
  static init() {
    const info = wx.getSystemInfoSync();
    this.safeArea = info.safeArea;
    this.screenWidth = info.screenWidth;
    this.screenHeight = info.screenHeight;

    this.paddingTop = this.safeArea.top;
    this.paddingBottom = this.screenHeight - this.safeArea.bottom;
    this.paddingLeft = this.safeArea.left;
    this.paddingRight = this.screenWidth - this.safeArea.right;
  }

  // 获取顶部安全偏移（用于UI布局）
  static getTopOffset() {
    return this.paddingTop;
  }

  // 获取底部安全偏移
  static getBottomOffset() {
    return this.paddingBottom;
  }

  // 判断是否为刘海屏
  static isNotchScreen() {
    return this.paddingTop > 20;
  }
}
```

### 4.4 横屏游戏适配
```
设计分辨率：1280 × 720
适配策略：FIT_HEIGHT

注意：
- 横屏时刘海在左侧或右侧
- 操作区域避开刘海侧
- 双指操作需要足够空间
- 虚拟按键可能在短边侧
```

---

## 5. 测试机型清单

### 5.1 安卓测试机型
| 等级 | 机型 | 芯片 | RAM | 关注点 |
|------|------|------|-----|--------|
| 高端 | 小米14/华为Mate60 | 骁龙8Gen3/麒麟9000s | 12-16GB | 全特效流畅 |
| 中端 | 红米Note 13/OPPO A3 | 骁龙6/天玑700 | 6-8GB | 主流体验 |
| 低端 | 小米12/荣耀Play5 | 骁龙4/天玑6020 | 4GB | 最低保障 |
| 特殊 | 华为折叠屏/小米平板 | - | - | 异形屏适配 |

### 5.2 iOS测试机型
| 等级 | 机型 | 芯片 | RAM | 关注点 |
|------|------|------|-----|--------|
| 高端机型 | - | A17/A18 | 8GB | 全特效 |
| 中端机型 | - | A14/A15 | 4GB | 主流体验 |
| 低端机型（最低保障） | - | A15/A11 | 2-3GB | 最低保障 |
| 特殊 | iPad（各尺寸） | - | - | 大屏适配 |

### 5.3 鸿蒙测试机型
| 等级 | 机型 | 关注点 |
|------|------|--------|
| 高端 | Mate 60 Pro/Pura 70 Ultra | Shader兼容、性能 |
| 中端 | nova 12/Mate 60E | 主流鸿蒙体验 |
| 平板 | MatePad Pro | 大屏+鸿蒙 |

### 5.4 最低保障机型建议
- 安卓：4GB RAM + 骁龙660/天玑700 以上
- iOS：iPhone 8（A11）以上
- 鸿蒙：麒麟990 以上
- 低于此配置：降低画质/帧率保障可玩性

---

## 6. 真机调试方法

### 6.1 微信开发者工具真机调试
```
步骤：
1. 微信开发者工具 → 工具栏 → "真机调试"
2. 选择"真机调试2.0"（推荐，更稳定）
3. 生成二维码
4. 手机微信扫码（需登录同一微信）
5. 电脑端打开远程调试面板
6. 可实时查看：Console、Network、Storage、Performance

注意：
- 手机和电脑需在同一网络
- 调试模式下性能数据偏低（有调试开销）
- 部分API在调试模式下行为不同
```

### 6.2 vConsole 调试
```javascript
// 在game.js中引入vConsole（仅开发版）
if (DEBUG) {
  // 微信小游戏内置vConsole
  wx.setEnableDebug({ enableDebug: true });
}

// 或者使用微信开发者工具的"打开调试"功能
// 基础库 2.11.0+ 支持
```

### 6.3 多机型测试流程
```
测试流程：
1. 开发者工具模拟器快速验证（5分钟）
2. 自己手机真机测试（10分钟）
3. 找3-5台不同机型测试（覆盖高/中/低端）
4. 使用微信"体验版"分发给测试群
5. 收集反馈 → 修复 → 重复3-4

重点关注：
- [ ] 启动是否正常（无黑屏/白屏）
- [ ] UI布局是否正确（无错位/溢出）
- [ ] 刘海屏/挖孔屏是否遮挡内容
- [ ] 触摸操作是否灵敏
- [ ] 帧率是否流畅
- [ ] 音频是否正常播放
- [ ] 广告是否正常展示
- [ ] 分享功能是否正常
- [ ] 前后台切换是否正常
- [ ] 弱网环境是否正常
```

### 6.4 体验版分发测试
1. 微信开发者工具 → 上传代码
2. 微信公众平台 → 版本管理 → 设为体验版
3. 添加体验成员（最多100人）
4. 成员扫码即可体验
5. 收集反馈（建议建微信群）

### 6.5 远程日志收集（生产环境）
```javascript
// 生产环境错误上报
wx.onError((error) => {
  // 上报到自建服务器或第三方平台
  wx.request({
    url: '你的服务器/api/error-report',
    method: 'POST',
    data: {
      message: error.message,
      stack: error.stack,
      device: wx.getSystemInfoSync().model,
      platform: wx.getSystemInfoSync().platform,
      version: '1.0.0',
      timestamp: Date.now()
    }
  });
});
```

---

## 附录：适配问题速查表

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| 顶部内容被刘海遮挡 | 未适配安全区域 | UI下移safeArea.top |
| 底部按钮被遮挡 | 虚拟按键/Home Indicator | UI上移底部安全距离 |
| 画面变形拉伸 | 适配策略错误 | 改用FIT_WIDTH/FIT_HEIGHT |
| 左右黑边 | SHOW_ALL策略 | 改用FIT策略+背景填充 |
| 部分机型闪退 | 内存超限 | 降低纹理质量、释放资源 |
| 鸿蒙字体模糊 | 系统字体渲染差异 | 使用BMFont |
| 触摸偏移 | 屏幕比例计算错误 | 使用引擎坐标系统 |
| 横竖屏切换异常 | 未锁定方向 | game.json设置deviceOrientation |
