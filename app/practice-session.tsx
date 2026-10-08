"use client";
import {waitForRecallResult} from './recall-flow-model';
import {StudyPluginOptionsProvider,StudyPluginOptionsSlot} from './study-plugin-options';
import {StudyGuidanceHelp} from './study-guidance';
import {NonWordPluginHost,useNonWordRoundCache} from './study-dashboard/nonword-plugin-host';
import {continueNonWordRound,type NonWordHostScope,type NonWordRoundState} from '../src/application/nonword-study';
import {bindInlineNonWordRound,projectInlineNonWordRound} from '../src/features/nonword-study';
import {ReviewContext} from "./review-context";
import type {ReviewContextData} from "./review-context-model";
import {StudyItemSource} from "./study-item-source";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CompanionPlanClient, PracticeItem } from "./companion-plan-client";
import { registry, type FSRSRating, type PluginContext, type PluginGradeOptions } from "./plugins";
import { TutorFollowUp } from "./plugins/tutor-follow-up";
import { MathText } from "./math-text";
import {createLearningDraftStore,learningDraftItemId,type LearningDraftStore} from './learning-draft-store';
import {LearningDraftBoundary,LearningDraftLeaveGuard} from './learning-draft';
import type {AssistanceObservation} from './assistance-summary';
import {prepareAttemptEvidence} from '../src/domain/assessment';
import {attemptFailureMessage} from '../src/features/study-attempt';
import type {StudyAttemptRequest} from '../src/application/study-attempt';
import type {RecallAttemptScope} from './recall-attempt-state';
import {orderPracticeItems,practiceGroup,reorderRemainingPracticeItems,type PracticeGroup,type PracticeOrder} from './practice-order';
import {acceptLegacyReview} from '../src/domain/guided-math';
import {completesSubjectItemAfterAttempt} from '../src/domain/planning';
import {isNonWordOriginal,hasExecutableCodeMaterial} from '../src/domain/content';

/**
 * Practice session shell (Task 7).
 *
 * Consumes the Companion practice endpoints — GET /v1/practice,
 * POST /v1/practice/grade, POST /v1/practice/variant — through the wrapped
 * companionClient methods (getPractice / gradePractice / variantPractice) so
 * the session stays transport-agnostic. The parent may pre-fetch the item list
 * via companionClient.getPractice() and pass it as props; when items is not
 * provided the session loads it itself. Each item renders through the plugin
 * registry; wrong answers open an explanation panel with a "回到原笔记" link,
 * Same-content retries are immediate, temporary review, never transfer evidence.
 */

export type PracticeAttempt = {
  item: PracticeItem;
  rating: FSRSRating;
  correct: boolean;
  attempts: number;
  assistance?:AssistanceObservation|null;
};

export type PracticeSummary = {
  answered: number;
  correct: number;
  wrong: number;
};
/** Host adapter receipt; never serialized into the attempt or passed to a plugin. */
export type PracticePersistenceContext={request:StudyAttemptRequest;durable:()=>void};

export type PracticeSessionProps = {
  reviewContextFor?:(item:PracticeItem)=>ReviewContextData;
  sourcePreferenceScope?:string;
  temporary?:boolean;
  items: PracticeItem[] | null;
  companionClient?: CompanionPlanClient | null;
  onFinish?: (summary: PracticeSummary) => void;
  /** v3 event hook: the dashboard wires recordStudyAttempt with its delivery deps. */
  onRecordAttempt?: (attempt: PracticeAttempt,context:PracticePersistenceContext) => void|Promise<unknown>;
  drafts?:LearningDraftStore;
  /** Plugin context: requestAiHint from the dashboard, and authenticated
   * recall/calculation grading. When either grader is omitted the session
   * provisions it from companionClient.gradePractice (session-authenticated),
   * so plugins never need a raw fetch that would 401. */
  context?: PluginContext;
  nonWordScopeFor?:(item:PracticeItem)=>NonWordHostScope|undefined;
  recallScopeFor?:(item:PracticeItem)=>RecallAttemptScope|undefined;
  groupFor?:(item:PracticeItem)=>PracticeGroup;
};

type PracticePhase = "answering" | "explained";

const QUESTION_TYPE_PLUGIN: Record<PracticeItem["questionType"], string> = {
  quiz: "@zhixue/plugin-quiz",
  recall: "@zhixue/plugin-recall",
  calculation: "@zhixue/plugin-calculation",
  code: "@zhixue/plugin-code",
  flashcard: "@zhixue/plugin-flashcard",
  "three-stage": "@zhixue/plugin-three-stage",
};

function markdownNotePath(value?: string): string | undefined {
  const path = value?.trim();
  return path && path.toLocaleLowerCase("en-US").endsWith(".md") ? path : undefined;
}

function obsidianUri(notePath: string): string {
  if (notePath.startsWith("/") || /^[a-zA-Z]:\\/.test(notePath)) {
    return `obsidian://open?path=${encodeURIComponent(notePath)}`;
  }
  return `obsidian://open?file=${encodeURIComponent(notePath)}`;
}

/** Adapts a PracticeItem to its plugin's expected data shape; null when the plugin cannot render it. */
function pluginDataFor(item: PracticeItem): { id: string; data: unknown } | null {
  const explanation = item.explanation ?? item.reviewPoint ?? "";
  const identity={itemId:item.itemId,fingerprint:item.fingerprint,contentHash:item.contentHash,learningSupport:item.learningSupport};
  switch (item.questionType) {
    case "quiz": {
      if(item.learningSupport?.type==='quiz')return{id:QUESTION_TYPE_PLUGIN.quiz,data:{...identity,topic:item.sourceLabel,prompt:item.prompt,explanation}};
      const options = item.options ?? [];
      const answer = options[Number(item.answer)] ?? String(item.answer ?? "");
      if (options.length < 2 || answer === "") return null;
      return { id: QUESTION_TYPE_PLUGIN.quiz, data: { ...identity,topic: item.sourceLabel, prompt: item.prompt, options, answer, explanation } };
    }
    case "recall":
      return {
        id: QUESTION_TYPE_PLUGIN.recall,
        data: { ...identity,prompt: item.prompt, sourceLabel:item.sourceLabel, answer: item.answer, reviewPoint: item.reviewPoint, explanation },
      };
    case "calculation":
      return { id: QUESTION_TYPE_PLUGIN.calculation, data: { ...identity,prompt: item.prompt, answer: item.answer, explanation } };
    case "flashcard": {
      const back = String(item.answer ?? "") || explanation || "对照来源笔记复习。";
      return { id: QUESTION_TYPE_PLUGIN.flashcard, data: { ...identity,front: item.prompt, back, tags: [item.abilityId] } };
    }
    case "code":
      return hasExecutableCodeMaterial(item) ? {id:QUESTION_TYPE_PLUGIN.code,data:item} : null;
    case "three-stage":
      // PracticeItem carries no code/vocabulary fields these plugins require,
      // so the session falls back to the minimal prompt + explanation view.
      return null;
    default:
      return null;
  }
}

/** Unsupported typed content is readable, never an invented self-scoring test. */
function FallbackPractice({item,onSkip}:{item:PracticeItem;onSkip:()=>void}){
  return <section className="study-card study-feedback" aria-label="学习内容需要核对">
    <h2>本题暂不计入成绩</h2>
    <p>{item.prompt}</p>
    <p role="status">本题缺少所需的题目配置，请从“查看来源”核对。暂时跳过不会改变原有成绩。</p>
    <button type="button" className="study-secondary-action" onClick={onSkip}>暂时跳过，不计成绩</button>
  </section>;
}

export function PracticeSession({ items, companionClient, onFinish, onRecordAttempt, context,recallScopeFor,nonWordScopeFor,groupFor=practiceGroup,drafts:providedDrafts,reviewContextFor,sourcePreferenceScope,temporary }: PracticeSessionProps) {
  const localDrafts=useMemo(()=>createLearningDraftStore('inline-practice'),[]),drafts=providedDrafts??localDrafts;
  useSyncExternalStore(drafts.subscribe,drafts.getSnapshot,()=>0);
  const practiceAlive=useRef(true);useEffect(()=>{practiceAlive.current=true;return()=>{practiceAlive.current=false;};},[]);
  const [saveError,setSaveError]=useState(''),[saveRetry,setSaveRetry]=useState(0);
  const parentProvided = items !== undefined && items !== null;
  // A refreshed transport does not change an already supplied question set.
  const sourceClient=parentProvided?null:companionClient;
  const groupForRef=useRef(groupFor);useLayoutEffect(()=>{groupForRef.current=groupFor;},[groupFor]);
  const [order,setOrder]=useState<PracticeOrder>('focus');
  const [practiceItems, setPracticeItems] = useState<PracticeItem[] | null>(()=>parentProvided ? orderPracticeItems(items!,'focus',groupFor) : null);
  const [practiceLoading, setPracticeLoading] = useState(!parentProvided);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [index, setIndex] = useState(0);
  const [activeItem, setActiveItem] = useState<PracticeItem | null>(()=>parentProvided ? orderPracticeItems(items!,'focus',groupFor)[0] ?? null : null);
  const [attempts, setAttempts] = useState(0);
  const [phase, setPhase] = useState<PracticePhase>("answering");
  const [variantError, setVariantError] = useState<string | null>(null);
  const [variantLoading,setVariantLoading]=useState(false);
  const variantRequest=useRef({epoch:0,busy:false});
  const sessionEpoch=useRef(0),ended=useRef(false);
  const invalidateVariant=()=>{variantRequest.current.epoch++;variantRequest.current.busy=false;setVariantLoading(false);};
  useLayoutEffect(()=>{
    sessionEpoch.current++;ended.current=false;variantRequest.current.epoch++;variantRequest.current.busy=false;
    return()=>{sessionEpoch.current++;ended.current=true;variantRequest.current.epoch++;variantRequest.current.busy=false;};
  },[items,sourceClient]);
  useLayoutEffect(()=>{
    const request=variantRequest.current;let active=true;
    request.epoch++;request.busy=false;
    void Promise.resolve().then(()=>{if(active)setVariantLoading(false);});
    return()=>{active=false;request.epoch++;request.busy=false;};
  },[companionClient]);
  const [summary, setSummary] = useState<PracticeSummary>({ answered: 0, correct: 0, wrong: 0 });
  const draftAdapter=activeItem?drafts.adapter(learningDraftItemId('inline',activeItem.itemId,activeItem),`${activeItem.questionType}:${attempts}`):undefined;

  const list = practiceItems ?? [];
  const getRound=useNonWordRoundCache();
  const roundBinding=bindInlineNonWordRound(list,nonWordScopeFor,Boolean(temporary));
  const roundKey=roundBinding?.key??'';
  const currentRoundKey=useRef(roundKey);
  const [roundReady,setRoundReady]=useState(''),[roundError,setRoundError]=useState(''),[roundRetry,setRoundRetry]=useState(0);
  const [awaitingReview,setAwaitingReview]=useState(0),[skipped,setSkipped]=useState(0);
  const [roundGeneration,setRoundGeneration]=useState(0);
  const skipLock=useRef(false);
  useLayoutEffect(()=>{if(currentRoundKey.current!==roundKey){currentRoundKey.current=roundKey;sessionEpoch.current++;ended.current=false;}},[roundKey]);
  const restoreRound=(state:NonWordRoundState)=>{
    if(!roundBinding||currentRoundKey.current!==roundKey||!practiceAlive.current)return false;
    const restored=projectInlineNonWordRound(roundBinding,state);
    setSummary(restored.summary);setAwaitingReview(restored.awaiting);setSkipped(restored.skipped);
    const next=restored.index===null?null:list[restored.index]??null;
    const changed=activeItem?.itemId!==next?.itemId;
    if(changed){invalidateVariant();setIndex(restored.index??list.length);setActiveItem(next);setAttempts(0);setPhase('answering');setVariantError(null);setRoundGeneration(value=>value+1);}
    return changed;
  };
  useEffect(()=>{
    let cancelled=false;
    if(roundBinding)void(async()=>{
      await Promise.resolve();if(cancelled)return;
      setRoundError('');
      try{const group=await getRound(roundBinding.scope);if(!group)throw Error('本题组尚未启用恢复。');
        const state=await group.read();if(cancelled||currentRoundKey.current!==roundKey)return;
        restoreRound(state);setRoundReady(roundKey);
      }catch(reason){if(!cancelled&&currentRoundKey.current===roundKey)setRoundError(reason instanceof Error?reason.message:'题组恢复失败，原作答已保留。');}
    })();
    return()=>{cancelled=true;};
    // Scope identity includes every immutable member. Constructor callbacks are scope-pinned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[roundKey,roundRetry]);
  const continueSavedRound=async()=>{
    if(!roundBinding)return;
    const key=roundKey,epoch=sessionEpoch.current;
    try{const group=await getRound(roundBinding.scope);if(!group)throw Error('本题组尚未启用恢复。');
      const state=await group.read();if(!practiceAlive.current||currentRoundKey.current!==key||sessionEpoch.current!==epoch)return;
      restoreRound(state);setRoundError('');
      if(state.currentItemKey===null&&!ended.current){ended.current=true;onFinish?.(projectInlineNonWordRound(roundBinding,state).summary);}
    }catch(reason){if(practiceAlive.current&&currentRoundKey.current===key)setRoundError(reason instanceof Error?reason.message:'续学状态尚未保存，请重试。');}
  };
  const skipSavedRound=async()=>{
    if(!roundBinding||!activeItem||drafts.isPending()||ended.current||skipLock.current)return;
    skipLock.current=true;
    const key=roundKey,epoch=sessionEpoch.current;
    try{const group=await getRound(roundBinding.scope);if(!group)throw Error('本题组尚未启用恢复。');
      if(currentRoundKey.current!==key||epoch!==sessionEpoch.current)return;
      const member=roundBinding.scope.members![index];await continueNonWordRound(group,member.itemKey,'skipped');
      if(currentRoundKey.current!==key||epoch!==sessionEpoch.current)return;
      drafts.clearItem(learningDraftItemId('inline',activeItem.itemId,activeItem));await continueSavedRound();
    }catch(reason){if(practiceAlive.current&&currentRoundKey.current===key)setRoundError(reason instanceof Error?reason.message:'跳过状态尚未保存，当前题目保留。');}
    finally{skipLock.current=false;}
  };

  // The parent may pre-fetch /v1/practice items and pass them as props; when it
  // does not, the session loads them itself through companionClient.getPractice().
  // All state writes happen after the async boundary, never synchronously.
  useEffect(() => {
    let active = true;
    const epoch=sessionEpoch.current;
    void (async () => {
      // Defer the state transition, and cancel a superseded attempt before starting it.
      await Promise.resolve();if(!active||epoch!==sessionEpoch.current||ended.current)return;
      setLoadError(null);setPracticeLoading(!parentProvided);setVariantError(null);setVariantLoading(false);
      setOrder("focus");setSaveError('');setIndex(0);setAttempts(0);setPhase("answering");setSummary({answered:0,correct:0,wrong:0});
      if(parentProvided){const ordered=orderPracticeItems(items!,'focus',groupForRef.current);setPracticeItems(ordered);setActiveItem(ordered[0]??null);return;}
      try {
        if(!sourceClient)throw new Error('需要先提供账号题目或连接 Companion。');
        const payload = await sourceClient.getPractice();
        if (!active||epoch!==sessionEpoch.current||ended.current) return;
        const ordered=orderPracticeItems(payload.items,'focus',groupForRef.current);
        setLoadError(null);setPracticeItems(ordered);
        setActiveItem(ordered[0] ?? null);
        setPracticeLoading(false);
      } catch (error) {
        if (!active||epoch!==sessionEpoch.current||ended.current) return;
        setPracticeLoading(false);
        setLoadError(error instanceof Error ? error.message : "复习题加载失败。");
      }
    })();
    return () => {
      active = false;
    };
  }, [sourceClient, parentProvided, items, reloadToken]);

  const changeOrder=(next:PracticeOrder)=>{
    if(drafts.isPending()||roundBinding)return;
    setPracticeItems(current=>current?reorderRemainingPracticeItems(current,index,next,groupFor):current);
    setOrder(next);
  };

  const advance = (nextSummary: PracticeSummary) => {
    if(ended.current)return;
    if(roundBinding){void continueSavedRound();return;}
    invalidateVariant();
    const nextIndex = index + 1;
    if (nextIndex >= list.length) {
      ended.current=true;onFinish?.(nextSummary);
      return;
    }
    const next = list[nextIndex] ?? null;
    setIndex(nextIndex);
    setActiveItem(next);
    setAttempts(0);
    setVariantError(null);
    setPhase("answering");
  };

  const advanceRef=useRef(advance);
  useLayoutEffect(()=>{advanceRef.current=advance;},[advance]);

  const handleGrade = async (rating: FSRSRating,options?:PluginGradeOptions) => {
    const deferAdvance=Boolean(activeItem&&['calculation','recall','code','quiz','flashcard'].includes(activeItem.questionType))&&options?.deferAdvance===true;
    if (!activeItem||!draftAdapter||!practiceAlive.current||ended.current) return;
    const submittedEpoch=sessionEpoch.current;
    return await drafts.submit(draftAdapter,{
      identity:options?.identity,
      intent:JSON.stringify([rating,deferAdvance]),deferred:deferAdvance,
      current:()=>practiceAlive.current&&!ended.current&&submittedEpoch===sessionEpoch.current,
      async execute(request,control){
        const prepared=request.capture('inline-command',()=>{
          const evidence=prepareAttemptEvidence({rating,mode:activeItem.questionType,recallConfigured:activeItem.learningSupport?.type==='recall',original:activeItem},draftAdapter);
          const correct=evidence.rating==='good'||evidence.rating==='easy';
          return {attempt:{item:activeItem,rating:evidence.rating,correct,attempts,assistance:evidence.observation},
            summary:attempts>0?summary:{answered:summary.answered+1,correct:summary.correct+(correct?1:0),wrong:summary.wrong+(correct?0:1)}};
        });
        const durable=()=>{control.durable({
          continue:()=>advanceRef.current(prepared.summary),
          publish(){
            setSaveError('');setSummary(prepared.summary);
            if(prepared.attempt.correct||Boolean(nonWordScopeFor?.(activeItem))&&completesSubjectItemAfterAttempt(activeItem)){if(!deferAdvance)advance(prepared.summary);}
            else if(activeItem.questionType!=='recall'||!deferAdvance)setPhase('explained');
          },
        });};
        if(prepared.attempt.attempts===0)await onRecordAttempt?.(prepared.attempt,{request,durable});
        durable();
      },
      onError(error,saved){setSaveError(attemptFailureMessage(error,saved));if(!saved&&!(nonWordScopeFor?.(activeItem)&&isNonWordOriginal(activeItem.questionType,activeItem)))setSaveRetry(value=>value+1);},
    });
  };

  const handleRetryVariant = async () => {
    if(!activeItem||drafts.isPending()||variantRequest.current.busy||ended.current||phase!=="explained")return;
    if(!companionClient){setVariantError('需要连接本地资料助手才能准备原题复习；仍可跳过或结束。');return;}
    const request=++variantRequest.current.epoch,epoch=sessionEpoch.current,original=activeItem,nextAttempt=attempts+1;
    variantRequest.current.busy=true;setVariantLoading(true);setVariantError(null);
    const current=()=>practiceAlive.current&&!ended.current&&epoch===sessionEpoch.current&&request===variantRequest.current.epoch;
    try {
      const payload=await companionClient.variantPractice(original,nextAttempt);
      if(!current())return;
      if(drafts.hasUnsavedInput())throw new Error('本页还有未确认的临时输入，原题复习没有切换。请先处理这些输入后重试。');
      let reviewed:PracticeItem;
      try{reviewed=acceptLegacyReview(original,payload?.item).item;}
      catch{throw new Error('资料助手返回了不受支持的题目改动，原题与反馈已保留。请更新 Companion 后重试。');}
      drafts.clearItem(learningDraftItemId('inline',original.itemId,original));
      setActiveItem(reviewed);setAttempts(nextAttempt);setVariantError(null);setPhase("answering");
    } catch(error){if(current())setVariantError(error instanceof Error?error.message:'原题复习准备失败，原题已保留。');}
    finally{if(current()){variantRequest.current.busy=false;setVariantLoading(false);}}
  };

  const handleSkip = () => {
    if(drafts.isPending())return;
    if(activeItem?.questionType==='calculation'){draftAdapter?.continueAfterFeedback?.();return;}
    advance(summary);
  };

  const handleFinish = () => {
    if(drafts.isPending()||ended.current)return;
    if(drafts.hasUnrecoverableInput()&&!window.confirm('还有未提交的输入，结束复习后不会保留。已保存的学习记录不受影响。仍要结束吗？'))return;
    invalidateVariant();ended.current=true;sessionEpoch.current++;onFinish?.(summary);
  };

  if (practiceLoading) {
    return (
      <section className="p-8 bg-white dark:bg-zinc-900 border border-[var(--line)] rounded-3xl shadow-sm" aria-label="复习练习">
        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-2">开始复习</p>
        <p className="text-sm text-[var(--ink)] opacity-60">正在加载到期复习题…</p>
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="p-8 bg-white dark:bg-zinc-900 border border-[var(--line)] rounded-3xl shadow-sm" aria-label="复习练习">
        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--orange)] mb-2">复习题加载失败</p>
        <p className="text-sm text-[var(--ink)] opacity-70 mb-4">{loadError}</p>
        <div className="flex gap-3">
          <button className="px-5 py-2.5 rounded-xl bg-[var(--ink)] text-[var(--surface)] font-black text-sm hover:brightness-110 active:scale-95 transition-all" onClick={() => setReloadToken((current) => current + 1)}>重试</button>
          <button className="px-5 py-2.5 rounded-xl border border-[var(--line)] text-[var(--ink)] font-bold text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 active:scale-95 transition-all" onClick={handleFinish}>结束复习</button>
        </div>
      </section>
    );
  }

  if (list.length === 0) {
    return (
      <section className="p-8 bg-white dark:bg-zinc-900 border border-[var(--line)] rounded-3xl shadow-sm" aria-label="复习练习">
        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-2">开始复习</p>
        <h3 className="font-serif text-2xl tracking-tight text-[var(--ink)] mb-2">今日没有到期复习题</h3>
        <p className="text-sm text-[var(--ink)] opacity-60">练习会话会从 /v1/practice 拉取到期条目；先去读一点材料，或稍后再来。</p>
        <button className="mt-4 px-5 py-2.5 rounded-xl border border-[var(--line)] text-[var(--ink)] font-bold text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 active:scale-95 transition-all" onClick={handleFinish}>关闭</button>
      </section>
    );
  }

  if(roundBinding&&(roundReady!==roundKey||roundError))return <section className="study-card" aria-label="复习练习">
    <p role={roundError?'alert':'status'}>{roundError||'正在恢复本题组的作答与当前位置…'}</p>
    {roundError&&<button type="button" className="study-secondary-action" onClick={()=>setRoundRetry(value=>value+1)}>重试恢复题组</button>}
    <button type="button" className="study-secondary-action" onClick={handleFinish}>结束复习</button>
  </section>;
  if(roundBinding&&!activeItem)return <section className="study-card study-feedback" aria-label="本轮已练">
    <h2>本轮已练</h2><p>已答 {summary.answered} · 正确 {summary.correct} · 待巩固 {summary.wrong} · 待核对 {awaitingReview} · 暂时跳过 {skipped}</p>
    {awaitingReview>0&&<p>待核对的原答案保留在“待核对答案”中，尚未计入正确或错误。</p>}
    <button type="button" className="study-secondary-action" onClick={handleFinish}>结束复习</button>
  </section>;

  const adaptedPlugin = activeItem ? pluginDataFor(activeItem) : null;
  const ActivePlugin = adaptedPlugin ? registry.get(adaptedPlugin.id) : undefined;
  const notePath = activeItem ? markdownNotePath(activeItem.sourceNote) : undefined;
  // 插件上下文：优先用父组件提供的认证判题方法；缺省时由会话用
  // companionClient 自备——保证回忆题和计算题都带会话头，而不是裸 fetch。
  const bindItem=(item:unknown)=>({...((item&&typeof item==='object')?item:{}),itemId:activeItem?.itemId,fingerprint:activeItem?.fingerprint});
  const activeNonWordScope=activeItem&&attempts===0&&!temporary?nonWordScopeFor?.(activeItem):undefined;
  const pluginContext: PluginContext = {...context,draft:draftAdapter,guidanceInOptions:true,
    nativeMath:activeNonWordScope?.nativeMathIdentity&&!activeNonWordScope.cloud?context?.nativeMath??companionClient?.nativeMath:context?.nativeMath,
    nativeCourse:activeNonWordScope?.nativeCourseIdentity&&!activeNonWordScope.cloud?context?.nativeCourse??companionClient?.nativeCourse:context?.nativeCourse,
    contentSource:activeItem?{mode:activeItem.questionType,data:activeItem}:undefined,
    nonWordScope:activeNonWordScope?{...activeNonWordScope,...(roundBinding?{day:roundBinding.scope.day,members:roundBinding.scope.members}:{})}:undefined,
    nonWordNavigation:{...(roundBinding?{restoreRound}:{}),continuePending:()=>advance(summary),resumeFormal:rating=>{setSaveError('');advance({answered:summary.answered+1,correct:summary.correct+(['good','easy'].includes(rating)?1:0),wrong:summary.wrong+(['good','easy'].includes(rating)?0:1)});}},
    contentNavigation:{onSkip:()=>{
      if(!activeItem||drafts.isPending()||draftAdapter?.isPending?.()||draftAdapter?.hasSavedFeedback?.()||ended.current)return;
      if(roundBinding){void skipSavedRound();return;}
      drafts.clearItem(learningDraftItemId('inline',activeItem.itemId,activeItem));advance(summary);
    }},
    recallNavigation:activeItem?.questionType==='recall'?{continueLabel:index+1>=list.length?'结束本轮':'下一题',onSkip:()=>{
      if(!activeItem||drafts.isPending()||draftAdapter?.isPending?.()||ended.current)return;
      if(roundBinding){void skipSavedRound();return;}
      drafts.clearItem(learningDraftItemId('inline',activeItem.itemId,activeItem));advance(summary);
    }}:undefined,
    guidanceScope:context?.guidanceScope??context?.paperServices?.owner,
    recallScope:activeItem&&attempts===0&&!temporary?recallScopeFor?.(activeItem):undefined,
    ...((temporary||attempts>0)?{recallPersistenceRequired:false}:{}),
    aiItem:{id:JSON.stringify([activeItem?.fingerprint??index,adaptedPlugin?.id,attempts]),title:'复习练习',question:activeItem?.prompt},
    ...(context?.requestAiHint?{requestAiHint:(item:unknown,selected:string|null)=>context.requestAiHint!(bindItem(item),selected)}:{}),
    ...(context?.gradeRecall?{gradeRecall:(item:unknown,answer:string,signal?:AbortSignal)=>drafts.grade(()=>waitForRecallResult(()=>context.gradeRecall!(bindItem(item),answer,signal),signal),signal)}:companionClient?{gradeRecall:(item:unknown,answer:string,signal?:AbortSignal)=>drafts.grade(()=>waitForRecallResult(()=>companionClient.gradePractice(item as PracticeItem,answer),signal),signal)}:{}),
    ...(context?.gradeCalculation?{gradeCalculation:(item:unknown,answer:string,signal?:AbortSignal)=>drafts.grade(()=>context.gradeCalculation!(bindItem(item),answer,signal),signal)}:companionClient?{gradeCalculation:(item:unknown,answer:string,signal?:AbortSignal)=>drafts.grade(()=>companionClient.gradePractice(item as PracticeItem,answer),signal)}:{})};

  return (
    <StudyPluginOptionsProvider><section className="p-8 bg-white dark:bg-zinc-900 border border-[var(--line)] rounded-3xl shadow-sm" aria-label="复习练习">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-2">复习练习 · 第 {Math.min(index + 1, list.length)} / {list.length} 题</p>
          <h3 className="font-serif text-2xl tracking-tight text-[var(--ink)]">{activeItem?.sourceLabel || "复习"}</h3>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-[var(--ink)] opacity-60">已答 {summary.answered} · 正确 {summary.correct} · 待复习 {summary.wrong}{roundBinding&&<> · 待核对 {awaitingReview} · 暂时跳过 {skipped}</>}</span>
          <button className="px-4 py-2 rounded-xl border border-[var(--line)] text-[var(--ink)] font-bold text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 active:scale-95 transition-all" onClick={handleFinish}>结束复习</button>
        </div>
      </div>

      {saveError&&<p role="status" className="study-source-update-note">{saveError}</p>}
      {attempts>0&&<p role="status" className="study-source-update-note">即时重练 · 不计入正式记录。{activeItem?.questionType==='quiz'?'这里只重排原选项':'这里仍是原题'}，不代表新情境迁移；本轮统计保留首次结果。</p>}
      <details className="study-inline-options"><summary>学习选项</summary><StudyPluginOptionsSlot/>
      <StudyGuidanceHelp kind={adaptedPlugin?.id}/>
      {activeItem&&<ReviewContext {...reviewContextFor?.(activeItem)} temporary={temporary||attempts>0} recorded={Boolean(draftAdapter?.hasSavedFeedback?.())||phase==='explained'}/>}
      <details className="study-practice-order"><summary>练习顺序 · {order==='focus'?'按学科连续':'混合挑战'}</summary><label>后续题目顺序<select aria-label="后续题目顺序" value={order} disabled={Boolean(roundBinding)||drafts.isPending()||index>=list.length-1} onChange={event=>changeOrder(event.target.value==='mixed'?'mixed':'focus')}><option value="focus">按学科连续</option><option value="mixed">混合挑战</option></select></label><p>{roundBinding?'本轮按已保存的来源顺序继续，刷新后保持同一题组。':'当前作答保留，只调整后续题目。缺少学科信息时按资料来源分组。'}</p></details>
      </details>
      {!providedDrafts&&<LearningDraftLeaveGuard store={drafts}/>}
      <LearningDraftBoundary store={drafts} interactiveWhileGrading={activeItem?.questionType==='recall'}>
      {adaptedPlugin && ActivePlugin && activeItem ? (
        (() => {
          const Render = ActivePlugin;
          return (
            <NonWordPluginHost plugin={Render}
              key={`${activeItem.itemId}:${attempts}:${saveRetry}:${roundGeneration}:${roundKey}`}
              round={roundBinding?()=>getRound(roundBinding.scope):undefined}
              data={adaptedPlugin.data as Record<string,unknown>}
              onGrade={handleGrade}
              context={pluginContext}
            />
          );
        })()
      ) : activeItem ? (
        <FallbackPractice item={activeItem} onSkip={()=>pluginContext.contentNavigation?.onSkip()} />
      ) : null}
      </LearningDraftBoundary>
      {activeItem&&<details className="study-context"><summary>查看本题来源</summary><StudyItemSource item={activeItem} source={{title:activeItem.sourceLabel||'当前题目',scope:'当前复习条目的来源信息'}} canOpenLocal={Boolean(companionClient)} getObsidianUri={obsidianUri} preferenceScope={sourcePreferenceScope}/></details>}

      {phase === "explained" && activeItem && (
        <div className="mt-6 p-6 rounded-2xl border border-[var(--line)] bg-[rgba(0,0,0,0.02)] dark:bg-[rgba(255,255,255,0.03)]">
          <p className="text-[10px] font-black uppercase tracking-widest text-[var(--orange)] mb-2">再讲一遍</p>
          <p className="text-sm text-[var(--ink)] opacity-80 leading-relaxed mb-4 whitespace-pre-wrap">
            <MathText text={activeItem.explanation || activeItem.reviewPoint || "对照来源笔记复习。"} />
          </p>
          <TutorFollowUp askTutor={context?.askTutor} item={activeItem} />
          {variantError && <p className="mb-4 text-xs font-bold text-[var(--orange)]">{variantError}</p>}
          <div className="flex flex-wrap items-center gap-3">
            {notePath && companionClient && (
              <a className="px-4 py-2 rounded-xl bg-[var(--ink)] text-[var(--surface)] font-black text-sm hover:brightness-110 active:scale-95 transition-all" href={obsidianUri(notePath)} target="_blank" rel="noreferrer">回到原笔记</a>
            )}
            {notePath&&!companionClient&&<span className="study-meta">可在“查看本题来源”中设置本机 Obsidian 库名，或复制路径。</span>}
            <button disabled={!companionClient||variantLoading||drafts.isPending()} className="px-4 py-2 rounded-xl bg-[var(--lime)] text-[var(--lime-dark)] font-black text-sm hover:brightness-110 active:scale-95 transition-all disabled:opacity-40" onClick={() => void handleRetryVariant()}>{variantLoading?"正在准备原题复习…":activeItem.questionType==='quiz'?"重排复习":"原题再练"}</button>
            <button className="px-4 py-2 rounded-xl border border-[var(--line)] text-[var(--ink)] font-bold text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 active:scale-95 transition-all" onClick={handleSkip}>下次再考</button>
          </div>
        </div>
      )}
    </section></StudyPluginOptionsProvider>
  );
}
