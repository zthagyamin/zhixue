'use client';
import {useEffect,useState} from 'react';
import {dailyMinimumProgress} from '../../domain/planning';
import type {LongTermPlanSpec,LongTermPlanState,MinimumProgressPlan} from '../../domain/planning';

type Props={spec:LongTermPlanSpec|null;plan:MinimumProgressPlan|null;day:string;names:Record<string,string>};
export function DailyMinimumStatus({spec,plan,day,names}:Props){
  const rows=dailyMinimumProgress(spec,plan,day);
  if(!rows.length)return null;
  return <aside className="long-term-notice" aria-label="今日与长线最低目标对照">
    <strong>今日安排 · 对照长线最低目标</strong>
    {rows.map(row=><p key={row.subjectId}>{names[row.subjectId]??row.subjectId}：已安排 {row.assigned} / 最低 {row.minimum}
      {row.blocked>0?` · ${row.blocked} 个需核对来源或前置条件`:''}
      {row.missing>0?<strong> · 仍缺 {row.missing} 个新词</strong>:null}</p>)}
    {rows.some(row=>row.missing>0)&&<p>完成已安排的任务不等于达到最低量。可在“调整安排”中补齐今日草稿；资料不足或手动排除的词不会用旧词凑数。</p>}
  </aside>;
}

type Client={getLongTermPlanState:()=>Promise<LongTermPlanState>};
export function AccountDailyMinimumStatus({client,refreshKey,...props}:Omit<Props,'spec'>&{client:Client;refreshKey:string}){
  const [read,setRead]=useState<{client:Client;state:LongTermPlanState}|null>(null);
  useEffect(()=>{
    let active=true;
    void client.getLongTermPlanState().then(state=>{if(active)setRead({client,state});}).catch(()=>{if(active)setRead(null);});
    return()=>{active=false;};
  },[client,refreshKey]);
  if(read?.client!==client)return <p className="study-meta">最低词量尚在核对，已保存的任务保留。</p>;
  return <DailyMinimumStatus {...props} spec={read.state.enabled?read.state.snapshot?.spec??null:null}/>;
}
