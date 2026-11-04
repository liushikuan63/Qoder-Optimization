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
  ],
};
