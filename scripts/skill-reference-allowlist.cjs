'use strict';

// 允许清单只记录"引用有效但解析器按技能根找不到"的跨技能路径；每条必须写明原因。
module.exports = {
  schema: 1,
  entries: [
    {
      skill: 'skill-trim-with-capability-transfer',
      ref: 'scripts/docx-surgery.js',
      reason: 'cross-skill reference to skills/office-docs/scripts/docx-surgery.js; the validator resolves only within the current skill and the repo root',
    },
    {
      skill: 'skill-authoring-closure',
      ref: 'scripts/evolution.js',
      reason: 'cross-skill reference to skills/self-evolution/scripts/evolution.js',
    },
    {
      skill: 'share-package-release',
      ref: 'scripts/pkg-diff.cjs',
      reason: 'cross-skill reference to skills/merge-inbound-qoder-package/scripts/pkg-diff.cjs; pkg-diff lives in the merge skill and is not shipped under the package root scripts/',
    },
    {
      skill: 'awesome-design-md',
      ref: 'scripts/derive-examples-block.mjs',
      reason: 'imported design-system mirrors: the blockquote describes the UPSTREAM derivation tool that generated these DESIGN.md files; that script is not part of this package and the mirrors are kept verbatim',
    },
    {
      skill: 'deliver-prd',
      ref: '../../docs/internal/release-plans/v2.32.0/spec_c3-ai-product-family.md',
      reason: 'HISTORY.md records paths in the upstream authoring repository, not files shipped in this package',
    },
    {
      skill: 'deliver-prd',
      ref: '../../docs/internal/skill-versioning.md',
      reason: 'HISTORY.md records paths in the upstream authoring repository, not files shipped in this package',
    },
    {
      skill: 'electron-app-stuck-spinner-triage',
      ref: 'resources/app/main.js',
      reason: 'illustrative path inside the Electron application being diagnosed (app.asar layout), not a file in this repository',
    },
    {
      skill: 'frontend-development',
      ref: '../../vite.config.ts',
      reason: 'illustrative path in the user project being described (import-alias example), not a file in this repository',
    },
    {
      skill: 'memory-entry-update',
      ref: 'file.md',
      reason: 'generic placeholder filename used in a prose example, not a real reference',
    },
    {
      skill: 'office-docs',
      ref: '图.png',
      reason: 'generic placeholder image name used in a STYLES.md example, not a real reference',
    },
  ],
};
