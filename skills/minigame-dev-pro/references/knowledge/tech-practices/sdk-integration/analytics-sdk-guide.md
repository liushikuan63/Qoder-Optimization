# 数据分析接入指南

> 微信小游戏数据分析完整方案：官方工具 + 自定义埋点 + 分析方法论。
> 平台口径：本文以**微信小游戏**为准，代码示例全局对象前缀为 `wx.`。其他平台（抖音 `tt.` 等）须切换对应接口前缀，详见 `references/data/platforms.json`。

---

## 1. 微信官方数据助手使用

### 1.1 数据助手入口
- 路径：微信公众平台（mp.weixin.qq.com）→ 统计 → 数据助手
- 也可通过：开发管理 → 开发设置 → 数据接口

### 1.2 官方提供的数据维度

#### 用户数据
| 指标 | 说明 | 查看路径 |
|------|------|---------|
| 累计用户 | 历史总访问用户数 | 统计→用户分析 |
| 新增用户 | 每日首次访问用户 | 统计→用户分析 |
| 活跃用户 | 日活/周活/月活 | 统计→用户分析 |
| 留存率 | 次日/3日/7日/30日 | 统计→用户分析 |
| 用户画像 | 性别/年龄/地域/设备 | 统计→用户画像 |
| 访问来源 | 搜索/分享/扫码/广告等 | 统计→访问分析 |

#### 游戏数据
| 指标 | 说明 |
|------|------|
| 游戏时长 | 平均单次/日均游戏时长 |
| 启动次数 | 日启动总次数/人均次数 |
| 页面访问 | 各页面PV/UV |
| 自定义事件 | 开发者埋点上报的事件 |

#### 收入数据
| 指标 | 说明 |
|------|------|
| 广告收入 | 每日/每月广告总收入 |
| eCPM | 千次展示收入 |
| 广告展示量 | 各广告位展示次数 |
| 广告点击率 | 点击/展示比率 |

### 1.3 数据助手使用技巧
- 设置关键指标日报（每日邮件/消息推送）
- 对比不同时间段数据（环比/同比）
- 关注异常波动（留存突降、来源结构变化）
- 导出数据做深度分析（支持CSV导出）

---

## 2. 自定义埋点方法

### 2.1 微信官方埋点API

```javascript
// ========== 基础事件上报 ==========
// 上报自定义事件（微信官方接口）
wx.reportEvent('event_id', {
  // 自定义参数（key-value，value仅支持字符串和数字）
  'level': '5',
  'score': '1200',
  'duration': '180'
});

// ========== 监控/性能事件 ==========
wx.reportMonitor('monitor_id', value);

// ========== 分析事件（更详细） ==========
wx.reportAnalytics('purchase_item', {
  item_id: 'sword_001',
  item_name: '铁剑',
  price: 100,
  currency: 'gold'
});
```

### 2.2 埋点封装工具类

```javascript
/**
 * 数据分析管理器
 * 统一管理所有埋点事件
 */
class AnalyticsManager {
  constructor() {
    this.enabled = true; // 生产环境开启
    this.queue = [];     // 事件队列（批量上报）
    this.sessionId = this.generateSessionId();
    this.sessionStart = Date.now();
  }

  /**
   * 上报事件
   * @param {string} eventName - 事件名称
   * @param {object} params - 事件参数
   */
  track(eventName, params = {}) {
    if (!this.enabled) return;

    const event = {
      event: eventName,
      params: {
        ...params,
        session_id: this.sessionId,
        timestamp: Date.now(),
        // 自动附加基础信息
        platform: wx.getSystemInfoSync().platform,
        version: this.getAppVersion()
      }
    };

    // 使用微信API上报
    try {
      wx.reportEvent(eventName, this.formatParams(params));
    } catch (e) {
      console.warn('事件上报失败', e);
    }
  }

  /**
   * 格式化参数（微信要求value为字符串或数字）
   */
  formatParams(params) {
    const formatted = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' || typeof value === 'number') {
        formatted[key] = String(value);
      } else {
        formatted[key] = JSON.stringify(value);
      }
    }
    return formatted;
  }

  /**
   * 页面/场景停留时长
   */
  trackDuration(sceneName) {
    const startTime = Date.now();
    return () => {
      const duration = Math.round((Date.now() - startTime) / 1000);
      this.track('scene_duration', {
        scene: sceneName,
        duration_seconds: duration
      });
    };
  }

  generateSessionId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  getAppVersion() {
    return '1.0.0'; // 从配置读取（示例游戏版本）
  }
}

// 全局单例
const analytics = new AnalyticsManager();
module.exports = analytics;
```

### 2.3 使用示例

```javascript
const analytics = require('./utils/analytics');

// 关卡开始
analytics.track('level_start', {
  level_id: 5,
  level_type: 'normal',
  attempt: 2  // 第几次尝试
});

// 关卡完成
analytics.track('level_complete', {
  level_id: 5,
  stars: 3,
  score: 12500,
  duration_seconds: 95,
  powerups_used: 1
});

// 广告展示
analytics.track('ad_show', {
  ad_type: 'rewarded_video',
  ad_scene: 'revive',
  ad_unit_id: 'adunit-xxx'
});

// 广告点击/完成
analytics.track('ad_complete', {
  ad_type: 'rewarded_video',
  ad_scene: 'revive',
  is_ended: true
});

// 分享行为
analytics.track('share_trigger', {
  share_type: 'friend',  // friend / moment
  share_scene: 'level_complete'
});
```

---

## 3. 必须埋的事件清单

### 3.1 用户生命周期事件
| 事件名 | 触发时机 | 关键参数 |
|--------|---------|---------|
| game_launch | 游戏启动 | source, is_first_launch |
| tutorial_start | 新手引导开始 | - |
| tutorial_complete | 新手引导完成 | duration_seconds |
| tutorial_skip | 跳过新手引导 | skip_at_step |
| first_level_start | 首次开始游戏 | - |
| day_n_return | 第N天回访 | n (1/3/7/30) |

### 3.2 核心游戏事件
| 事件名 | 触发时机 | 关键参数 |
|--------|---------|---------|
| level_start | 关卡开始 | level_id, attempt |
| level_complete | 关卡通过 | level_id, stars, score, duration |
| level_fail | 关卡失败 | level_id, attempt, fail_reason |
| game_over | 游戏结束（无尽模式） | score, duration, rank |
| revive_use | 使用复活 | level_id, revive_type |
| powerup_use | 使用道具 | item_id, level_id |

### 3.3 商业化事件
| 事件名 | 触发时机 | 关键参数 |
|--------|---------|---------|
| ad_show | 广告展示 | ad_type, ad_scene |
| ad_click | 广告点击 | ad_type, ad_scene |
| ad_complete | 广告完整观看 | ad_type, ad_scene, is_ended |
| ad_fail | 广告加载失败 | ad_type, error_code |
| purchase_start | 发起购买 | item_id, price |
| purchase_success | 购买成功 | item_id, price |
| purchase_fail | 购买失败 | item_id, error |

### 3.4 社交/传播事件
| 事件名 | 触发时机 | 关键参数 |
|--------|---------|---------|
| share_trigger | 触发分享 | share_scene, share_type |
| share_success | 分享成功 | share_scene |
| invite_friend | 邀请好友 | invite_count |
| rank_view | 查看排行榜 | - |

### 3.5 性能/异常事件
| 事件名 | 触发时机 | 关键参数 |
|--------|---------|---------|
| load_complete | 资源加载完成 | duration_ms, package_size |
| load_fail | 资源加载失败 | resource_url, error |
| crash_report | 异常崩溃 | error_msg, scene |
| low_fps | 帧率过低 | fps, scene, device |

---

## 4. 事件命名规范

### 4.1 命名规则
```
格式：{对象}_{动作}  或  {对象}_{动作}_{修饰}
分隔符：下划线（snake_case）
长度：≤ 50字符
字符：小写字母 + 数字 + 下划线
```

### 4.2 命名示例
```
正确：
- level_start
- level_complete
- ad_show
- ad_rewarded_complete
- item_purchase_success
- tutorial_step_complete

错误：
- LevelStart（驼峰）
- level-start（连字符）
- 关卡开始（中文）
- a1（无意义）
- user_click_button_in_level_3_to_open_shop_page（过长）
```

### 4.3 参数命名规范
```
格式：snake_case
通用参数：
- level_id（关卡ID）
- duration_seconds（时长，秒）
- score（分数）
- ad_type（广告类型）
- ad_scene（广告场景）
- item_id（道具ID）
- source（来源）
- attempt（尝试次数）
```

### 4.4 事件文档管理
建议维护一份事件字典表格：

| 事件名 | 触发时机 | 参数 | 参数类型 | 说明 |
|--------|---------|------|---------|------|
| level_start | 进入关卡 | level_id | int | 关卡序号 |
| level_start | | attempt | int | 第几次挑战 |
| level_complete | 通关 | stars | int | 获得星数1-3 |

---

## 5. 数据查看和分析方法

### 5.1 日常监控看板（每日必看）
```
核心指标：
├── DAU（日活跃用户）
├── 新增用户数
├── 次日留存率（目标 ≥ 30%）
├── 7日留存率（目标 ≥ 10%）
├── 人均游戏时长
├── 人均游戏局数
├── 广告收入（日）
├── eCPM
└── 分享率（分享用户/活跃用户）
```

### 5.2 关键分析方法

#### 漏斗分析
```
启动 → 新手引导完成 → 第1关通过 → 第5关 → 第10关 → 第20关
100%    85%           75%        60%     45%      30%

关注：哪一步流失最大？为什么？
```

#### 留存分析
- 按渠道分：搜索来的 vs 分享来的 vs 广告来的
- 按行为分：完成新手引导 vs 未完成
- 按设备分：iOS vs 安卓
- 找到"魔法数字"（如：第一天玩3局的用户留存高2倍）

#### 关卡分析
- 每关通过率（低于60%的关卡需要调整难度）
- 每关平均尝试次数
- 每关平均耗时
- 道具使用率（高使用率=难度可能过高）

#### 广告分析
- 各场景广告触发率（有入口但没点的比例）
- 各场景广告完成率
- 广告观看与留存的关系
- 每日人均广告观看次数

### 5.3 数据驱动决策框架

```
发现问题 → 提出假设 → 设计实验 → 收集数据 → 验证假设 → 执行决策

示例：
- 发现：第3关流失率突然升高（40%→65%）
- 假设：第3关难度过高
- 实验：降低第3关敌人血量20%
- 数据：A/B测试，各50%用户
- 验证：通过率从55%提升到75%，留存提升5%
- 决策：全量发布难度调整
```

### 5.4 数据报警阈值建议
| 指标 | 正常范围 | 报警阈值 |
|------|---------|---------|
| 次日留存 | 25-45% | < 20% |
| 7日留存 | 8-20% | < 5% |
| 崩溃率 | < 1% | > 3% |
| 加载时间 | < 3s | > 5s |
| eCPM | 30-80元 | < 15元 |
| 分享率 | 5-15% | < 3% |

### 5.5 第三方分析工具（可选）
| 工具 | 特点 | 适用场景 |
|------|------|---------|
| 微信数据助手 | 官方、免费、基础 | 所有项目 |
| 友盟小游戏版 | 功能丰富 | 中大型项目 |
| TalkingData | 游戏行业深耕 | 重度游戏 |
| 自建（后端+BI） | 完全自定义 | 企业级需求 |

> 个人开发者建议：微信官方数据助手 + 自定义埋点即可满足需求，无需额外接入第三方。
