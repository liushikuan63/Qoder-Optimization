#!/usr/bin/env node
// 体检脚本的可失败性验证：在隔离的假 HOME 里造违规 → 断言报红 → 还原 → 断言零告警。
// 用假 HOME 而不是改真实配置：不冒污染真源的风险，且能造出真实配置里不该有的状态。
//   node ~/.qoder/scripts/rules-weekly-audit.test.js   → 全绿退 0，任一失败退 1
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE = process.execPath;
const AUDIT = path.join(__dirname, 'rules-weekly-audit.js');
const SB = path.join(require('os').tmpdir(), 'q31', 'audit-sandbox');
const H = path.join(SB, '.qoder');
const C = path.join(SB, '.qoder-cn');

function w(p, t) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }

const AGENTS = [
  '# 全局开发规则', '',
  '> 首要纪律：不要随意停止；只有六种情形可以停下（见冲突裁决优先级）。', '',
  '## 冲突裁决优先级', '推送 / 部署前必须完整检验（本地小增量提交按影响面配比）。', '',
  '## 工作方式', '预算判断只在开工前：装不下时按「切小单元」继续。', '',
  '引入 `rules/java.md` 与 `scripts/helper.js`，另见技能 `i-have-adhd`。', '',
  '允许结束回合的只有三种情形。（两把尺子：可停下问 ≠ 可结束回合。）', '',
].join('\n');
const RULE = (name, trig) => `---\ntrigger: ${trig}\nglob: ["**/*.java"]\ndescription: 测试规则 ${name}，用于体检脚本的沙箱验证。\n---\n\n# ${name}\n\n- 内容。\n`;
// 基线里这条 hook 必须指向**真实存在**的脚本：V18（hook 指向不存在的脚本）落地后，
// 指向一个不存在的路径会让"健康沙箱零告警"直接判红。桩文件在 buildSandbox 里落盘。
const GUARD = path.join(H, 'scripts', 'global-config-guard.js');
const SETTINGS = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'x', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 5 }] }], SessionStart: [{ hooks: [{ type: 'command', command: 'x', timeout: 5 }, { type: 'command', command: 'node ' + GUARD, timeout: 15 }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: 5 }] }], PostToolUse: [{ hooks: [{ type: 'command', command: 'x', timeout: 5 }] }] } }, null, 2);

function buildSandbox({ slowMemory = false, staleHeartbeat = false } = {}) {
  fs.rmSync(SB, { recursive: true, force: true });
  for (const side of [H, C]) {
    w(path.join(side, 'AGENTS.md'), AGENTS);
    w(path.join(side, 'rules', 'java.md'), RULE('java', 'glob'));
    w(path.join(side, 'settings.json'), SETTINGS);
    w(path.join(side, 'tmp', 'stop-gate', 'violations.log'), 'x\n');
  }
  // 假同步脚本：只满足审计的调用契约（快，便于做干净的基线对照）
  const memStub = slowMemory
    ? '#!/bin/bash\nsleep 12\n echo "[memory-sync] 两侧一致"\nexit 0\n'
    : '#!/bin/bash\necho "[memory-sync] 两侧一致（2 个文件，含 MEMORY.md），索引自洽。"\nexit 0\n';
  w(path.join(H, 'scripts', 'sync-memory.sh'), memStub);
  w(path.join(C, 'scripts', 'sync-memory.sh'), memStub);
  fs.copyFileSync(path.join(__dirname, 'sync-global-config.sh'), path.join(H, 'scripts', 'sync-global-config.sh'));
  w(path.join(H, 'scripts', 'helper.js'), '// stub\n');
  // 遵守率检查要求"每条纪律挂的机制存在、且判据还在"，所以桩里必须带上被探针匹配的字符串，
  // 否则基线就会因为"机制缺失"报红，后面所有"植入后必须报红"的断言都失去意义。
  w(path.join(H, 'scripts', 'rules-reminder.js'), '// stub: 简体中文 / 不随意停止\n');
  w(path.join(H, 'scripts', 'stop-gate.js'), '// stub: R1b- R2- R3- R5- R9-claim-without-run\n');
  w(path.join(H, 'scripts', 'attempt-lock-core.js'), '// stub: 同类操作连败计数（构建/测试/部署）\n');
  w(path.join(H, 'scripts', 'global-config-guard.js'), '// stub: 悬空引用（基线 hook 指向它，必须真实存在）\n');
  w(path.join(H, 'scripts', 'session-budget.js'), '// stub: compactionNote\n');
  w(path.join(H, 'scripts', 'edit-guard.js'), '// stub: 备份提醒\n');
  w(path.join(H, 'scripts', 'export-memory.sh'), '#!/bin/bash\n# stub: scan_gate\n');
  // 周检会跑 `disk-sweeper.js --json` 报水位 ⇒ 基线必须镜像真契约，否则"零告警"根本立不住
  w(path.join(H, 'scripts', 'disk-sweeper.js'),
    'process.stdout.write(JSON.stringify({ freeGb: 200, level: "ok", tier1Files: 0, tier1Bytes: 0,'
    + ' extraFiles: 0, extraBytes: 0, archiveSuggested: null }))\n');
  w(path.join(H, 'scripts', 'rules-reminder.log'), '2026-09-19T00:00:00Z ok\n');
  if (staleHeartbeat) {
    const old = Date.now() / 1000 - 20 * 86400;
    fs.utimesSync(path.join(H, 'scripts', 'rules-reminder.log'), old, old);
    fs.utimesSync(path.join(H, 'tmp', 'stop-gate', 'violations.log'), old, old);
  }
}

function audit(extraArgs = []) {
  const r = spawnSync(NODE, [AUDIT, ...extraArgs], { encoding: 'utf8', env: { ...process.env, HOME: SB, USERPROFILE: SB, HOOK_CRASH_LOG: path.join(SB, 'sandbox-hooks-crash.log') }, timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

// ── 基线对照：健康沙箱必须零告警（否则后面的"报红"没有意义）──
buildSandbox();
let r = audit();
check('基线：健康沙箱零告警', r.code === 0, `exit=${r.code}`);

// ── 逐项植入违规 ──
const cases = [
  {
    name: 'V1 悬空引用（引用了不存在的 rules/scripts）',
    plant: () => { const p = path.join(H, 'rules', 'java.md'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n见 `rules/ghost.md` 与 `scripts/ghost.js`。\n'); w(path.join(C, 'rules', 'java.md'), fs.readFileSync(p, 'utf8')); },
    expect: /适用性[\s\S]{0,200}ghost\.md/,
  },
  {
    name: 'V2 frontmatter 非法（trigger 缺失/非法）',
    plant: () => { const p = path.join(H, 'rules', 'java.md'); const t = '---\ndescription: 没有 trigger 的规则示例。\n---\n\n# java\n'; fs.writeFileSync(p, t); w(path.join(C, 'rules', 'java.md'), t); },
    expect: /frontmatter/,
  },
  {
    name: 'V3 冲突回归 C1（写回"提交前必须完整检验"旧措辞）',
    plant: () => { const p = path.join(H, 'rules', 'java.md'); const t = fs.readFileSync(p, 'utf8').replace('推送 / 部署前必须完整检验', '') + '\n提交前必须完整检验，测试全绿才允许提交。\n'; fs.writeFileSync(p, t); w(path.join(C, 'rules', 'java.md'), t); },
    expect: /冲突回归[\s\S]{0,120}C1/,
  },
  {
    name: 'V4 领域规则放宽通用纪律（"不必验证"）',
    plant: () => { const p = path.join(H, 'rules', 'java.md'); const t = fs.readFileSync(p, 'utf8') + '\n小改动不必验证，直接上。\n'; fs.writeFileSync(p, t); w(path.join(C, 'rules', 'java.md'), t); },
    expect: /放宽通用纪律/,
  },
  {
    name: 'V18 hook 指向不存在的路径 → 报"该机制从未运行过"（2026-10-06 实测事故）',
    // 真实事故的形状：接线在、事件对、两侧一致，唯独脚本路径是另一台机器的用户目录。
    // 前面几道（漏挂 / 两侧不一致 / 心跳）全都看不见，而 hook 失败是 fail-open ⇒ 台账零行。
    plant: () => {
      for (const side of [H, C]) {
        const p = path.join(side, 'settings.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        c.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node ~/.qoder/scripts/nope-stop-gate.js', timeout: 15 }] }];
        fs.writeFileSync(p, JSON.stringify(c, null, 2));
      }
    },
    expect: /指向不存在的脚本[\s\S]{0,160}从未运行过/,
  },
  {
    name: 'V20 另一侧 scripts/ 与 skills/ 整个不存在 → 报"两侧不对等"（2026-10-06 实测：CN 重装后链接丢失，此前无任何检查出声）',
    plant: () => {
      for (const d of ['scripts', 'skills']) fs.rmSync(path.join(C, d), { recursive: true, force: true });
    },
    expect: /机制脚本目录「scripts」两侧不对等[\s\S]{0,80}仅非 CN 有/,
  },
  {
    name: 'V20b 两侧同缺 skills（合法形态，不是漂移）⇒ 不判红（对照组）',
    plant: () => {
      for (const side of [H, C]) fs.rmSync(path.join(side, 'skills'), { recursive: true, force: true });
    },
    want: 'any',
    expect: /^((?!技能库「skills」两侧不对等)[\s\S])*$/,
  },
  {
    name: 'V21 cua-driver 有新版未升 → 报 warn（自动更新纪律的机制面，2026-10-14）',
    plant: () => {
      w(path.join(SB, '.cua-driver', 'version_check.json'), JSON.stringify({ latest_version: '0.35.2', last_checked_at: '2026-10-14T00:00:00Z' }));
      fs.mkdirSync(path.join(SB, '.cua-driver', 'packages', 'releases', '0.30.2-windows-x86_64'), { recursive: true });
    },
    expect: /cua-driver 有新版未升：0\.30\.2 → 0\.35\.2/,
  },
  {
    name: 'V21b 已升到最新 ⇒ 不报（对照组）',
    plant: () => {
      w(path.join(SB, '.cua-driver', 'version_check.json'), JSON.stringify({ latest_version: '0.35.2' }));
      fs.mkdirSync(path.join(SB, '.cua-driver', 'packages', 'releases', '0.35.2-x86_64-pc-windows-msvc'), { recursive: true });
    },
    want: 0,
    expect: /^((?!cua-driver 有新版未升)[\s\S])*$/,
  },
  {
    name: 'V5 hook 接线缺失（Stop 被摘掉）',
    plant: () => { const p = path.join(H, 'settings.json'); const c = JSON.parse(fs.readFileSync(p, 'utf8')); delete c.hooks.Stop; fs.writeFileSync(p, JSON.stringify(c, null, 2)); w(path.join(C, 'settings.json'), fs.readFileSync(p, 'utf8')); },
    expect: /缺 Stop 接线/,
  },
  {
    name: 'V6 机制心跳过期（20 天没动静）',
    build: () => buildSandbox({ staleHeartbeat: true }),
    expect: /天没更新/,
  },
  {
    name: 'V7 两侧漂移（改单边，--no-fix 下应报 DRIFT）',
    plant: () => { fs.appendFileSync(path.join(H, 'rules', 'java.md'), '\n只改了本侧。\n'); },
    expect: /漂移|DRIFT/,
    args: ['--no-fix'],
  },
  {
    name: 'V8 AGENTS.md 篇幅超硬线',
    plant: () => { const bloated = AGENTS + '\n' + Array(200).fill('- 填充行').join('\n') + '\n'; w(path.join(H, 'AGENTS.md'), bloated); w(path.join(C, 'AGENTS.md'), bloated); },
    expect: /已 \d+ 行（硬线 190）/,
  },
  {
    name: 'V11 遵守率：机制文件被删 → 报"机制掉了"',
    plant: () => { fs.rmSync(path.join(H, 'scripts', 'stop-gate.js')); },
    expect: /遵守率[\s\S]{0,200}机制缺失 stop-gate\.js/,
  },
  {
    name: 'V12 遵守率：机制里判据被改名 → 报"找不到对应判据"',
    plant: () => { w(path.join(H, 'scripts', 'stop-gate.js'), '// stub: R1b- R2x R3- R5-\n'); },
    expect: /遵守率[\s\S]{0,240}已找不到对应判据/,
  },
  {
    name: 'V13 两侧 hook 接线不一致（只在 CN 多挂一个）→ 报"接线不一致"',
    plant: () => {
      const p = path.join(C, 'settings.json');
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      c.hooks.Stop.push({ hooks: [{ type: 'command', command: 'only-on-cn.js', timeout: 5 }] });
      fs.writeFileSync(p, JSON.stringify(c, null, 2));
    },
    expect: /两侧接线不一致[\s\S]{0,120}仅 CN 有/,
  },
  {
    name: 'V14 两侧都漏挂同一事件 → 完整性检查仍要报',
    plant: () => {
      for (const side of [H, C]) {
        const p = path.join(side, 'settings.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        delete c.hooks.PreToolUse;
        fs.writeFileSync(p, JSON.stringify(c, null, 2));
      }
    },
    expect: /缺 PreToolUse 接线/,
  },
  {
    name: 'V15 磁盘工具跑不起来 → 周检必须出声（否则低水位提醒会静默消失）',
    plant: () => { w(path.join(H, 'scripts', 'disk-sweeper.js'), 'throw new Error("模块坏了")\n'); },
    expect: /磁盘水位[\s\S]{0,200}未能执行|磁盘水位[\s\S]{0,200}不是 JSON/,
  },
  {
    name: 'V17 settings 里有 modelConfigs.customModels → 周检必须报红（它会把 BYOK provider 整体清掉）',
    plant: () => {
      const p = path.join(C, 'settings.json');
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      c.modelConfigs = { customModels: [{ provider: 'qoder-custom-x', apiKey: 'k', model: 'm' }] };
      fs.writeFileSync(p, JSON.stringify(c, null, 2));
    },
    expect: /modelConfigs\.customModels[\s\S]{0,160}provider 会被整体丢弃/,
  },
  {
    name: 'V9 内联检查耗时超预算（调用方必然超时）',
    build: () => buildSandbox({ slowMemory: true }),
    expect: /超出调用方预算 8s/,
  },
  {
    name: 'V9b 内联检查串行合计越过 hook 超时（被掐死的是整段体检）',
    plant: () => {
      // 把消费者自己的超时压到 8s，而它内部两路检查各带 8s 上限、总预算 11s ⇒ 必然越界。
      // 单项判据看不见这种洞：每一路都"没超时"，加起来却整段被 hook 掐掉、连提醒都不输出。
      for (const side of [H, C]) {
        const p = path.join(side, 'settings.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const g of (c.hooks || {}).SessionStart || []) {
          for (const h of g.hooks || []) {
            if (String(h.command).includes('global-config-guard.js')) h.timeout = 8;
          }
        }
        fs.writeFileSync(p, JSON.stringify(c, null, 2));
      }
    },
    expect: /声明的总预算 11s ≥ hook 超时 8s/,
  },
  // ── hook 身份比较（2026-11-07：只比 command 字符串把 args/base64 形式误判成"另一侧没挂"）──
  {
    name: 'V22 args 数组与单串指向同一脚本 → 不算接线差异（假阳性回归对照）',
    plant: () => {
      const script = path.join(H, 'scripts', 'stop-gate.js');
      const ph = path.join(H, 'settings.json');
      const ch = JSON.parse(fs.readFileSync(ph, 'utf8'));
      ch.hooks.Stop = [{ hooks: [{ type: 'command', command: NODE, args: [script], timeout: 15 }] }];
      fs.writeFileSync(ph, JSON.stringify(ch, null, 2));
      const pc = path.join(C, 'settings.json');
      const cc = JSON.parse(fs.readFileSync(pc, 'utf8'));
      cc.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node ' + script, timeout: 15 }] }];
      fs.writeFileSync(pc, JSON.stringify(cc, null, 2));
    },
    want: 0,
    expect: /^((?!两侧接线不一致)[\s\S])*$/,
  },
  {
    name: 'V23 base64 包装与单串指向同一脚本 → 不算接线差异（run-package-hook 形式）',
    plant: () => {
      const payload = Buffer.from(JSON.stringify({ client: H, event: 'Stop', script: 'stop-gate.js', args: [] })).toString('base64');
      const ph = path.join(H, 'settings.json');
      const ch = JSON.parse(fs.readFileSync(ph, 'utf8'));
      ch.hooks.Stop = [{ hooks: [{ type: 'command', command: NODE, args: [path.join(H, 'scripts', 'run-package-hook.cjs'), payload], timeout: 15 }] }];
      fs.writeFileSync(ph, JSON.stringify(ch, null, 2));
      const pc = path.join(C, 'settings.json');
      const cc = JSON.parse(fs.readFileSync(pc, 'utf8'));
      cc.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node ' + path.join(H, 'scripts', 'stop-gate.js'), timeout: 15 }] }];
      fs.writeFileSync(pc, JSON.stringify(cc, null, 2));
    },
    want: 0,
    expect: /^((?!两侧接线不一致)[\s\S])*$/,
  },
  {
    name: 'V24 包装形式的脚本另一侧没挂 → 仍要报"仅非 CN 有"（身份比较不能漏报真差异）',
    plant: () => {
      const payload = Buffer.from(JSON.stringify({ client: H, event: 'Stop', script: 'stop-gate.js', args: [] })).toString('base64');
      const ph = path.join(H, 'settings.json');
      const ch = JSON.parse(fs.readFileSync(ph, 'utf8'));
      ch.hooks.Stop = [{ hooks: [{ type: 'command', command: NODE, args: [path.join(H, 'scripts', 'run-package-hook.cjs'), payload], timeout: 15 }] }];
      fs.writeFileSync(ph, JSON.stringify(ch, null, 2));
    },
    expect: /两侧接线不一致[\s\S]{0,120}仅非 CN 有 stop-gate\.js/,
  },
  {
    name: 'V25 单侧缺 PostToolUse → 完整性检查要报（第五事件纳入后）',
    plant: () => {
      const pc = path.join(C, 'settings.json');
      const cc = JSON.parse(fs.readFileSync(pc, 'utf8'));
      delete cc.hooks.PostToolUse;
      fs.writeFileSync(pc, JSON.stringify(cc, null, 2));
    },
    expect: /缺 PostToolUse 接线/,
  },
  {
    name: 'V26 args 形式指向不存在的脚本 → 存在性检查要穿透 args（V18 只覆盖单串）',
    plant: () => {
      for (const side of [H, C]) {
        const p = path.join(side, 'settings.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        c.hooks.Stop = [{ hooks: [{ type: 'command', command: NODE, args: [path.join(H, 'scripts', 'ghost-stop-gate.js')], timeout: 15 }] }];
        fs.writeFileSync(p, JSON.stringify(c, null, 2));
      }
    },
    expect: /指向不存在的脚本[\s\S]{0,160}从未运行过/,
  },
  {
    name: 'V27 同名脚本两侧开关不同 → 报 INFO 但不判红（行为口径分叉要可见）',
    plant: () => {
      const script = path.join(H, 'scripts', 'rules-reminder.js');
      const ph = path.join(H, 'settings.json');
      const ch = JSON.parse(fs.readFileSync(ph, 'utf8'));
      ch.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: NODE, args: [script, '--workflow-mode', 'model'], timeout: 5 }] }];
      fs.writeFileSync(ph, JSON.stringify(ch, null, 2));
      const pc = path.join(C, 'settings.json');
      const cc = JSON.parse(fs.readFileSync(pc, 'utf8'));
      cc.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: 'node ' + script, timeout: 5 }] }];
      fs.writeFileSync(pc, JSON.stringify(cc, null, 2));
    },
    want: 0,
    expect: /两侧开关不同：非 CN \[--workflow-mode\] \/ CN \[无\]/,
  },
  {
    name: 'V28 powershell -File 的 args 形式与单串形式 → 同一脚本不算差异（BYOK guardian 形态）',
    plant: () => {
      const script = path.join(H, 'scripts', 'stop-gate.js');
      const ph = path.join(H, 'settings.json');
      const ch = JSON.parse(fs.readFileSync(ph, 'utf8'));
      ch.hooks.Stop = [{ hooks: [{ type: 'command', command: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'Start'], timeout: 10 }] }];
      fs.writeFileSync(ph, JSON.stringify(ch, null, 2));
      const pc = path.join(C, 'settings.json');
      const cc = JSON.parse(fs.readFileSync(pc, 'utf8'));
      cc.hooks.Stop = [{ hooks: [{ type: 'command', command: 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + script + ' -Action Start', timeout: 10 }] }];
      fs.writeFileSync(pc, JSON.stringify(cc, null, 2));
    },
    want: 0,
    expect: /^((?!两侧接线不一致)[\s\S])*$/,
  },
];

for (const c of cases) {
  if (c.build) c.build(); else { buildSandbox(); c.plant(); }
  const res = audit(c.args || []);
  // 植入型用例默认要求"报红且退 1"；对照组用 `want: 0` 要求"健康退 0"、`want: 'any'` 只断言输出内容
  // （有些对照场景会合法地带着别的告警退 1，此时只有"某句话不得出现"才是有效断言）。
  const wantCode = c.want === 'any' ? null : (c.want ?? 1);
  const pass = (wantCode === null || res.code === wantCode) && c.expect.test(res.out);
  check(c.name, pass, `exit=${res.code}`);
  if (!pass) {
    console.log('     实际输出片段：' + res.out.replace(/\n/g, ' | ').slice(0, 240));
  }
}

// ── 自动修：漂移在默认模式下应被修掉且退出码回落 ──
buildSandbox();
fs.appendFileSync(path.join(H, 'rules', 'java.md'), '\n只改了本侧。\n');
r = audit();
check('V10 漂移默认只报告而不自动覆盖', r.code === 1 && /两侧漂移/.test(r.out) && !/已自动同步/.test(r.out), `exit=${r.code}`);
const after = fs.readFileSync(path.join(C, 'rules', 'java.md'), 'utf8');
check('V10b 未授权时另一侧原文保持不变', !after.includes('只改了本侧'));

// ── 单端形态（只装 Qoder，没有 ~/.qoder-cn）：合法安装，必须同样零告警 ──
// 这是 2026-09-23 修掉的一类假警报：两个同步脚本曾硬要求"另一侧"存在（退 2），
// 于是单端用户每次开会话都会收到"规则不生效"，周检也会滚出一堆"读不到/解析失败"。
buildSandbox();
fs.rmSync(C, { recursive: true, force: true });
r = audit();
check('V16 单端（无 ~/.qoder-cn）也必须零告警（反假警报）', r.code === 0, `exit=${r.code}`);
if (r.code !== 0) console.log('     实际输出片段：' + r.out.replace(/\n/g, ' | ').slice(0, 300));

// ── T-11 / A1：现役体检只读巡检通道（两个 doctor 挂进周检，不进 CI 隔离 HOME）──
function installDoctors(skillsStub) {
  fs.copyFileSync(path.join(__dirname, 'config-doctor.cjs'), path.join(H, 'scripts', 'config-doctor.cjs'));
  fs.copyFileSync(path.join(__dirname, 'client-root.js'), path.join(H, 'scripts', 'client-root.js'));
  if (skillsStub) w(path.join(H, 'scripts', 'skills-doctor.cjs'), skillsStub);
  else fs.copyFileSync(path.join(__dirname, 'skills-doctor.cjs'), path.join(H, 'scripts', 'skills-doctor.cjs'));
}
function ledgerLast() {
  const p = path.join(H, 'tmp', 'rules-audit', 'history.log');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).pop() || '';
}
function driftCnHooks() {
  const p = path.join(C, 'settings.json');
  const original = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(original);
  j.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'node ' + path.join(H, 'scripts', 'helper.js'), timeout: 5 });
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
  return { p, original };
}

buildSandbox();
installDoctors();
r = audit(['--no-fix']);
const cdHits = (r.out.match(/现役体检 — config-doctor/g) || []).length;
const sdHits = (r.out.match(/现役体检 — skills-doctor/g) || []).length;
check('V29 巡检报告含 config-doctor 与 skills-doctor 结论各 1 次', cdHits === 1 && sdHits === 1, `config-doctor=${cdHits} skills-doctor=${sdHits} exit=${r.code}`);
if (cdHits !== 1 || sdHits !== 1) console.log('     实际输出片段：' + r.out.replace(/\n/g, ' | ').slice(0, 400));
check('V29b --no-fix 不写台账（只读巡检零写入）', ledgerLast() === '', ledgerLast());

buildSandbox();
installDoctors();
const drift = driftCnHooks();
r = audit(['--no-fix']);
check('V30 负对照：造一条 hook 接线漂移后巡检必须判红',
  r.code === 1 && /现役体检 — config-doctor 判红/.test(r.out) && /HOOK-DIFF/.test(r.out), `exit=${r.code}`);
if (!/现役体检 — config-doctor 判红/.test(r.out)) console.log('     实际输出片段：' + r.out.replace(/\n/g, ' | ').slice(0, 400));
fs.writeFileSync(drift.p, drift.original);
r = audit(['--no-fix']);
check('V30b 还原漂移后 config-doctor 复绿', /现役体检 — config-doctor 结论 CLEAN/.test(r.out), `exit=${r.code}`);
if (!/现役体检 — config-doctor 结论 CLEAN/.test(r.out)) console.log('     实际输出片段：' + r.out.replace(/\n/g, ' | ').slice(0, 400));

buildSandbox();
// 真 skills-doctor 在裸沙箱里会因两侧 skills/ 不存在而判红（V29 实测），
// 所以「健康 → doctors 字段为空」这条必须用绿色桩，否则断言的是沙箱缺陷而不是巡检行为。
installDoctors('console.log("OK    SKILL-PARITY=0");\nconsole.log("VERDICT=CLEAN");\nprocess.exit(0);\n');
r = audit();
check('V31 健康时台账追加 doctors= 空字段', /\|doctors=$/.test(ledgerLast()), ledgerLast());
const drift2 = driftCnHooks();
r = audit();
check('V31b 红项进台账 doctors=config-doctor', /\|doctors=config-doctor/.test(ledgerLast()), ledgerLast());
fs.writeFileSync(drift2.p, drift2.original);

buildSandbox();
installDoctors('console.log("RED   SKILL-PARITY  两侧技能集不一致");\nconsole.log("VERDICT=RED");\nprocess.exit(1);\n');
r = audit(['--no-fix']);
check('V32 doctor 判红 → 周检 warn 且点名红项', r.code === 1 && /现役体检 — skills-doctor 判红 1 项/.test(r.out) && /SKILL-PARITY/.test(r.out), `exit=${r.code}`);

buildSandbox();
installDoctors('console.log("ERROR precondition");\nprocess.exit(2);\n');
r = audit(['--no-fix']);
check('V33 doctor 前置失败（exit 2）→ 报"未能执行"而不是静默', /现役体检 — skills-doctor 未能执行（退出码 2）/.test(r.out), `exit=${r.code}`);

buildSandbox();
r = audit(['--no-fix']);
check('V34 未装 doctor 的单端机器 → INFO 跳过、不判红、不凭空造目录',
  r.code === 0 && /现役体检 — config-doctor 不在本机客户端 scripts 目录，跳过/.test(r.out), `exit=${r.code}`);

// 单端 + 只装 CN 侧：巡检不得为了跑 doctor 去新建 .qoder
buildSandbox();
fs.rmSync(C, { recursive: true, force: true });
fs.copyFileSync(path.join(__dirname, 'config-doctor.cjs'), path.join(H, 'scripts', 'config-doctor.cjs'));
fs.copyFileSync(path.join(__dirname, 'client-root.js'), path.join(H, 'scripts', 'client-root.js'));
r = audit(['--no-fix']);
check('V35 单端跑巡检后另一侧目录仍不存在（0 个凭空创建）', !fs.existsSync(C), `exists=${fs.existsSync(C)} exit=${r.code}`);

// ── T-12 / A6：evidence-audit 接线（判红逻辑本身已存在，这里只验「真的被调用」）──
function installEvidenceAudit() {
  fs.copyFileSync(path.join(__dirname, 'evidence-audit.cjs'), path.join(H, 'scripts', 'evidence-audit.cjs'));
}
function evidenceReport(label, tamperRunId) {
  const crypto = require('crypto');
  const dir = path.join(H, 'tmp', 'evidence-audit');
  fs.mkdirSync(dir, { recursive: true });
  const runId = 'run-' + label;
  const mk = (name, exitCode, stdout, rid) => {
    const value = { schema: 1, runId: rid || runId, cwd: SB, level: 'runtime', termination: 'completed', exitCode, stdout, stderr: '' };
    const buf = Buffer.from(JSON.stringify(value, null, 1));
    const record = path.join(dir, name);
    fs.writeFileSync(record, buf);
    // 周检按 mtime 选「最近一份报告」。真实布局里记录落在 records/ 子目录、不会与计划竞争；
    // 本夹具把两者平铺在同一目录，若三次写入落在同一个 mtime 刻度内，稳定排序会退回 readdir
    // 字母序而选中 neg.json（记录不是计划）→ 判 ERROR，V37/V38 随机器快慢假红。
    // 把记录时间显式拨旧，让计划文件无歧义地最新；判定语义与断言均不变。
    const older = new Date(Date.now() - 60000);
    fs.utimesSync(record, older, older);
    return { file: name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), expect: { exitCode, stdoutIncludes: [stdout] } };
  };
  const positive = mk('pos.json', 0, 'PASS');
  const negative = mk('neg.json', 1, 'FAIL', tamperRunId ? 'other-run' : runId);
  const plan = {
    schema: 1, task: '接线负对照', runId, cwd: SB,
    checks: [{ id: 'c1', claim: '测试全绿', requiredLevel: 'runtime', status: 'verified', changedVariable: 'x', positive, negative }],
  };
  const file = path.join(dir, label + '.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 1));
  return file;
}

buildSandbox();
installEvidenceAudit();
r = audit(['--no-fix']);
check('V36 无证据报告 → INFO 提示而不是静默', /证据审计 — 尚无证据报告可核对/.test(r.out) && !/证据审计 — .*结论/.test(r.out), `exit=${r.code}`);

buildSandbox();
installEvidenceAudit();
evidenceReport('pass');
r = audit(['--no-fix']);
check('V37 对照组：真实 PASS 报告 → 周检记 INFO 且零告警', r.code === 0 && /证据审计 — pass\.json 结论 PASS/.test(r.out), `exit=${r.code}`);
if (r.code !== 0) console.log('     实际输出片段：' + r.out.replace(/\n/g, ' | ').slice(0, 300));

buildSandbox();
installEvidenceAudit();
evidenceReport('tampered', true);
r = audit(['--no-fix']);
check('V38 接线负对照：主张已验证但证据不属本轮 → 周检必须判红',
  r.code === 1 && /证据审计 — tampered\.json 结论 FAIL/.test(r.out), `exit=${r.code}`);
if (!/证据审计 — tampered\.json 结论 FAIL/.test(r.out)) console.log('     实际输出片段：' + r.out.replace(/\n/g, ' | ').slice(0, 400));

// 变异负对照：摘掉 checkEvidenceAudit() 调用后，同一份篡改报告必须不再产生证据审计告警
{
  const source = fs.readFileSync(AUDIT, 'utf8');
  const mutant = source.replace('  checkEvidenceAudit();\n', '');
  check('V39 变异命中调用点', mutant !== source && !mutant.includes('  checkEvidenceAudit();'));
  const mutantFile = path.join(__dirname, 'rules-weekly-audit.mutant.tmp.js');
  fs.writeFileSync(mutantFile, mutant);
  const mr = spawnSync(NODE, [mutantFile, '--no-fix'], { encoding: 'utf8', env: { ...process.env, HOME: SB, USERPROFILE: SB, HOOK_CRASH_LOG: path.join(SB, 'sandbox-hooks-crash.log') }, timeout: 120000 });
  const mout = (mr.stdout || '') + (mr.stderr || '');
  check('V39b 变异负对照：摘掉接线后同一篡改报告不再被判红（证明告警确由接线产生）',
    !/证据审计 —/.test(mout), `exit=${mr.status}`);
  fs.unlinkSync(mutantFile);
}

buildSandbox();
r = audit(['--no-fix']);
check('V40 未装 evidence-audit → INFO 跳过、不判红', r.code === 0 && /证据审计 — evidence-audit\.cjs 不在本机客户端 scripts 目录，跳过/.test(r.out), `exit=${r.code}`);

fs.rmSync(SB, { recursive: true, force: true });
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
