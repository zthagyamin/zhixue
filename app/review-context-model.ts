export type ReviewContextData={temporary?:boolean;completedStage?:number;due?:string;category?:string;recorded?:boolean};
export function reviewContextText(data:ReviewContextData,now=Date.now()):{label:string;detail:string}{
 if(data.temporary)return {label:'临时练习 · 不改变正式排期',detail:'本轮用于体验或额外巩固，不生成正式成绩、记忆保留率或下次复习承诺。'};
 const stage=typeof data.completedStage==='number'&&Number.isInteger(data.completedStage)&&data.completedStage>=0&&data.completedStage<=3?data.completedStage:null;
 const date=typeof data.due==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(data.due)?Date.parse(data.due):NaN;
 if(data.recorded)return {label:'作答已处理 · 新排期待核对',detail:'保存作答与确认下次复习时间是两件事；此处不会把旧日期当作本次评分后的新安排。返回今日可核对最新任务。'};
 if(Number.isFinite(date))return {label:(date<=now?'到期复习':'已有复习安排')+' · '+new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(date)),detail:'时间来自当前读取到的排期记录，按这台设备的时区显示，不是临时估算的记忆率。跨设备或资料变更后，以重新核对的安排为准。'};
 return {label:data.category==='review'?'复习任务 · 具体日期待核对':stage!==null?`阶段学习 · 阶段 ${Math.min(3,stage+1)} / 3`:'当前任务 / 自由练习',detail:'题目来自当前选择的学习范围。没有可靠排期时不编造日期；答错是后续练习的依据，不等于惩罚或已失去掌握。'};
}
