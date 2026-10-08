import type {StudyAIContext} from './study-ai-types';
// @ts-expect-error Node contract tests use explicit extensions.
import {normalizeStudyAIContext} from './study-ai-context.ts';
type Subject={subjectId:string;name:string;itemCount:number};
type Task={subjectId:string;title:string;category:string;quantity:number};
export function studyAIPageContext(input:{page:string;day:string;subjects:Subject[];activeSubjectIndex?:number;tasks?:readonly Task[];planState:'approved'|'draft'|'local'|'none'|'unknown';historyReady:boolean;practiceCount:number|null;activeProgress?:{name:string;evidenceCount:number;knownItemCount:number;completionPercent:number|null}|null}):StudyAIContext{
 const basic=['today','progress','sources'].includes(input.page),kind=basic?input.page:'exercise';
 const subject=input.activeSubjectIndex===undefined?undefined:input.subjects[input.activeSubjectIndex];
 const title=kind==='today'?'今日学习':kind==='progress'?'学习进度':kind==='sources'?'资料与设置':subject?.name??'当前练习';
 const lines=[`当前页面：${title}`,`学习日期：${input.day}`];
 if(kind==='today'){
  lines.push(input.planState==='approved'?'以下是已批准的今日安排。':input.planState==='draft'?'当前只有草稿，尚未批准，不可当作已开始或已完成。':input.planState==='local'?'以下是当前显示的本机安排，保留原有确认流程。':input.planState==='unknown'?'今日安排仍在核对。':'今日尚无已批准安排。');
  const groups=new Map<string,Task[]>();for(const task of input.tasks??[]){const rows=groups.get(task.subjectId)??[];rows.push(task);groups.set(task.subjectId,rows);}
  for(const [id,tasks]of groups){lines.push(`学科：${input.subjects.find(subject=>subject.subjectId===id)?.name??'学习任务'}；${tasks.length} 项任务。`);for(const task of tasks)lines.push(`- ${task.title}（${task.category==='new-word'?`新词 ${task.quantity} 个`:task.category==='review'?'复习':'学习任务'}）`);}
  lines.push('任务列出的是安排，不等同完成或掌握。完成状态需依照实际记录。');
 }
 if(kind==='progress'){
  lines.push(input.historyReady?`已核对的真实作答记录：${input.practiceCount??'未知'} 次。`:'学习历史尚未核对完整；不能按零进度解释。');
  if(input.historyReady&&input.activeProgress){const p=input.activeProgress;lines.push(`当前查看：${p.name}；${p.evidenceCount} 项已有证据；${p.knownItemCount} 项历史内容；可验证完成度：${p.completionPercent===null?'未知':`${p.completionPercent}%`}。`);}
 }
 if(kind==='sources')lines.push('此页可配置资料结构映射、下载知识库入门包、查看连接与同步状态、设置模型。配置表单中的密钥、地址、账户信息和本机路径不在上下文中。');
 const visibleSubjects=kind==='exercise'?(subject?[subject]:[]):input.subjects;
 if(visibleSubjects.length)lines.push('页面中的学科：');for(const row of visibleSubjects)lines.push(`- ${row.name}：${row.itemCount} 项已登记内容。`);
 if(kind==='exercise')lines.push('当前题目、作答和运行信息由正在显示的练习补充；没有补充时不要猜测具体题目。');
 return normalizeStudyAIContext({id:`page:${kind}${kind==='exercise'?`:${input.activeSubjectIndex??'practice'}`:''}`,title,pageKind:kind,pageText:lines.join('\n')});
}
