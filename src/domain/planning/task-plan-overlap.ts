import type {TaskAction} from './task-plan-types';
type Action=TaskAction|{kind:'open-material';materialId:string};
type Unit={subjectId:string;unitId:string;action:Action;completionRule?:string};
type Task={subjectId:string;unitIds:string[];action:Action;completionRule?:string};
/** Different completion rules remain different work. AI avoids any repeated part; manual groups are blocked only when fully covered. */
export function planningUnitAlreadyScheduled(unit:Unit,tasks:readonly Task[],mode:'any'|'complete'='any'):boolean{
 const subjectTasks=tasks.filter(task=>task.subjectId===unit.subjectId);
 if(subjectTasks.some(task=>task.unitIds.includes(unit.unitId)))return true;
 const sameRule=subjectTasks.filter(task=>!task.completionRule||!unit.completionRule||task.completionRule===unit.completionRule);
 const action=unit.action;
 if(action.kind==='practice'){
  const keys=new Set(sameRule.flatMap(task=>task.action.kind==='practice'?task.action.itemKeys:[]));
  return mode==='complete'?action.itemKeys.length>0&&action.itemKeys.every(key=>keys.has(key)):action.itemKeys.some(key=>keys.has(key));
 }
 return sameRule.some(task=>action.kind==='open-note'&&task.action.kind==='open-note'?action.contentRef===task.action.contentRef
  :action.kind==='open-material'&&task.action.kind==='open-material'&&action.materialId===task.action.materialId);
}
export function coveredPlanningUnitIds(plan:{tasks:readonly Task[]},catalog:{subjects:readonly {units:readonly Unit[]}[]},mode:'any'|'complete'='any'):string[]{
 return catalog.subjects.flatMap(subject=>subject.units.filter(unit=>planningUnitAlreadyScheduled(unit,plan.tasks,mode)).map(unit=>unit.unitId));
}
