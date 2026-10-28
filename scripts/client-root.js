'use strict';
// 客户端配置根解析：单端装配时不制造另一侧目录（2026-10-27）。
// 判定全部基于文件系统事实：
//   ① QODER_HOME 显式指定（测试 / 非标准安装）；
//   ② HOME 下只有一侧（.qoder 国际版 / .qoder-cn CN）⇒ 就是它，另一侧不存在就不碰；
//   ③ 两侧都在 ⇒ .qoder（状态主目录，与历史口径一致）；
//   ④ 都不在（客户端还没装、脚本从包目录直接跑）⇒ .qoder（安装说明里指定落点）。
// 反面教材：判"哪一侧"不能用 __dirname —— 本机 .qoder-cn/scripts 是指向 .qoder/scripts 的
// junction，被 require 的模块 __dirname 会被 Node realpath 成实体侧（实测），
// process.argv[1] 才保留调用方路径；但测试靠 HOME 隔离沙箱，故 HOME 只有一侧时以 HOME 为准。
const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir(home) {
  return home || process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function clientRoot(home) {
  if (process.env.QODER_HOME) return path.resolve(process.env.QODER_HOME);
  const h = homeDir(home);
  const sides = [path.join(h, '.qoder'), path.join(h, '.qoder-cn')].filter((p) => {
    try { return fs.existsSync(p); } catch (e) { return false; }
  });
  if (sides.length === 1) return sides[0];
  return path.join(h, '.qoder');
}

// 另一侧：不存在就返回 null —— 单端装配下调用方必须跳过该侧，而不是 mkdir 出来。
function counterpart(root) {
  if (!root) return null;
  const other = path.basename(root) === '.qoder' ? '.qoder-cn' : '.qoder';
  const p = path.join(path.dirname(root), other);
  try { return fs.existsSync(p) ? p : null; } catch (e) { return null; }
}

// Resource lookup follows the wrapper's installation, not the caller's HOME.
function resolveSkillFile(name, file, root = path.resolve(__dirname, '..')) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || path.isAbsolute(file) || /[\\:]/.test(file) || file.split('/').includes('..')) throw new Error('Invalid skill resource path');
  const matches = ['skills', 'skills-library'].map(tier => path.join(root, tier, name, file)).filter(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (matches.length !== 1) throw new Error(`${matches.length ? 'Ambiguous' : 'Missing'} skill resource: ${name}/${file}`);
  return matches[0];
}

module.exports = { clientRoot, counterpart, homeDir, resolveSkillFile };
