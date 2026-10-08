'use client';
import {registerStudyNavigationGuard} from './study-navigation-guard';
import {sourceWorksheet} from '../src/domain/remediation';
import {SourceReviewLauncher} from '../src/features/remediation';
import {MathPracticeLauncher} from '../src/features/guided-math';
import '../src/features/guided-math/practice.css';
import {StudyGuidance} from './study-guidance';
import {useReportStudyAIItem} from './ai/use-report-study-ai-item';
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {CalculationSupport} from './calculation-support';
import {CalculationExploration} from './calculation-exploration';
import {useLearningDraftState} from './learning-draft';
import {useAssistance,useAssistanceDisplay} from './assistance-display';
import { MathText } from "./math-text";
import {LearningFeedback,LearningText} from '../src/features/nonword-study';
import {useCalculationStudy,presentMathVariant,formatVariantMathFeedback} from '../src/features/calculation-study';
import { TutorFollowUp } from "./plugins/tutor-follow-up";
import type { StudyPlugin, PluginRenderProps, PluginContext, GradePayload } from "./plugins/registry";

const emptySnapshot=()=>0;
const noSubscription=()=>()=>{};

export type CalculationData = {
  itemId?:string;
  id?:string;
  fingerprint?:string;
  contentHash?:string;
  learningSupport?:CalculationSupport;
  prompt: string;
  answer?: string | number;
  explanation?: string;
};

/**
 * 判题走会话上下文提供的已认证调用（context.gradeCalculation，经
 * companionPlanClient.gradePractice 转发并携带 X-Study-Loop-Session 头）。
 * 插件自身不做裸 fetch —— 那会缺会话头而恒 401。
 */
async function gradeCalculation(
  data: CalculationData,
  answer: string,
  grade?: PluginContext["gradeCalculation"],
  signal?:AbortSignal,
): Promise<GradePayload> {
  const item = {
    itemId:data.itemId??data.id,
    ...(data.learningSupport?{learningSupport:data.learningSupport}:{}),
    questionType: "calculation" as const,
    prompt: data.prompt,
    ...(data.answer === undefined ? {} : { answer: String(data.answer) }),
    explanation: data.explanation ?? "",
  };
  if (!grade) throw new Error("上下文未提供判题方法。");
  return grade(item, answer,signal);
}

export const CalculationPlugin: StudyPlugin<CalculationData> = {
  id: "@zhixue/plugin-calculation",
  name: "计算题",
  description: "输入数值或表达式结果，由 Companion 判定正误。",
  renderUI: function CalculationUI({ data, onGrade, context }: PluginRenderProps<CalculationData>) {
    const lifecycle=context?.nonWordLearning;
    const practice=lifecycle?.practice;
    useSyncExternalStore(context?.draft?.subscribe??noSubscription,context?.draft?.getSnapshot??emptySnapshot,emptySnapshot);
    const active=useRef(true),request=useRef<AbortController|null>(null);
    const originalSource=context?.contentSource?.data as {contentHash?:unknown}|undefined;
    const parentContentHash=typeof originalSource?.contentHash==='string'?originalSource.contentHash:data.contentHash;
    const identity=JSON.stringify([data.itemId,data.id,data.prompt,data.answer,data.learningSupport,parentContentHash,practice?.calculation?.activeVariant?.()?.variantHash]);
    const scopeKey=JSON.stringify([lifecycle?.attemptId,lifecycle?.purpose,parentContentHash]);
    const calculationStudy=useCalculationStudy(practice,parentContentHash,identity);
    const support=calculationStudy.support??data.learningSupport;
    const variant=calculationStudy.variant;
    const variantPresentation=variant?presentMathVariant(variant):null;
    const prompt=variantPresentation?.prompt??data.prompt;
    const currentIdentity=useRef(identity);currentIdentity.current=identity;
    const currentScope=useRef({scopeKey,practice});currentScope.current={scopeKey,practice};
    useEffect(()=>{active.current=true;return()=>{active.current=false;request.current?.abort();};},[identity,scopeKey,practice]);
    const assistance=useAssistance(context?.draft);
    const [value, setValue] = useLearningDraftState(context?.draft,'value',"");
    const [submitting, setSubmitting] = useState(false);
    const [flowError,setFlowError]=useState('');
    const [stepChecking,setStepChecking]=useState(false);
    const [childOpening,setChildOpening]=useState(false);
    const [answerKind,setAnswerKind]=useLearningDraftState(context?.draft,'calculationAnswerKind','number');
    const hasAnswer=variant?answerKind!=='number'||Boolean(value.trim()):Boolean(value.trim());
    const actionLock=useRef(false),continued=useRef(false);
    const [result, setResult] = useLearningDraftState<{ correct: boolean|null; explanation: string } | null>(context?.draft,'result',null);
    const feedbackText=variant?formatVariantMathFeedback(variant,result?.explanation??'',result?.correct):(result?.explanation??'');
    useReportStudyAIItem(context,{question:data.prompt,learnerAnswer:value,errors:result?.correct===false?[result.explanation]:[]});
    const [feedbackDisplayId,setFeedbackDisplayId]=useLearningDraftState<string|null>(context?.draft,'feedbackDisplayId',null);
    useAssistanceDisplay(assistance,'answer-feedback',feedbackDisplayId,Boolean(result&&result.correct!==null));

    const handleSubmit = async () => {
      const trimmed = value.trim();
      if (trimmed === "" || submitting || request.current || (result&&result.correct!==null)) return;
      assistance?.submit();
      setSubmitting(true);
      const controller=new AbortController();request.current=controller;
      try {
        const payload = await gradeCalculation(data, trimmed, context?.gradeCalculation,controller.signal);
        if(!active.current||controller.signal.aborted||currentIdentity.current!==identity)return;
        const correct = payload.verdict === "correct"?true:['wrong','incorrect'].includes(payload.verdict??'')?false:null;
        setResult({ correct, explanation: payload.explanation || "" });
        setFeedbackDisplayId(crypto.randomUUID());
        if(correct!==null)onGrade(correct ? "good" : "again",{deferAdvance:true});
      } catch (error) {
        if(!active.current||controller.signal.aborted||currentIdentity.current!==identity)return;
        setResult({
          correct: null,
          explanation: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if(request.current===controller)request.current=null;
        if(active.current)setSubmitting(false);
      }
    };

    const handleNonWordSubmit = async () => {
      if(!lifecycle?.ready||!hasAnswer||submitting||request.current||actionLock.current||Boolean(result&&result.correct!==null))return;
      const controller=new AbortController(),submittedAnswer=variant?JSON.stringify({answerKind,answer:answerKind==='number'?value:''}):value;request.current=controller;
      const current=()=>active.current&&!controller.signal.aborted&&request.current===controller&&currentIdentity.current===identity
        &&currentScope.current.scopeKey===scopeKey&&currentScope.current.practice===practice;
      assistance?.submit();setSubmitting(true);setFlowError('');
      try{
        if(!lifecycle.submitted)await calculationStudy.saveStep();
        if(!current())return;
        await lifecycle.submit(submittedAnswer);
        if(!current())return;
        let payload:GradePayload;
        try{
          if(calculationStudy.calculation){
            const checked=await calculationStudy.calculation.evaluate('final',controller.signal);
            if(!current()||!calculationStudy.accept(checked))return;
            if(!checked.final)throw Error('最终结果尚未完成核对，原答案已保留。');
            payload={verdict:checked.final.status==='correct'?'correct':checked.final.status==='incorrect'?'wrong':'unknown',
              correct:checked.final.status==='undetermined'?null:checked.final.status==='correct',source:checked.final.source,explanation:checked.final.explanation};
          }else payload=await gradeCalculation(data,submittedAnswer,context?.gradeCalculation,controller.signal);
        }
        catch(reason){
          if(!current())return;
          const explanation=reason instanceof Error?reason.message:String(reason);
          setResult({correct:null,explanation});setFeedbackDisplayId(crypto.randomUUID());
          await lifecycle.waitForReview(explanation);return;
        }
        if(!current())return;
        let correct:boolean|null=payload.verdict==='correct'?true:['wrong','incorrect'].includes(payload.verdict??'')?false:null;
        let explanation=payload.explanation||(correct===null?'现有规则不能判定这份答案，原输入保留待核对。':data.explanation||'已按题目参考核对本次输入。');
        if(correct!==null&&payload.correct!==undefined&&payload.correct!==correct){correct=null;explanation='核对结果相互矛盾，原答案保留待核对。';}
        if(['ai','model','self-assess'].includes(payload.source??'')){correct=null;explanation='本次结果未提供确定性核对依据，原答案保留待核对。';}
        setResult({correct,explanation});setFeedbackDisplayId(crypto.randomUUID());
        if(correct===null){await lifecycle.waitForReview(explanation);return;}
        await lifecycle.assess({status:correct?'correct':'incorrect',source:'deterministic',rating:correct?'good':'again',explanation});
        if(current()&&lifecycle.purpose==='first')await onGrade(correct?'good':'again',{deferAdvance:true});
      }catch(reason){if(current())setFlowError(reason instanceof Error?reason.message:'作答保存尚未完成，输入和核对结果已保留。');}
      finally{if(request.current===controller)request.current=null;if(active.current)setSubmitting(false);}
    };

    const handleCheckStep=async()=>{
      if(!calculationStudy.calculation||!lifecycle?.submitted||!calculationStudy.stepText.trim()||request.current||submitting||stepChecking)return;
      const controller=new AbortController();request.current=controller;setStepChecking(true);setFlowError('');
      const current=()=>active.current&&!controller.signal.aborted&&request.current===controller&&currentIdentity.current===identity
        &&currentScope.current.scopeKey===scopeKey&&currentScope.current.practice===practice;
      try{
        const checked=await calculationStudy.calculation.evaluate('step',controller.signal);
        if(current())calculationStudy.accept(checked);
      }catch(reason){if(current())setFlowError(reason instanceof Error?reason.message:'这一步已保存，暂未完成核对。');}
      finally{if(request.current===controller)request.current=null;if(active.current)setStepChecking(false);}
    };

    const handleSaveNonWordResult = async () => {
      if(!lifecycle?.ready||!result||result.correct===null||submitting||actionLock.current||context?.draft?.isPending?.()||context?.draft?.hasSavedFeedback?.())return;
      actionLock.current=true;setSubmitting(true);setFlowError('');
      try{
        await lifecycle.assess({status:result.correct?'correct':'incorrect',source:'deterministic',rating:result.correct?'good':'again',explanation:result.explanation});
        if(active.current&&currentIdentity.current===identity&&lifecycle.purpose==='first')await onGrade(result.correct?'good':'again',{deferAdvance:true});
      }catch(reason){if(active.current)setFlowError(reason instanceof Error?reason.message:'保存尚未完成，原核对结果保持不变。');}
      finally{actionLock.current=false;if(active.current)setSubmitting(false);}
    };

    const handleNonWordContinue = async () => {
      if(!lifecycle?.ready||submitting||actionLock.current||continued.current||context?.draft?.isPending?.())return;
      actionLock.current=true;setFlowError('');
      try{
        if(lifecycle.purpose==='remediation'){
          if(!lifecycle.finishRemediation)throw Error('当前入口尚未提供补练结束回执，结果已保留。');
          await lifecycle.finishRemediation();continued.current=true;
        }else if(result?.correct===null){await lifecycle.continuePending();continued.current=true;}
        else if(context?.draft?.hasSavedFeedback?.())continued.current=context.draft.continueAfterFeedback?.()===true;
      }catch(reason){if(active.current)setFlowError(reason instanceof Error?reason.message:'继续前的保存尚未完成。');}
      finally{actionLock.current=false;}
    };

    const handleStartVariant=async()=>{
      if(!lifecycle?.startVariant||!calculationStudy.calculation?.canVariant||submitting||stepChecking||actionLock.current||context?.draft?.isPending?.())return;
      actionLock.current=true;setChildOpening(true);setFlowError('');
      try{await lifecycle.startVariant(crypto.getRandomValues(new Uint32Array(1))[0]);}
      catch(reason){if(active.current)setFlowError(reason instanceof Error?reason.message:'新题尚未打开。');}
      finally{actionLock.current=false;if(active.current)setChildOpening(false);}
    };

    const handleStartRemediation = async () => {
      if(!lifecycle?.ready||submitting||stepChecking||actionLock.current||context?.draft?.isPending?.())return;
      actionLock.current=true;setFlowError('');setChildOpening(true);
      try{
        if(result?.correct!==null&&!context?.draft?.hasSavedFeedback?.())throw Error('请先保存首轮核对结果，再开始补练。');
        if(!lifecycle.startRemediation)throw Error('当前入口尚未提供内联补练，原答案已保留。');
        await lifecycle.startRemediation();
      }catch(reason){if(active.current)setFlowError(reason instanceof Error?reason.message:'补练尚未开始。');}
      finally{actionLock.current=false;if(active.current)setChildOpening(false);}
    };

    return (
      <div data-study-activity="calculation" className="study-activity study-calculation w-full max-w-3xl mx-auto flex flex-col">
        <StudyGuidance topic="calculation" context={context} engaged={Boolean(value.trim()||result)}/>
        <div className="study-card">
          <div className="flex justify-between items-center mb-6">
            <span className="study-activity-eyebrow">计算 · {variant?'换条件练习':support?.mode==='symbolic'?'符号表达式':'数值作答'}</span>
          </div>

          <h2 className="study-question">
            {lifecycle?<MathText text={prompt}/>:prompt}
          </h2>
          {calculationStudy.calculation?.sourceLabel&&<p className="study-meta">来源：{calculationStudy.calculation.sourceLabel}</p>}
          {!variant&&support?.schemaVersion===2&&support.conditions?.length&&<div className="text-sm leading-relaxed mb-3"><span className="text-[var(--muted)]">条件：</span>{support.conditions.map((condition,index)=><div key={index}><MathText text={condition}/></div>)}</div>}
          {!variant&&support?.schemaVersion===2&&support.units&&<p className="text-sm leading-relaxed mb-3">单位：<MathText text={support.units}/></p>}
          {variant&&<p className="text-sm leading-relaxed mb-3"><MathText text={variantPresentation!.domain}/></p>}

          {childOpening?<p role="status">正在打开练习…</p>:<div className="flex flex-col gap-4">
            {variant&&<label className="flex flex-col gap-2 text-sm">结论类型
              <select aria-label="结论类型" value={answerKind} disabled={submitting||Boolean(lifecycle?.submitted)} onChange={event=>setAnswerKind(event.target.value)} className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-base focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
                <option value="number">数值结果</option><option value="none">无解</option><option value="all">不唯一 / 任意值</option><option value="allowed">允许</option><option value="not-allowed">不允许</option>
              </select>
            </label>}
            {(!variant||answerKind==='number')&&<input
              type="text"
              inputMode={support?.mode==='symbolic'?'text':'decimal'}
              value={value}
              readOnly={submitting||Boolean(result&&result.correct!==null)||Boolean(lifecycle?.submitted)}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter"&&!event.nativeEvent.isComposing) void (lifecycle?handleNonWordSubmit():handleSubmit());
              }}
              placeholder="输入你的答案"
              aria-label="你的答案"
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#1A1D24] px-4 py-3 text-base text-zinc-900 dark:text-zinc-100 outline-none focus:border-[#00D4FF]"
            />}
            {calculationStudy.step&&<details className="border-t border-[var(--line)] pt-3">
              <summary className="cursor-pointer text-sm focus-visible:outline-2 focus-visible:outline-[var(--accent)]">记录关键步骤（可选）</summary>
              <div className="flex flex-col gap-3 pt-3">
                <p className="text-sm leading-relaxed"><MathText text={calculationStudy.step.prompt}/></p>
                <textarea aria-label="关键步骤" rows={3} value={calculationStudy.stepText} readOnly={submitting||Boolean(lifecycle?.submitted)} onChange={event=>calculationStudy.editStep(event.target.value)} placeholder="只写这一步；可留空" className="w-full resize-y rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-base leading-relaxed focus-visible:outline-2 focus-visible:outline-[var(--accent)]"/>
                {calculationStudy.diagnostic&&<div className="text-sm leading-relaxed" role="status">
                  <p className="font-semibold">{calculationStudy.diagnostic.status==='correct'?'这一步正确':calculationStudy.diagnostic.status==='incorrect'?'这一步有误':'这一步待核对'}</p>
                  <LearningFeedback text={calculationStudy.diagnostic.explanation} renderMath={text=><MathText text={text}/>}/>
                </div>}
                {lifecycle?.submitted&&calculationStudy.stepText.trim()&&<button type="button" className="study-secondary-action" disabled={submitting||stepChecking||!lifecycle.ready} onClick={handleCheckStep}>{stepChecking?'核对中…':'核对这一步'}</button>}
              </div>
            </details>}
            {(!result||result.correct===null)&&<button
              onClick={() => lifecycle?handleNonWordSubmit():handleSubmit()}
              disabled={!hasAnswer || submitting||stepChecking||Boolean(lifecycle&&!lifecycle.ready)}
              className="study-primary-action"
            >
              {submitting ? "判定中..." : "提交"}
            </button>}
          </div>}

          {support?.mode==='symbolic'&&<p className="text-sm text-[var(--muted)] mt-3">实数变量：{support.variables.join(', ')||'无'}。</p>}
          {!variant&&support?.exploration&&<CalculationExploration key={JSON.stringify(support.exploration)} config={support.exploration}/>}

          {calculationStudy.recoveryError&&<p role="alert">{calculationStudy.recoveryError}</p>}
          {flowError&&<p role="alert">{flowError}</p>}
          {result&&!childOpening && (
            <div
              className={`mt-6 p-5 rounded-xl border animate-in fade-in slide-in-from-bottom-4 ${
                result.correct===null?'bg-[var(--surface-2)] border-[var(--line)]':result.correct
                  ? "bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800/50"
                  : "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/50"
              }`}
            >
              <p
                className={`font-black text-sm uppercase tracking-widest mb-2 ${
                  result.correct===null?'text-[var(--muted)]':result.correct ? "text-teal-700 dark:text-teal-300" : "text-red-700 dark:text-red-300"
                }`}
              >
                {result.correct===null?(lifecycle?'首轮答案已保留 · 待核对':'未能判定 · 请重试'):result.correct ? (lifecycle?'✓ 最终结果正确':'✓ 回答正确') : (lifecycle?'✗ 最终结果有误':'✗ 回答错误')}
              </p>
              {result.explanation && (
                lifecycle?(feedbackText.length>320||feedbackText.split('\n').length>6?<details><summary>查看完整解析</summary><LearningText text={feedbackText} renderMath={text=><MathText text={text}/>}/></details>:<LearningFeedback className="text-sm" text={feedbackText} renderMath={text=><MathText text={text}/>}/>):<p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  <MathText text={result.explanation} />
                </p>
              )}
              {lifecycle&&!variant&&result.correct!==null&&data.explanation&&data.explanation!==result.explanation&&<details><summary>查看题目完整解法</summary><LearningText text={data.explanation} renderMath={text=><MathText text={text}/>}/></details>}
              {lifecycle&&variant&&result.correct!==null&&variantPresentation?.reference&&!result.explanation.includes(variant.definition.reference)&&<details><summary>查看变式解法</summary><LearningText text={variantPresentation.reference} renderMath={text=><MathText text={text}/>}/></details>}
              {lifecycle?<div className="mt-4 flex flex-col gap-3">
                {lifecycle.purpose==='remediation'?<button type="button" className="study-primary-action" disabled={submitting||stepChecking||!lifecycle.ready} onClick={handleNonWordContinue}>结束补练，继续</button>:
                  lifecycle.purpose==='guided'?null:
                  result.correct===null?<button type="button" className="study-primary-action" disabled={submitting||!lifecycle.ready||!lifecycle.submitted} onClick={handleNonWordContinue}>保留待核对结果，继续</button>:
                  context?.draft?.hasSavedFeedback?.()?<button type="button" className="study-primary-action" disabled={submitting} onClick={handleNonWordContinue}>继续</button>:
                  <button type="button" className="study-secondary-action" disabled={submitting||context?.draft?.isPending?.()} onClick={handleSaveNonWordResult}>重试保存</button>}
                {lifecycle.purpose==='first'&&result.correct!==true&&<button type="button" className="study-secondary-action" disabled={submitting||stepChecking||!lifecycle.ready} onClick={handleStartRemediation}>收起解法重算</button>}
                {lifecycle.purpose==='first'&&calculationStudy.calculation?.canVariant&&lifecycle.startVariant&&<button type="button" className="study-secondary-action" disabled={submitting||stepChecking||!lifecycle.ready||context?.draft?.isPending?.()} onClick={handleStartVariant}>换条件，再练一题</button>}
              </div>:result.correct!==null&&<div className="mt-4">
                {!context?.draft?.hasSavedFeedback?.()&&<p className="study-meta" role="status">{context?.draft?.isPending?.()?'正在保存作答…':'评分尚未保存，请重试保存；当前答案和反馈已保留。'}</p>}
                {context?.draft?.hasSavedFeedback?.()?<button type="button" className="study-primary-action" onClick={()=>context?.draft?.continueAfterFeedback?.()}>继续</button>:<button type="button" className="study-secondary-action" disabled={context?.draft?.isPending?.()} onClick={()=>{if(!context?.draft?.isPending?.()&&!context?.draft?.hasSavedFeedback?.())onGrade(result.correct?'good':'again',{deferAdvance:true});}}>重试保存</button>}
              </div>}
              {lifecycle?<details><summary>更多帮助</summary><TutorFollowUp askTutor={context?.askTutor} item={data} compact draft={context?.draft}/></details>:
                <TutorFollowUp askTutor={context?.askTutor} item={data} compact draft={context?.draft}/>}
              {!lifecycle&&result.correct===false&&<SourceReviewLauncher registerGuard={registerStudyNavigationGuard} worksheet={sourceWorksheet({kind:'recalculate',binding:identity,target:data.prompt,reference:String(data.explanation||(data.answer??''))})} createDraft={context?.draft?.createTemporary} disabled={!context?.draft?.hasSavedFeedback?.()} label="重算这一步（辅助练习）" expected={data.answer} calculation={data.learningSupport?.type==='calculation'?data.learningSupport:undefined}/>}
              {!lifecycle&&result.correct!==null&&<MathPracticeLauncher source={{key:data.itemId??data.id??'visible-calculation',contentHash:parentContentHash,title:data.prompt,snapshot:JSON.stringify([data.prompt,data.answer,data.explanation,data.learningSupport])}} scope={context?.guidanceScope??identity} createDraft={context?.draft?.createTemporary} registerGuard={registerStudyNavigationGuard} disabled={!context?.draft?.hasSavedFeedback?.()}/>}
            </div>
          )}
        </div>
      </div>
    );
  },
};
