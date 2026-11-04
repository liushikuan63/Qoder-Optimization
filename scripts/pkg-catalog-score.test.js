'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { norm, CAT_LABEL, hay, scoreEntry } = require('./pkg-catalog-score.cjs');

const entry = { id: 'skill:demo-tool', name: 'demo-tool', category: 'skill', description: '演示用的技能' };

test('norm lowercases and tolerates missing input', () => {
  assert.equal(norm('Demo'), 'demo');
  assert.equal(norm(undefined), '');
});

test('hay includes name, description and Chinese category label', () => {
  const text = hay(entry);
  assert.ok(text.includes('demo-tool'));
  assert.ok(text.includes('演示用'));
  assert.ok(text.includes(CAT_LABEL.skill));
});

test('scoreEntry prefers exact matches over partial description hits', () => {
  const exact = scoreEntry(entry, 'demo-tool', ['demo-tool']);
  const partial = scoreEntry(entry, '演示', ['演示']);
  assert.ok(exact > partial);
  assert.equal(scoreEntry(entry, '不存在的词', ['不存在的词']), 0);
});
