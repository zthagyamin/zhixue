"use client";
import {NonWordPluginHost,createNonWordContinuation,restorePendingAnswers,scopeForNonWord,nonWordRoundMembers,useNonWordRoundCache,subjectLearningServices,cursorSeed,restoreSavedPending,restartSavedRound,makeExtra} from './nonword-plugin-host';
import { createNonWordQuestionSelection, bindNonWordNavigation, sourceUpdateNotice } from '../../src/features/nonword-study';
import {practicedSubjectKeys,pendingSubjectKeys,isSubjectPassComplete,skipSubjectRound} from '../subject-round';
import {DemoModeBadge} from "../demo-mode-badge";
import {StudyGuidanceHelp} from '../study-guidance';
import {StudySaveStatus} from '../study-save-status';
import {ReviewContext} from "../review-context";
import { useState } from "react";
import { ExtraPracticeSession, type ExtraPracticeSnapshot } from "../extra-practice-session";
import { StudyItemSource } from "../study-item-source";
import { resolveModuleTaskScope } from "../account-study-runtime";
import { StudyAITrigger } from "../components/ai-sidebar";
import {
modulePresentation,
resolveEventAbilityId,
resolveStudyItemProgressKey,
stableStudyItemKey
} from "../dynamic-ui-model";
import { LearningDraftBoundary } from "../learning-draft";
import { learningDraftItemId } from "../learning-draft-store";
import { updateStudyEventDelivery } from "../local-study-events";
import { applySavedNativeAttempt } from "../native-progress-view";
import { filterPlanSubject,planItemStages,resolvePlanPractice } from "../plan-runtime";
import {
PLUGIN_TYPES,
adaptStudyItemForPlugin,
compatiblePluginTypes,
isVocabularySubject,
pluginItemKey,
pluginLabels,
recommendedPluginType,
resolvePluginType
} from "../plugin-routing";
import { registry } from "../plugins";
import { recordStudyAttempt,type StudyAttemptInput } from "../study-event-controller";
import {prepareAttemptEvidence} from "../../src/domain/assessment";
import {completesSubjectItemAfterAttempt,isInitialReviewProbe,reviewDisplayStage,reviewSubmission} from "../../src/domain/planning";
import {createSubjectGradeHandler} from "../../src/features/study-attempt";
import type { StudyEventV3 } from "../study-event-v3";
import { StudyRecoveryState,StudySessionShell,StudySubjectMenu } from "../study-session-shell";
import { strongerAuxiliaryDelivery } from "../study-submission-status";
import { advanceSubjectRound,emptySubjectRound,isSubjectRoundComplete } from "../subject-round";
import { assertPlanningStudySources,taskWordStages } from "../task-plan-runtime";
import { advanceThreeStageSession } from "../three-stage-order";
import { firstIncompleteGroup,pacingForSubject,resolveServedGroup,splitGroupBounds,vocabQuotaOptions } from "../vocab-pacing";
import { Progress,StudyItem,domainForSubject,itemKindForDomain,itemLabel,markdownNotePath,validatePluginData } from "./prelude";
import type { DashboardController } from './use-dashboard-controller';
type Props={model:Pick<DashboardController,"accountDailyPlan"|"accountLibraryId"|"accountLoaded"|"accountModeEpoch"|"accountModuleSource"|"activeLearningDraftsRef"|"activeTaskScope"|"assistanceHistory"|"auxiliaryDelivery"|"captureAttemptFrame"|"choosePlanVocabEntry"|"cloudSyncMetadata"|"companionPlanClient"|"companionSession"|"currentDay"|"data"|"effectivePlan"|"eventMutation"|"freeStudySubject"|"getVisibleSubjectRound"|"getObsidianUri"|"gradeAccountCalculation"|"inputPoolPractice"|"isDemoMode"|"itemIndices"|"learningDrafts"|"localSourcePending"|"moduleNavigationSubjects"|"moduleSubjects"|"nativeHistoryError"|"nativeScope"|"nativeView"|"navigateToStudyTab"|"normalizedSubjects"|"noteEventsChanged"|"openSources"|"paperServices"|"persistSubmittedEvent"|"persistVocabPacing"|"pluginOverrides"|"practiceRequest"|"progressEvents"|"requestAiHint"|"requestAiTutor"|"restartSubjectRound"|"restartStatus"|"retrySubjectRestart"|"cancelSubjectRestart"|"runAccountQuestionAi"|"scopedAccountProgress"|"selectedPlanVocabKey"|"sendSubmittedCloud"|"sendSubmittedCompanion"|"sessionUser"|"setAccountProgress"|"setActiveTaskScope"|"setAiEntryOpen"|"setDemoProgress"|"setFreeStudySubject"|"setItemIndex"|"setItemIndices"|"setItemPluginOverride"|"setNativeProjection"|"setPlanMessage"|"setProgress"|"setProgressEvents"|"setSelectedPlanVocabKey"|"setStageRoundBump"|"setSubjectPluginOverride"|"setSubjectRounds"|"stageRoundBump"|"subjectPacing"|"subjectRounds"|"subjects"|"syncState"|"tab"|"taskLearning"|"taskPlanningEnabled"|"taskWorkspaceRef"|"uiProgress"|"visibleAccountStatus"|"visibleLearningRef"|"vocabPacingWorkspace"|"workspaceId"|"continueTodayStudy"|"practiceLoading"|"planMessage">};
export function SubjectView({model}:Props){
 const owner=JSON.stringify([model.workspaceId,model.accountLibraryId??model.data.localLibraryId??'',model.tab,model.currentDay,model.isDemoMode,Boolean(model.accountLoaded),model.selectedPlanVocabKey??null]);
 return <SubjectViewSession key={owner} model={model}/>;
}
function SubjectViewSession({model}:Props){
 const [extraPractice,setExtraPractice]=useState<ExtraPracticeSnapshot|null>(null),nonWordRoundFor=useNonWordRoundCache();
 const {
  accountDailyPlan,
  accountLibraryId,
  accountLoaded,
  accountModeEpoch,
  accountModuleSource,
  activeLearningDraftsRef,
  activeTaskScope,
  assistanceHistory,
  auxiliaryDelivery,
  captureAttemptFrame,
  choosePlanVocabEntry,
  cloudSyncMetadata,
  companionPlanClient,
  companionSession,
  currentDay,
  data,
  effectivePlan,
  eventMutation,
  freeStudySubject,
  getObsidianUri,
  getVisibleSubjectRound,
  gradeAccountCalculation,
  inputPoolPractice,
  isDemoMode,
  itemIndices,
  learningDrafts,
  localSourcePending,
  moduleNavigationSubjects,
  moduleSubjects,
  nativeHistoryError,
  nativeScope,
  nativeView,
  navigateToStudyTab,
  normalizedSubjects,
  noteEventsChanged,
  openSources,
  paperServices,
  persistSubmittedEvent,
  persistVocabPacing,
  pluginOverrides,
  practiceRequest,
  progressEvents,
  requestAiHint,
  requestAiTutor,
  restartSubjectRound,
  runAccountQuestionAi,
  scopedAccountProgress,
  selectedPlanVocabKey,
  sendSubmittedCloud,
  sendSubmittedCompanion,
  sessionUser,
  setAccountProgress,
  setActiveTaskScope,
  setAiEntryOpen,
  setDemoProgress,
  setFreeStudySubject,
  setItemIndex,
  setItemIndices,
  setItemPluginOverride,
  setNativeProjection,
  setPlanMessage,
  setProgress,
  setProgressEvents,
  setSelectedPlanVocabKey,
  setStageRoundBump,
  setSubjectPluginOverride,
  setSubjectRounds,
  stageRoundBump,
  subjectPacing,
  subjectRounds,
  subjects,
  syncState,
  tab,
  taskLearning,
  taskPlanningEnabled,
  taskWorkspaceRef,
  uiProgress,
  visibleAccountStatus,
  visibleLearningRef,
  vocabPacingWorkspace,
  workspaceId,
 }=model;
 const restarting=model.restartStatus?.subjectId===tab?model.restartStatus:null;
 if(restarting?.busy)return <StudyRecoveryState onExit={()=>navigateToStudyTab('today')}><h2>正在重新开始</h2><p>{restarting.message}</p><p>{restarting.completed} / {restarting.total}</p></StudyRecoveryState>;
 return <>{restarting&&restarting.completed<restarting.total&&<section role="status" className="study-source-update-note"><p>{restarting.message}</p>{restarting.canRetry&&<button type="button" onClick={model.retrySubjectRestart}>重试未完成项</button>}<button type="button" onClick={model.cancelSubjectRestart}>保留已处理结果，停止剩余重启</button></section>}{moduleNavigationSubjects.map((subject) => {
          if (tab !== subject.id) return null;
          if(accountLoaded&&!activeTaskScope?.accountSource&&freeStudySubject!==subject.id)return <StudyRecoveryState key={subject.id} onExit={()=>navigateToStudyTab('today')}><p>{accountDailyPlan.error||(accountDailyPlan.ready?'今日计划已就绪，可以继续本学科的任务。':'正在核对今日账号计划…')}</p>{accountDailyPlan.ready&&!accountDailyPlan.error?<button onClick={()=>navigateToStudyTab(subject.id)}>继续今日任务</button>:<button onClick={()=>void accountDailyPlan.refresh().catch(()=>{})}>重新同步计划</button>}<button type="button" onClick={()=>setFreeStudySubject(subject.id)}>使用已缓存资料自由学习</button></StudyRecoveryState>;
          const allItems = isVocabularySubject(subject) ? moduleSubjects.find(entry=>entry.id===subject.id)?.items || [] : subject.items || [];
          const vocabPacing = pacingForSubject(subjectPacing,subject.id,subject.groupQuota);
          if (allItems.length === 0) return <StudyRecoveryState key={subject.id} onExit={()=>navigateToStudyTab('today')}><p>这个学科暂无学习内容，请返回今日检查资料。</p></StudyRecoveryState>;
          if(!isDemoMode&&!accountLoaded&&(!nativeView.ready||allItems.some((item,index)=>nativeView.unresolvedKeys.includes(resolveStudyItemProgressKey(item,index,uiProgress)))))return <StudyRecoveryState key={subject.id} onExit={()=>navigateToStudyTab('today')}><h2>本机学习历史待核对</h2><p>{nativeHistoryError||'已有记录保留，但尚不能确认它们属于当前本机资料。不会把其他题库的进度用于评分。请连接当前学习库重新核对。'}</p><button type="button" onClick={noteEventsChanged}>重新核对历史</button><button type="button" onClick={()=>openSources('connections')}>查看资料连接</button></StudyRecoveryState>;
          const chooseVisiblePlanEntry=(key:string)=>{if(!accountLoaded&&!taskPlanningEnabled){choosePlanVocabEntry(key);return;}setSelectedPlanVocabKey(key);setItemIndices(indices=>({...indices,[subject.id]:0}));setSubjectRounds(rounds=>({...rounds,[subject.id]:emptySubjectRound()}));};

          // 计划驱动（主旨一/二）：有当日计划时，模块只渲染计划内内容；
          // 计划的 vocab-group 条目决定背词组，题目条目决定阅读/论文题。
          const taskScope=resolveModuleTaskScope({day:currentDay,subjectId:subject.id,active:activeTaskScope,accountMode:Boolean(accountLoaded),approved:accountModuleSource,
            local:taskPlanningEnabled&&taskLearning.state?.draft?.plan&&taskLearning.state.catalog?{plan:taskLearning.state.draft.plan,catalog:taskLearning.state.catalog}:null,freeStudy:freeStudySubject===subject.id});
          const modulePlan=taskScope?.adapter??(accountLoaded||(taskPlanningEnabled||Boolean(accountLoaded))?null:effectivePlan);
          const plannedVocabEntries=modulePlan?.items.filter(item=>{const ref=resolvePlanPractice(item,moduleSubjects); return ref?.kind==='vocab-group' && ref.subjectId===subject.id;})??[];
          const selectedVocabEntry=plannedVocabEntries.find(item=>item.itemKey===selectedPlanVocabKey) ?? plannedVocabEntries[0];
          const selectedVocabReference=selectedVocabEntry ? resolvePlanPractice(selectedVocabEntry,moduleSubjects) : undefined;
          const scopedTask=taskScope?.plan.tasks.find(task=>task.taskId===(selectedVocabEntry?.itemKey??taskScope.taskId));
          const groupedTasks=taskScope?.groupTaskIds?taskScope.plan.tasks.filter(task=>taskScope.groupTaskIds!.includes(task.taskId)):null;
          if(taskScope){
            try{for(const task of groupedTasks??taskScope.plan.tasks.filter(task=>task.subjectId===subject.id&&task.action.kind==='practice'&&(!scopedTask||task.taskId===scopedTask.taskId)))assertPlanningStudySources(taskScope.catalog,moduleSubjects,task);}
            catch{return <section key={subject.id} className="max-w-3xl mx-auto p-6 border border-[var(--line)] rounded-xl"><p role="status">这项任务的资料已变化，请返回今日汇总确认后继续。</p><button onClick={()=>navigateToStudyTab('today')}>返回今日汇总</button></section>;}
          }
          const scopedRound=taskLearning.state?.reviewRounds.find(round=>round.roundId===scopedTask?.reviewRoundId || round.aliasRoundIds?.includes(scopedTask?.reviewRoundId??''));
          const accountEvents=accountLoaded?.records.filter(row=>row.record.provenanceMode!=='task').map(row=>row.record.event as StudyEventV3)??[];
          const learningStages = groupedTasks&&taskLearning.state?.catalog&&!accountLoaded
            ?groupedTasks.reduce((stages,task)=>taskWordStages(task,taskLearning.state?.reviewRounds.find(round=>round.roundId===task.reviewRoundId||round.aliasRoundIds?.includes(task.reviewRoundId??'')),progressEvents,stages,taskLearning.state!.catalog!),uiProgress.itemStages)
            :scopedTask && taskLearning.state?.catalog && !accountLoaded
            ? taskWordStages(scopedTask,scopedRound,progressEvents,uiProgress.itemStages,taskLearning.state.catalog)
            : planItemStages(selectedVocabEntry,moduleSubjects,uiProgress,accountLoaded?[...accountEvents,...progressEvents]:progressEvents,currentDay);
          const plannedVocabGroup=selectedVocabReference?.groupIndex ?? null;

          // 背词科目按组服务（默认 20 词/组、20 词/天，可自由调整）；
          // 进度键是内容稳定的（abilityId/词形），切片不影响既有进度。
          const isVocabPaced = isVocabularySubject(subject);
          const vocabBounds = splitGroupBounds(allItems.length, isVocabPaced ? selectedVocabReference?.groupQuota ?? vocabPacing.settings.quota : allItems.length);
          const vocabCompletedAt = (index: number) => (uiProgress.itemStages[resolveStudyItemProgressKey(allItems[index], index, uiProgress)] || 0) >= 3;
          const autoVocabGroup = resolveServedGroup({
            todayKey: currentDay,
            saved: vocabPacing.serve,
            firstIncomplete: firstIncompleteGroup(vocabBounds, vocabCompletedAt),
            override: isVocabPaced ? vocabPacing.settings.override : null,
            groupCount: vocabBounds.length,
          });
          // 计划指定组时以计划为准（计划是当日范围的总纲）。
          const vocabServedGroup = plannedVocabGroup !== null && plannedVocabGroup < vocabBounds.length ? plannedVocabGroup : autoVocabGroup;
          const vocabServeBounds = vocabBounds[Math.min(vocabServedGroup, vocabBounds.length - 1)];
          const vocabLibraryComplete = isVocabPaced && allItems.every((item, index) => vocabCompletedAt(index));
          const selectionPlan=modulePlan && isVocabPaced && selectedVocabEntry ? {...modulePlan,items:[selectedVocabEntry]} : modulePlan;
          const items = selectionPlan
            ? filterPlanSubject({...subject,items:allItems},selectionPlan,moduleSubjects) as StudyItem[]
            : isVocabPaced ? allItems.slice(vocabServeBounds.start, vocabServeBounds.end) : allItems;
          if(items.length===0) return <section key={subject.id} className="max-w-3xl mx-auto p-6"><p role="status">这个学科暂无可执行的计划条目，请返回今日计划检查资料。</p><button onClick={()=>navigateToStudyTab('today')}>返回今日计划</button></section>;
          const vocabServedCompletedCount=isVocabPaced ? items.filter((item,index)=>(learningStages[resolveStudyItemProgressKey(item,index,uiProgress)]||0)>=3).length : 0;

          // Extra practice owns an independent snapshot and cannot reuse official completion state.
          const extraScopeKey=JSON.stringify([workspaceId,accountLibraryId??data.localLibraryId??'',currentDay,subject.id,isDemoMode,Boolean(accountLoaded),selectedVocabEntry?.itemKey??scopedTask?.taskId??null,items.map((item,index)=>[resolveStudyItemProgressKey(item,index,uiProgress),item.contentHash??item.fingerprint??null])]);
          const nonWordSourceScope={workspaceId,ownerId:accountLoaded?sessionUser?.userId??workspaceId:workspaceId,libraryId:accountLibraryId??data.localLibraryId,loaded:accountLoaded,enabled:!isDemoMode&&!isVocabularySubject(subject)};
          const nonWordMembers=nonWordRoundMembers(nonWordSourceScope,items,(item,index)=>resolveStudyItemProgressKey(item,index,uiProgress),item=>recommendedPluginType(item,subject.pluginType));
          const beginExtraPractice=(onlyKeys?:readonly string[])=>{
            if(learningDrafts.isPending()){setPlanMessage('当前作答正在处理，完成后再开始额外巩固。');return;}
            const selected=items.map((item,index)=>({item,index})).filter(({item,index})=>!onlyKeys||onlyKeys.includes(resolveStudyItemProgressKey(item,index,uiProgress)));
            if(!selected.length)return;
            setExtraPractice(makeExtra({scopeKey:extraScopeKey,workspaceId,day:currentDay,title:subject.name,source:data.source,scope:nonWordSourceScope,selected:selected.map(({item,index})=>({item,key:resolveStudyItemProgressKey(item,index,uiProgress),sourceMode:recommendedPluginType(item,subject.pluginType),mode:resolvePluginType(item,subject.pluginType,pluginOverrides.item[pluginItemKey(subject.id,item,index)],pluginOverrides.subject[subject.id])}))}));
          };
          if(extraPractice?.scopeKey===extraScopeKey)return <ExtraPracticeSession key={extraScopeKey} snapshot={extraPractice} onExit={()=>setExtraPractice(null)} canOpenLocal={!accountLoaded&&Boolean(companionSession)&&syncState==='connected'} getObsidianUri={getObsidianUri} nativeCourse={!accountLoaded?companionPlanClient?.nativeCourse:undefined} nativeMath={!accountLoaded?companionPlanClient?.nativeMath:undefined}/>;
          const resetWarning=subject.pluginType==='three-stage'
            ?isDemoMode?'仅重置当前公开示例的阶段，不写入个人记录。是否继续？'
              :accountLoaded?'重新开始会清除本组当前阶段视图；历史记录保留，后续正常作答仍会记录。这不是额外巩固。是否继续？'
              :'将把本组已学词按“记错”重新开始，FSRS 复习间隔会相应缩短。这不是额外巩固。是否继续？'
            :'重新开始会清除本轮答题状态，后续正常作答仍会记录；已有历史保留。这不是额外巩固。是否继续？';

          const idx = itemIndices[subject.id] || 0;
          const currentItem = items[idx % items.length];
          const itemProgressKey = resolveStudyItemProgressKey(currentItem, idx, uiProgress);
          const overrideKey = pluginItemKey(subject.id, currentItem, idx % items.length);
          const itemOverride = pluginOverrides.item[overrideKey];
          const subjectOverride = pluginOverrides.subject[subject.id];
          const aiRecommendedPluginType = recommendedPluginType(currentItem, subject.pluginType);
          const compatibleItemPlugins = compatiblePluginTypes(currentItem);
          const compatibleSubjectPlugins = PLUGIN_TYPES.filter((type) => items.some((item) => adaptStudyItemForPlugin(type, item) !== null));
          const actualPluginType = resolvePluginType(currentItem, subject.pluginType, itemOverride, subjectOverride);
          const pluginData = adaptStudyItemForPlugin(actualPluginType, currentItem);
          const Plugin = registry.get(`@zhixue/plugin-${actualPluginType}`);
          if (!Plugin) return <StudyRecoveryState key={subject.id} onExit={()=>navigateToStudyTab('today')}><p>当前学习方式暂不可用：{actualPluginType}。请返回今日选择其他学科。</p></StudyRecoveryState>;
          const validationError = validatePluginData(actualPluginType, (pluginData || currentItem) as StudyItem);
          if (validationError) return <StudyRecoveryState key={subject.id} onExit={()=>navigateToStudyTab('today')}><strong>这条学习内容暂时无法显示</strong><p className="mt-2 text-sm">{validationError}</p></StudyRecoveryState>;
          const completedStage = learningStages[itemProgressKey] || 0;
          const plannedCategory=groupedTasks?.[0]?.category??scopedTask?.category;
          const isDueWordReview=isVocabPaced&&(plannedCategory?plannedCategory==='review':['review','overdue'].includes(selectedVocabEntry?.kind??''));
          const catalogWord=taskScope?.catalog.subjects.find(entry=>entry.subjectId===subject.id||entry.subjectId===scopedTask?.subjectId)
            ?.words.find(word=>word.itemKey===itemProgressKey||word.legacyKeys?.includes(itemProgressKey));
          const reviewKeys=[itemProgressKey,...(catalogWord?[catalogWord.itemKey,...(catalogWord.legacyKeys??[])]:[])];
          const reviewAnchor=scopedRound?(progressEvents.find(event=>event.eventId===scopedRound.anchorEventId)?.occurredAt??scopedRound.observedAt):undefined;
          const quickReview=isInitialReviewProbe({review:isDueWordReview&&(!accountLoaded||scopedAccountProgress?.historyReady===true),mode:actualPluginType,completedStage,itemKeys:reviewKeys,
            events:accountLoaded?[...accountEvents,...progressEvents]:progressEvents,
            boundary:accountLoaded||!taskScope?{kind:'day',day:currentDay}:reviewAnchor?{kind:'after',occurredAt:reviewAnchor}:null});
          const currentStage = (actualPluginType === "calculation" || actualPluginType === "recall") ? 1 : actualPluginType==='three-stage'
            ?reviewDisplayStage(completedStage,quickReview):Math.min(3,completedStage+1);
          const roundScope=getVisibleSubjectRound(subject.id).scope;
          const sourceItemId=learningDraftItemId(subject.id,itemProgressKey,currentItem);
          const draftItemId=JSON.stringify([roundScope,items.map((item,index)=>resolveStudyItemProgressKey(item,index,uiProgress)),sourceItemId]);
          const draftViewId=JSON.stringify([draftItemId,actualPluginType,currentStage,stageRoundBump]);
          const draftFrame={navigationEpoch:-1};
          const draftAdapter=learningDrafts.adapter(draftItemId,actualPluginType+':'+currentStage,itemLabel(currentItem,idx),sourceItemId);
          const roundSnapshot=subjectRounds[subject.id];
          const domain = domainForSubject(subject);
          const itemKind = currentItem.eventKind??(isVocabularySubject(subject) ? 'word' : subject.sourceMode === 'gateway' ? 'due' : itemKindForDomain(domain));
          const round = subjectRounds[subject.id] || emptySubjectRound();
          const itemKeys=items.map((item,index)=>resolveStudyItemProgressKey(item,index,uiProgress));
          const recallPassUsed=Boolean(round.reviewedKeys||round.skippedKeys||round.awaitingReviewKeys);
          const practiced=practicedSubjectKeys(round).filter(key=>itemKeys.includes(key));
          const needsReview=(round.reviewedKeys??[]).filter(key=>itemKeys.includes(key)&&!round.correctKeys.includes(key));
          const skipped=(round.skippedKeys??[]).filter(key=>itemKeys.includes(key));
          const awaiting=(round.awaitingReviewKeys??[]).filter(key=>itemKeys.includes(key));
          const recallNextLabel=pendingSubjectKeys(round,itemKeys).some(key=>key!==itemProgressKey)?'下一题':'结束本轮';
          const continueTodayButton=taskScope?<button type="button" disabled={model.practiceLoading} onClick={()=>void model.continueTodayStudy()}>{model.practiceLoading?'正在读取下一组…':'继续今日自测'}</button>:null;
          const skipRecall=()=>{
            if(learningDrafts.isPending()||draftAdapter.isPending?.()||draftAdapter.hasSavedFeedback?.())return;
            if(visibleLearningRef.current!==draftViewId||taskWorkspaceRef.current!==workspaceId)return;
            const next=skipSubjectRound(round,itemKeys,idx%items.length);
            learningDrafts.clearItem(draftItemId);
            setSubjectRounds(current=>current[subject.id]===roundSnapshot?{...current,[subject.id]:next.round}:current);
            setItemIndices(current=>({...current,[subject.id]:next.nextIndex}));
            if(next.nextIndex===idx%items.length)setStageRoundBump(value=>value+1);
          };
          const nonWordScope=scopeForNonWord(nonWordSourceScope,currentItem,itemProgressKey,roundScope??JSON.stringify([subject.id,itemKeys]),roundScope??JSON.stringify([currentDay,subject.id,itemKeys]));if(nonWordScope){nonWordScope.day=currentDay;nonWordScope.members=nonWordMembers;}
          const nonWordNavigationPorts:Parameters<typeof createNonWordContinuation>[1]={
            canContinue:()=>!learningDrafts.isPending()&&visibleLearningRef.current===draftViewId&&taskWorkspaceRef.current===workspaceId&&getVisibleSubjectRound(subject.id).scope===roundScope,
            canRestore:()=>!learningDrafts.isPending()&&taskWorkspaceRef.current===workspaceId&&getVisibleSubjectRound(subject.id).scope===roundScope,round:()=>getVisibleSubjectRound(subject.id).round??round,clear:()=>learningDrafts.clearItem(draftItemId),
            publish:update=>setSubjectRounds(current=>({...current,[subject.id]:update(current[subject.id]??round)})),select:next=>setItemIndices(current=>({...current,[subject.id]:next})),bump:()=>setStageRoundBump(value=>value+1),
          };
          const navigation=()=>bindNonWordNavigation({itemKeys,index:idx%items.length},nonWordNavigationPorts,()=>setPlanMessage(''));
          const selectQuestion=(index:number)=>createNonWordQuestionSelection({enabled:Boolean(nonWordScope),original:{mode:aiRecommendedPluginType,data:currentItem},itemKeys,current:nonWordNavigationPorts.canContinue,
            begin:()=>++practiceRequest.current,latest:request=>practiceRequest.current===request,round:()=>nonWordRoundFor(nonWordScope!,cursorSeed(nonWordScope!,round,itemProgressKey)),select:index=>setItemIndex(subject.id,index),failure:setPlanMessage})(index);
          const restartRound=()=>{const run=()=>restartSubjectRound(subject.id,itemKeys);void(nonWordScope?restartSavedRound(nonWordRoundFor,nonWordScope,run,()=>setStageRoundBump(value=>value+1)):run()).catch(reason=>setPlanMessage(String(reason)));};
          if(recallPassUsed&&isSubjectPassComplete(round,itemKeys))return <section key={subject.id} className="max-w-6xl mx-auto" aria-label={`${subject.name}本轮回顾`}>
            <div className="caught-up-state" aria-live="polite">
              {isDemoMode&&<DemoModeBadge/>}<h2>本轮练习结束</h2>
              <p>已练 {practiced.length} / {items.length} · 待巩固 {needsReview.length}{awaiting.length?` · 待核对 ${awaiting.length}`:''}{skipped.length?` · 暂时跳过 ${skipped.length}`:''}</p>
              <p className="study-meta">本轮结束不代表全部答对。后续任务与复习安排仍以实际记录为准。</p>
              {model.planMessage&&<p role="status">{model.planMessage}</p>}
              <div>{continueTodayButton}<button type="button" disabled={model.practiceLoading} onClick={()=>navigateToStudyTab('today')}>返回今日</button>
                {awaiting.length>0&&<button type="button" disabled={learningDrafts.isPending()} onClick={()=>void restoreSavedPending(nonWordRoundFor,nonWordScope,()=>restorePendingAnswers(itemKeys,nonWordNavigationPorts)).catch(reason=>setPlanMessage(String(reason)))}>恢复待核对的 {awaiting.length} 份原答案</button>}
                {needsReview.length>0&&<button type="button" disabled={model.practiceLoading} onClick={()=>beginExtraPractice(needsReview)}>只练待巩固的 {needsReview.length} 题</button>}
                {skipped.length>0&&<button type="button" disabled={model.practiceLoading} onClick={()=>beginExtraPractice(skipped)}>查看跳过的 {skipped.length} 题</button>}
                <button type="button" disabled={model.practiceLoading} onClick={()=>beginExtraPractice()}>再巩固一遍</button>
                <details><summary>重新开始正常练习</summary><p>{resetWarning}</p><button type="button" disabled={learningDrafts.isPending()} onClick={()=>{if(window.confirm(resetWarning))restartRound();}}>再学一轮（正常练习）</button></details>
              </div>
            </div>
          </section>;
          // 非词汇保存并继续后标记已练；词汇规则、正式成绩与复习安排保持不变。
          const subjectRoundComplete = isSubjectRoundComplete({
            pluginType: actualPluginType,
            items,
            itemStages: learningStages,
            keyOf: (item, index) => resolveStudyItemProgressKey(item, index, uiProgress),
            round,
          });

          if (subjectRoundComplete && isVocabPaced && !vocabLibraryComplete) {
            const nextPlanned=plannedVocabEntries[plannedVocabEntries.findIndex(item=>item===selectedVocabEntry)+1];
            const nextGroup = vocabServedGroup + 1;
            const hasNextGroup = modulePlan ? Boolean(nextPlanned) : nextGroup < vocabBounds.length;
            return (
              <section key={subject.id} className="max-w-6xl mx-auto" aria-label={`${subject.name}今日词量完成`}>
                <div className="caught-up-state" aria-live="polite">
                  <span className="caught-up-mark">✓</span>
                  <p className="module-eyebrow">VOCABULARY · DAILY GOAL</p>
                  {isDemoMode&&<DemoModeBadge/>}
                  <h2>{(taskPlanningEnabled||Boolean(accountLoaded))?`本次${scopedTask?.category==='review'?'复习':'学习'}的 ${items.length} 个词已完成`:`本组 ${items.length} 个词已完成`}</h2>
                  <p>{(taskPlanningEnabled||Boolean(accountLoaded))?'本组已有完成记录；新词与到期复习的今日计数请查看今日学习。':`第 ${vocabServedGroup + 1} / ${vocabBounds.length} 组全部通过（本次打错/重置 ${round.resets} 次）。词库共 ${allItems.length} 词，已完成 ${allItems.filter((item, index) => vocabCompletedAt(index)).length} 个。`}</p>
                  <div>
                    {continueTodayButton}
                    <button disabled={model.practiceLoading} onClick={() => navigateToStudyTab("today")}>返回今日汇总</button>
                    <button type="button" disabled={model.practiceLoading} onClick={() => beginExtraPractice()}>再巩固一遍</button>
                    {(taskPlanningEnabled||accountLoaded) && modulePlan && <button onClick={()=>{setFreeStudySubject(subject.id);setActiveTaskScope(null);setItemIndices(indices=>({...indices,[subject.id]:0}));}}>切换自由学习</button>}
                    {hasNextGroup && <button onClick={() => modulePlan && nextPlanned ? chooseVisiblePlanEntry(nextPlanned.itemKey) : persistVocabPacing(subject.id,{ settings: { ...vocabPacing.settings, override: nextGroup }, serve: { dayKey: currentDay, group: nextGroup } })}>继续下一组（{nextPlanned ? resolvePlanPractice(nextPlanned,moduleSubjects)?.count : vocabBounds[nextGroup].end - vocabBounds[nextGroup].start} 词）</button>}
                  </div>
                </div>
              </section>
            );
          }

          if (subjectRoundComplete && (!isVocabPaced || vocabLibraryComplete)) {
            return (
              <section key={subject.id} className="max-w-6xl mx-auto" aria-label={`${subject.name}本轮完成`}>
                <div className="caught-up-state" aria-live="polite">
                  <span className="caught-up-mark">✓</span>
                  <p className="module-eyebrow">{modulePresentation(subject).eyebrow} · ROUND COMPLETE</p>
                  {isDemoMode&&<DemoModeBadge/>}
                  <h2>「{subject.name}」本组已完成</h2>
                  <p>{round.correctKeys.length===0&&round.resets===0?`这组 ${items.length} 项内容此前已完成。`:`本组 ${items.length} 项内容已完成。`}</p>
                  <details className="study-guidance-help"><summary>本轮记录与操作说明</summary><p>本轮会话记录到 {round.resets} 次需重练作答；次数不代表掌握度。额外巩固不会改变已有进度或复习安排。</p><StudyGuidanceHelp kind={actualPluginType}/></details>
                  <div>
                    {continueTodayButton}
                    <button disabled={model.practiceLoading} onClick={() => navigateToStudyTab("today")}>返回今日汇总</button>
                    <button type="button" disabled={model.practiceLoading} onClick={() => beginExtraPractice()}>再巩固一遍</button>
                    {round.wrongKeys.length > 0 && <button type="button" onClick={() => beginExtraPractice(round.wrongKeys)}>只重练答错的 {round.wrongKeys.length} 项</button>}
                    <details>
                      <summary>重新开始正常练习</summary>
                      <p>{resetWarning}</p>
                      <button type="button" disabled={learningDrafts.isPending()} data-study-action="restart-round" onClick={() => {
                        if (!window.confirm(resetWarning)) return;
                        restartRound();
                      }}>再学一轮（正常练习）</button>
                      {!nonWordScope&&round.wrongKeys.length > 0 && <button type="button" disabled={learningDrafts.isPending()} data-study-action="restart-wrong-items" onClick={() => {
                        if (!window.confirm(`仅重新开始本轮答错的 ${round.wrongKeys.length} 项。${resetWarning}`)) return;
                        restartSubjectRound(subject.id, round.wrongKeys);
                      }}>重新开始错题（正常练习）</button>}
                    </details>
                  </div>
                </div>
              </section>
            );
          }

          return (
            <StudySessionShell key={subject.id} title={subject.name} assistant={<StudyAITrigger onUnavailable={()=>setAiEntryOpen(true)}/>}
              notice={sourceUpdateNotice(Boolean(accountLoaded),visibleAccountStatus.phase,localSourcePending)}
              scope={isDemoMode?'公开示例 · 不计入个人记录':taskScope?`${scopedTask?.category==='review'?'到期复习':'今日任务'} · 本组 ${items.length} ${isVocabPaced?'词':'题'}`:isVocabPaced?`自由学习 · 第 ${vocabServedGroup+1} / ${vocabBounds.length} 组`:'自由学习'}
              progress={accountLoaded&&!scopedAccountProgress?.historyReady?'进度待核对':`${recallPassUsed||actualPluginType==='recall'?'已练':'已完成'} ${recallPassUsed||actualPluginType==='recall'?practiced.length:isVocabPaced?vocabServedCompletedCount:round.correctKeys.length} / ${items.length}`}
              mode={actualPluginType==='three-stage'?`${['认义','语境','自评'][currentStage-1]} · ${currentStage}/3`:pluginLabels[actualPluginType]}
              onExit={()=>navigateToStudyTab('today')}
              subjects={<StudySubjectMenu subjects={subjects} activeId={subject.id} onChoose={id=>navigateToStudyTab(id)} />}
              source={<StudyItemSource item={currentItem} source={data.source} canOpenLocal={!accountLoaded&&Boolean(companionSession)&&syncState==='connected'} getObsidianUri={getObsidianUri} preferenceScope={JSON.stringify([workspaceId,accountLibraryId??data.localLibraryId??'local'])}/>}
              queue={<div className="word-stage-list">{items.map((item,index)=>{const key=resolveStudyItemProgressKey(item,index,uiProgress),stage=learningStages[key]||0;return <button key={key} type="button" className={index===idx?'active':''} onClick={()=>selectQuestion(index)}><span>{itemLabel(item,index)}</span>{(item.pluginType||item.type||subject.pluginType)==='three-stage'&&<b>{[1,2,3].map(step=><i key={step} className={stage>=step?'done':''}/>)}</b>}</button>;})}</div>}
              options={<>
                <StudyGuidanceHelp kind={actualPluginType}/>
                <section aria-label="本题复习安排"><h3>本题复习安排</h3><ReviewContext temporary={isDemoMode} completedStage={actualPluginType==='three-stage'?completedStage:undefined} category={scopedTask?.category} due={uiProgress.fsrsData?.[itemProgressKey]?.due} recorded={draftAdapter.hasSavedFeedback?.()}/></section>
                {(taskPlanningEnabled||accountLoaded) && <div className="mb-4 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="学习范围">
                  <button className="rounded-lg border border-[var(--line)] px-3 py-2 focus-visible:outline-2" aria-pressed={Boolean(modulePlan)} onClick={()=>navigateToStudyTab('today')}>今日任务</button>
                  <button className="rounded-lg border border-[var(--line)] px-3 py-2 focus-visible:outline-2" aria-pressed={!modulePlan} onClick={()=>{setFreeStudySubject(subject.id);setActiveTaskScope(null);setItemIndices(indices=>({...indices,[subject.id]:0}));}}>自由学习</button>
                  <span className="opacity-60">{taskScope?`${scopedTask?.title??'今日计划'} · 本次 ${items.length} ${isVocabPaced?'词':'题'}`:'可浏览完整词库与资料；不会改变每日20新词目标。'}</span>
                </div>}
                <div className="study-options-section">
                  <div className="flex flex-col gap-4">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-50">学习模式</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        <strong>{pluginLabels[actualPluginType]}</strong>
                        <span className="study-meta">资料默认方式：{pluginLabels[aiRecommendedPluginType]}</span>
                        {actualPluginType !== aiRecommendedPluginType && <span className="text-xs font-bold text-[var(--orange)]">手动模式</span>}
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-bold">
                        <span className="opacity-60">本学科默认</span>
                        <select
                          aria-label={`${subject.name}的默认学习模式`}
                          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)]"
                          value={subjectOverride || ""}
                          onChange={(event) => setSubjectPluginOverride(subject.id, event.target.value)}
                        >
                          <option value="">资料默认方式</option>
                          {compatibleSubjectPlugins.map((type) => <option key={type} value={type}>{pluginLabels[type]}</option>)}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-bold">
                        <span className="opacity-60">本题模式</span>
                        <select
                          aria-label="当前题目的学习模式"
                          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)]"
                          value={itemOverride || ""}
                          onChange={(event) => setItemPluginOverride(overrideKey, event.target.value)}
                        >
                          <option value="">跟随学科默认</option>
                          <option value="ai">仅本题使用 资料默认方式</option>
                          {compatibleItemPlugins.map((type) => <option key={type} value={type}>{pluginLabels[type]}</option>)}
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] opacity-60">
                    <span>切换只改变练习方式，不会清空本题进度；不兼容题目会自动回到 资料默认方式。</span>
                    {itemOverride && itemOverride !== "ai" && <button className="font-black underline underline-offset-4" onClick={() => setItemPluginOverride(overrideKey, "ai")}>本题恢复资料默认方式</button>}
                  </div>
                  {isVocabPaced && (taskScope && modulePlan ? <div className="mt-3 text-sm font-bold"><span>今日任务 · {scopedTask?.category==='review'?'复习':'新学'} · 本次 {items.length} 词（已完成 {vocabServedCompletedCount}）</span>{plannedVocabEntries.length>1&&<label className="mt-2 flex items-center gap-2">切换任务<select aria-label="计划词汇任务" value={selectedVocabEntry?.itemKey??''} onChange={event=>chooseVisiblePlanEntry(event.target.value)} className="min-h-11 min-w-0 max-w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2">{plannedVocabEntries.map(entry=><option key={entry.itemKey} value={entry.itemKey}>{entry.title} · {entry.practice?.count} 词</option>)}</select></label>}</div> :
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[var(--line)] bg-[rgba(0,0,0,0.02)] dark:bg-[rgba(255,255,255,0.02)] px-4 py-2.5 text-xs font-bold text-[var(--ink)] opacity-80">
                      <span>词库分组：第 {vocabServedGroup + 1} / {vocabBounds.length} 组 · 本次 {items.length} 词（已完成 {vocabServedCompletedCount}）</span>
                      <label className="flex items-center gap-1.5">
                        {(taskPlanningEnabled||Boolean(accountLoaded))?'分组大小':'每日词量'}
                        <select
                          aria-label="每日词量"
                          disabled={vocabPacingWorkspace !== workspaceId}
                          title={effectivePlan ? '当前计划的词条不变；新词量在下次生成计划时生效。' : undefined}
                          value={vocabPacing.settings.quota === allItems.length ? "all" : String(vocabPacing.settings.quota)}
                          onChange={(event) => {
                            const quota = event.target.value === "all" ? allItems.length : Number(event.target.value);
                            persistVocabPacing(subject.id,{ settings: { quota, override: null }, serve: effectivePlan ? vocabPacing.serve : { dayKey: currentDay, group: 0 } });
                          }}
                          className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-1 outline-none focus:border-[var(--ink)]"
                        >
                          {vocabQuotaOptions(vocabPacing.settings.quota).map(quota=><option key={quota} value={quota}>{quota}</option>)}
                          <option value="all">全部（{allItems.length}）</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5">
                        组别
                        <select
                          aria-label="词库组别"
                          disabled={vocabPacingWorkspace !== workspaceId}
                          value={effectivePlan ? selectedVocabEntry?.itemKey ?? '' : vocabPacing.settings.override ?? vocabServedGroup}
                          onChange={(event) => {
                            if(effectivePlan) {choosePlanVocabEntry(event.target.value); return;}
                            const value = event.target.value;
                            const override = value === "auto" ? null : Number(value);
                            const group = override ?? vocabServedGroup;
                            persistVocabPacing(subject.id,{ settings: { ...vocabPacing.settings, override }, serve: { dayKey: currentDay, group } });
                          }}
                          className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-1 outline-none focus:border-[var(--ink)]"
                        >
                          {!effectivePlan && <option value="auto">自动推进</option>}
                          {effectivePlan ? plannedVocabEntries.map(entry => {
                            const groupIndex = inputPoolPractice(entry.itemKey)?.groupIndex;
                            return <option key={entry.itemKey} value={entry.itemKey}>{groupIndex === undefined ? '复习词条（计划内）' : `第 ${groupIndex + 1} 组（计划内）`}</option>;
                          }) : vocabBounds.map((_, group) => <option key={group} value={group}>第 {group + 1} 组</option>)}
                        </select>
                      </label>
                    </div>
                  )}
                </div>
              </>}
            >
                <LearningDraftBoundary key={JSON.stringify([learningDrafts.scopeKey,draftItemId,learningDrafts.getItemVersion(draftItemId)])} store={learningDrafts} interactiveWhileGrading={actualPluginType==='recall'} onVisibility={visible=>{if(visible){draftFrame.navigationEpoch=practiceRequest.current;visibleLearningRef.current=draftViewId;}else if(visibleLearningRef.current===draftViewId)visibleLearningRef.current=null;}}>
                <NonWordPluginHost plugin={Plugin} round={nonWordScope?()=>nonWordRoundFor(nonWordScope,cursorSeed(nonWordScope,round,itemProgressKey)):undefined}
                   key={`${subject.id}:${itemProgressKey}:${actualPluginType}:${currentStage}:${stageRoundBump}`}
                   data={{
                     ...pluginData,
                     stage: currentStage,
                     dashboard: data.dashboard
                   }}
                   context={{
                     nonWordScope,
                     nonWordNavigation:{continuePending:()=>navigation().continuePending(),resumeFormal:rating=>navigation().resumeFormal(rating),restoreRound:state=>navigation().restoreRound(state)},
                     guidanceScope:workspaceId,guidanceInOptions:true,
                     contentNavigation:{onSkip:skipRecall},
                     contentSource:{mode:aiRecommendedPluginType,data:currentItem},
                     recallNavigation:actualPluginType==='recall'?{continueLabel:recallNextLabel,onSkip:skipRecall}:undefined,
                     aiItem:{id:JSON.stringify([currentItem.contentHash??`${normalizedSubjects.indexOf(subject)}:${idx}`,actualPluginType,currentStage]),title:subject.name,question:typeof pluginData?.prompt==='string'?pluginData.prompt:typeof currentItem.word==='string'?currentItem.word:subject.name},
                     draft:draftAdapter,paperServices,
                     recallPersistenceRequired:!isDemoMode,
                     recallScope:!isDemoMode&&currentItem.contentHash&&(accountLibraryId||data.localLibraryId)?{workspaceId,libraryId:accountLibraryId??data.localLibraryId!,itemKey:stableStudyItemKey(currentItem)??itemProgressKey,contentHash:currentItem.contentHash}:undefined,
                     ...subjectLearningServices({account:Boolean(accountLoaded),item:currentItem,run:runAccountQuestionAi,evaluate:(work,signal)=>learningDrafts.grade(work,signal),companion:companionPlanClient,calculation:gradeAccountCalculation,hint:requestAiHint,tutor:requestAiTutor}),
                   }}
                   onGrade={(rating,options)=>createSubjectGradeHandler({mode:actualPluginType,completedStage,isDemoMode,draft:draftAdapter},{
                     drafts:learningDrafts,modeEpoch:()=>accountModeEpoch.current,
                     ownerCurrent:gradeModeEpoch=>taskWorkspaceRef.current===workspaceId&&activeLearningDraftsRef.current===learningDrafts&&accountModeEpoch.current===gradeModeEpoch,
                     canPresent:explicitContinue=>visibleLearningRef.current===draftViewId&&(explicitContinue||practiceRequest.current===draftFrame.navigationEpoch),
                     prepare(request,rating){
                       const evidence=prepareAttemptEvidence({rating,mode:actualPluginType,recallConfigured:currentItem.learningSupport?.type==='recall',original:currentItem},draftAdapter);
                       const isCorrect=evidence.rating==='good'||evidence.rating==='easy';
                       const wordTransition=actualPluginType==='three-stage'?reviewSubmission({completedStage,correct:isCorrect,quick:quickReview}):null;
                       const nextStage=wordTransition?.stageAfter??(isCorrect?3:0);
                       const input:StudyAttemptInput={
                         identity:request.identity,workspaceId,domain,
                         item:{kind:itemKind,key:itemProgressKey,...(currentItem.stateHandle===undefined?{}:{stateHandle:currentItem.stateHandle})},
                         rating:evidence.rating,correct:isCorrect,stageBefore:wordTransition?.stageBefore??completedStage,stageAfter:nextStage,
                         reviewedAt:request.identity.reviewedAt,isThreeStage:wordTransition?.isThreeStage??false,currentFsrs:uiProgress.fsrsData?.[itemProgressKey],
                         localContext:{
                           title:`${isCorrect?'完成':'需要复习'}：${itemLabel(currentItem,idx)}`,
                           activityType:'website-practice',durationMin:actualPluginType==='code'?5:2,
                           weakPoints:isCorrect?[]:[itemLabel(currentItem,idx)],
                           sourceNote: markdownNotePath(currentItem.sourceNote) || markdownNotePath(data.source.path),
                           stateRef: markdownNotePath(currentItem.stateRef),
                           abilityId: resolveEventAbilityId(currentItem, idx, uiProgress),
                         },
                         delivery:{cloud:accountLoaded||sessionUser&&cloudSyncMetadata.decision==='enabled'?'pending':'not-required',companion:accountLoaded?'not-required':'pending'},
                       };
                       return {input,frame:captureAttemptFrame(currentItem,wordTransition?.practiceMode??actualPluginType,wordTransition?.stageBefore??completedStage),
                         observation:evidence.observation,isCorrect,nextStage,wordTransition};
                     },
                     advance(command){
                       // Formal evidence stays fixed; return/continue uses the latest page traversal.
                       const currentRound=getVisibleSubjectRound(subject.id);if(currentRound.scope!==roundScope)return false;
                       const latestRound=currentRound.round??round;
                       const threeStageTransition=actualPluginType==='three-stage'?advanceThreeStageSession({currentIndex:idx%items.length,stages:items.map((item,index)=>{
                         const key=resolveStudyItemProgressKey(item,index,uiProgress);
                         return latestRound.correctKeys.includes(key)?3:index===idx%items.length&&quickReview?2:learningStages[key]||0;
                       }),correct:command.isCorrect}):null;
                       const traversal={itemKeys:items.map((item,index)=>resolveStudyItemProgressKey(item,index,uiProgress)),currentIndex:idx%items.length,correct:command.isCorrect,completeItem:threeStageTransition?command.nextStage>=3:command.isCorrect,completeAfterAttempt:actualPluginType==='recall'||completesSubjectItemAfterAttempt(currentItem,subject)};
                       const roundResult=advanceSubjectRound({...traversal,round:latestRound});
                       setSubjectRounds(current=>({...current,[subject.id]:advanceSubjectRound({...traversal,round:current[subject.id]??round}).round}));
                       const nextIndex=command.wordTransition?.repeatCurrent?idx%items.length:threeStageTransition?.nextIndex??roundResult.nextIndex;
                       if(nextIndex===idx%items.length)setStageRoundBump(bump=>bump+1);
                       setItemIndices(current=>({...current,[subject.id]:nextIndex}));
                       return true;
                     },
                     publishDemo(command){
                       setDemoProgress(current=>({...current,itemStages:{...current.itemStages,[itemProgressKey]:command.nextStage},answered:current.answered+1,correct:current.correct+(command.isCorrect?1:0)}));
                     },
                     record:recordStudyAttempt,
                     persist:async(record,frame,observation)=>{eventMutation.current++;return persistSubmittedEvent(record,frame,observation);},
                     publishEvent(record){noteEventsChanged();setProgressEvents(current=>[...current.filter(event=>event.eventId!==record.eventId),record.event]);},
                     publishProgress(command,{event,clientStateAfter}){
                         const update=(current:Progress):Progress=>({...current,itemStages:{...current.itemStages,[itemProgressKey]:command.nextStage},fsrsData:clientStateAfter?{...(current.fsrsData||{}),[itemProgressKey]:clientStateAfter}:current.fsrsData,answered:current.answered+1,correct:current.correct+(command.isCorrect?1:0)});
                         if(accountLoaded)setAccountProgress(current=>current?.workspaceId===workspaceId&&current.libraryId===accountLoaded.bundle.snapshot.libraryId?{...current,progress:update(current.progress)}:current);
                         else{setProgress(update);setNativeProjection(current=>applySavedNativeAttempt(current,{workspaceId,sourceScope:nativeScope},event,clientStateAfter));}
                     },
                     sendCloud:sendSubmittedCloud,sendCompanion:sendSubmittedCompanion,updateDelivery:updateStudyEventDelivery,
                     setMessage:setPlanMessage,invalidateView:()=>setStageRoundBump(bump=>bump+1),
                   })(rating,options)}
                />
                </LearningDraftBoundary>
                {auxiliaryDelivery?.workspaceId===workspaceId&&<StudySaveStatus state={strongerAuxiliaryDelivery(auxiliaryDelivery.state,assistanceHistory.entries.find(entry=>entry.eventId===auxiliaryDelivery.eventId)?.state)}/>}
            </StudySessionShell>
          );
        })}</>;
}
