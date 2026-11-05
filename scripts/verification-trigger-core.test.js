'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyVerificationTrigger, buildTriggerNote } = require('./verification-trigger-core.js');

test('可执行任务触发选档', () => {
  const prompts = [
    '实现用户导出功能',
    '修复登录接口的鉴权缺陷',
    '给 B05 加上自动触发接线',
    '帮我加个导出功能',
    '重构订单模块并补充回归测试，然后部署上线',
    '另外把接口鉴权也加上',
    '帮我修一下这个报错',
    '重写这个组件',
    '把超时时间调成 30 秒',
    '生成一份月度报表',
    '把数据导出成 Excel',
    '跑一下端到端测试',
    '把这个模块拆分一下',
  ];
  for (const prompt of prompts) {
    const result = classifyVerificationTrigger(prompt);
    assert.equal(result.trigger, true, prompt + ' → ' + result.reason);
  }
});

test('问答、确认、只读、琐碎改动与同任务续做不触发', () => {
  const prompts = [
    '',
    '现在多段检测机制，是否已经在本机生效',
    '继续',
    '确认',
    '只读分析这个仓库的目录结构',
    '为什么构建失败了？',
    '怎么修复这个问题',
    '是否已经部署上线',
    '修复一个按钮文案并提交',
    '继续修复这个问题',
    '把日志改成 UTC',
    '帮我把这段话润色一下',
    '检查一下这段代码有没有问题',
    '看一下这个文件',
    '继续重写这个组件',
    '修一下按钮文案',
  ];
  for (const prompt of prompts) {
    const result = classifyVerificationTrigger(prompt);
    assert.equal(result.trigger, false, prompt + ' → ' + result.reason);
  }
});

test('显式要求选档时即使没有动作词也触发', () => {
  assert.equal(classifyVerificationTrigger('按难度选验证').reason, 'EXPLICIT');
});

test('请求式问句按任务触发，纯咨询/状态问句不触发', () => {
  assert.equal(classifyVerificationTrigger('是否可以给 B05 加个开关').trigger, true);
  assert.equal(classifyVerificationTrigger('能否帮我修复登录接口').trigger, true);
  assert.equal(classifyVerificationTrigger('是否应该重构这个模块').trigger, false);
  assert.equal(classifyVerificationTrigger('现在是否已经部署上线').trigger, false);
});

test('提示文本包含政策入口、提问方式、授权边界与退出条件', () => {
  const note = buildTriggerNote(classifyVerificationTrigger('重构订单模块并补充回归测试'), 'X:/qoder/scripts/verification-policy.cjs');
  assert.match(note, /【B05 自动选档 · 已触发】/);
  assert.match(note, /verification-policy\.cjs/);
  assert.match(note, /AskUserQuestion/);
  assert.match(note, /mandatoryCheckIds/);
  assert.match(note, /resolveAuthority/);
  assert.match(note, /咨询模式/);
  assert.match(note, /忽略本条/);
});
