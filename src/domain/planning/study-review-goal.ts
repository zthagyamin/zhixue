/** Presentation goal only: every actual obligation stays in the saved plan and due queue. */
export function activeDailyReviewTarget(state:{enabled:boolean;snapshot:{spec:{startDate:string;targetDeadline:string;dailyReviewTarget?:number}}|null}|null,day:string){
 const spec=state?.snapshot?.spec;return state?.enabled&&spec&&day>=spec.startDate&&day<=spec.targetDeadline?spec.dailyReviewTarget:undefined;
}
export function reviewGoalView<T extends {taskId:string;category:string}>(tasks:readonly T[],target:number|undefined,extra:number,completedIds:readonly string[],startedIds:readonly string[]=[],selectedIds:readonly string[]=[]){
 const reviews=tasks.filter(task=>task.category==='review'),completed=new Set(completedIds),started=new Set(startedIds);
 const selected=new Set(selectedIds),retained=reviews.filter(task=>selected.has(task.taskId)).length;
 const preferred=target===undefined?reviews.length:Math.min(reviews.length,Math.max(retained,Math.max(0,Math.floor(target)))+Math.max(0,Math.floor(extra)));
 const chosen=new Set(reviews.filter(task=>completed.has(task.taskId)||started.has(task.taskId)||selected.has(task.taskId)).map(task=>task.taskId));
 for(const task of reviews){if(chosen.size>=preferred)break;chosen.add(task.taskId);}
 return{visible:tasks.filter(task=>task.category!=='review'||chosen.has(task.taskId)),deferred:reviews.filter(task=>!chosen.has(task.taskId)),
  total:reviews.length,target:Math.max(preferred,chosen.size),completed:reviews.filter(task=>completed.has(task.taskId)).length};
}
