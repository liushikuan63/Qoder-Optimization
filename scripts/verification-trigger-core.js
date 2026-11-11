'use strict';

// B05 自动选档触发判定：只从请求文本判断"这是不是一个需要验证决策的可执行任务"。
// 不读文件、不写状态、不发放任何授权；真正的档位由 verification-policy + 用户选择决定。

const ACTION = /(?:实现|开发|改造|重构|接入|迁移|新增|添加|删除|移除|优化|定位|排查|升级|部署|上线|发布|推送|提交|测试|验证|验收|编写|设计|补齐|调整|替换|安装|配置|加上|增加|修复|修改|更新|处理|搞|加|改|\b(?:implement|fix|refactor|migrate|deploy|release|wire|add|update|upgrade|remove|delete|optimi[sz]e|test|verify|configure|install|build|change|modify)\b)/i;
// 口语执行动词单独兜底，避免把单个"修/调/补"等放进 ACTION 后误伤"调查/补充说明"这类只读请求。
const EXTRA_ACTION = /(?:修(?:一下|好|下|正)|重写|重做|重命名|改名|生成|创建|新建|导出|导入|合并|拆分|清理|清除|去掉|删掉|同步|对接|联调|复现|跑(?:一下|一遍|个|测试|单测|构建|冒烟|回归)|调(?:成|到|一下|低|高|大|小)|补(?:齐|上|个|一下|测试|单测)|弄(?:一下|好|成|个)|搞定|画(?:一个|个)|写(?:一个|个|成|入)|\b(?:rewrite|generate|export|import|merge|split|clean|sync|compile)\b)/i;
const READ_ONLY = /(?:只读|仅审阅|只审查|只分析|仅分析|只评估|仅评估|不要修改|不改文件|不用改|无需修改|仅给建议|仅解释|解释一下|是什么|什么意思|\b(?:read[- ]only|just review|explain)\b)/i;
const ACK = /^(?:继续|确认|好的?|可以|同意|行|嗯|收到|是的|开始|执行|go|ok(?:ay)?)[。！!，,\s]*$/i;
const ADVICE = /^(?:怎么|如何|为什么|为何|多少|什么时候|哪里|哪个|请问|是否应该|要不要|值不值得|有没有必要)/;
const STATUS = /^(?:是否|有没有|现在).{0,24}(?:生效|部署|上线|发布|完成|成功|可用|正常|存在|运行)|已经.{0,12}(?:生效|部署|上线|发布|完成|成功)/;
const CONTINUATION = /^(?:继续|接着|然后|还有|顺便|另外|再|这里|这个|它|那|刚才|上一|按上面|照这个)/;
const EXPLICIT = /(?:按难度|选档|选择?验证(?:强度|方式|档位)|验证强度|自适应验证|分档验证)/;
const OPT_OUT = /(?:不要|不用|无需|不必|跳过|取消|关闭|禁用|停用).{0,6}(?:选档|选择?验证(?:强度|方式|档位)|验证强度|自适应验证|分档验证)/;
const SMALL_SCOPE = /(?:文案|错别字|注释|日志|颜色|样式|按钮文字|拼写|标点|格式|版本号|README|文档|说明文字|提示语|措辞|表述|话术|翻译|润色|排版|\b(?:typo|comment|readme|docs?|style|color|label|text)\b)/i;
const RISK = /(?:生产|线上|数据库|迁移|权限|鉴权|认证|计费|支付|删除|覆盖|回滚|安全|并发|性能|密钥|凭据|部署|上线|发布|推送|集群|服务端|服务器|外部|对外|\bpr\b)/i;
const SCOPE = /(?:全仓|整个仓库|跨模块|多个模块|多个文件|多文件|批量|逐个|端到端|全流程|完整|系统|模块|接口|服务|脚本|配置|settings|hook|接线|代码库|仓库|前端|后端|\b(?:module|service|api|hook|config|repo|codebase|frontend|backend)\b)/i;
const IMPLEMENT = /(?:实现|开发|改造|重构|接入|迁移|新增|添加|删除|移除|优化|修复|修改|更新|编写|设计|补齐|调整|替换|安装|配置|加上|增加|改)/;
const VERIFY = /(?:测试|验证|验收|联调|回归|截图)/;
const EXTERNAL = /(?:部署|上线|发布|推送|提交|\bpr\b)/i;

const SIGNAL_LABELS = {
  risk: '风险或外部动作',
  scope: '范围或配置变更',
  'multi-stage': '多阶段',
  explicit: '用户明确要求选档',
};

function normalize(prompt) {
  return typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
}

function classifyVerificationTrigger(prompt) {
  const text = normalize(prompt);
  const no = (reason) => ({ trigger: false, reason, signals: [] });
  if (!text) return no('EMPTY');
  if (OPT_OUT.test(text)) return no('OPT_OUT');
  if (ACK.test(text)) return no('ACK');
  if (READ_ONLY.test(text)) return no('READ_ONLY');
  if (ADVICE.test(text) || STATUS.test(text)) return no('QUESTION');
  if (EXPLICIT.test(text)) return { trigger: true, reason: 'EXPLICIT', signals: ['explicit'] };
  if (!ACTION.test(text) && !EXTRA_ACTION.test(text)) return no('NO_ACTION');
  const risk = RISK.test(text);
  if (CONTINUATION.test(text) && !risk) return no('CONTINUATION');
  if (SMALL_SCOPE.test(text) && text.length < 60 && !risk) return no('SMALL');
  const signals = [];
  if (risk) signals.push('risk');
  if (SCOPE.test(text)) signals.push('scope');
  if ([IMPLEMENT, VERIFY, EXTERNAL].filter((re) => re.test(text)).length >= 2) signals.push('multi-stage');
  return { trigger: true, reason: 'TRIGGER', signals };
}

function buildTriggerNote(result, policyPath) {
  const signals = result.signals.map((s) => SIGNAL_LABELS[s] || s).join('、') || '可执行任务';
  return '\n【B05 自动选档 · 已触发】本请求判定为需要验证决策（信号：' + signals + '）。'
    + '\n开工前按 verify-before-claim 技能“按难度选档”执行：'
    + '\n1) 只读核对请求、实际改动、已有测试与验收要求；不要为了打分先跑测试或做全仓审查。'
    + '\n2) 用真实 facts/sourceRefs/checks/baseline 构造 request JSON（未知写 unknown，不得编造），运行 `' + policyPath + ' <request.json>`。'
    + '\n3) 完整展示 recommendedTier 与四个选项（推荐置首、不隐藏低档）：本轮有开工确认卡时，把四项作为卡内「验证档」问一次问全（card.verification 承载 tier/reason/options），不另弹窗；没有开工卡时才单独用 AskUserQuestion 原样提问。宿主没有该工具时用文本给出同样四项并等待明确答复。未答复/取消不默认档，同任务不重复询问。'
    + '\n4) 只执行所选档的 checkIds 与 mandatoryCheckIds，汇报所选范围与未执行项；选档不授予发布、安装或生产操作权限。'
    + '\nfacts.uncertainty 描述动作风险；只是结论尚待取证时写 uncertaintyScope=conclusion（仅本地+可逆+非敏感+低影响低风险免阻断，高风险仍 FACTS_UNRESOLVED）。'
    + '\n若宿主未提供 resolveAuthority（本机当前如此）：不要调用 applyChoice/beginVerification，不要伪造授权或宣称 T-07 原生链路通过；按所选清单执行并标注“选档为咨询模式”。'
    + '\n若用户明确不需要选档或本任务已完成选档，忽略本条。';
}

module.exports = { classifyVerificationTrigger, buildTriggerNote };
