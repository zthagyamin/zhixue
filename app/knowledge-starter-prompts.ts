export const KNOWLEDGE_STARTER_LABEL='获取知识库入门包';
const common=`请帮助我把自己提供的材料整理成可练习的学习内容。
只依据材料，保留来源标题、章节或页码；缺失之处标为待补充，不虚构引文、真题出处或实验结果。信息不足且影响答案时，先问最多两个关键问题。
输出 UTF-8 Markdown。生成材料的 frontmatter 使用 type: study-loop-source、status: active、generated: true、learning_status: unattempted。生成不等于我已经学过，不填写学习成绩或掌握状态。
每个问题只检查一个关键点，保留适用条件与容易混淆之处。先给可导入的材料，再单独列出待核对项；不要把使用说明混进题目表。`;
export const knowledgeStarterPrompts=[
  {id:'vocabulary',title:'词汇材料',description:'从阅读材料中整理少量值得主动回忆的词汇。',file:'vocabulary.md',prompt:common+`
请选 5–10 个与我的目标相关的词或短语。使用「## 词汇」及 word、meaning、context 三列 Markdown 表格。释义贴合当前语境。context 优先保留我提供的原句；新写例句须标明是生成例句，不能冒充原文。未转义的管道符不能出现在单元格里。`},
  {id:'python',title:'Python 练习',description:'先自己实现，再用边界测试检查。',file:'python.md',prompt:common+`
围绕当前材料设计 1–3 道基础 Python 练习，不提前替我完成作答。使用「## 代码」表格，列为 id、topic、prompt、initialCode、testCode、solutionCode、explanation。
题干写清输入、返回值和边界；初始代码保留函数签名和待完成处；测试包含普通与边界情况；参考实现单独放 solutionCode。代码换行编码为字面量 \\n，保留缩进。只用基础 Python，不访问文件、网络或系统，不引入第三方依赖。不生成 sourceNote、stateRef 或掌握证据；知学接入时会建立独立练习记录。`},
  {id:'concepts',title:'概念回忆',description:'把“看懂了”变成能闭卷解释的问题。',file:'concepts.md',prompt:common+`
提炼 3–5 道闭卷回忆题。使用「## 题目」表格，列为 id、topic、prompt、answer、explanation。问题尽量包含“为什么”“什么条件下”或一个小反例；答案给关键判断与边界，不堆术语。解释指出常见误解。单元格保持一行，管道符需转义。`},
  {id:'course',title:'课程笔记',description:'按一节课程组织概念、推导与自测。',file:'course.md',prompt:common+`
按一节课的范围整理，先说明本节要解决的问题，再用二级标题组织 2–4 个知识点。每节用完整段落解释因果关系，必要时给最小例子和推导；结尾给一个能闭卷回答的问题与核对要点。保留老师或教材的原始说法与生成解释的区别。不要扩大到尚未提供的课程内容。`},
  {id:'paper',title:'论文阅读',description:'分清作者的报告、自己的推断和未解决的问题。',file:'paper.md',prompt:common+`
只整理当前提供的论文部分，按研究问题、方法直觉、关键证据、限制和待查问题组织二级标题。逐项区分作者直接报告、根据材料推断和尚未验证。数字、数据集、图表与页码必须能在材料中核对，缺失就不补造。给出 3 个理解检查问题，先让我回答，再逐步提示；不要把读摘要写成完成全文或复现。`}
] as const;
export type StarterProfile={goal:string;level:string;dailyMinutes:string};
export function buildKnowledgeStarterPrompt(prompt:string,profile:StarterProfile,path:'existing'|'new'='new'):string{
  const goal=profile.goal.trim().slice(0,240)||'先用一小份材料建立可以持续学习的知识库';
  const level=profile.level.trim().slice(0,120)||'基础尚未说明，请不要假定我已经掌握先修知识';
  const minutes=/^\d{1,3}$/.test(profile.dailyMinutes)&&Number(profile.dailyMinutes)>0?profile.dailyMinutes+' 分钟':'尚未确定，请建议一个小任务';
  const route=path==='existing'?'我已有知识库。保留现有目录、笔记和历史，只整理我明确选中的材料。先说明建议，不自动移动、覆盖或重新组织整个库。':'我还没有知识库。先从一个小材料目录开始，不要求我先建立复杂索引或掌握记录。';
  return `${route}\n我的学习目标：${goal}\n当前基础：${level}\n每天可用时间：${minutes}\n\n${prompt}\n\n我的材料（请在下方粘贴原文或附上文件；没有材料时先等我提供）：\n`;
}
