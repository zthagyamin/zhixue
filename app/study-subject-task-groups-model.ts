export type StudyGroupTask={taskId:string;subjectId:string;title:string;category:string;quantity:number;action:{kind:string};blockedReason?:string};
export type StudyTaskGroup<T extends StudyGroupTask>={subjectId:string;tasks:T[];completed:number|null;newWords:number;reviews:number;blocked:number;next:T|undefined;started:boolean};
export function groupStudyTasks<T extends StudyGroupTask>(tasks:readonly T[],options:{ready:boolean;completedTaskIds:readonly string[];startedTaskIds?:readonly string[];verifiedStartedTaskIds?:readonly string[];subjects?:readonly {subjectId:string;kind?:string}[];finishedPassTaskIds?:readonly string[];practiceGroupByTask?:Record<string,string>;canStart?:(task:T)=>boolean}):StudyTaskGroup<T>[]{
 const grouped=new Map<string,T[]>(),done=new Set(options.completedTaskIds),started=new Set(options.startedTaskIds??[]);
 for(const task of tasks){const group=grouped.get(task.subjectId)??[];group.push(task);grouped.set(task.subjectId,group);}
 return [...grouped].map(([subjectId,rows])=>{
  const pending=rows.filter(task=>!done.has(task.taskId)&&!options.finishedPassTaskIds?.includes(task.taskId)&&!task.blockedReason&&(options.canStart?.(task)??task.action.kind==='practice'));
  const startedGroups=new Set([...started].map(id=>options.practiceGroupByTask?.[id]).filter(Boolean));
  const source=options.subjects?.find(subject=>subject.subjectId===subjectId);
  const verified=new Set(source&&source.kind!=='words'&&!rows.some(task=>task.category==='new-word')?options.verifiedStartedTaskIds??[]:[]);
  const verifiedGroups=new Set([...verified].map(id=>options.practiceGroupByTask?.[id]).filter(Boolean));
  const resumed=pending.find(task=>verified.has(task.taskId)||verifiedGroups.has(options.practiceGroupByTask?.[task.taskId]))??pending.find(task=>started.has(task.taskId)||startedGroups.has(options.practiceGroupByTask?.[task.taskId]));
  return{subjectId,tasks:rows,completed:options.ready?rows.filter(task=>done.has(task.taskId)).length:null,newWords:rows.filter(task=>task.category==='new-word').reduce((sum,task)=>sum+task.quantity,0),reviews:rows.filter(task=>task.category==='review').length,blocked:rows.filter(task=>Boolean(task.blockedReason)&&!done.has(task.taskId)).length,next:resumed??pending[0],started:Boolean(resumed)};
 });
}
