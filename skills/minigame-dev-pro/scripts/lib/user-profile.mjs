// user-profile.mjs — 用户理解与状态读写库（1.0.8）
// 存储后端：优先 memory 工具；不可用时回退 <workspace>/.workbuddy/minigame-dev/ 文件。
// 无外部依赖，无副作用（读取失败返回默认值），幂等。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const STATE_DIRNAME = 'minigame-dev';
const MEMORY_KEY = 'wechat-minigame user-profile';

function resolveStateDir() {
  // 工作区优先取 cwd 下的 .workbuddy；回退用户主目录，保证跨会话可定位。
  const candidates = [
    path.join(process.cwd(), '.workbuddy', STATE_DIRNAME),
    path.join(os.homedir(), '.workbuddy', STATE_DIRNAME),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* 尝试下一个 */
    }
  }
  return candidates[0];
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    /* 损坏或不可读返回默认值 */
  }
  return fallback;
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function loadProfile() {
  const dir = resolveStateDir();
  return readJson(path.join(dir, 'user-profile.json'), { version: '1.1.0', identity: {}, tech: {}, stage: {}, budget: {}, time: {} });
}

export function saveProfile(profile) {
  const dir = resolveStateDir();
  return writeJson(path.join(dir, 'user-profile.json'), { ...profile, version: '1.1.0', updatedAt: new Date().toISOString() });
}

export function loadProjectState() {
  const dir = resolveStateDir();
  return readJson(path.join(dir, 'project-state.json'), { version: '1.1.0', detected: false });
}

export function loadFeedbackLog() {
  const dir = resolveStateDir();
  return readJson(path.join(dir, 'feedback-log.json'), []);
}

export function appendFeedback(entry) {
  const dir = resolveStateDir();
  const log = loadFeedbackLog();
  log.push({ ...entry, timestamp: new Date().toISOString() });
  return writeJson(path.join(dir, 'feedback-log.json'), log);
}

export function loadEvolutionLog() {
  const dir = resolveStateDir();
  return readJson(path.join(dir, 'evolution-log.json'), []);
}

export function appendEvolution(entry) {
  const dir = resolveStateDir();
  const log = loadEvolutionLog();
  log.push(entry);
  return writeJson(path.join(dir, 'evolution-log.json'), log);
}

export { MEMORY_KEY, resolveStateDir };

// CLI 入口（被直接执行时）：node user-profile.mjs --get | --set '<json>'
// 供 agent 在引导完成/更新画像时持久化用户理解状态（幂等，无外部依赖）。
const __self = fileURLToPath(import.meta.url);
const __entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__self === __entry) {
  function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--get') out.get = true;
      else if (argv[i] === '--set') out.set = argv[++i];
      else if (argv[i] === '--key') out.key = argv[++i];
    }
    return out;
  }
  function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.get) {
      console.log(JSON.stringify(loadProfile(), null, 2));
      return;
    }
    if (args.set) {
      let patch;
      try { patch = JSON.parse(args.set); } catch (e) {
        console.error('[user-profile] --set 需合法 JSON');
        process.exit(1);
      }
      const cur = loadProfile();
      const next = { ...cur, ...patch, version: '1.1.0', updatedAt: new Date().toISOString() };
      const ok = saveProfile(next);
      console.log(ok ? '[user-profile] 已保存画像' : '[user-profile] 保存失败');
      process.exit(ok ? 0 : 1);
    }
    console.error('用法: node user-profile.mjs --get | --set \'<json>\'');
    process.exit(1);
  }
  main();
}
