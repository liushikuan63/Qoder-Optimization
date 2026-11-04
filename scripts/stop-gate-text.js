'use strict';

// 判"收尾行为"的规则都要先剥掉引用：引用来的违规原文、规则示例不算我自己的陈述。
// 2026-10-27：这段剥离原先只有 R1/R2 用（tailView），R3 只剥围栏代码块 ⇒ 复盘时引用规则原文
// （"只写『界面已完成』就放行"）被当成我自己的交付主张拦下。现抽成公共函数，R1/R2/R3/R9 共用。
function stripQuoted(t) {
  return String(t == null ? '' : t)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]{1,200}`/g, ' ')
    .replace(/"[^"\n]{1,400}"/g, ' ')
    .replace(/“[^”\n]{1,400}”/g, ' ')
    .replace(/「[^」\n]{1,400}」/g, ' ');
}

module.exports = { stripQuoted };
