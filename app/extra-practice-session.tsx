'use client';
import {StudyPluginOptionsProvider,StudyPluginOptionsSlot} from './study-plugin-options';
import {StudyGuidanceHelp} from './study-guidance';
import {ReviewContext} from './review-context';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {createLearningDraftStore} from './learning-draft-store';
import {LearningDraftBoundary,LearningDraftLeaveGuard} from './learning-draft';
import { registry } from './plugins';
import { adaptStudyItemForPlugin, pluginLabels, type PluginType } from './plugin-routing';
import { gradeCalculationInWorker } from './calculation-client';
import { advanceExtraPractice, createExtraPracticeState, skipExtraPractice } from './extra-practice-state';
import { StudyItemSource } from './study-item-source';
import type { StudyItem } from './study-dashboard/prelude';
import {continueNonWordRound, type NonWordHostScope, type NonWordRoundState} from '../src/application/nonword-study';
import {bindExtraNonWordRound, projectExtraNonWordRound} from '../src/features/nonword-study';
import type {FSRSRating,PluginContext,PluginGradeOptions} from './plugins/registry';
import {isNonWordOriginal} from '../src/domain/content';
import {NonWordPluginHost} from './study-dashboard/nonword-plugin-host';
import {useNonWordRoundCache} from './study-dashboard/nonword-round-cache';

export type ExtraPracticeSnapshot = {
  scopeKey: string;
  guidanceScope?: string;
  sourcePreferenceScope?: string;
  title: string;
  items: StudyItem[];
  modes: PluginType[];
  /** Original content contract, independent of a chosen display mode. Page-local only. */
  sourceModes?: PluginType[];
  /** Exact approved source versions; present only for recoverable temporary work. */
  recoveryScopes?: (NonWordHostScope | undefined)[];
  recoveryDay?: string;
  source: { title: string; scope: string };
};

/** Deliberately receives neither a dashboard controller nor a persistence callback. */
export function ExtraPracticeSession({ snapshot, onExit, canOpenLocal, getObsidianUri, nativeCourse, nativeMath }: {
  snapshot: ExtraPracticeSnapshot;
  onExit: () => void;
  canOpenLocal: boolean;
  getObsidianUri: (path: string) => string;
  nativeCourse?: PluginContext['nativeCourse'];
  nativeMath?: PluginContext['nativeMath'];
}) {
  const [state, setState] = useState(() => createExtraPracticeState(snapshot.items.length));
  const [awaiting,setAwaiting]=useState<number[]>([]),[runRevision,setRunRevision]=useState(0);
  const getRound=useNonWordRoundCache();
  const roundBinding=useMemo(()=>bindExtraNonWordRound(snapshot.scopeKey,snapshot.items.map((data,index)=>({data,
    mode:snapshot.modes[index],sourceMode:snapshot.sourceModes?.[index]??data.pluginType??snapshot.modes[index],scope:snapshot.recoveryScopes?.[index]})),snapshot.recoveryDay),[snapshot]);
  const [savedRound,setSavedRound]=useState<{key:string;runId:string}|null>(null),[roundError,setRoundError]=useState(''),[roundBusy,setRoundBusy]=useState(false);
  const roundLock=useRef(false);
  const ready=!roundBinding||savedRound?.key===roundBinding.key,runToken=roundBinding&&savedRound?.key===roundBinding.key?savedRound.runId:String(runRevision);
  const pendingContinuations=useRef(new Set<string>());
  const navigation=useRef({scopeKey:snapshot.scopeKey,runToken,index:state.index,revision:state.revision});
  useLayoutEffect(()=>{navigation.current={scopeKey:snapshot.scopeKey,runToken,index:state.index,revision:state.revision};},[snapshot.scopeKey,runToken,state.index,state.revision]);
  const drafts=useMemo(()=>createLearningDraftStore('extra:'+snapshot.scopeKey),[snapshot.scopeKey]);
  const draft=drafts.adapter(`${state.index}:${state.revision}`,snapshot.modes[state.index]);
  const restoreRound=(cursor:NonWordRoundState)=>{
    if(!roundBinding||navigation.current.scopeKey!==snapshot.scopeKey)return false;
    const projection=projectExtraNonWordRound(roundBinding,cursor),{awaiting:pending,...restored}=projection;
    const same=savedRound?.runId===cursor.runId&&JSON.stringify([state.stages,state.index,state.complete,state.reviewed??[],state.skipped??[],awaiting])===JSON.stringify([restored.stages,restored.index,restored.complete,restored.reviewed,restored.skipped,pending]);
    if(same)return false;
    setSavedRound({key:roundBinding.key,runId:cursor.runId});setAwaiting(pending);setState(current=>({...restored,revision:current.revision+1}));return true;
  };
  useEffect(()=>{
    if(!roundBinding)return;
    let cancelled=false;
    void getRound(roundBinding.scope).then(async group=>{if(!group)throw Error('巩固恢复暂不可用，原答案已保留。');const cursor=await group.read();if(!cancelled)restoreRound(cursor);}).catch(reason=>{if(!cancelled)setRoundError(reason instanceof Error?reason.message:'巩固恢复失败，原答案已保留。');});
    return()=>{cancelled=true;};
    // The immutable source binding owns this bootstrap, including its initial projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[roundBinding?.key]);
  const exit=()=>{if(!state.complete&&drafts.hasUnsavedInput()&&!window.confirm('当前巩固还有未提交的输入，结束后不会保留。仍要结束吗？'))return;onExit();};
  const surface = useRef<HTMLElement>(null);
  useEffect(() => {
    surface.current?.focus({ preventScroll: true });
    surface.current?.scrollIntoView({ block: 'start' });
  }, [state.complete]);
  const item = snapshot.items[state.index];
  const mode = snapshot.modes[state.index];
  const sourceMode=snapshot.sourceModes?.[state.index]??item.pluginType??mode;
  const originalNonWord=isNonWordOriginal(sourceMode,item);
  const suppliedScope=snapshot.recoveryScopes?.[state.index];
  const recoveryScope=originalNonWord&&suppliedScope?{...suppliedScope,temporary:true,
    ...(runRevision?{roundId:JSON.stringify([suppliedScope.roundId,'extra-run',runRevision])}:{})}:undefined;
  const pluginData = adaptStudyItemForPlugin(mode, item);
  const Plugin = mode === 'paper' ? undefined : registry.get(`@zhixue/plugin-${mode}`);
  const completed = state.stages.filter((stage,index) => stage >= 3||state.reviewed?.includes(index)||awaiting.includes(index)).length;
  const pendingRecall=(state.reviewed??[]).filter(index=>state.stages[index]<3);
  const last=state.stages.every((stage,index)=>index===state.index||stage>=3||state.reviewed?.includes(index)||state.skipped?.includes(index));
  const isCurrent=()=>navigation.current.scopeKey===snapshot.scopeKey&&navigation.current.runToken===runToken&&navigation.current.index===state.index&&navigation.current.revision===state.revision;
  const advance=(rating:FSRSRating)=>{if(!isCurrent())return;setState(current=>{
    const next=advanceExtraPractice(current,{index:state.index,revision:state.revision,threeStage:mode==='three-stage',recall:mode==='recall'||Boolean(recoveryScope),rating});
    return roundBinding&&(rating==='good'||rating==='easy')?{...next,reviewed:next.reviewed?.filter(index=>index!==state.index)}:next;
  });};
  const continuePending=()=>{
    const token=JSON.stringify([runToken,state.index,state.revision]);
    if(!isCurrent())return;
    if(pendingContinuations.current.has(token)||drafts.isPending()||draft.isPending?.())return;
    pendingContinuations.current.add(token);drafts.clearItem(`${state.index}:${state.revision}`);
    setAwaiting(current=>[...new Set([...current,state.index])]);setState(current=>skipExtraPractice(current,state.index,state.revision));
  };
  const skip=async(allowSavedFeedback=false)=>{
    if(!ready||!isCurrent()||roundLock.current||drafts.isPending()||draft.isPending?.()||!allowSavedFeedback&&draft.hasSavedFeedback?.())return;
    roundLock.current=true;setRoundBusy(true);setRoundError('');
    try{const group=roundBinding?await getRound(roundBinding.scope):null;
      if(group){const cursor=await continueNonWordRound(group,recoveryScope!.itemKey,'skipped',savedRound!.runId);if(!isCurrent())return;restoreRound(cursor);}
      else setState(current=>skipExtraPractice(current,state.index,state.revision));
      drafts.clearItem(`${state.index}:${state.revision}`);
    }catch(reason){setRoundError(reason instanceof Error?reason.message:'跳过状态尚未保存，请再试一次。');}
    finally{roundLock.current=false;setRoundBusy(false);}
  };
  const restart=async()=>{
    if(roundLock.current)return;roundLock.current=true;setRoundBusy(true);setRoundError('');
    try{const group=roundBinding?await getRound(roundBinding.scope):null;
      if(group){const cursor=await group.startNewRound({restartConfirmed:true});restoreRound(cursor);}
      else{setAwaiting([]);setRunRevision(current=>current+1);setState(current=>({...createExtraPracticeState(snapshot.items.length),revision:current.revision+1}));}
      pendingContinuations.current.clear();
    }catch(reason){setRoundError(reason instanceof Error?reason.message:'新一轮尚未保存，请再试一次。');}
    finally{roundLock.current=false;setRoundBusy(false);}
  };
  const context:PluginContext={
    nativeCourse:recoveryScope?.nativeCourseIdentity&&!recoveryScope.cloud?nativeCourse:undefined,
    nativeMath:recoveryScope?.nativeMathIdentity&&!recoveryScope.cloud?nativeMath:undefined,
    guidanceScope:snapshot.guidanceScope,guidanceInOptions:true,draft,recallPersistenceRequired:false,
    contentSource:{mode:sourceMode,data:item},nonWordScope:recoveryScope,
    nonWordNavigation:recoveryScope?{continuePending,resumeFormal:advance,...(roundBinding?{restoreRound}: {})}:undefined,
    contentNavigation:{onSkip:()=>void skip()},
    recallNavigation:mode==='recall'?{continueLabel:last?'结束本轮':'下一题',onSkip:()=>void skip(!roundBinding)}:undefined,
    gradeCalculation:(question,answer,signal)=>gradeCalculationInWorker(question as Parameters<typeof gradeCalculationInWorker>[0],answer,signal),
  };
  const grade=(rating:FSRSRating,options?:PluginGradeOptions)=>{
    const ticket=draft.begin();if(!ticket)return;
    const deferred=(Boolean(recoveryScope)||mode==='calculation'||mode==='recall')&&options?.deferAdvance===true;
    if(drafts.commit(ticket,deferred?()=>advance(rating):undefined)&&!deferred)advance(rating);
  };
  const hasRecovery=snapshot.items.some((entry,index)=>snapshot.recoveryScopes?.[index]&&isNonWordOriginal(snapshot.sourceModes?.[index]??entry.pluginType??snapshot.modes[index],entry));
  const skippedCount=(state.skipped??[]).filter(index=>!awaiting.includes(index)).length;
  return <StudyPluginOptionsProvider><section ref={surface} tabIndex={-1} className="study-session-shell study-extra-practice" aria-label="额外巩固">
    <LearningDraftLeaveGuard store={drafts}/>
    <header className="study-session-topbar">
      <button type="button" className="study-back" onClick={exit}>结束巩固</button>
      <h2>{snapshot.title} · 额外巩固</h2>
      <span>{completed} / {snapshot.items.length}</span>
    </header>
    <p className="study-meta">额外巩固 · 不计入正式记录</p>
    <details className="study-inline-options"><summary>学习选项</summary><StudyPluginOptionsSlot/><StudyGuidanceHelp kind={mode}/><ReviewContext temporary/>
      <p>{hasRecovery?'本轮不计入今日进度，不改变正式成绩或复习安排；支持恢复的作答按原来源保存在本机，同步状态以题目提示为准。':'本轮仅在当前页面练习，不计入今日进度，不改变正式成绩或复习安排；离开后不保留。'}</p>
    </details>
    {roundError&&<p role="alert">{roundError}</p>}
    {!ready?<p role="status">正在恢复本组巩固…</p>:state.complete ? <div className="caught-up-state extra-practice-result" aria-live="polite">
      <h2>{state.reviewed||state.skipped?'本轮练习结束':'本轮巩固完成'}</h2><p>已练 {completed} / {snapshot.items.length}{state.reviewed?` · 待巩固 ${pendingRecall.length}`:''}{awaiting.length?` · 待核对 ${awaiting.length}`:''}{skippedCount?` · 暂时跳过 ${skippedCount}`:''}。原有学习记录未改变。</p>
      <div>
      <button type="button" className="study-primary-action" onClick={exit}>返回本轮完成页</button>
      <button type="button" className="study-secondary-action" disabled={roundBusy} onClick={()=>void restart()}>再巩固一遍</button>
      </div>
    </div> : <>
      <div className="study-session-status"><span>{mode === 'three-stage'?`${['认义','语境','自评'][Math.min(2,state.stages[state.index])]} · ${Math.min(3,state.stages[state.index]+1)}/3`:pluginLabels[mode]}</span>{roundBinding&&<button type="button" disabled={roundBusy||drafts.isPending()||draft.hasSavedFeedback?.()} onClick={()=>void skip()}>暂时跳过</button>}</div>
      <div className="study-session-content">
        <LearningDraftBoundary store={drafts} interactiveWhileGrading={mode==='recall'}>{Plugin && pluginData ? recoveryScope?<NonWordPluginHost
          key={`${state.index}:${state.revision}:${mode}:${runToken}`} plugin={Plugin} round={roundBinding?()=>getRound(roundBinding.scope):undefined}
          data={{ ...pluginData, stage: Math.min(3, state.stages[state.index] + 1) }} context={context} onGrade={grade}
        />:<Plugin.renderUI
          key={`${state.index}:${state.revision}:${mode}`}
          data={{ ...pluginData, stage: Math.min(3, state.stages[state.index] + 1) }}
          context={context} onGrade={grade}
        /> : <div role="status"><p>此项暂不支持额外巩固，请返回原学习入口查看；没有改变学习记录。</p><button type="button" onClick={exit}>返回本轮完成页</button></div>}</LearningDraftBoundary>
      </div>
      <details className="study-context"><summary>查看本题来源</summary><StudyItemSource item={item} source={snapshot.source} preferenceScope={snapshot.sourcePreferenceScope} canOpenLocal={canOpenLocal} getObsidianUri={getObsidianUri}/></details>
    </>}
  </section></StudyPluginOptionsProvider>;
}
