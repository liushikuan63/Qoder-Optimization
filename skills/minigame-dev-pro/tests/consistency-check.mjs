#!/usr/bin/env node
// consistency-check.mjs — 注册表完整性 + 跨文件事实一致性（1.0.5）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(ROOT, 'references', 'data', 'spec-registry.json');

function main() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const withPlatform = reg.specs.filter((s) => s.platform).length;
  const withLayer = reg.specs.filter((s) => s.layer).length;
  console.log(`注册表：${reg.specs.length} 条；platform=${withPlatform}；layer=${withLayer}`);

  // 跨文件包体一致性：tech-specs 与 error-reference 均须带 platform 标签，且同 platform 内部一致
  const tech = fs.readFileSync(path.join(ROOT, 'references/knowledge/tech-specs.md'), 'utf8');
  const err = fs.readFileSync(path.join(ROOT, 'references/knowledge/error-reference.md'), 'utf8');
  const techTagged = /微信|platform\s*=\s*wechat|platform=wechat/.test(tech);
  const errTagged = /微信|platform\s*=\s*wechat|platform=wechat/.test(err);
  console.log(`包体声明平台标注：tech-specs=${techTagged} error-reference=${errTagged}`);

  const ok = reg.specs.length >= 10 && withPlatform === reg.specs.length && withLayer === reg.specs.length && techTagged && errTagged;
  console.log(`\n一致性校验=${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}
main();
