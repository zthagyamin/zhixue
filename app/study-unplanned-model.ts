export type UnplannedTask={taskId:string;title:string;category:string;quantity:number};
export type UnplannedState={currentPlan:{tasks:UnplannedTask[]}|null;approvedPlan:{tasks:UnplannedTask[]}|null};
export type UnplannedPhase='checking'|'failed'|'empty'|'draft'|'approved-empty';
export function unplannedTodayModel(state:UnplannedState|null,error?:string|null){
  const phase:UnplannedPhase=error?'failed':!state?'checking':state.approvedPlan?'approved-empty':state.currentPlan?'draft':'empty';
  const tasks=phase==='draft'?state?.currentPlan?.tasks??[]:[];
  const titles:Record<UnplannedPhase,string>={checking:'正在核对今日安排',failed:'暂时无法核对今日安排',empty:'安排今天的学习',draft:tasks.length?'今日草稿已准备好':'完善今天的学习草稿','approved-empty':'今天暂未安排学习任务'};
  const descriptions:Record<UnplannedPhase,string>={checking:'正在读取当天计划，已有资料仍可查看。',failed:'已有资料和学习记录保留，可以重新核对。',empty:'生成一份草稿，确认后开始学习。也可以先按学科自由练习。',draft:`草稿中有 ${tasks.length} 项任务。可以先调整，再批准为今天的安排。`,'approved-empty':'当前批准版本没有任务。可以调整安排，或先按学科自由学习。'};
  const actions:Record<UnplannedPhase,'wait'|'retry'|'generate'|'review'>={checking:'wait',failed:'retry',empty:'generate',draft:'review','approved-empty':'review'};
  const labels:Record<UnplannedPhase,string>={checking:'正在核对…',failed:'重新核对',empty:'生成今日草稿',draft:'查看草稿','approved-empty':'调整今日安排'};
  return{phase,title:titles[phase],description:descriptions[phase],action:actions[phase],actionLabel:labels[phase],tasks,
    newWords:phase==='draft'?tasks.filter(task=>task.category==='new-word').reduce((sum,task)=>sum+task.quantity,0):null,
    reviews:phase==='draft'?tasks.filter(task=>task.category==='review').length:null};
}
