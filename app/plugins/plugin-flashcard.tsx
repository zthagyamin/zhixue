'use client';
import {registerStudyNavigationGuard} from '../study-navigation-guard';
import {StudyGuidance} from '../study-guidance';
import {useReportStudyAIItem} from '../ai/use-report-study-ai-item';
import {studyAIVisibleText} from '../ai/study-ai-visible-text';
import React, { useEffect,useLayoutEffect,useRef,useState } from "react";
import type {LearningSupport} from '../learning-support';
import {FlashcardImage} from '../components/flashcard-image';
import {useLearningDraftState} from '../learning-draft';
import {useAssistance,useAssistanceDisplay} from '../assistance-display';
import { StudyPlugin, PluginRenderProps, FSRSRating } from "./registry";
import {useStudySwipe} from '../use-study-swipe';
import {splitCardSections} from '../../src/domain/practice-candidates';
import {CandidateLauncher} from '../../src/features/remediation';
import {downloadStudyMaterial} from '../../src/infrastructure/artifacts';
import {MathText} from '../math-text';

export type FlashcardData = {
  id?:string;itemId?:string;learningSupport?:LearningSupport;
  front: React.ReactNode;
  back: React.ReactNode;
  tags?: string[];
};

export const FlashcardPlugin: StudyPlugin<FlashcardData> = {
  id: "@zhixue/plugin-flashcard",
  name: "自评翻转卡片",
  description: "基于主动唤回原理的经典卡片模式，由用户自行评估记忆难度。",
  renderUI: props=><FlashcardUI key={JSON.stringify([props.data.itemId??props.data.id,props.data.learningSupport,props.context?.paperServices?.owner,props.context?.paperServices?.library])} {...props}/>
};
function FlashcardUI({ data, onGrade, context }: PluginRenderProps<FlashcardData>) {
    const lifecycle=context?.nonWordLearning;
    const assistance=useAssistance(context?.draft);
    const [isFlipped, setIsFlipped] = useLearningDraftState(context?.draft,'isFlipped',false);
    const support=data.learningSupport?.type==='flashcard'?data.learningSupport:undefined;
    const occlusion=support?.mode==='occlusion'?support:undefined;
    const visibleBack=occlusion?occlusion.masks.find(mask=>mask.id===occlusion.activeMaskId)?.answer:data.back;
    const [imageReady,setImageReady]=useState(false),[submitted,setSubmitted]=useState(()=>Boolean(lifecycle&&context?.draft?.read('flashcardSaved',false))),consumed=useRef(false);
    const [flashcardRating,setFlashcardRating]=useLearningDraftState<FSRSRating|null>(context?.draft,'flashcardRating',null);
    const [saving,setSaving]=useState(false),[flowError,setFlowError]=useState('');
    const actionLock=useRef(false),live=useRef(true),currentLifecycle=useRef(lifecycle);
    useLayoutEffect(()=>{currentLifecycle.current=lifecycle;},[lifecycle]);
    useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
    const ready=(!support||Boolean(support.parentId))&&(!occlusion||imageReady);
    const showAnswer=(isFlipped||Boolean(lifecycle&&submitted&&flashcardRating))&&ready;
    const frontText=studyAIVisibleText(data.front),backText=studyAIVisibleText(visibleBack);
    const sourceData=context?.contentSource?.data as {contentHash?:string;fingerprint?:string}|undefined;
    const contentVersion=sourceData?.contentHash??sourceData?.fingerprint;
    useReportStudyAIItem(context,{question:studyAIVisibleText(data.front)||context?.aiItem?.question,learnerAnswer:showAnswer?'已翻面查看答案':'正在回忆，尚未翻面'});
    useAssistanceDisplay(assistance,'reference-answer','flashcard-back',showAnswer&&(Boolean(visibleBack)||visibleBack===0));

    const handleGrade = (rating: FSRSRating) => {
      if(!showAnswer||consumed.current||context?.draft?.isPending?.()||context?.paperServices?.isCurrent?.()===false)return;
      consumed.current=true;
      setSubmitted(true);
      onGrade(rating);
      setIsFlipped(false); // Reset for the next card (if reused)
    };

    const handleNonWordGrade = async (rating:FSRSRating) => {
      if(!lifecycle?.ready||!showAnswer||submitted||consumed.current||actionLock.current||context?.draft?.isPending?.()||context?.paperServices?.isCurrent?.()===false)return;
      if(flashcardRating&&flashcardRating!==rating)return;
      actionLock.current=true;setSaving(true);setFlowError('');
      const current=()=>live.current&&(currentLifecycle.current===lifecycle||Boolean(lifecycle.attemptId)&&currentLifecycle.current?.attemptId===lifecycle.attemptId)&&context?.paperServices?.isCurrent?.()!==false;
      try{
        setFlashcardRating(rating);assistance?.submit();
        // An oral self-assessment has no collected typed answer. Never invent one from the card.
        await lifecycle.submit('');if(!current())return;
        await lifecycle.assess({status:rating==='again'?'incorrect':rating==='hard'?'partial':'correct',source:'self-assess',rating,
          explanation:`用户主动自评为${{again:'忘记',hard:'困难',good:'良好',easy:'极易'}[rating]}。`});
        if(!current())return;
        if(lifecycle.purpose==='first')await onGrade(rating,{deferAdvance:true});
        if(current())setSubmitted(true);
      }catch(reason){if(current())setFlowError(reason instanceof Error?reason.message:'自评尚未保存，卡片与所选评级已保留。');}
      finally{actionLock.current=false;if(current())setSaving(false);}
    };

    const handleNonWordContinue = async () => {
      if(!lifecycle?.ready||saving||actionLock.current||consumed.current||context?.draft?.isPending?.())return;
      actionLock.current=true;setFlowError('');
      try{
        if(lifecycle.purpose==='remediation'){
          if(!lifecycle.finishRemediation)throw Error('当前入口尚未提供补练结束回执，自评结果已保留。');
          await lifecycle.finishRemediation();consumed.current=true;
        }else if(context?.draft?.hasSavedFeedback?.())consumed.current=context.draft.continueAfterFeedback?.()===true;
        else if(lifecycle.purpose==='first'&&submitted&&flashcardRating){await onGrade(flashcardRating,{deferAdvance:false});if(live.current)consumed.current=true;}
      }catch(reason){if(live.current)setFlowError(reason instanceof Error?reason.message:'继续前的保存尚未完成。');}
      finally{actionLock.current=false;}
    };

    const handleStartRemediation = async () => {
      if(!lifecycle?.ready||saving||actionLock.current||context?.draft?.isPending?.())return;
      actionLock.current=true;setFlowError('');
      try{
        if(!context?.draft?.hasSavedFeedback?.())throw Error('请先保存首轮自评，再进入补练。');
        if(!lifecycle.startRemediation)throw Error('当前入口尚未提供内联补练，原自评已保留。');
        await lifecycle.startRemediation();
      }catch(reason){if(live.current)setFlowError(reason instanceof Error?reason.message:'补练尚未开始。');}
      finally{actionLock.current=false;}
    };

    const chooseGrade=lifecycle?handleNonWordGrade:handleGrade;
    const swipe=useStudySwipe({revealed:showAnswer,ready:ready&&(!lifecycle||lifecycle.ready),busy:submitted||saving||Boolean(lifecycle&&flashcardRating),isCurrent:()=>context?.paperServices?.isCurrent?.()!==false&&!context?.draft?.isPending?.(),onReveal:()=>{if(!consumed.current&&!saving&&!context?.draft?.isPending?.()&&(!lifecycle||lifecycle.ready))setIsFlipped(true);},onGrade:chooseGrade});

    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if(e.defaultPrevented||e.repeat||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||document.querySelector('dialog[open]'))return;
        if(e.target instanceof Element&&e.target.closest('input,textarea,select,button,a,summary,[contenteditable]'))return;
        if(context?.draft?.isPending?.())return;
        if (e.code === "Space") {
          e.preventDefault();
          if (!isFlipped&&ready&&!consumed.current&&(!lifecycle||lifecycle.ready&&!saving)) setIsFlipped(true);
        }
        const ratings:Record<string,FSRSRating>={'1':'again','2':'hard','3':'good','4':'easy'};
        if(showAnswer&&ratings[e.key]){e.preventDefault();void chooseGrade(ratings[e.key]);}
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    });

    return (
      <div data-study-activity="flashcard" className="study-activity study-flashcard w-full max-w-3xl mx-auto flex flex-col items-center">
        <StudyGuidance topic="flashcard" context={context} engaged={isFlipped}/>
        {/* Main Card Area */}
        <div className="study-card study-flashcard-body" {...swipe}>
          
          <div className="w-full flex-grow flex flex-col justify-center items-center text-center">
            <div className="study-flashcard-front">
              {support?.mode==='bidirectional'&&<small>{support.direction==='reverse'?'反向回忆':'正向回忆'} · {lifecycle?(lifecycle.purpose==='first'?'首轮自评':'辅助回忆'):'独立排程'}</small>}
              {lifecycle&&typeof data.front==='string'?<MathText text={data.front}/>:data.front}
            </div>
            {occlusion&&<FlashcardImage support={occlusion} revealed={showAnswer} services={context?.paperServices} onReady={setImageReady}/>}
            {support&&!support.parentId&&<p role="status">这组卡片尚未展开，请更新 Companion 后重新同步来源。</p>}
            
            {showAnswer && (
              <div className="w-full animate-in fade-in slide-in-from-top-4 flex flex-col items-center mt-4">
                <div className="w-16 h-px bg-zinc-200 dark:bg-zinc-800/80 mb-8"></div>
                <div className="whitespace-pre-line text-lg sm:text-xl text-zinc-600 dark:text-zinc-300">
                  {lifecycle&&typeof visibleBack==='string'?<MathText text={visibleBack}/>:visibleBack}
                </div>
              </div>
            )}
          </div>

          {!showAnswer && (
            <div className="mt-8 w-full flex justify-center">
              <button 
                disabled={!ready||submitted||saving||Boolean(lifecycle&&!lifecycle.ready)}
                onClick={() => {if(ready&&!consumed.current&&(!lifecycle||lifecycle.ready))setIsFlipped(true);}}
                className="study-primary-action"
              >
                <span>显示答案</span>
                <span className="opacity-50 text-sm font-normal ml-3 hidden sm:inline-block">(Space)</span>
              </button>
            </div>
          )}
          <div className="study-swipe-handle" data-quiet-handle data-swipe-reveal role="group" aria-label={showAnswer?'卡片手势区：左滑忘记，右滑良好':'卡片手势区：上滑显示答案'}><span aria-hidden="true">↔</span><span aria-hidden="true">手势区</span></div>
        </div>

        {/* Grading Area */}
        {showAnswer && (!lifecycle||!flashcardRating) && (
          <div className="mt-6 sm:mt-8 flex gap-2 sm:gap-4 w-full justify-center animate-in fade-in slide-in-from-bottom-4">
            <button 
              disabled={saving||Boolean(lifecycle&&!lifecycle.ready)} onClick={() => chooseGrade("again")}
              className="study-rating study-rating--again"
            >
              <span className="font-semibold text-sm sm:text-base mb-1">忘记</span>
            </button>
            <button 
              disabled={saving||Boolean(lifecycle&&!lifecycle.ready)} onClick={() => chooseGrade("hard")}
              className="study-rating study-rating--hard"
            >
              <span className="font-semibold text-sm sm:text-base mb-1">困难</span>
            </button>
            <button 
              disabled={saving||Boolean(lifecycle&&!lifecycle.ready)} onClick={() => chooseGrade("good")}
              className="study-rating study-rating--good"
            >
              <span className="font-semibold text-sm sm:text-base mb-1">良好</span>
            </button>
            <button 
              disabled={saving||Boolean(lifecycle&&!lifecycle.ready)} onClick={() => chooseGrade("easy")}
              className="study-rating study-rating--easy"
            >
              <span className="font-semibold text-sm sm:text-base mb-1">极易</span>
            </button>
          </div>
        )}
        {flowError&&<p role="alert">{flowError}</p>}
        {lifecycle&&flashcardRating&&showAnswer&&<section className="nonword-feedback mt-6 w-full" aria-label="闪卡自评反馈">
          <p>{flashcardRating==='again'?'自评：忘记，首轮需要复习。':flashcardRating==='hard'?'自评：困难，仍需巩固。':`自评：${flashcardRating==='good'?'良好':'极易'}。`}</p>
          {flashcardRating==='again'&&<p>先对照背面的关键解释，再选择继续或独立重试。</p>}
          {saving?<p role="status">正在保存自评…</p>:!submitted&&!context?.draft?.hasSavedFeedback?.()?<button type="button" className="study-secondary-action" disabled={context?.draft?.isPending?.()} onClick={()=>handleNonWordGrade(flashcardRating)}>重试保存自评</button>:
            lifecycle.purpose==='guided'?<p role="status">引导自评已保存；请收起讲解后进入独立尝试。</p>:
            <button type="button" className="study-primary-action" disabled={saving||context?.draft?.isPending?.()} onClick={handleNonWordContinue}>{lifecycle.purpose==='remediation'?'结束补练，继续':'继续'}</button>}
          {lifecycle.purpose==='first'&&['again','hard'].includes(flashcardRating)&&(submitted||context?.draft?.hasSavedFeedback?.())&&<button type="button" className="study-secondary-action" disabled={saving||context?.draft?.isPending?.()} onClick={handleStartRemediation}>收起解释，再回忆一次</button>}
          {lifecycle.purpose==='remediation'&&<p role="status">这是辅助补练，首轮自评保持不变。</p>}
        </section>}
        {showAnswer&&!occlusion&&<CandidateLauncher registerGuard={registerStudyNavigationGuard} source={{kind:'card',key:data.itemId??data.id??'visible-card',version:contentVersion,versionKind:contentVersion?'item-content':'visible-snapshot',title:frontText,fragments:[{id:'back',label:'父卡背面',text:backText}]}} seeds={splitCardSections(frontText,backText)} scope={JSON.stringify([context?.guidanceScope,context?.paperServices?.library])} createDraft={context?.draft?.createTemporary} isCurrent={context?.paperServices?.isCurrent} download={downloadStudyMaterial} label="把复杂背面整理为子卡候选"/>}
      </div>
    );
}
