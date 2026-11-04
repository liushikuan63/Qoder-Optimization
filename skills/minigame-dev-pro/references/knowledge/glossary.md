---
last_verified: 2026-09-03
verify_cycle: 90
next_verify: 2026-12-02
primary_source: 对应平台官方文档（构建期逐一核实，过期须重核）
---


# 中英术语对照表

> 本文件用于中英文切换时保证术语一致性。英文输出时以此表为准，避免合规/技术术语翻译错误。
> 最后更新：2026-08-03

---

## 使用规则

1. 英文输出时，术语首次出现给双语标注（如"包体大小 (package size)"），后续用英文
2. 合规编号（RULE-XXX/SCAN-XX）、API 名、文件路径不翻译
3. 本表未收录的术语，翻译后标注"（暂译）"并记录到此表
4. 中文法规名称保留原文，括号内附英文意译

---

## 一、合规与法律

| 中文 | English | 备注 |
|------|---------|------|
| 微信小游戏 | WeChat Mini Game | 平台官方称谓 |
| 小程序 | Mini Program | 区别于 Mini Game |
| ICP备案 | ICP Filing | 中国网站/应用备案制度 |
| 软件著作权 | Software Copyright | 简称"软著" |
| 计算机软件著作权登记证书 | Computer Software Copyright Registration Certificate | 提审必传 |
| 自审自查报告 | Self-Review Report | 提审必传 |
| 隐私保护指引 | Privacy Protection Guidelines | 《个人信息保护法》要求 |
| 防沉迷系统 | Anti-Addiction System | 未成年人保护 |
| 实名认证 | Real-Name Authentication | — |
| 游戏版号 | Game Publication Number | 简称"版号"，游戏出版主管部门颁发 |
| 网络游戏出版物号 | Online Game Publication Number | 版号全称 |
| 内容备案 | Content Filing | 文旅部门备案 |
| 违规分享奖励 | Inducing Share | 红线 RULE-008 |
| 随机抽取概率公示 | Gacha Probability Disclosure | 红线 RULE-009 |
| 虚拟货币反向兑换 | Virtual Currency Reverse Exchange | 红线 RULE-010，绝对禁止 |
| 侵权IP | Infringing IP | 红线 RULE-011 |
| 广告超比例 | Excessive Ad Ratio | 红线 RULE-012 |
| 内容合规 | Content Compliance | 红线 RULE-013 |
| 批量注册 | Batch Registration | 红线 RULE-014 |
| 《个人信息保护法》 | Personal Information Protection Law (PIPL) | 2021年实施 |
| 广告法 | Advertising Law | 禁止使用绝对化用语（如"最好""第一"等宣称表述） |
| 游戏出版主管部门 | Game Publishing Authority | 版号审批机构 |
| 微信公众平台 | WeChat Official Platform | mp.weixin.qq.com |
| 微信开发者工具 | WeChat Developer Tool | CLI 所在应用 |
| 微信认证 | WeChat Verification | 企业 300元/年 |
| 开放数据域 | Open Data Context | 好友关系链，隔离环境 |

---

## 二、技术与开发

| 中文 | English | 备注 |
|------|---------|------|
| 主包 | Main Package | ≤4MB |
| 分包 | Subpackage | 总包≤30MB |
| 包体大小 | Package Size | — |
| 基础库 | Base Library | 版本号如 3.5.0 |
| 开发者工具 CLI | DevTool CLI | 命令行接口 |
| 预览 | Preview | 自动预览 auto-preview |
| 真机预览 | Real Device Preview | 扫码在手机测试 |
| 上传发布 | Upload & Publish | upload 命令 |
| 就绪度自检 | Readiness Check | 提审前自检 |
| 合规扫描 | Compliance Scan | 代码层红线扫描 |
| 包体分析 | Package Analyzer | — |
| 性能打点 | Performance Profiler | inject/read/revert |
| 素材检查 | Asset Check | 版权风险扫描 |
| 知识库过滤 | Knowledge Filter | 按阶段/主题/角色加载 |
| 帧率 | Frame Rate (FPS) | — |
| 内存 | Memory | usedJSHeapSize |
| DrawCall | Draw Call | 渲染调用次数 |
| Canvas | Canvas | 2D/WebGL 绘图 |
| 引擎 | Engine | Cocos/Unity/Laya |
| Cocos Creator | Cocos Creator | 主流小游戏引擎 |
| 云开发 | Cloud Development | 微信云开发 |
| 云函数 | Cloud Function | — |
| 开放数据域 | Open Data Context | — |
| 跨端经营 | Cross-Platform Operation | 小游戏→APP→PC |
| 自动化测试 | Automated Testing | miniprogram-automator |
| 激励视频广告 | Rewarded Video Ad | 用户主动触发 |
| 插屏广告 | Interstitial Ad | 自然间歇点 |
| Banner广告 | Banner Ad | 顶部/底部 |
| 格子广告 | Grid Ad | 非核心页面 |

---

## 三、运营与数据

| 中文 | English | 备注 |
|------|---------|------|
| 日活 | Daily Active Users (DAU) | — |
| 月活 | Monthly Active Users (MAU) | — |
| 留存率 | Retention Rate | 次留/7留/30留 |
| 次日留存 | Day-1 Retention | — |
| ARPU | Average Revenue Per User | 单用户平均收入 |
| ARPPU | Average Revenue Per Paying User | 付费用户平均收入 |
| eCPM | Effective Cost Per Mille | 千次展示收入 |
| CPM | Cost Per Mille | 千次展示成本 |
| CPA | Cost Per Action | 单次行动成本 |
| LTV | Life Time Value | 用户生命周期价值 |
| 内购 | In-App Purchase (IAP) | 个人主体不可 |
| 广告变现 | In-App Advertising (IAA) | — |
| 混合变现 | Hybrid Monetization | IAP + IAA |
| 买量 | User Acquisition (UA) | 付费获客 |
| 裂变 | Viral Growth | 社交传播 |
| 关系链 | Social Graph | 微信好友/群 |
| 群排行 | Group Ranking | 需单独申请 |
| 首次用户体验 | First-Time User Experience (FTUE) | — |
| 核心循环 | Core Loop | 游戏核心玩法循环 |
| 数值平衡 | Difficulty Balancing | — |
| 经济系统 | Economy System | 金币/钻石/体力 |
| 放置类 | Idle Game | — |
| 合成类 | Merge Game | — |
| 消除类 | Match-3 Game | — |
| Roguelike | Roguelike | 随机地牢 |
| 随机抽取 | Gacha | 随机抽取 |

---

## 四、维护说明

- 新增术语时，同步更新中英两栏
- 法规名称变更（如机构改革）时，更新英文意译并标注变更日期
- 不确定的翻译标注"（暂译）"，待核实后去掉标注
