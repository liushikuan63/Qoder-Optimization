/**
 * 发行复盘清单校验（自研，1.1.0 新增）
 *
 * 职责：校验发行/上线复盘清单（production/release-checklist.md）是否含必备章节——
 *       上线前检查、热更预案、社区与合规沟通、Post-Mortem 复盘。确保 release-ops.md
 *       （发行运营方法论）有可校验的产出，而非表面功能（计划附录④）。
 *
 * 边界（human-in-the-loop）：
 *  - 本工具只校验清单章节完整性，不替用户写复盘；复盘内容由人工/运营填写。
 *  - 真机/官方面审不在 agent 范围；清单齐备仅代表流程闭环就绪，不标"已通过官方审核"。
 *
 * 输入契约（计划附录② P0）：--project 必填；缺失即报错退出（exit 1），不静默跑空。
 * 0 外部依赖。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const VERSION = '1.1.0';
const REQUIRED_SECTIONS = ['上线前', '热更', '复盘', '合规沟通'];

const HELP = `发行复盘清单校验（${VERSION}）

用法:
  node scripts/release-gate.mjs --project <路径> [--checklist <file>] [--json]

必填:
  --project <path>   小游戏项目目录（默认探测 production/release-checklist.md 或 release-checklist.md）

可选:
  --checklist <file>  自定义清单路径
  --json             输出 JSON
  --help             显示本帮助

退出码:
  0  校验完成（含 warn 级缺口）
  1  --project 缺失 / 路径不存在 / 参数非法`;

/**
 * 核心校验（可复用于 tests/release-gate.mjs，零重复逻辑）
 * @returns {{found:boolean, present:boolean, complete:boolean, missing:string[], sections:string[]}}
 */
export function runReleaseGate(absProject, opts = {}) {
  const candidates = [
    opts.checklist ? resolve(opts.checklist) : null,
    join(absProject, 'production', 'release-checklist.md'),
    join(absProject, 'release-checklist.md'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) {
      const txt = readFileSync(c, 'utf-8');
      const missing = REQUIRED_SECTIONS.filter((s) => !txt.includes(s));
      return { found: true, present: true, complete: missing.length === 0, missing, sections: REQUIRED_SECTIONS };
    }
  }
  return { found: false, present: false, complete: false, missing: REQUIRED_SECTIONS, sections: REQUIRED_SECTIONS };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelp(HELP);
  const json = !!args.json;
  if (!args.project) outputError('缺少 --project <项目目录>（P0 输入契约，不静默跑空）', { hint: 'node scripts/release-gate.mjs --project ./my-game' }, json);
  const absProject = resolve(args.project);
  if (!existsSync(absProject)) outputError(`项目路径不存在: ${absProject}`, {}, json);

  const result = runReleaseGate(absProject, { checklist: args.checklist });
  if (!result.found) {
    outputSuccess({
      tool: 'release-gate',
      version: VERSION,
      found: false,
      present: false,
      missing: result.missing,
      note: '未找到发行复盘清单（production/release-checklist.md）；建议参考 release-ops.md 建立上线前/热更/复盘/合规沟通四节清单。',
    }, json);
    return;
  }
  if (!result.complete) {
    outputSuccess({
      tool: 'release-gate',
      version: VERSION,
      found: true,
      present: true,
      complete: false,
      missing: result.missing,
      note: `清单存在但缺章节：${result.missing.join('、')}；补齐后重跑。`,
    }, json);
    return;
  }
  outputSuccess({
    tool: 'release-gate',
    version: VERSION,
    found: true,
    present: true,
    complete: true,
    missing: [],
    note: '发行复盘清单完整（上线前/热更/复盘/合规沟通）；清单齐备仅代表流程闭环就绪，不标"已通过官方审核"。',
  }, json);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => outputError(`release-gate.mjs 未预期错误: ${e && e.stack ? e.stack : e}`, {}, false));
}
