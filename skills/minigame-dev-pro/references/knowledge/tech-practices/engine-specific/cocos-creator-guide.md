# Cocos Creator 微信小游戏实战指南

> 基于 Cocos Creator 3.8.x，覆盖从项目创建到发布上线全流程。
> 平台口径：本文以**微信小游戏**为准，代码示例全局对象前缀为 `wx.`。发布到其他平台（抖音 `tt.`、QQ `qq.` 等）须切换对应构建模板与 API 前缀，详见 `references/data/platforms.json`。

---

## 1. 版本选择建议

### 1.1 版本推荐
| 版本 | 推荐度 | 适用场景 |
|------|--------|---------|
| Cocos Creator 3.8.x | 首选 | 新项目，2D/3D均支持，鸿蒙适配 |
| Cocos Creator 3.7.x | 推荐 | 稳定项目，社区资源丰富 |
| Cocos Creator 2.4.x | 维护 | 老项目维护，不建议新项目使用 |
| Cocos Creator 3.6及以下 | 不推荐 | 已停止维护 |

### 1.2 选择依据
- **新项目**：直接用 3.8.x（TypeScript、组件化、性能优化好）
- **团队有2.x经验**：3.x学习成本约1-2周，值得迁移
- **纯2D休闲游戏**：3.8.x 完全胜任
- **需要鸿蒙支持**：必须 3.8.2+

### 1.3 下载和安装
- 通过 Cocos Dashboard 安装（cocos官网/creator-download）
- 安装时勾选"微信小游戏构建支持"
- 建议同时安装 VS Code 作为代码编辑器

---

## 2. 项目创建和配置

### 2.1 创建项目
1. 打开 Cocos Dashboard → 新建项目
2. 选择模板：
   - 纯2D游戏 → "Empty(2D)"
   - 需要3D → "Empty(3D)"
   - 快速原型 → 选择对应示例模板
3. 项目名称：英文+数字，无空格
4. 项目路径：避免中文路径

### 2.2 项目结构
```
project/
├── assets/              # 资源目录
│   ├── scenes/          # 场景文件
│   ├── scripts/         # 脚本代码
│   ├── textures/        # 图片资源
│   ├── audio/           # 音频资源
│   ├── prefabs/         # 预制体
│   ├── animations/      # 动画
│   └── resources/       # 动态加载资源（注意：会全部打入包体）
├── settings/            # 项目设置
├── package.json         # 项目配置
└── tsconfig.json        # TypeScript配置
```

### 2.3 基础配置
- 项目设置 → 项目数据：
  - 设计分辨率：720×1280（竖屏）或 1280×720（横屏）
  - 适配策略：FIT_WIDTH（竖屏）/ FIT_HEIGHT（横屏）
- 项目设置 → 脚本：
  - 使用 TypeScript（推荐）
  - 严格模式开启

---

## 3. 构建发布设置

### 3.1 构建面板配置
路径：菜单栏 → 项目 → 构建发布

```
构建配置：
├── 发布平台：微信小游戏
├── AppID：填写你的小游戏AppID
├── 设备方向：portrait（竖屏）/ landscape（横屏）
├── 初始场景：选择启动场景（如 LoadingScene）
├── 场景列表：勾选需要包含的场景
├── 远程服务器地址：你的CDN地址（远程资源地址）
├── 主包压缩类型：
│   ├── 合并所有 JSON（推荐）
│   └── 合并所有纹理（推荐）
├── 压缩引擎代码：✓
├── 压缩游戏代码：✓（选择 Terser）
├── MD5 Cache：✓（资源缓存版本管理）
├── 分包配置：（见下方）
└── 构建路径：默认 build/wechatgame
```

### 3.2 构建后操作
1. 构建完成后，打开微信开发者工具
2. 导入项目：选择 `build/wechatgame` 目录
3. AppID 自动填充（构建时已配置）
4. 在开发者工具中预览/调试
5. 确认无误后：上传 → 微信后台提审

---

## 4. 分包配置

### 4.1 Cocos Creator 分包设置
路径：项目设置 → 项目数据 → 分包配置

```json
// 构建面板中的分包配置示例
{
  "subpackages": [
    {
      "name": "levels",
      "root": "levels/",
      "scenes": ["Level1Scene", "Level2Scene"]
    },
    {
      "name": "shop",
      "root": "shop/",
      "scenes": ["ShopScene"]
    }
  ]
}
```

### 4.2 分包资源管理
- 将分包资源放在对应的 assets 子目录下
- 场景归属：在场景编辑器中设置场景所属分包
- 动态加载分包资源：

```typescript
import { assetManager } from 'cc';

// 加载分包中的资源
assetManager.loadBundle('levels', (err, bundle) => {
  if (err) {
    console.error('分包加载失败', err);
    return;
  }
  // 从分包中加载具体资源
  bundle.load('textures/level_bg', SpriteFrame, (err, spriteFrame) => {
    // 使用资源
  });
});
```

### 4.3 分包注意事项
- `resources` 目录下的资源会全部打入主包（慎用！）
- 分包中的资源不能被主包直接引用
- 公共资源放主包或单独公共分包
- 单个普通分包无硬性大小限制（独立分包≤4MB）

---

## 5. 性能优化

### 5.1 DrawCall 优化
| 方法 | 说明 | 收益 |
|------|------|------|
| 合图（Atlas） | 多张小图合成一张大图 | DrawCall减少50-80% |
| 自动合图 | 项目设置→构建→自动合图 | 自动处理 |
| 减少材质种类 | 同材质对象一起渲染 | 减少批次切换 |
| 避免频繁切换透明度 | 透明/不透明分开渲染 | 减少overdraw |
| Label使用BMFont | 替代系统字体 | 可合入图集 |

**目标**：同屏DrawCall ≤ 50（休闲游戏）/ ≤ 100（中度游戏）

### 5.2 内存优化
```typescript
// 1. 及时释放不用的资源
import { assetManager, resources } from 'cc';

// 释放单个资源
assetManager.releaseAsset(texture);

// 释放整个bundle
assetManager.removeBundle(bundle);

// 2. 对象池复用
import { NodePool, instantiate } from 'cc';

class BulletManager {
  private pool: NodePool = new NodePool();

  getBullet(): Node {
    if (this.pool.size() > 0) {
      return this.pool.get();
    }
    return instantiate(this.bulletPrefab);
  }

  recycleBullet(bullet: Node) {
    this.pool.put(bullet);
  }
}

// 3. 避免每帧创建对象
// 错误：
update() {
  const pos = new Vec3(x, y, z); // 每帧new
}
// 正确：
private tempPos = new Vec3();
update() {
  this.tempPos.set(x, y, z); // 复用
}
```

### 5.3 对象池模式
```typescript
import { NodePool, Node, instantiate, Prefab } from 'cc';

export class ObjectPoolManager {
  private pools: Map<string, NodePool> = new Map();

  /**
   * 初始化对象池
   */
  initPool(name: string, prefab: Prefab, initCount: number = 10) {
    const pool = new NodePool();
    for (let i = 0; i < initCount; i++) {
      const node = instantiate(prefab);
      pool.put(node);
    }
    this.pools.set(name, pool);
  }

  /**
   * 获取对象
   */
  get(name: string, prefab: Prefab): Node {
    let pool = this.pools.get(name);
    if (!pool) {
      this.initPool(name, prefab);
      pool = this.pools.get(name);
    }
    if (pool.size() > 0) {
      return pool.get();
    }
    return instantiate(prefab);
  }

  /**
   * 回收对象
   */
  put(name: string, node: Node) {
    const pool = this.pools.get(name);
    if (pool) {
      pool.put(node);
    } else {
      node.destroy();
    }
  }

  /**
   * 清空对象池
   */
  clear(name: string) {
    const pool = this.pools.get(name);
    if (pool) {
      pool.clear();
      this.pools.delete(name);
    }
  }
}
```

### 5.4 其他优化要点
- **帧率控制**：休闲游戏可锁30fps省电（`game.frameRate = 30`）
- **减少节点数**：同屏节点 ≤ 200
- **避免频繁 setActive**：用对象池替代
- **合理使用定时器**：用 `scheduleOnce` 替代 `setTimeout`
- **纹理尺寸**：非2的幂次纹理会浪费内存（尽量用 256/512/1024/2048）
- **音频管理**：不用的音频及时 stop + 释放

---

## 6. 常见问题

### 6.1 黑屏问题
| 原因 | 解决方案 |
|------|---------|
| 初始场景未正确设置 | 构建面板确认初始场景 |
| Canvas组件缺失 | 场景根节点添加Canvas |
| 相机配置错误 | 检查Camera的visibility和clearColor |
| 资源加载失败 | 检查资源路径，查看Console报错 |
| 适配问题 | 检查Canvas的适配设置 |

### 6.2 资源加载失败
```typescript
// 常见原因和解决：
// 1. 路径错误（大小写敏感！）
resources.load('textures/BG', SpriteFrame, callback); // 注意大小写

// 2. 资源类型不匹配
resources.load('audio/bgm', AudioClip, callback); // 不是Audio

// 3. 动态加载的资源必须在 resources 目录或 bundle 中
// 非resources目录的资源只能通过bundle加载

// 4. 构建后资源被压缩/重命名
// 使用 MD5 Cache 时路径会变，用原始路径加载即可
```

### 6.3 屏幕适配问题
```typescript
// 竖屏游戏适配（720×1280设计分辨率）
// Canvas 组件设置：
// - Design Resolution: 720 × 1280
// - Fit Width: true（宽度适配，高度裁切）
// - Fit Height: false

// 安全区域适配（刘海屏/底部横条）
import { view, screen } from 'cc';

const safeArea = screen.safeArea;
const windowSize = screen.windowSize;

// 顶部偏移（刘海）
const topOffset = windowSize.height - safeArea.height - safeArea.y;
// 底部偏移（Home Indicator）
const bottomOffset = safeArea.y;

// 将UI元素偏移到安全区域内
uiNode.setPosition(0, bottomOffset + originalY, 0);
```

### 6.4 音频播放问题
- iOS 首次播放需用户交互触发（不能自动播放）
- 解决：在首次触摸事件中初始化音频
- 同时播放过多音频会卡顿（控制 ≤ 8个）
- 格式推荐：MP3（兼容性最好）

### 6.5 微信小游戏特有问题
- `wx.onShow` / `wx.onHide` 处理前后台切换
- 分享回调在部分安卓机型不可靠
- 开放数据域（排行榜）与主域通信只能用 `postMessage`
- 文件系统路径与浏览器不同

---

## 7. 调试方法

### 7.1 开发阶段调试
```
调试工具链：
├── Cocos Creator 内置预览（浏览器）
│   ├── 快速迭代
│   ├── Chrome DevTools
│   └── 不代表真机表现
├── 微信开发者工具
│   ├── 模拟器预览
│   ├── Console日志
│   ├── Network请求
│   ├── Storage查看
│   └── 性能面板
└── 真机调试
    ├── 微信开发者工具→真机调试
    ├── vConsole（移动端日志）
    └── 远程断点调试
```

### 7.2 真机调试步骤
1. 微信开发者工具 → 工具栏 → "真机调试"
2. 选择调试模式（自动预览/扫码）
3. 手机微信扫码
4. 电脑端出现远程调试面板
5. 可查看Console、Network、断点调试

### 7.3 性能调试
```typescript
// 代码中插入性能监控
import { director, profiler } from 'cc';

// 开启内置性能统计（FPS、DrawCall、节点数）
profiler.showStats();

// 自定义帧率监控
let frameCount = 0;
let lastTime = Date.now();

function checkFPS() {
  frameCount++;
  const now = Date.now();
  if (now - lastTime >= 1000) {
    const fps = frameCount;
    frameCount = 0;
    lastTime = now;
    if (fps < 30) {
      console.warn(`低帧率警告: ${fps}fps`);
    }
  }
}
```

### 7.4 日志管理
```typescript
// 分级日志系统
const Logger = {
  debug: (...args) => {
    if (DEBUG) console.log('[DEBUG]', ...args);
  },
  info: (...args) => {
    console.info('[INFO]', ...args);
  },
  warn: (...args) => {
    console.warn('[WARN]', ...args);
  },
  error: (...args) => {
    console.error('[ERROR]', ...args);
    // 生产环境上报错误
    if (!DEBUG) {
      wx.reportEvent('error_log', { msg: args.join(' ') });
    }
  }
};

// 构建时通过宏控制
// 项目设置→脚本→宏配置：DEBUG = true/false
```

### 7.5 常见调试场景

| 问题 | 调试方法 |
|------|---------|
| 渲染异常 | 浏览器预览+Chrome DevTools截图对比 |
| 性能问题 | 真机调试→Performance录制 |
| 网络问题 | 开发者工具→Network面板 |
| 存储问题 | 开发者工具→Storage面板 |
| 音频问题 | 真机测试（模拟器音频不准） |
| 适配问题 | 多机型真机测试 |
| 内存泄漏 | 真机调试→Memory面板→堆快照对比 |

---

## 附录：Cocos Creator 微信小游戏项目模板配置

### tsconfig.json 推荐配置
```json
{
  "compilerOptions": {
    "target": "ES2015",
    "module": "ES2015",
    "strict": true,
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### 构建检查清单
- [ ] AppID 填写正确
- [ ] 初始场景设置正确
- [ ] 远程资源地址配置（CDN已部署）
- [ ] 分包配置完成
- [ ] 代码压缩开启
- [ ] MD5 Cache 开启
- [ ] 不用的引擎模块已裁剪
- [ ] 设计分辨率和适配策略正确
- [ ] 音频格式为 MP3
- [ ] 图片已压缩
- [ ] 真机测试通过
