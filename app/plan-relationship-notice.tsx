import type {LongTermDailyAllocation} from './long-term-daily-allocation';
import './plan-relationship.css';
import './ux-remedies.css';
export function PlanRelationshipNotice({allocation,hasPlan,draftOnly=false,onLongTerm}:{allocation?:LongTermDailyAllocation;hasPlan:boolean;draftOnly?:boolean;onLongTerm?:()=>void}){
 return <details className="plan-relationship-disclosure"><summary>长期计划与今日安排</summary><section className="plan-relationship" aria-label="今日与长线计划的关系"><div><strong>{allocation?`${draftOnly?'今日草稿':'今日安排'}来自长线计划`:hasPlan?'今天使用独立安排':'长线定节奏，今日来执行'}</strong>{onLongTerm&&<button type="button" onClick={onLongTerm}>调整以后每天的节奏 →</button>}</div>
  {allocation?<><p>本日新词目标 <b>{allocation.vocabularyTarget} 个</b>{allocation.reviewTarget!==undefined&&<> · 复习{allocation.reviewTarget===null?'按实际到期':<>目标 <b>{allocation.reviewTarget} 条</b></>}</>}{allocation.budgetMinutes!==undefined&&<> · 参考时间约 <b>{allocation.budgetMinutes} 分钟</b></>}</p><small>今天的配额已固定。修改、暂停或另建长线计划，只影响后续安排；实际到期复习仍会更新。</small>{allocation.reviewTarget===undefined&&<small>这份旧版今日计划尚未固定复习目标，暂按实际到期展示；新的目标会随下一份安排保存。</small>}</>:<p>{hasPlan?'本日已有安排保留。启用长线计划后，后续每天会承接其中的配额。':'长线计划设置每日数量与学科优先级；今日安排负责具体任务和完成情况。'}</p>}
  <small>启用长期计划后，每天打开网站会自动准备今日安排，已有安排继续保留。今日可调整顺序、追加复习和选做任务；今日 AI 只推荐额外内容，不更改长期目标。</small>
 </section></details>;
}
