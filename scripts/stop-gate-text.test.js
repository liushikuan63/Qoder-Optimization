'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { stripQuoted } = require('./stop-gate-text.js');

test('stripQuoted removes fenced blocks, inline code and quoted spans', () => {
  const text = '前文 ```js\nconst x = 1;\n``` 中 `inline` 后 "双引号" “中文引号” 「直角引号」 结尾';
  assert.equal(stripQuoted(text).replace(/\s+/g, ' ').trim(), '前文 中 后 结尾');
});

test('stripQuoted leaves ordinary prose intact and tolerates nullish input', () => {
  assert.equal(stripQuoted('已经完成并验证'), '已经完成并验证');
  assert.equal(stripQuoted(null), '');
  assert.equal(stripQuoted(undefined), '');
});
