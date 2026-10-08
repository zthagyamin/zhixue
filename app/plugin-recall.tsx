'use client';
import {registerStudyNavigationGuard} from './study-navigation-guard';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {StudyGuidance} from './study-guidance';
import type {LearningSupport} from './learning-support';
import {parseLearningSupport,recallCoverage,capRecallRating} from './learning-support';
import {useRecallSupport} from './use-recall-support';
import type {RecallAttemptState} from './recall-attempt-state';
import {useReportStudyAIItem} from './ai/use-report-study-ai-item';
import {useLearningDraftState} from './learning-draft';
import {useAssistance,useAssistanceDisplay} from './assistance-display';
import {MathText} from './math-text';
import {LearningFeedback} from '../src/features/nonword-study';
import {TutorFollowUp} from './plugins/tutor-follow-up';
import {accountAiFailureMessage} from './account-study-runtime';
import {recallReference,recallResultRating,recallChosenRating,waitForRecallResult} from './recall-flow-model';
import type {StudyPlugin,PluginRenderProps,GradePayload,FSRSRating} from './plugins/registry';
import {recallPrompt} from './recall-content';
import {checkContentQuality} from './content-quality';
import {validateRecallModelEvaluation,recallEvaluationNotice,recallMaterialText} from '../src/domain/assessment';
import {sourceWorksheet,isPaperRecallSource} from '../src/domain/remediation';
import {prepareFeedbackPractice} from '../src/application/temporary-practice';
import {SourceReviewLauncher,PaperRecallPractice,usePaperRecallPractice,RecallMaterialNotice,RecallSourceCaption} from '../src/features/remediation';
import './recall-flow.css';
import '../src/features/remediation/paper-recall.css';

export type RecallData = {
  learningSupport?:LearningSupport;
  itemId?:string;
  fingerprint?:string;
  prompt:string;
  sourceLabel?:string;
  topic?:string;
  explanation?:string;
  reviewPoint?:string;
  answer?:string|number;
};
const idleSubscribe=()=>()=>{};
const idleSnapshot=()=>0;
function verdictLabel(result:GradePayload):string{
  const rating=recallResultRating(result);
  return rating==='good'||rating==='easy'?'回答正确':rating==='hard'?'部分正确':rating==='again'?'需要复习':'请对照要点自评';
}

export const RecallPlugin:StudyPlugin<RecallData>={
  id:'@zhixue/plugin-recall',name:'回忆题',
  description:'先回忆或明确选择忘记，再核对并保存结果；本轮练过不等于已掌握。',
  renderUI:function RecallUI({data:originalData,onGrade,context}:PluginRenderProps<RecallData>){
    // Presentation only: preserve the stored item, binding and review history.
    const sourceLabel=typeof originalData.sourceLabel==='string'&&originalData.sourceLabel.trim()?originalData.sourceLabel:typeof originalData.topic==='string'?originalData.topic:undefined;
    const data={...originalData,sourceLabel,prompt:recallPrompt(originalData)};
    const draft=context?.draft;
    const nonWord=context?.nonWordLearning;
    const revision=useSyncExternalStore(draft?.subscribe??idleSubscribe,draft?.getSnapshot??idleSnapshot,idleSnapshot);
    const assistance=useAssistance(draft);
    const support=data.learningSupport?parseLearningSupport(data.learningSupport,'recall'):undefined;
    const policy=useRecallSupport(Boolean(support),draft,nonWord?undefined:context?.recallScope,nonWord?false:context?.recallPersistenceRequired,
      nonWord?.recordHint?{recover:()=>draft?.read<RecallAttemptState|null>('recallAttempt',null)??null,persist:state=>nonWord.recordHint!(state)}:undefined);
    const criteria=support?.criteria??[];
    const reference=recallReference(data,criteria,support?.hints?.[2]);
    const quality=checkContentQuality('recall',data);
    const [disputed,setDisputed]=useLearningDraftState(draft,'recallDisputed',false);
    const [answer,setAnswer]=useLearningDraftState(draft,'answer','');
    const [revealed,setRevealed]=useLearningDraftState(draft,'revealed',false);
    const [forgotten,setForgotten]=useLearningDraftState(draft,'recallForgotten',false);
    const [result,setResult]=useLearningDraftState<GradePayload|null>(draft,'result',null);
    const [selectedRating,setSelectedRating]=useLearningDraftState<FSRSRating|null>(draft,'recallSelectedRating',null);
    const [hintLevel,setHintLevel]=useLearningDraftState(draft,'recallHintDisplay',0);
    const [matchedCriteria,setMatchedCriteria]=useLearningDraftState<string[]>(draft,'recallMatchedCriteria',[]);
    const [alignmentSource,setAlignmentSource]=useLearningDraftState<'self'|'ai'>(draft,'recallAlignmentSource','self');
    const [feedbackDisplayId,setFeedbackDisplayId]=useLearningDraftState<string|null>(draft,'feedbackDisplayId',null);
    const [fallbackNotice,setFallbackNotice]=useLearningDraftState<string|null>(draft,'fallbackNotice',null);
    const [pendingReview,setPendingReview]=useLearningDraftState(draft,'nonwordPending','');
    const [continueRequested,setContinueRequested]=useLearningDraftState(draft,'recallContinueRequested',false);
    const [submitting,setSubmitting]=useState(false),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
    const request=useRef<AbortController|null>(null),live=useRef(true),saveLock=useRef(false),hostCalled=useRef(false),submitLock=useRef(false);
    const feedback=useRef<HTMLElement>(null),focusFeedback=useRef(false);
    const identity=JSON.stringify([data.itemId,data.fingerprint,data.sourceLabel,data.prompt,data.answer,data.explanation,data.reviewPoint,support]);
    const openedIdentity=useRef(identity),currentIdentity=useRef(identity);currentIdentity.current=identity;
    const contentChanged=openedIdentity.current!==identity;
    useEffect(()=>{live.current=true;return()=>{live.current=false;request.current?.abort();request.current=null;};},[identity]);
    useEffect(()=>{if(revealed&&focusFeedback.current){focusFeedback.current=false;feedback.current?.focus({preventScroll:true});}},[revealed]);
    useReportStudyAIItem(context,{question:data.prompt,learnerAnswer:answer,errors:result?.correct===false?[result.feedback||'上次回答未通过']:[]});
    useAssistanceDisplay(assistance,hintLevel===3?'reference-answer':'ai-hint',policy.state?`recall:${policy.state.attemptId}:hint:${hintLevel}`:null,Boolean(hintLevel));
    useAssistanceDisplay(assistance,'reference-answer','recall-reference',revealed&&Boolean(reference)&&result?.source!=='ai');
    useAssistanceDisplay(assistance,'answer-feedback',feedbackDisplayId,revealed&&result?.source==='ai');
    const saved=(!nonWord||nonWord.purpose==='first')&&Boolean(draft?.hasSavedFeedback?.()),failed=Boolean(draft?.hasSaveFailure?.());
    const draftPending=Boolean(draft?.isPending?.());
    // A continuation click first writes once, then consumes the host's durable receipt once.
    // Merely obtaining AI feedback or opening reference text cannot advance or save a grade.
    useEffect(()=>{
      if(!nonWord&&saved&&continueRequested){draft?.continueAfterFeedback?.();return;}
      if(failed&&hostCalled.current&&!draftPending&&!policy.pending){saveLock.current=false;hostCalled.current=false;}
    },[saved,continueRequested,draft,revision,failed,draftPending,policy.pending,nonWord]);
    const fallback=(reason?:string)=>{
      if(reason&&context?.nonWordLearning){
        setFallbackNotice(reason);setPendingReview(reason);setResult(null);setSelectedRating(null);setRevealed(false);
        return context.nonWordLearning.waitForReview(reason).catch(error=>{
          if(live.current&&currentIdentity.current===identity)setPendingReview(error instanceof Error?error.message:'答案尚未可靠保存。');
        });
      }
      setFallbackNotice(reason??null);setResult({correct:null,verdict:'self-assess',source:'self-assess',aiFallback:Boolean(reason)});
      setSelectedRating(null);focusFeedback.current=true;setRevealed(true);
    };
    const explicitSelfCheck=async(forgetAnswer=false)=>{
      if(!nonWord||!live.current||currentIdentity.current!==identity||submitting||submitLock.current||saveLock.current||saved||contentChanged||!nonWord.ready||!policy.ready||policy.pending)return;
      submitLock.current=true;setSubmitting(true);setSaveError('');
      try{
        assistance?.submit();await nonWord.submit(answer);
        if(!live.current||currentIdentity.current!==identity)return;
        setPendingReview('');setForgotten(forgetAnswer);fallback();
        if(forgetAnswer)setSelectedRating('again');
      }catch(error){if(live.current)setPendingReview(error instanceof Error?error.message:'口头作答尚未保存，请重试。');}
      finally{submitLock.current=false;if(live.current)setSubmitting(false);}
    };
    const forget=()=>{
      if(nonWord){void explicitSelfCheck(true);return;}
      if(submitting||saveLock.current||saved)return;
      // Commit to a forgotten response before displaying the reference. No fake learner text.
      assistance?.submit();setForgotten(true);setSelectedRating('again');fallback();
      if(reference&&support){void policy.record(3).catch(()=>{});}
    };
    const submitRecall=async()=>{
      const trimmed=answer.trim();
      if(!trimmed||contentChanged||request.current||submitting||submitLock.current||saveLock.current||!policy.ready||policy.pending||(nonWord&&(!live.current||currentIdentity.current!==identity)))return;
      submitLock.current=Boolean(nonWord);
      try{
      if(context?.nonWordLearning){
        setSubmitting(true);setPendingReview('');
        try{await context.nonWordLearning.submit(answer);}
        catch(error){setPendingReview(error instanceof Error?error.message:'答案尚未可靠保存，请重试。');setSubmitting(false);return;}
        if(!live.current||currentIdentity.current!==identity)return;
        setSubmitting(false);
      }
      if(!quality.capabilities.canAutoAssess){await fallback('本题缺少可核对的参考要点，没有调用 AI，也不会自动计分。');return;}
      assistance?.submit();setSubmitting(true);setFallbackNotice(null);setDisputed(false);
      const controller=new AbortController();request.current=controller;
      const timer=setTimeout(()=>controller.abort(),30000);
      try{
        if(!context?.gradeRecall){await fallback(nonWord?'当前未连接 AI，原回答保留为待核对。':'当前未连接 AI，可对照已有要点自评。');return;}
        const graded=await waitForRecallResult(()=>context.gradeRecall!({
          itemId:data.itemId,fingerprint:data.fingerprint,questionType:'recall',prompt:data.prompt,
          answer:data.answer,reviewPoint:data.reviewPoint,explanation:reference??'',...(support?{learningSupport:support}:{}),
        },trimmed,controller.signal),controller.signal);
        if(!live.current||currentIdentity.current!==identity||request.current!==controller||controller.signal.aborted)return;
        if(context?.nonWordLearning&&graded.source!=='ai'){await fallback('AI 尚未提供可核对的语义判定，答案保留为待核对。');return;}
        if(graded.source==='ai'){
          try{validateRecallModelEvaluation(graded,criteria);}
          catch{await fallback(nonWord?'本次 AI 评价与评分依据不一致，原回答保留为待核对。':recallEvaluationNotice());return;}
        }
        if(context?.nonWordLearning){
          const rated=recallResultRating(graded);
          if(!rated){await fallback('AI 尚未提供有效评级，原回答保留为待核对。');return;}
          await context.nonWordLearning.assess({status:rated==='good'?'correct':rated==='hard'?'partial':'incorrect',source:'model',rating:rated,explanation:graded.feedback||graded.explanation||'依据本题参考要点核对。'});
        }
        setResult(graded);setSelectedRating(graded.source==='ai'?recallResultRating(graded):null);
        if(graded.matchedPointIds&&graded.missedPointIds&&graded.matchedPointIds.every(id=>criteria.some(point=>point.id===id))){setMatchedCriteria(graded.matchedPointIds);setAlignmentSource('ai');}
        setFeedbackDisplayId(crypto.randomUUID());focusFeedback.current=true;setRevealed(true);
      }catch(error){
        if(live.current&&currentIdentity.current===identity&&request.current===controller)await fallback(controller.signal.aborted?(nonWord?'已停止本次核对，原回答保留为待核对。':'已停止本次核对，可对照已有要点自评。'):accountAiFailureMessage(error));
      }finally{
        clearTimeout(timer);if(request.current===controller){request.current=null;if(live.current)setSubmitting(false);}
      }
      }finally{submitLock.current=false;}
    };
    const rating=recallChosenRating(forgotten,selectedRating,disputed?null:result);
    const capLevel=nonWord?.submitted?(nonWord.answerRevealed?3:nonWord.submittedHintLevel):policy.state?.maxPreHintLevel;
    const appliedRating=rating&&support&&capLevel!==undefined?capRecallRating(rating,capLevel):rating;
    const needsPractice=appliedRating==='again'||appliedRating==='hard';
    const aiResult=!disputed&&result?.source==='ai'&&recallResultRating(result)!==null;
    const needsReference=!reference&&!aiResult;
    const submitGrade=async(value:FSRSRating,continueAfter=true)=>{
      if(nonWord&&(!live.current||currentIdentity.current!==identity))return false;
      if(saved){if(continueAfter)draft?.continueAfterFeedback?.();return true;}
      if(contentChanged||saveLock.current||saved||draftPending||!policy.ready||policy.pending||needsReference)return false;
      saveLock.current=true;hostCalled.current=false;setSaving(true);setSaveError('');setContinueRequested(continueAfter);
      try{
        // Explicit forgetting always remains again, even if an old UI closure tries to send good.
        const applied=forgotten?'again':value;
        if(nonWord){
          if(!nonWord.submitted)await nonWord.submit(answer);
          if(result?.source!=='ai')await nonWord.assess({status:applied==='good'||applied==='easy'?'correct':applied==='hard'?'partial':'incorrect',source:'self-assess',rating:applied,
            explanation:result?.feedback||(forgotten?'用户明确选择忘记。':'用户明确进行口头回忆后自评。')});
          if(nonWord.purpose==='remediation'){
            if(!nonWord.finishRemediation)throw Error('补练完成入口暂不可用，当前回答已保留。');
            await nonWord.finishRemediation();return true;
          }
          if(!live.current||currentIdentity.current!==identity)return false;
          draft?.write('recallRequestedRating',applied);hostCalled.current=true;
          await onGrade(applied,{deferAdvance:true});
          if(live.current&&continueAfter)draft?.continueAfterFeedback?.();
          return true;
        }
        await policy.grade(applied,next=>{
          if(!live.current||currentIdentity.current!==identity)return;hostCalled.current=true;
          onGrade(next,{deferAdvance:true});
        });
        if(live.current&&!draft){saveLock.current=false;setSaving(false);}
        else if(live.current&&hostCalled.current&&!draft?.isPending?.()&&!draft?.hasSavedFeedback?.()){
          saveLock.current=false;setSaving(false);setSaveError('作答未能保存，请重试保存；当前反馈仍保留。');
        }
        return true;
      }catch(error){
        if(live.current){saveLock.current=false;setSaving(false);setSaveError(nonWord&&error instanceof Error?error.message:'提示记录或作答未能保存，请恢复记录后重试。');}
        return false;
      }finally{if(nonWord&&live.current){saveLock.current=false;setSaving(false);}}
    };
    const beginRemediation=async()=>{
      if(!nonWord?.startRemediation||rating===null||!live.current||currentIdentity.current!==identity)return;
      if(!await submitGrade(rating,false))return;
      setSubmitting(true);setSaveError('');
      try{await nonWord.startRemediation();}
      catch(error){if(live.current)setSaveError(error instanceof Error?error.message:'补练尚未准备完成，请重试。');}
      finally{if(live.current)setSubmitting(false);}
    };
    const continuePending=async()=>{
      if(!nonWord||submitting||submitLock.current||!live.current||currentIdentity.current!==identity)return;
      submitLock.current=true;setSubmitting(true);
      try{await nonWord.continuePending();}
      catch(error){if(live.current)setPendingReview(error instanceof Error?error.message:'答案暂时不能继续，请保留页面重试。');}
      finally{submitLock.current=false;if(live.current)setSubmitting(false);}
    };
    const saveBusy=saving&&!failed&&!saved;
    const busy=submitting||saveBusy||draftPending||policy.pending;
    const next=context?.recallNavigation?.continueLabel??'下一题';
    const nextLabel=forgotten?`看完了，${next}`:next;
    const coverage=recallCoverage(criteria,matchedCriteria);
    const alignmentKnown=!nonWord||!aiResult||Boolean(result?.matchedPointIds&&result?.missedPointIds);
    const keyGap=alignmentKnown?criteria.find(point=>point.mandatory&&coverage.missingMandatory.includes(point.id)):undefined;
    const paperRecall=isPaperRecallSource(originalData,context?.contentSource?.data);
    const worksheet=reference?sourceWorksheet({kind:'condition',binding:identity,target:keyGap?.text??'本题参考中的关键条件与结论边界',reference:paperRecall?reference:(keyGap?.text??reference)}):null;
    const paperPractice=usePaperRecallPractice({binding:identity,enabled:!nonWord&&paperRecall&&needsPractice&&!needsReference,disabled:busy||!policy.ready,createDraft:draft?.createTemporary,beforeOpen:signal=>draft&&rating!==null?prepareFeedbackPractice(draft,async()=>{await submitGrade(rating,false);},signal):Promise.resolve(false),onContinue:()=>draft?.continueAfterFeedback?.()??false});
    if(contentChanged)return <section className="study-card" aria-label="参考内容已变化"><p role="status">本题参考内容已变化，请退出后重新打开。原回答保留在本页，旧评价不会用于新内容。</p>{answer&&<p>{answer}</p>}</section>;
    if(paperPractice.draft)return <div data-study-activity="recall" className="study-activity study-recall recall-flow"><div className="study-card"><PaperRecallPractice sourceLabel={data.sourceLabel} prompt={data.prompt} reference={reference??''} draft={paperPractice.draft} onContinue={paperPractice.complete} onExit={paperPractice.cancel} notice={paperPractice.notice} registerGuard={registerStudyNavigationGuard}/></div></div>;
    if(quality.issues.some(issue=>issue.code==='unfocused-recall-question'))return <RecallMaterialNotice title={data.sourceLabel} reference={recallMaterialText(data,criteria,support?.hints?.[2])} onNext={context?.recallNavigation?.onSkip} disabled={busy||saved}/>;
    return <div data-study-activity="recall" className="study-activity study-recall recall-flow">
      <StudyGuidance topic="recall" context={context} engaged={Boolean(answer.trim()||revealed)}/>
      <div className="study-card">
        <RecallSourceCaption label={data.sourceLabel} prompt={data.prompt}/>
        <h2 className={`study-question${data.prompt.length>100?' study-long-question':''}`}>{nonWord?<MathText text={data.prompt}/>:data.prompt}</h2>
        {nonWord?.purpose==='remediation'&&<p role="status">这次是辅助补练，首轮答案与结果保持原样。</p>}
        {support&&<section className="recall-policy-status" aria-label="回忆提示记录">
          {(policy.error||!policy.ready)&&<p role="status">{policy.error||'正在恢复提示记录…'}{policy.error&&<button type="button" onClick={policy.retry}>重试读取</button>}</p>}
          {!revealed&&support.hints&&<details><summary>需要一点提示</summary>
            <button type="button" disabled={!policy.ready||busy||hintLevel>=3} onClick={()=>{const level=hintLevel+1;void policy.record(level).then(()=>{if(live.current)setHintLevel(level);}).catch(()=>{});}}>{hintLevel===0?'给我一个方向':hintLevel===1?nonWord?.submitted?'结构提示（不改变首轮结果）':'结构提示（最高记为困难）':nonWord?.submitted?'完整参考（不改变首轮结果）':'完整参考（按再学记录）'}</button>
            {hintLevel>0&&<p><MathText text={support.hints[hintLevel-1]}/></p>}
          </details>}
        </section>}
        {!revealed?<div className="recall-answer-form">
          <label className="recall-input-label">你的回答<textarea aria-label="写下你回忆到的内容" placeholder={paperRecall?"用一两句话回答":"写下你记得的内容"} rows={paperRecall?3:5} value={answer} disabled={busy||!policy.ready} readOnly={Boolean(nonWord?.submitted)} onChange={event=>{if(!nonWord?.submitted)setAnswer(event.target.value);}}/></label>
          {pendingReview&&<section aria-label="待核对答案"><p role="status">待核对：{pendingReview}</p><p>首轮答案保持原样；未知不会记成答错或答对。</p>{nonWord&&<button type="button" className="study-secondary-action" disabled={!nonWord.submitted||busy} onClick={()=>void continuePending()}>保存的答案稍后核对，继续</button>}</section>}
          <div className="recall-actions">
            <button type="button" className="study-primary-action" disabled={!answer.trim()||busy||!policy.ready} onClick={()=>void submitRecall()}>{submitting?'正在核对…':'提交并核对'}</button>
            <button type="button" className="study-secondary-action" disabled={submitting||saving||saved} onClick={forget}>忘记了，查看要点</button>
          </div>
          {submitting&&request.current&&<button type="button" className="recall-text-action" onClick={()=>request.current?.abort()}>{context?.nonWordLearning?'停止核对，保留待核对答案':'停止核对，改为自评'}</button>}
          <details className="recall-oral-option"><summary>口头回忆后自评</summary><button type="button" disabled={busy||!policy.ready} onClick={()=>{if(nonWord)void explicitSelfCheck();else{assistance?.submit();fallback();}}}>想好了，核对要点</button></details>
        </div>:<section ref={feedback} tabIndex={-1} className="recall-feedback" aria-label="回忆反馈">
          {fallbackNotice&&<p className="recall-status" role="status">{fallbackNotice}</p>}
          {disputed&&<p className="recall-status" role="status">已在本页标记判定有争议，尚未保存成绩。请核对来源后自评；离开本页不保留争议标记。</p>}
          {answer.trim()&&<details className="recall-own-answer"><summary>你的回答</summary><p>{nonWord?<MathText text={answer}/>:answer}</p></details>}
          {forgotten?<p className="recall-result-label">{needsReference?'缺少可核对的参考要点':paperRecall?'先看要点，再试一次。':'本次按需要复习记录'}</p>:result&&aiResult&&<>
            <p className="recall-result-label">AI 判定 · {verdictLabel(result)}</p>
            {(result.feedback||result.explanation)&&(nonWord?<LearningFeedback className="recall-core-feedback" fullLabel="完整 AI 反馈" text={result.feedback||result.explanation||''} renderMath={text=><MathText text={text}/>}/>:<p className="recall-core-feedback"><MathText text={result.feedback||result.explanation||''}/></p>)}
          </>}
          {aiResult&&keyGap&&<p className="recall-core-feedback"><strong>关键遗漏：</strong><MathText text={keyGap.text}/></p>}
          {aiResult&&!saved&&<button type="button" className="recall-text-action" disabled={busy} onClick={()=>{setDisputed(true);setSelectedRating(null);}}>改用我的自评</button>}
          {nonWord&&needsPractice&&reference&&<section aria-label="关键要点讲解" className="recall-reference"><h3>关键要点</h3><MathText text={keyGap?.text??reference}/><p>先核对机制和条件，再收起讲解重新作答。</p></section>}
          {reference?((nonWord&&needsPractice)||(aiResult&&!(paperRecall&&needsPractice))?<details className="recall-reference"><summary>再看参考要点</summary><MathText text={reference}/></details>:<div className="recall-reference"><h3>参考要点</h3><MathText text={reference}/></div>):!aiResult&&<p role="status">本题尚未提供参考要点，请从“查看来源”核对。暂时跳过不会生成成绩。</p>}
          {!needsReference&&!forgotten&&!aiResult&&!saved&&<fieldset className="recall-assessment" disabled={busy||saved}>
            <legend>{disputed?'你的自评（基于首次回忆）':'对照要点自评'}</legend>
            {(['good','hard','again'] as const).map((value,index)=><label key={value}><input type="radio" name={`recall-assessment-${data.itemId??'current'}`} value={value} checked={rating===value||(value==='good'&&rating==='easy')} onChange={()=>setSelectedRating(value)}/>{['记得','部分记得','不记得'][index]}</label>)}
          </fieldset>}
          {support&&capLevel!==undefined&&capLevel>=2&&<p className="recall-status">{capLevel>=3?'本轮已用完整参考，按需要复习记录。':'本轮已用结构提示，评级最高为困难。'}</p>}
          {nonWord?.submitted&&policy.state&&policy.state.maxPreHintLevel>(capLevel??0)&&<p className="recall-status">提交后的提示不改变首轮作答和评级上限。</p>}
          {saved&&!paperRecall&&<p className="recall-status" role="status">本次结果已保留，可以继续下一题或当天补练。</p>}
          {(saveError||failed)&&<p className="recall-save-error" role="alert">{saveError||'作答尚未保存，回答和反馈已保留。'}</p>}
          <div className="recall-actions recall-continue">
            {!nonWord&&paperRecall&&!needsReference&&rating!==null&&needsPractice&&<button type="button" className="study-primary-action paper-retry-action" disabled={busy||!policy.ready||paperPractice.preparing} onClick={()=>void paperPractice.start()}>{paperPractice.preparing?'正在保存…':'再试一次'}</button>}
            {nonWord?.purpose==='first'&&nonWord.startRemediation&&!needsReference&&rating!==null&&needsPractice&&<button type="button" className="study-secondary-action" disabled={busy||!policy.ready} onClick={()=>void beginRemediation()}>收起讲解，再试一次</button>}
            {!needsReference&&<button type="button" className={paperRecall&&needsPractice?"study-secondary-action":"study-primary-action"} disabled={rating===null||busy||!policy.ready} onClick={()=>{if(rating)void submitGrade(rating);}}>{saveBusy||draftPending?'正在保存…':failed||saveError?'重试保存':nonWord?.purpose==='guided'?'保存引导反馈':nonWord?.purpose==='remediation'?'结束补练并继续':nextLabel}</button>}
            {needsReference&&context?.recallNavigation&&<button type="button" className="study-secondary-action" disabled={busy||saved} onClick={context.recallNavigation.onSkip}>暂时跳过，不计成绩</button>}
          </div>
          {!nonWord&&!paperRecall&&!needsReference&&rating!==null&&needsPractice&&<SourceReviewLauncher registerGuard={registerStudyNavigationGuard} key={identity} worksheet={worksheet} createDraft={draft?.createTemporary} disabled={busy||!policy.ready} label="保留本次结果，针对要点补练" beforeOpen={signal=>draft?prepareFeedbackPractice(draft,async()=>{await submitGrade(rating,false);},signal):Promise.resolve(false)}/>}
          {paperPractice.notice&&<p role="status" className="recall-status">{paperPractice.notice}</p>}
          {saved&&continueRequested&&<p role="status">已保存，正在进入{next==='结束本轮'?'本轮回顾':'下一题'}…</p>}
          {!forgotten&&(criteria.length>0||result?.matchedPoints?.length||result?.missedPoints?.length||context?.askTutor)&&<details className="recall-more-feedback"><summary>详细核对与追问</summary>
            {typeof result?.confidence==='number'&&<p>AI 自报置信度 {Math.round(Math.max(0,Math.min(1,result.confidence))*100)}% · 不代表你的掌握度</p>}
            {result?.matchedPoints?.map(point=><p key={`matched-${point}`}>已覆盖：{point}</p>)}
            {result?.missedPoints?.map(point=><p key={`missed-${point}`}>待补充：{point}</p>)}
            {criteria.length>0&&<section aria-label="要点覆盖自评"><h3>逐项核对</h3>{alignmentKnown?<p>{alignmentSource==='ai'?'AI 建议':'对照自评'} · {coverage.matched.length}/{criteria.length} 项 · 加权覆盖 {coverage.percent??0}% · 关键遗漏 {coverage.missingMandatory.length} 项</p>:<p>本次恢复没有逐项对齐记录；本页自查已勾选 {coverage.matched.length}/{criteria.length} 项，不改写首轮评价。</p>}{criteria.map(point=><label key={point.id}><input type="checkbox" checked={matchedCriteria.includes(point.id)} onChange={event=>{setAlignmentSource('self');setMatchedCriteria(current=>event.target.checked?[...new Set([...current,point.id])]:current.filter(id=>id!==point.id));}}/><MathText text={point.text}/></label>)}</section>}
            <TutorFollowUp askTutor={context?.askTutor} item={data} compact draft={draft}/>
          </details>}
        </section>}
      </div>
    </div>;
  },
};
