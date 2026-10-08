'use client';
import '../src/features/remediation/remediation.css';
import type {ComponentType} from 'react';
import {checkContentQuality} from '../src/domain/assessment';
import type {PluginType} from './plugin-routing';
import type {PluginRenderProps} from './plugins/registry';
import {studyAIVisibleText} from './ai/study-ai-visible-text';
import type {ReactNode} from 'react';
import type {LearningSupport} from '../src/domain/content';
import {RecallMaterialNotice} from '../src/features/remediation';
import {recallMaterialText} from '../src/domain/assessment';

function visibleData(value:unknown):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const data=value as Record<string,unknown>;
  // Existing flashcards can contain MathText/React children. Inspect visible text,
  // not JSON.stringify(props), which could mistake hidden descriptors for answers.
  return {...data,...('front' in data?{front:studyAIVisibleText(data.front as ReactNode)}:{}),
    ...('back' in data?{back:studyAIVisibleText(data.back as ReactNode)}:{})};
}

/** A shared rendering/submission boundary. Checks are derived, never persisted. */
export function PluginContentBoundary<T>({mode,View,...props}:PluginRenderProps<T>&{mode:PluginType;View:ComponentType<PluginRenderProps<T>>}){
  const quality=checkContentQuality(mode,visibleData(props.data));
  const source=props.context?.contentSource;
  const sourceCheck=source?checkContentQuality(source.mode,visibleData(source.data)):quality;
  const sourceBlocked=sourceCheck.issues.some(issue=>issue.severity==='blocking')&&!sourceCheck.capabilities.canSelfCheck;
  const problem=quality.issues.find(issue=>issue.severity==='blocking');
  // Recall has its own missing-reference/skip flow. Code can still trial-run
  // without tests; a trial must never claim automatic success.
  const canExplainLocally=mode==='recall'&&problem?.code==='missing-recall-reference'&&(!source||source.mode==='recall');
  const canTrial=mode==='code'&&problem?.code==='missing-code-tests'&&(!source||source.mode==='code');
  const blocked=mode!=='paper'&&!canExplainLocally&&!canTrial&&(sourceBlocked||Boolean(problem));
  const skip=props.context?.contentNavigation?.onSkip??props.context?.recallNavigation?.onSkip;
  if([...quality.issues,...sourceCheck.issues].some(issue=>issue.code==='unfocused-recall-question')){
    const raw=(source?.data??props.data) as {sourceLabel?:string;prompt?:string;answer?:string;explanation?:string;reviewPoint?:string;learningSupport?:LearningSupport};
    return <RecallMaterialNotice title={raw.sourceLabel} reference={recallMaterialText(raw,raw.learningSupport?.type==='recall'?raw.learningSupport.criteria:[],raw.learningSupport?.type==='recall'?raw.learningSupport.hints?.[2]:undefined)} onNext={skip} disabled={props.context?.draft?.isPending?.()||props.context?.draft?.hasSavedFeedback?.()}/>;
  }
  if(blocked){
    return <section className="study-card study-feedback" aria-label="学习内容需要核对">
      <h2>本题暂不计入成绩</h2>
      <p role="status">{problem?.message??sourceCheck.issues.find(issue=>issue.severity==='blocking')?.message??'本题缺少可靠参考，请核对来源。'}</p>
      <p>可从“查看来源”核对材料。暂时跳过不会删除题目，也不会改变原有成绩。</p>
      {skip&&<button type="button" className="study-secondary-action" disabled={props.context?.draft?.isPending?.()||props.context?.draft?.hasSavedFeedback?.()} onClick={()=>{if(!props.context?.draft?.isPending?.()&&!props.context?.draft?.hasSavedFeedback?.())skip();}}>暂时跳过，不计成绩</button>}
    </section>;
  }
  if(canTrial)return <>
    <section className="study-feedback" aria-label="仅试运行">
      <p role="status">缺少题目测试，本页仅供试运行和核对材料，不生成成绩。</p>
      {skip&&<button type="button" className="study-secondary-action" disabled={props.context?.draft?.isPending?.()||props.context?.draft?.hasSavedFeedback?.()} onClick={()=>{if(!props.context?.draft?.isPending?.()&&!props.context?.draft?.hasSavedFeedback?.())skip();}}>暂时跳过，不计成绩</button>}
    </section>
    <View {...props} onGrade={()=>{}}/>
  </>;
  return <View {...props} onGrade={(rating,options)=>{
    if(mode==='paper'||sourceBlocked||!quality.capabilities.canDisplay)return;
    if(!quality.capabilities.canSelfCheck&&!quality.capabilities.canAutoAssess)return;
    if((rating==='good'||rating==='easy')&&['quiz','code','spelling'].includes(mode)&&!quality.capabilities.canAutoAssess)return;
    const result=props.onGrade(rating,options);
    if(props.context?.nonWordLearning)return result;
  }}/>;
}
