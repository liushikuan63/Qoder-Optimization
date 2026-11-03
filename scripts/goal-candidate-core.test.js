'use strict';

const { classifyGoalCandidate, goalCandidateNote } = require('./goal-candidate-core.js');

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const longTask = '开始代码实现，完成前后端联调，部署线上验证通过后提交SVN';
const candidate = classifyGoalCandidate(longTask);
check('多阶段实现+联调+部署+提交命中候选', candidate.candidate && candidate.matchedStages.length === 4);
const note = goalCandidateNote(longTask);
check('候选提醒要求AskUserQuestion确认Goal', note.includes('AskUserQuestion') && note.includes('创建目标并持续推进'));
check('候选提醒主动询问Vibecoding文档', note.includes('Vibecoding 四层文档') && note.includes('创建或更新'));

const explicit = classifyGoalCandidate('请设为Goal模式并持续推进到完成');
check('显式Goal请求直接识别授权', explicit.candidate && explicit.explicitGoal);
check('显式Goal仍检查Vibecoding文档', goalCandidateNote('请设为Goal模式并持续推进到完成').includes('Vibecoding'));

check('单点小修复不命中', !classifyGoalCandidate('修复一个按钮文案并提交').candidate);
check('纯只读审阅不命中', !classifyGoalCandidate('只读审查这个方案并给建议，不要修改文件').candidate);
check('普通实现但无部署交付边界不命中', !classifyGoalCandidate('实现一个本地解析函数并测试').candidate);
check('目录任务包文字本身不命中', !classifyGoalCandidate('看看目录里的vibecoding任务包').candidate);
check('阈值变异后原候选翻转', !classifyGoalCandidate(longTask, { minStages: 5 }).candidate);

console.log(failures ? `\n${failures} 项失败` : '\nALL PASS');
process.exit(failures ? 1 : 0);
