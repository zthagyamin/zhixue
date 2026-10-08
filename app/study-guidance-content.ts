export type GuidanceKind = 'three-stage' | 'flashcard' | 'spelling' | 'quiz' | 'recall' | 'calculation' | 'code' | 'paper';
export type GuidanceTopic = GuidanceKind | 'three-stage-1' | 'three-stage-2' | 'three-stage-3';
type Guide = {title: string; tip: string; details: readonly string[]; shortcuts?: string};
export const STUDY_GUIDES: Record<GuidanceKind, Guide> = {
  'three-stage': {
    title: '三阶段背词', tip: '先回想词义，再查看答案并自评。',
    details: ['依次进行认义、语境和无提示回忆；各阶段均需自行核对答案。', '选择“不认识”后可以先学释义，再继续练习；这次仍按需要复习记录。', '完成三阶段是一条学习证据，不等于已经正式掌握。', '语境阶段不会自动朗读。可在学习选项中启用例句挖空；未揭晓时不朗读目标词。原文片段太短或格式不适合时，保留原文核对，不生成新句子。'],
    shortcuts: 'Space 朗读（语境挖空未揭晓时不可用）；1 / 2 选择；查看释义后 Enter 继续。按钮获得焦点时仍使用原生键盘操作。',
  },
  flashcard: {title: '翻转卡片', tip: '先回想，再翻面；按实际回忆情况自评。', details: ['忘记：重新学习；困难：回忆吃力；良好：正确回忆；极易：轻松回忆。', '在卡片手势区上滑显示答案；翻面后左滑为忘记、右滑为良好。按钮始终可用。'], shortcuts: 'Space 显示答案；1 / 2 / 3 / 4 分别为忘记、困难、良好、极易。'},
  spelling: {title: '拼写练习', tip: '点击输入框逐字拼写，错字退格后重输。', details: ['根据释义和例句输入。输入动效与速度显示不改变评分。', '查看答案或拼读会按需要复习处理；材料提供的拼读映射不是额外生成的答案。']},
  quiz: {title: '选择题', tip: '先判断选项，再查看本题反馈。', details: ['部分单选题点击即显示反馈；有提交按钮时，选择后再提交。多选需选齐全部正确项。', '划选题干可高亮，点击高亮可移除；支持的题目可排除和恢复选项。', 'AI 提示是辅助信息，不替代本题答案或原始材料。答错后的重练以页面按钮为准。']},
  recall: {title: '回忆题', tip: '先回忆；想不起来可直接查看要点。', details: ['支持同义改写和分点回答。AI 无法判定时保留对照自评。', '作答前使用结构提示最高按“困难”，查看完整参考按“再学”；提交后核对答案不降低本次独立作答。', '忘记时不用乱填答案；查看要点后仍按需要复习记录。下一题或结束本轮只在保存成功后推进，失败可重试保存。', '已练与答对分开统计。单题忘记后也能结束本轮，不会强制立即重问；待巩固内容可主动再练。']},
  calculation: {title: '计算题', tip: '提交后先看解析，点击“继续”再切题。', details: ['符号计算使用 * 表示乘法、^ 表示幂；可用函数以题目支持范围为准。', '不能判定的答案不会被伪装成正确或错误。保存失败可以重试保存，不需重新判题。', '点击“继续”不会重复记分；额外巩固不写正式记录。'], shortcuts: '在答案输入框中按 Enter 提交（输入法选字期间不会提交）。'},
  code: {title: '编程练习', tip: '完成代码后运行题目测试，再核对结果。', details: ['题目自带测试通过后可以继续；通过公开测试不代表覆盖所有情况。', '自定义输入只试运行代码，不改变题目测试或生成通关记录。', '运行可随时停止；加载失败或超时按当前运行提示处理。输入与代码仅暂存在当前页面。']},
  paper: {title: '论文精读', tip: '先读当前微段，再用自己的话重构主线。', details: ['点词选中；同句拖选 2–8 词。也可先点起点，再 Shift + 点终点。', '手机可在文献阅读与主线填答之间往返；切换不会清空草稿。隐藏原文后需主动重新显示。', '主线模板可切换，各模板输入独立保留。自检是阅读草稿，不生成掌握结论。']},
};
export function guidanceKind(value: string | undefined): GuidanceKind | null {
  const kind = value?.replace('@zhixue/plugin-', '').replace(/-[123]$/, '');
  return kind && Object.hasOwn(STUDY_GUIDES, kind) ? kind as GuidanceKind : null;
}
export function guidanceTip(topic: GuidanceTopic): string {
  if (topic === 'three-stage-2') return '结合例句回想词义，再核对答案。';
  if (topic === 'three-stage-3') return '不看提示回想词义，再核对答案。';
  const key = guidanceKind(topic);
  return key ? STUDY_GUIDES[key].tip : '';
}
