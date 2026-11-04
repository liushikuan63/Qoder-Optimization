---
last_verified: 2026-09-03
verify_cycle: 90
next_verify: 2026-12-02
primary_source: 对应平台官方文档（构建期逐一核实，过期须重核）
---


﻿# 防沉迷系统接入手册

> 适用：个人开发者 / 企业开发者
> 费用：免费（使用微信平台能力）
> 周期：技术接入1-3天
> 法律依据：《未成年人保护法》《关于防止未成年人沉迷网络游戏的通知》（2021年修订）
> 最后更新：2026-07-09
> 最后核实：2026-08-03 ✓（已核实：内容与现行规则一致）
> 核实周期：每季度（未成年人保护规则变动较快，需高频核实）
> 下次核实：2026-11-03

---

## 一、核心数值（必须牢记）

### 1.1 游戏时长限制

| 用户类型 | 可玩时间 | 具体规则 |
|----------|----------|----------|
| 未成年人（<18岁） | 仅周五、周六、周日及法定节假日 | 每日20:00-21:00，共1小时 |
| 未成年人 | 其他所有时间 | 完全禁止登录 |
| 成年人（≥18岁） | 无限制 | 无时长限制 |

> 2021年9月1日起执行的最严规定：未成年人每周只能玩3小时（周五六日各1小时）。

### 1.2 时段限制（现行规则）

现行规则下，未成年人的可玩时段已被严格限定为"周五、周六、周日及法定节假日每日 20:00-21:00（当日累计不超过1小时）"，其余所有时段一律禁止登录。该规则已覆盖并取代早期"22:00-次日08:00宵禁"的表述：

| 时间段 | 规则 |
|--------|------|
| 周五/周六/周日及法定节假日 20:00-21:00 | 未成年人可玩（当日累计不超过1小时） |
| 其余所有时段 | 未成年人完全禁止登录 |

> 说明：旧版"22:00-次日08:00宵禁"的说法源于更早政策；2021年9月1日施行的最严规则已将未成年人游戏时间压缩至上述窗口，实现时无需再单独判断"宵禁"，以微信平台统一执行的实名认证与限时逻辑为准。

### 1.3 付费限制

| 年龄段 | 单次充值上限 | 每月充值上限 | 备注 |
|--------|-------------|-------------|------|
| 0-8岁（不含8岁） | 禁止任何付费 | 0元 | 完全不能花钱 |
| 8-16岁（不含16岁） | 50元 | 200元 | 按自然月计算 |
| 16-18岁（不含18岁） | 100元 | 400元 | 按自然月计算 |
| 18岁及以上 | 无限制 | 无限制 | |

### 1.4 节假日定义

法定节假日以国务院每年发布的通知为准（通常12月底发布次年安排）：
- 元旦（3天）
- 春节（7天）
- 清明节（1天）
- 劳动节（1天）
- 端午节（1天）
- 中秋节（1天）
- 国庆节（3天）

> 调休上班日不算节假日（如国庆调休的周末上班日不能玩）。
> 寒暑假不算节假日（不能玩）。

---

## 二、实名认证系统接入（企业端）

### 2.1 系统说明

微信小游戏平台已为大家提供了统一的游戏实名认证系统。小游戏开发者只需要通过微信提供的API来实现实名认证，不需要自己接入外部系统。

### 2.2 企业端接入（非必需）

如果企业有自己的服务端需要验证实名信息：

1. 访问国家新闻出版署防沉迷实名认证系统
2. 企业注册 → 提交资质（营业执照、版号、ICP许可证）
3. 审核通过 → 获取接口凭证（appId 和访问凭证）
4. 按照接口文档对接：
   - 实名认证接口：验证实名信息
   - 年龄判断接口：返回用户年龄段
5. 接口调用频率有限制，注意缓存结果

> 对于纯微信小游戏开发者，通常不需要单独接入，使用微信API即可。

---

## 三、微信小游戏防沉迷API

### 3.1 核心API列表

| API | 功能 | 调用时机 |
|-----|------|----------|
| wx.login | 获取用户登录凭证 | 游戏启动时 |
| wx.checkIsUserAdvisedToRest | 检查用户当天是否应被建议休息（未成年人限时限制由平台统一执行） | 登录后定时检查 |
| wx.requestFacialRecognition | 人脸核身（疑似未成年人冒用成年人账号时；仅开通虚拟支付的小游戏可用） | 需要进一步身份核验时 |

### 3.2 wx.checkIsUserAdvisedToRest

```javascript
// 检查当前用户是否被建议休息（防沉迷核心接口）
wx.checkIsUserAdvisedToRest({
  success: (res) => {
    // res.result: boolean
    // true = 用户是未成年人且当前不在允许时段，应被限制
    // false = 用户可以正常游戏

    if (res.result) {
      // 弹出提示并强制退出游戏
      showAntiAddictionDialog()
    }
  },
  fail: (err) => {
    // 接口调用失败时的处理
    // 建议：失败时也要做限制处理（从严）
    console.error('防沉迷检查失败', err)
  }
})
```

### 3.3 调用时机

```javascript
// 1. 游戏启动时立即检查
wx.login({
  success: () => {
    checkAntiAddiction()
  }
})

// 2. 游戏过程中每5分钟检查一次
setInterval(() => {
  checkAntiAddiction()
}, 5 * 60 * 1000)

// 3. 从后台切回前台时检查
wx.onShow(() => {
  checkAntiAddiction()
})

function checkAntiAddiction() {
  wx.checkIsUserAdvisedToRest({
    success: (res) => {
      if (res.result) {
        // 强制退出到提示页面
        forceExitToNotice()
      }
    }
  })
}
```

---

## 四、必须实现的功能

### 4.1 实名登录

```javascript
// 所有用户必须通过微信登录（微信已完成实名）
// 不允许"游客模式"跳过实名
wx.login({
  success: (res) => {
    // 用 res.code 换取 openid 和 session_key
    // 服务端调用 code2Session
    // 确认用户身份后才允许进入游戏
  },
  fail: () => {
    // 登录失败不能进入游戏
    showLoginFailedDialog()
  }
})
```

**要求：**
- 不能有不登录就能玩的"游客模式"
- 微信登录即视为完成实名（微信平台已对接中宣部系统）
- 不能让用户自行填写年龄（必须用平台验证结果）

### 4.2 时长限制

```javascript
// 未成年人只能在周五六日和法定节假日的20:00-21:00游玩
// 其他时间调用 wx.checkIsUserAdvisedToRest 会返回 true

function forceExitToNotice() {
  // 显示全屏提示（不可关闭、不可跳过）
  // 提示文案：
  // "根据国家防沉迷通知要求，未成年人仅可在周五、周六、周日
  //  及法定节假日20时至21时进行游戏。当前不在允许时段，
  //  请合理安排时间。"

  // 禁止任何操作（不能点"继续"、不能关闭弹窗）
  // 只保留"退出游戏"按钮

  wx.showModal({
    title: '防沉迷提示',
    content: '根据国家规定，未成年人仅可在周五、周六、周日及法定节假日20:00-21:00进行游戏。',
    showCancel: false,
    confirmText: '我知道了',
    success: () => {
      wx.exitMiniProgram() // 退出小游戏
    }
  })
}
```

### 4.3 付费限制

```javascript
// 在付费接口中增加年龄判断
function requestPayment(amount, userId) {
  // 1. 获取用户年龄（通过服务端记录的实名信息）
  const age = getUserAge(userId)

  if (age < 8) {
    // 完全禁止付费
    showToast('未满8周岁，无法进行充值')
    return
  }

  if (age >= 8 && age < 16) {
    // 单次50元，月累计≤200元
    if (amount > 50) {
      showToast('单次充值不能超过50元')
      return
    }
    if (getMonthlySpent(userId) + amount > 200) {
      showToast('本月充值已达上限200元')
      return
    }
  }

  if (age >= 16 && age < 18) {
    // 单次100元，月累计≤400元
    if (amount > 100) {
      showToast('单次充值不能超过100元')
      return
    }
    if (getMonthlySpent(userId) + amount > 400) {
      showToast('本月充值已达上限400元')
      return
    }
  }

  // 通过限制，正常发起支付
  wx.requestPayment({ ... })
}

// 月累计按自然月计算（每月1日0点重置）
function getMonthlySpent(userId) {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  // 查询数据库：该用户本月1日至今的充值总额
  return queryMonthlyTotal(userId, monthStart)
}
```

### 4.4 允许时段判定（示例，以平台为准）

```javascript
// 现行规则：未成年人仅周五/周六/周日及法定节假日 20:00-21:00 可玩1小时
// 注意：该限时由微信平台统一执行（腾讯健康系统/实名认证），
// wx.checkIsUserAdvisedToRest 会返回平台的休息建议；以下为自行兜底判定示例。

function isAllowedTimeForMinor(now) {
  const day = now.getDay()          // 0=周日 ... 6=周六
  const hour = now.getHours()
  const isWeekend = (day === 5 || day === 6 || day === 0) // 节假日需另行判断
  return isWeekend && hour === 20   // 20:00-21:00
}

// 在定时检查中响应平台建议
function checkAntiAddiction() {
  wx.checkIsUserAdvisedToRest({
    success: (res) => {
      if (res.result) {
        forceExitToNotice()
      }
    }
  })
}
```

### 4.5 家长监护

```javascript
// 提供家长监护入口（在游戏设置页面）
// 功能：
// 1. 家长可以绑定孩子的游戏账号
// 2. 家长可以查看孩子的游戏时长
// 3. 家长可以查看孩子的消费记录
// 4. 家长可以设置额外的限制

// 微信提供"成长守护平台"：
// 家长可以通过微信搜索"成长守护平台"公众号绑定孩子账号
// 小游戏开发者需要确保数据上报正确

// 游戏内设置页面添加：
// "家长监护"按钮 → 跳转说明页面
// 内容：告知家长如何通过"成长守护平台"管理孩子的游戏行为
```

---

## 五、各引擎接入方式

### 5.1 Cocos Creator

```javascript
// Cocos Creator 3.x 微信小游戏项目
// 在 game.js 或入口脚本中

// 1. 在构建时确保 game.json 包含：
{
  "deviceOrientation": "portrait",
  "__usePrivacyCheck__": true
}

// 2. 在游戏初始化逻辑中：
import { antiAddiction } from './AntiAddiction'

// GameScene.ts
onLoad() {
  antiAddiction.init()
}

// AntiAddiction.ts
export class AntiAddiction {
  private checkInterval: number = 5 * 60 * 1000 // 5分钟
  private timer: any = null

  init() {
    this.check()
    this.timer = setInterval(() => this.check(), this.checkInterval)

    // 切回前台时检查
    wx.onShow(() => this.check())
  }

  check() {
    wx.checkIsUserAdvisedToRest({
      success: (res) => {
        if (res.result) {
          this.forceExit()
        }
      }
    })
  }

  forceExit() {
    if (this.timer) clearInterval(this.timer)
    // 显示防沉迷提示UI（全屏遮罩，不可关闭）
    // Cocos中可以用一个常驻节点
    this.showNotice()
  }

  showNotice() {
    // 创建全屏黑色遮罩 + 文字提示
    // 只有"退出"按钮
    wx.showModal({
      title: '健康游戏提示',
      content: '未成年人仅可在周五、周六、周日及法定节假日20:00-21:00进行游戏。',
      showCancel: false,
      success: () => {
        wx.exitMiniProgram()
      }
    })
  }

  destroy() {
    if (this.timer) clearInterval(this.timer)
  }
}
```

### 5.2 Unity（微信小游戏导出）

```csharp
// Unity 通过 WebGL 导出微信小游戏
// 使用 WX SDK 桥接

using UnityEngine;

public class AntiAddictionManager : MonoBehaviour
{
    private float checkInterval = 300f; // 5分钟
    private float timer = 0f;

    void Start()
    {
        CheckAntiAddiction();
    }

    void Update()
    {
        timer += Time.deltaTime;
        if (timer >= checkInterval)
        {
            timer = 0f;
            CheckAntiAddiction();
        }
    }

    void CheckAntiAddiction()
    {
        // 通过 WXBridge 调用微信API
        // 具体调用方式取决于使用的微信小游戏Unity插件版本
        WX.CheckIsUserAdvisedToRest(new WXCheckIsUserAdvisedToRestOption()
        {
            success = (res) => {
                if (res.result)
                {
                    ForceExit();
                }
            }
        });
    }

    void ForceExit()
    {
        // 显示防沉迷UI
        antiAddictionPanel.SetActive(true);
        Time.timeScale = 0; // 暂停游戏
    }
}
```

### 5.3 原生微信小游戏（JavaScript）

```javascript
// game.js
const antiAddiction = require('./utils/anti-addiction')

GameGlobal.antiAddiction = antiAddiction

// 游戏启动时
wx.login({
  success: () => {
    antiAddiction.check(() => {
      // 通过检查，正常初始化游戏
      initGame()
    }, () => {
      // 未通过，显示防沉迷提示
      antiAddiction.showBlockScreen()
    })
  }
})
```

### 5.4 Laya

```javascript
// LayaAir 项目
// 在 GameConfig.js 或 Main.js 中
class AntiAddiction {
    static init() {
        this.check();
        Laya.timer.loop(5 * 60 * 1000, this, this.check);
        wx.onShow(() => this.check());
    }

    static check() {
        wx.checkIsUserAdvisedToRest({
            success: (res) => {
                if (res.result) {
                    this.block();
                }
            }
        });
    }

    static block() {
        Laya.timer.clearAll(this);
        // 显示防沉迷遮罩
        wx.showModal({
            title: '防沉迷提示',
            content: '未成年人仅可在周五、周六、周日及法定节假日20:00-21:00进行游戏。',
            showCancel: false,
            success: () => wx.exitMiniProgram()
        });
    }
}
```

---

## 六、测试验证方案

### 6.1 测试账号准备

| 测试场景 | 需要的账号 | 获取方式 |
|----------|-----------|----------|
| 成年人正常游戏 | 已实名的成年人微信号 | 自己的号 |
| 未成年人被限制 | 已实名的未成年人微信号 | 家人/测试号 |
| 8岁以下付费禁止 | 实名<8岁的号 | 测试号 |
| 8-16岁付费限制 | 实名8-15岁的号 | 测试号 |
| 16-18岁付费限制 | 实名16-17岁的号 | 测试号 |

> 微信提供了沙箱测试环境，可以在开发者工具中模拟不同年龄段。

### 6.2 测试用例

| 编号 | 测试点 | 操作 | 预期结果 |
|------|--------|------|----------|
| T01 | 成年人正常登录 | 成年人号登录 | 正常进入游戏 |
| T02 | 未成年人允许时段 | 周五20:00用未成年号登录 | 正常进入游戏 |
| T03 | 未成年人禁止时段 | 周三15:00用未成年号登录 | 显示防沉迷提示，无法进入 |
| T04 | 未成年人超时 | 周五20:00进入，等到21:00 | 被强制退出游戏 |
| T05 | 允许日非窗口时段 | 周五22:00用未成年号登录 | 显示防沉迷提示，无法进入 |
| T06 | 8岁以下付费 | 7岁号尝试充值 | 提示禁止，无法支付 |
| T07 | 8-16岁单次超限 | 12岁号充值51元 | 提示超过50元限制 |
| T08 | 8-16岁月累计超限 | 12岁号本月已充200元再充1元 | 提示月度上限 |
| T09 | 16-18岁单次超限 | 17岁号充值101元 | 提示超过100元限制 |
| T10 | 16-18岁月累计超限 | 17岁号本月已充400元再充1元 | 提示月度上限 |
| T11 | 切后台再回来 | 未成年人切后台5分钟后回来 | 重新检查，如超时则退出 |
| T12 | 游客模式 | 尝试不登录直接玩 | 不允许，必须登录 |

### 6.3 使用开发者工具测试

1. 打开微信开发者工具
2. 导入小游戏项目
3. 顶部菜单 →「工具」→「模拟操作」→「防沉迷」
4. 可以模拟：
   - 未成年人身份
   - 不同时间段
   - 不同年龄
5. 验证所有场景

### 6.4 真机测试

- 开发者工具模拟通过后，必须真机测试
- 用实际未成年人微信号测试（找家人帮忙）
- 在不同时间点测试（允许时段、禁止时段）
- 测试付费限制（用小额真实支付验证）

---

## 七、节假日列表维护

### 7.1 维护方式

```javascript
// 方案1：硬编码（每年初更新）
// 注意：以下为2026年各节日当天（农历节日日期已按万年历换算）。
// 放假调休天数以国务院当年《节假日安排通知》为准，本表仅列节日当天；
// 最稳妥做法是优先依赖 wx.checkIsUserAdvisedToRest（平台自动维护节假日列表）。
const HOLIDAYS_2026 = [
  '2026-01-01', // 元旦
  '2026-02-17', // 春节（正月初一，具体放假安排以国务院通知为准）
  '2026-04-05', // 清明
  '2026-05-01', // 劳动节
  '2026-06-19', // 端午（五月初五）
  '2026-09-25', // 中秋（八月十五）
  '2026-10-01', // 国庆
]

// 方案2：从服务端获取（推荐）
// 服务端维护节假日表，客户端启动时拉取
async function getHolidays() {
  const res = await wx.request({
    url: '你的服务端/api/holidays/2026'
  })
  return res.data.holidays
}

// 方案3：使用微信平台的判断（最省事）
// wx.checkIsUserAdvisedToRest 已经包含了节假日判断
// 微信平台会自动维护节假日列表
// 推荐优先依赖此接口
```

### 7.2 注意事项

- 国务院通常12月底发布次年节假日安排
- 调休日（周末上班）不算节假日
- 如果依赖自己的节假日表，每年1月必须更新
- 最稳妥：依赖 wx.checkIsUserAdvisedToRest + 自己的表做双保险

---

## 八、常见坑点

| 序号 | 坑点 | 说明 |
|------|------|------|
| 1 | 以为不需要自己处理 | 微信平台提供API但必须你在代码中调用和处理结果 |
| 2 | 只在启动时检查一次 | 必须定时检查（5分钟一次）+切回前台时检查 |
| 3 | 游客模式跳过实名 | 不允许游客模式，必须登录才能玩 |
| 4 | 付费限制在前端做 | 必须在服务端校验，前端校验可被修改 |
| 5 | 月累计按30天算 | 必须按自然月（每月1日重置） |
| 6 | 节假日表不更新 | 每年必须更新，或用微信API自动判断 |
| 7 | 防沉迷提示可以关闭 | 提示必须不可关闭，只能退出游戏 |
| 8 | 用用户自填年龄 | 必须用平台实名验证结果，不能让用户自己填 |
| 9 | 测试只用成年人号 | 必须用未成年人号实际测试 |
| 10 | 忽略审核员测试 | 审核员会用未成年人测试号验证你的防沉迷 |
