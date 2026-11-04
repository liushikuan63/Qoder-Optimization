# 广告SDK接入指南

> 微信小游戏广告组件完整接入手册，基于2026年微信广告最新规范。

---

## 1. 微信广告组件类型

### 1.1 组件概览
| 广告类型 | 适用场景 | eCPM参考 | 用户体验影响 |
|---------|---------|----------|-------------|
| 激励视频广告 | 复活/奖励/解锁 | 30-100元 | 低（用户主动） |
| 插屏广告 | 关卡结束/场景切换 | 10-40元 | 中 |
| Banner广告 | 游戏底部/暂停页 | 1-5元 | 低 |
| 原生模板广告 | 自定义位置嵌入 | 5-20元 | 取决于设计 |
| 格子广告 | 更多游戏入口 | 按点击 | 低 |

### 1.2 收入占比建议
- 激励视频：60-80%（主力收入）
- 插屏广告：10-20%
- Banner：5-10%
- 原生/格子：补充

---

## 2. 接入代码示例

### 2.1 激励视频广告（核心收入来源）

```javascript
// ========== 创建激励视频广告 ==========
let rewardedVideoAd = null;

function initRewardedVideo() {
  if (wx.createRewardedVideoAd) {
    rewardedVideoAd = wx.createRewardedVideoAd({
      adUnitId: 'adunit-xxxxxxxxxxxxxxxx' // 在微信后台创建
    });

    // 监听加载事件
    rewardedVideoAd.onLoad(() => {
      console.log('激励视频加载成功');
    });

    // 监听错误事件
    rewardedVideoAd.onError((err) => {
      console.error('激励视频加载失败', err);
      // 错误处理：提示用户稍后重试
    });

    // 监听关闭事件（核心回调）
    rewardedVideoAd.onClose((res) => {
      if (res && res.isEnded) {
        // 用户完整观看，发放奖励
        grantReward();
      } else {
        // 用户中途关闭，不发放奖励
        showTip('观看完整视频才能获得奖励哦');
      }
    });
  }
}

// ========== 展示激励视频 ==========
function showRewardedVideo() {
  if (!rewardedVideoAd) {
    showTip('广告还未准备好，请稍后再试');
    return;
  }

  rewardedVideoAd.show().catch(() => {
    // 展示失败，尝试重新加载后展示
    rewardedVideoAd.load()
      .then(() => rewardedVideoAd.show())
      .catch((err) => {
        console.error('激励视频展示失败', err);
        showTip('广告加载失败，请稍后再试');
      });
  });
}

// ========== 发放奖励 ==========
function grantReward() {
  // 根据业务场景发放：
  // - 复活机会
  // - 金币/道具
  // - 解锁内容
  // - 额外体力
  console.log('奖励已发放');
}

// 游戏启动时初始化
initRewardedVideo();
```

### 2.2 插屏广告

```javascript
let interstitialAd = null;

function initInterstitial() {
  if (wx.createInterstitialAd) {
    interstitialAd = wx.createInterstitialAd({
      adUnitId: 'adunit-yyyyyyyyyyyyyyyy'
    });

    interstitialAd.onLoad(() => {
      console.log('插屏广告加载成功');
    });

    interstitialAd.onError((err) => {
      console.error('插屏广告错误', err);
    });

    interstitialAd.onClose(() => {
      console.log('插屏广告关闭');
      // 可在此恢复游戏逻辑
    });
  }
}

function showInterstitial() {
  if (interstitialAd) {
    interstitialAd.show().catch((err) => {
      console.error('插屏展示失败', err);
    });
  }
}
```

### 2.3 Banner广告

```javascript
let bannerAd = null;

function initBanner() {
  if (wx.createBannerAd) {
    const { screenWidth, screenHeight } = wx.getSystemInfoSync();

    bannerAd = wx.createBannerAd({
      adUnitId: 'adunit-zzzzzzzzzzzzzzzz',
      adIntervals: 30, // 自动刷新间隔（秒），最短30s
      style: {
        left: 0,
        top: screenHeight - 80, // 底部展示
        width: screenWidth // 宽度自适应
      }
    });

    bannerAd.onResize((size) => {
      // 广告尺寸变化回调
      console.log('Banner尺寸', size.width, size.height);
    });

    bannerAd.onError((err) => {
      console.error('Banner错误', err);
      // 隐藏占位区域
    });
  }
}

function showBanner() {
  if (bannerAd) bannerAd.show();
}

function hideBanner() {
  if (bannerAd) bannerAd.hide();
}
```

### 2.4 原生模板广告

```javascript
let nativeAd = null;

function initNativeAd() {
  if (wx.createNativeAd) {
    nativeAd = wx.createNativeAd({
      adUnitId: 'adunit-native-xxxx'
    });

    nativeAd.onLoad((res) => {
      // res.adList 包含广告数据
      const adData = res.adList[0];
      // 自定义渲染广告内容
      renderNativeAd(adData);
    });

    nativeAd.onError((err) => {
      console.error('原生广告错误', err);
    });
  }
}
```

---

## 3. 激励视频优秀实践

### 3.1 触发时机设计
| 触发场景 | 奖励内容 | 转化率参考 |
|---------|---------|-----------|
| 游戏失败/死亡 | 复活1次 | 40-60% |
| 关卡结算 | 双倍金币 | 30-50% |
| 体力不足 | 恢复体力 | 50-70% |
| 随机抽取 | 免费抽1次 | 35-55% |
| 解锁道具 | 试用高级道具 | 25-40% |
| 每日签到 | 额外签到奖励 | 20-35% |
| 离线收益 | 收益翻倍 | 45-65% |

### 3.2 奖励设计原则
- 奖励要有感知价值（用户觉得"值得看"）
- 奖励不能破坏经济平衡（不能太慷慨）
- 奖励即时到账（看完立刻给）
- 奖励类型多样化（不要只有金币）

### 3.3 每日上限控制
```javascript
// 每日观看次数管理
const AdLimitManager = {
  MAX_DAILY_VIEWS: 15, // 每日总上限
  MAX_PER_SCENE: 5,    // 单场景上限

  getTodayCount(scene) {
    const key = `ad_count_${scene}_${this.getDateStr()}`;
    return wx.getStorageSync(key) || 0;
  },

  canShow(scene) {
    const totalKey = `ad_total_${this.getDateStr()}`;
    const total = wx.getStorageSync(totalKey) || 0;
    if (total >= this.MAX_DAILY_VIEWS) return false;

    const sceneCount = this.getTodayCount(scene);
    return sceneCount < this.MAX_PER_SCENE;
  },

  recordShow(scene) {
    const dateStr = this.getDateStr();
    const sceneKey = `ad_count_${scene}_${dateStr}`;
    const totalKey = `ad_total_${dateStr}`;
    wx.setStorageSync(sceneKey, (wx.getStorageSync(sceneKey) || 0) + 1);
    wx.setStorageSync(totalKey, (wx.getStorageSync(totalKey) || 0) + 1);
  },

  getDateStr() {
    return new Date().toISOString().slice(0, 10);
  }
};
```

### 3.4 UI设计建议
- 广告入口按钮要醒目（视频图标+文字说明）
- 明确告知奖励内容（"看视频获得×2金币"）
- 按钮旁显示剩余次数（"今日剩余3次"）
- 不要使用误导性文案（如伪装成"领取"按钮）

---

## 4. 广告合规要求

### 4.1 微信广告规范红线
- **广告面积 ≤ 屏幕50%**（Banner和原生广告）
- **不得遮挡核心游戏内容**
- **用户自愿原则**：不能强制观看（激励视频除外，但也要有跳过选项）
- **不得误触**：广告关闭按钮必须清晰可见、易于点击
- **频率限制**：插屏广告两次展示间隔 ≥ 60秒
- **不得威胁**：不能以"不看广告就封号"等方式威胁

### 4.2 禁止行为
- 自动弹出广告（未经用户操作触发）
- 隐藏关闭按钮或延迟出现
- 广告覆盖超过屏幕50%
- 模拟系统通知样式的广告
- 在用户首次进入时立即弹广告
- 连续弹出多个广告

### 4.3 审核注意事项
- 提审时广告功能必须完整可用
- 广告位不能留空白占位（无广告时隐藏）
- Banner不能遮挡游戏操作区域
- 激励视频奖励必须实际发放

---

## 5. eCPM优化技巧

### 5.1 提升eCPM的核心策略
| 策略 | 预期提升 | 实施难度 |
|------|---------|---------|
| 优化广告触发时机 | +20-50% | 低 |
| A/B测试广告位 | +10-30% | 中 |
| 提升用户留存（更多展示机会） | +30-100% | 高 |
| 分时段展示（高峰期） | +10-20% | 低 |
| 用户分层（付费用户少展示） | +5-15% | 中 |

### 5.2 时段优化
- eCPM高峰：12:00-14:00、19:00-23:00
- eCPM低谷：02:00-07:00
- 节假日/周末 eCPM通常更高
- 电商大促期间（618、双11）eCPM显著上升

### 5.3 广告填充率优化
- 创建多个广告位（同类型），轮流使用
- 广告加载失败时自动重试（最多3次）
- 提前预加载（在需要展示前30秒开始加载）
- 无广告填充时优雅降级（隐藏入口/给安慰奖）

### 5.4 数据监控
- 每日关注：展示量、点击率、eCPM、总收入
- 分广告位对比效果
- 关注异常波动（eCPM突然下降可能是违规）
- 微信后台 → 流量主 → 数据统计

---

## 6. 常见错误和排查

### 6.1 错误码速查
| 错误码 | 含义 | 解决方案 |
|--------|------|---------|
| 1000 | 后端错误 | 稍后重试 |
| 1001 | 参数错误 | 检查adUnitId |
| 1002 | 广告单元不存在 | 确认后台已创建 |
| 1003 | 内部错误 | 联系微信客服 |
| 1004 | 无合适广告 | 正常现象，稍后重试 |
| 1005 | 广告未加载完成 | 等待onLoad回调 |
| 1006 | 广告已过期 | 重新load |
| 1007 | 广告展示中 | 等待关闭后再展示 |
| 1008 | 广告关闭中 | 等待关闭完成 |

### 6.2 常见问题排查

**问题：广告一直加载失败**
- 检查adUnitId是否正确（复制粘贴有无空格）
- 检查小游戏是否已开通流量主
- 检查是否在新设备/新账号测试（新用户可能无广告填充）
- 检查网络是否正常
- 开发者工具中广告填充率低，用真机测试

**问题：激励视频看完没回调**
- 确认 `onClose` 回调已注册
- 检查 `res.isEnded` 判断逻辑
- 注意：用户点击"跳过"时 `isEnded` 为 false
- 网络中断可能导致回调丢失，做兜底处理

**问题：Banner广告不显示**
- 确认调用了 `bannerAd.show()`
- 检查位置是否在可视区域内
- 部分新用户/新设备无Banner填充
- 检查是否被其他元素遮挡

**问题：广告收入异常低**
- 检查是否存在无效点击（会被扣量）
- 确认广告展示逻辑正确（不是空展示）
- 检查用户质量（机器人流量会被过滤）

---

## 7. 流量主开通条件

### 7.1 开通门槛
| 条件 | 要求 |
|------|------|
| 累计独立访客（UV） | > 500（以微信广告最新门槛为准；或游戏圈活跃、同主体已有流量主可走其他通道） |
| 账号状态 | 正常（无违规记录） |
| 主体类型 | 企业/个体工商户（个人不可开通流量主） |
| 小游戏状态 | 已上线（非开发版） |

### 7.2 开通流程
1. 确保小游戏已上线且累计UV > 500（以最新官方门槛为准）
2. 登录微信公众平台（mp.weixin.qq.com）
3. 左侧菜单 → 流量主 → 开通
4. 填写结算信息（银行卡/对公账户）
5. 创建广告位（选择类型、填写名称）
6. 获取 adUnitId
7. 在代码中接入

### 7.3 结算规则
- 结算周期：月结（每月1日-月末）
- 结算门槛：累计收入 ≥ 100元
- 到账时间：申请后7-15个工作日
- 税费：
  - 个人：平台代扣个人所得税（劳务报酬）
  - 企业：需提供发票，不代扣
- 结算：微信后台 → 流量主 → 收入 → 申请结算

### 7.4 注意事项
- 开通后不要伪造流量（会被封禁流量主资格）
- 广告收入需依法纳税
- 个人主体每月结算额度有限制
- 保持小游戏正常运营（长期无更新可能影响广告填充）
