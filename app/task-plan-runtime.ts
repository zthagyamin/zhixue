import type {DynamicSubject} from './dynamic-ui-model';
import type {PracticeItem} from './companion-plan-client';
import type {TaskPlanV2,PlanningCatalog} from '../src/domain/planning';
// @ts-expect-error TS5097: standalone Node contracts.
import {practicePlanForTask} from '../src/domain/planning/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {selectPlannedPractice} from './plan-runtime.ts';
export type {PlanningStudySubject,TaskPlanSummary} from '../src/domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
export {summarizeTaskPlan,practicePlanForTask,taskWordStages,assertPlanningStudySources,prepareTaskSuggestion,applyTaskSuggestions} from '../src/domain/planning/index.ts';

export function practiceForTask(plan:TaskPlanV2,taskId:string,catalog:PlanningCatalog,subjects:DynamicSubject[],remote:PracticeItem[]):PracticeItem[] {
  const adapter=practicePlanForTask(plan,taskId,catalog),selected:PracticeItem[]=[];
  for(const entry of adapter.items) {
    if (entry.practice?.kind==='vocab-group') throw new Error('请从词汇模块开始这项任务。');
    const key=entry.itemKey,id=key.startsWith('practice:')?key.slice(9):undefined;
    const exact=remote.filter(item=>id?item.itemId===id:item.abilityId===key);
    if (exact.length>1) throw new Error('学习资料匹配不唯一，请同步后重试。');
    if (exact.length===1) {selected.push(exact[0]);continue;}
    const matches=subjects.flatMap(subject=>subject.items.filter(item=>id?item.itemId===id || item.id===id:item.abilityId===key).map(item=>({subject,item})));
    if (matches.length!==1) throw new Error('任务资料无法唯一定位，请同步学习知识库。');
    const {subject,item}=matches[0];
    selected.push(...selectPlannedPractice({...entry,practice:{...entry.practice!,subjectId:subject.id,itemIds:item.itemId?[item.itemId]:undefined}},[{...subject,items:[item]}],[]));
  }
  return selected.filter((item,index)=>selected.findIndex(other=>other.itemId===item.itemId)===index);
}
