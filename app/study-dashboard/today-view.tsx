"use client";
import {DemoModeBadge} from "../demo-mode-badge";
import {GeneratedPlanStart} from "../generated-plan-start";
import {StudyTermHelp} from "../study-term-help";
import {useCallback} from 'react';
import { AccountStudyPlan } from "../account-study-controls";
import { accountStudyPayload } from "../account-study-payload";
import { AccountReadNoticeSlot } from "../account-study-status";
import {
type ConstraintMode,
type PracticeItem
} from "../companion-plan-client";
import { DashboardFocusHero } from "../dashboard-focus-hero";
import {
modulePresentation,
resolveStudyItemProgressKey,
stableStudyItemKey
} from "../dynamic-ui-model";
import { LearningLibrary } from "../learning-library";
import { planDiff } from "../plan-diff";
import { isDemoPlanEntryDone,isPlanEntryDone } from "../plan-runtime";
import { PaperWorkshopLauncher } from "../paper-workshop-launcher";
import {createLazyComponent} from '../plugins/lazy-plugin';
import { StudyEmptyPlanIcon,StudyIcon,StudyTodayLayout } from "../study-session-shell";
import { emptySubjectRound,isSubjectRoundComplete } from "../subject-round";
import { TodayLearning,nativePlanDraftActions } from "../today-learning";
import { StudyPayload } from "./prelude";
import type { DashboardController } from './use-dashboard-controller';
import {inlineNonWordScope,inlinePracticeGroup} from './nonword-scopes';
const PracticeSession=createLazyComponent<Parameters<typeof import('../practice-session').PracticeSession>[0]>(async()=>({default:(await import('../practice-session')).PracticeSession}),'复习练习');
type Props={model:Pick<DashboardController,"accountAiEntryOwner"|"accountAttemptActiveRef"|"accountClient"|"accountDailyPlan"|"accountLibraryId"|"accountLoaded"|"accountLoadedRef"|"accountOptedOut"|"accountPendingLoadedRef"|"accountWorkspaceId"|"activeProject"|"activeTaskScope"|"allItems"|"allSubjectsComplete"|"applyAccountLoaded"|"applyLocalStudySource"|"approveTodayPlan"|"choosePlanVocabEntry"|"companionPlanClient"|"companionSession"|"completeAccountTask"|"completedItems"|"completion"|"constraintAuthority"|"constraintMode"|"currentDay"|"data"|"effectivePlan"|"eventRevision"|"focusDetail"|"focusPath"|"focusTitle"|"generateTodayPlan"|"getObsidianUri"|"gradeAccountCalculation"|"inputPoolPractice"|"isDemoMode"|"lastStudyReceipts"|"learningDrafts"|"legacyPlanningVisibility"|"navigateToStudyTab"|"normalizedSubjects"|"noteEventsChanged"|"openLongTermFromToday"|"openSources"|"paperLibraryScope"|"paperServices"|"pendingActivities"|"pendingLocalSourceRef"|"planApproved"|"planCandidate"|"planCurrent"|"planDeadlineDraft"|"planHistory"|"planLoading"|"planMessage"|"planMode"|"planRevision"|"planSettings"|"practiceItems"|"practiceLoading"|"practiceSessionKey"|"practiceSummary"|"primarySubject"|"progressEvents"|"readAccountAgain"|"recordPracticeAttempt"|"rejectTodayPlan"|"removePlanEntry"|"requestAiHint"|"requestAiTutor"|"restorePlanRevision"|"runAccountQuestionAi"|"savePlanSettings"|"sessionUser"|"setAccountAiEntryOwner"|"setConstraintMode"|"setData"|"setPlanDeadlineDraft"|"setPlanMessage"|"setPlanMode"|"setPlanSettings"|"setPracticeItems"|"setPracticeSummary"|"setTab"|"setTemporaryUntil"|"startAccountLearning"|"startPlannedQuestionPractice"|"startPractice"|"startTaskLearning"|"storageReady"|"subjectRounds"|"subjects"|"syncState"|"tab"|"taskLearning"|"taskPlanningEnabled"|"temporaryUntil"|"uiProgress"|"useCaughtUpPage"|"visibleAccountStatus"|"vocabPacingWorkspace"|"workspaceId"|"studyTaskNavigation">};
export function TodayView({model}:Props){
 const focusPracticeSurface=useCallback((node:HTMLElement|null)=>{
   if(!node||document.querySelector('dialog[open],.study-ai-panel:not([hidden])')||document.activeElement?.closest('input,textarea,select,[contenteditable]'))return;
   node.focus({preventScroll:true});node.scrollIntoView({block:'start',behavior:'instant'});
 },[]);
 const {
  accountAiEntryOwner,
  accountAttemptActiveRef,
  accountClient,
  accountDailyPlan,
  accountLibraryId,
  accountLoaded,
  accountLoadedRef,
  accountOptedOut,
  accountPendingLoadedRef,
  accountWorkspaceId,
  activeProject,
  activeTaskScope,
  allItems,
  allSubjectsComplete,
  applyAccountLoaded,
  applyLocalStudySource,
  approveTodayPlan,
  choosePlanVocabEntry,
  companionPlanClient,
  companionSession,
  completeAccountTask,
  completedItems,
  completion,
  constraintAuthority,
  constraintMode,
  currentDay,
  data,
  effectivePlan,
  eventRevision,
  focusDetail,
  focusPath,
  focusTitle,
  generateTodayPlan,
  getObsidianUri,
  gradeAccountCalculation,
  inputPoolPractice,
  isDemoMode,
  lastStudyReceipts,
  learningDrafts,
  legacyPlanningVisibility,
  navigateToStudyTab,
  normalizedSubjects,
  noteEventsChanged,
  openLongTermFromToday,
  openSources,
  paperLibraryScope,
  paperServices,
  pendingActivities,
  pendingLocalSourceRef,
  planApproved,
  planCandidate,
  planCurrent,
  planDeadlineDraft,
  planHistory,
  planLoading,
  planMessage,
  planMode,
  planRevision,
  planSettings,
  practiceItems,
  practiceLoading,
  practiceSessionKey,
  practiceSummary,
  primarySubject,
  progressEvents,
  readAccountAgain,
  recordPracticeAttempt,
  rejectTodayPlan,
  removePlanEntry,
  requestAiHint,
  requestAiTutor,
  restorePlanRevision,
  runAccountQuestionAi,
  savePlanSettings,
  sessionUser,
  setAccountAiEntryOwner,
  setConstraintMode,
  setData,
  setPlanDeadlineDraft,
  setPlanMessage,
  setPlanMode,
  setPlanSettings,
  setPracticeItems,
  setPracticeSummary,
  setTab,
  setTemporaryUntil,
  startAccountLearning,
  startPlannedQuestionPractice,
  startPractice,
  startTaskLearning,
  storageReady,
  subjectRounds,
  subjects,
  syncState,
  tab,
  taskLearning,
  taskPlanningEnabled,
  temporaryUntil,
  uiProgress,
  useCaughtUpPage,
  visibleAccountStatus,
  vocabPacingWorkspace,
  workspaceId,
 }=model;
 return <>{tab === "today" && (useCaughtUpPage ? <section className="caught-up-state max-w-6xl mx-auto" aria-live="polite">
          <span className="caught-up-mark">✓</span>
          <p className="module-eyebrow">TODAY · ALL CLEAR</p>
          <h2>今天的学习任务已完成</h2>
          <p>当前资料里没有待练内容。历史进度仍然保留，你也可以连接新的学习资料。</p>
          <div><button onClick={() => setTab("progress")}>查看学习进度</button><button onClick={() => openSources("sources")}>管理资料来源</button></div>
        </section> : <StudyTodayLayout
            plan={<>
              {accountLoaded&&accountWorkspaceId&&<div className="col-span-1 lg:col-span-2"><AccountStudyPlan {...model.studyTaskNavigation} studyFirst onLongTerm={openLongTermFromToday} activePractice={practiceItems!==null} initialSection={accountAiEntryOwner===accountWorkspaceId?'ai':undefined} onCloseEditor={()=>setAccountAiEntryOwner(null)} key={accountWorkspaceId} localRevision={eventRevision} state={accountDailyPlan.state} refreshPlanState={accountDailyPlan.refresh} planError={accountDailyPlan.error} client={accountClient} loaded={accountLoaded} day={currentDay} workspaceId={accountWorkspaceId} onStart={startAccountLearning} onComplete={completeAccountTask}/></div>}
              {planMessage && <p role="status" className="text-sm text-[var(--orange)]">{planMessage}</p>}
              <div className="col-span-1 lg:col-span-2 flex flex-col gap-8" aria-label="今日计划与复习">
          {legacyPlanningVisibility.warning && <p className="text-sm border-l-2 border-[var(--orange)] pl-3" role="status">当前 Companion 尚未支持任务型今日学习，请更新并重启；下方暂时显示旧版兼容计划。</p>}
          {accountLoaded ? null : taskPlanningEnabled ? <TodayLearning {...model.studyTaskNavigation} studyFirst onLongTerm={openLongTermFromToday} activePractice={practiceItems!==null}
            plan={taskLearning.state?.draft?.plan??null} catalog={taskLearning.state?.catalog??null}
            summary={taskLearning.state?.summary??{newDone:0,newTarget:20,newMissing:0,reviewDone:0,reviewTotal:0}}
            completedTaskIds={taskLearning.state?.completedTaskIds??[]} dirty={taskLearning.state?.draft?.dirty??false}
            reviewRounds={taskLearning.state?.reviewRounds??[]}
            loading={Boolean(taskLearning.state?.loading || taskLearning.state?.busy || practiceLoading)} ready={taskLearning.state?.ready??false}
            offline={taskLearning.state?.offline} hasVerifiedHistory={Boolean(taskLearning.state?.lastSyncedAt)}
            minimumSpec={taskLearning.state?.minimumSpec} hasBackup={Boolean(taskLearning.state?.lastBackup)}
            onRestoreBackup={()=>{void taskLearning.session?.restoreLastBackup().catch(()=>{});}}
            message={[taskLearning.state?.message,taskLearning.state?.error,planMessage].filter(Boolean).join(' ')} lastSyncedAt={taskLearning.state?.lastSyncedAt} pendingCount={taskLearning.state?.pendingCount}
            {...nativePlanDraftActions(taskLearning.session,()=>setPlanMessage(''))}
            onStart={(taskId,eligibleTaskIds)=>void startTaskLearning(taskId,eligibleTaskIds)}

            onSuggest={intent=>{setPlanMessage('');void taskLearning.session?.suggest(intent).catch(()=>{});}}
            onSave={()=>{setPlanMessage('');void taskLearning.session?.save().catch(()=>{});}}
            onComplete={taskId=>{void taskLearning.session?.complete(taskId).then(()=>taskLearning.session?.refresh(false)).catch(()=>{});}}
            onOptionalMinutes={minutes=>{void taskLearning.session?.optionalMinutes(minutes).catch(()=>{});}}
          /> : <section data-empty={!effectivePlan||undefined} data-plan-hash={effectivePlan?.planHash} className="c-legacy-plan-board p-8 bg-white dark:bg-zinc-900 border border-[var(--line)] rounded-3xl shadow-sm">
            <GeneratedPlanStart key={JSON.stringify([workspaceId,accountLibraryId??data.localLibraryId??null,currentDay])} scope={JSON.stringify([workspaceId,accountLibraryId??data.localLibraryId??null,currentDay])} hash={effectivePlan?.planHash} visible={tab==='today'&&practiceItems===null} disabled={planLoading||!storageReady||vocabPacingWorkspace!==workspaceId||subjects.length===0} generate={generateTodayPlan} onStart={()=>{
              const entry=effectivePlan?.items.find(candidate=>!(isDemoMode?isDemoPlanEntryDone(candidate,normalizedSubjects,uiProgress,data.practiceItems??[]):isPlanEntryDone(candidate,normalizedSubjects,uiProgress,progressEvents,currentDay))&&['question','vocab-group'].includes(inputPoolPractice(candidate.itemKey)?.kind??''));
              if(!entry){setPlanMessage('这份安排暂时没有可进入的练习，请查看任务或资料提示。');return;}
              if(inputPoolPractice(entry.itemKey)?.kind==='question')void startPlannedQuestionPractice(entry.itemKey);else choosePlanVocabEntry(entry.itemKey);
            }}/>
            {/* Starting the first unfinished entry is the primary action of the day; approving and
                writing back to Obsidian is an advanced step and now reads as a secondary control. */}
            {effectivePlan&&(()=>{
              const pending=effectivePlan.items.filter(entry=>!(isDemoMode?isDemoPlanEntryDone(entry,normalizedSubjects,uiProgress,data.practiceItems??[]):isPlanEntryDone(entry,normalizedSubjects,uiProgress,progressEvents,currentDay)));
              const leadEntry=pending.find(entry=>{const practice=inputPoolPractice(entry.itemKey);return practice?.kind==='question'||practice?.kind==='vocab-group';})??null;
              const leadPractice=leadEntry?inputPoolPractice(leadEntry.itemKey):undefined;
              const isVocabLead=leadPractice?.kind==='vocab-group';
              const leadTitle=leadEntry?(isVocabLead?`背词 · 本组 ${leadPractice?.count||''} 词`:`${leadEntry.title||leadEntry.itemKey}`):null;
              const leadMinutes=typeof leadEntry?.estimatedMinutes==='number'&&Number.isFinite(leadEntry.estimatedMinutes)&&leadEntry.estimatedMinutes>=0?leadEntry.estimatedMinutes:null;
              const remainingMinutes=pending.every(entry=>Number.isFinite(entry.estimatedMinutes)&&entry.estimatedMinutes>=0)?pending.reduce((sum,entry)=>sum+entry.estimatedMinutes,0):null;
              const summary={groups:pending.length,minutes:remainingMinutes,leadMinutes,blocked:pending.filter(entry=>!inputPoolPractice(entry.itemKey)).length};
              return <DashboardFocusHero summary={summary} lead={leadEntry?{taskId:leadEntry.itemKey,title:leadTitle??leadEntry.itemKey,kind:'next' as const}:null} disabled={practiceLoading||!leadEntry} keyboardEnabled={practiceItems===null} onStart={()=>{if(!leadEntry)return;if(leadPractice?.kind==='question')void startPlannedQuestionPractice(leadEntry.itemKey);else choosePlanVocabEntry(leadEntry.itemKey);}} onAdvanced={()=>document.getElementById('today-plan-entries')?.scrollIntoView({block:'start'})}/>;
            })()}
            <div className="c-legacy-plan-header flex flex-col sm:flex-row sm:justify-between items-start gap-6 mb-4">
              {!effectivePlan&&<StudyEmptyPlanIcon/>}
              <div>
                {effectivePlan&&<p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-2">今日计划</p>}
                <h3 className="font-serif text-2xl tracking-tight text-[var(--ink)] mb-2">
                  {planApproved ? `今日计划已批准（修订版本 ${planApproved.revision}）` : effectivePlan ? `今日计划候选（${effectivePlan.totalMinutes} 分钟）` : "今天还没生成计划"}
                </h3>
                {!effectivePlan&&<p className="c-legacy-empty-copy">点击“开始今日练习”后按当前材料安排并进入第一组；不会自动批准或写回笔记。也可先自由学习。</p>}
                {effectivePlan && subjects.length===0 && <p className="text-sm text-[var(--orange)]">今日计划没有可匹配的学习内容；请同步资料或重新生成计划。未自动加载计划外内容。</p>}
                {effectivePlan&&<p className="text-sm text-[var(--ink)] opacity-60 leading-relaxed max-w-2xl">
                  计划决定今天学什么：条目可直达对应练习，完成后自动勾掉；没完成的明天自动滚入。批准后写入 Obsidian 主计划中由知学维护的部分。<StudyTermHelp term="managed"/>
                </p>}
              </div>
              <details className="c-legacy-plan-options"><summary>计划生成与写回选项</summary><div className="c-legacy-plan-actions shrink-0 w-full sm:w-auto flex flex-col sm:flex-row gap-3">
                <details className="c-legacy-generation-options"><summary aria-label="生成选项"><StudyIcon name="options"/></summary><div className="c-legacy-generation-popover"><label className="flex items-center gap-1.5 text-xs font-bold">
                  <span className="opacity-60">生成方式</span>
                  <select
                    aria-label="计划生成方式"
                    value={planMode}
                    onChange={(event) => setPlanMode(event.target.value === "ai" ? "ai" : "deterministic")}
                    className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-2 outline-none focus:border-[var(--ink)]"
                  >
                    <option value="deterministic">按规则安排</option>
                    <option value="ai">AI 编排</option>
                  </select>
                </label></div></details>
                <button className={`c-legacy-generate px-5 py-2.5 rounded-2xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)] text-[var(--ink)] font-bold text-sm hover:bg-[rgba(0,0,0,0.1)] dark:hover:bg-[rgba(255,255,255,0.14)] active:scale-95 transition-all disabled:opacity-50 ${effectivePlan?'c-legacy-generate-secondary':''}`} onClick={async event=>{
                  const trigger=event.currentTarget,board=trigger.closest<HTMLElement>('.c-legacy-plan-board'),hash=await generateTodayPlan();
                  if(hash)requestAnimationFrame(()=>{if(document.activeElement===trigger&&board?.isConnected&&board.dataset.planHash===hash)board.querySelector<HTMLButtonElement>('.study-primary-action:not(:disabled)')?.focus();});
                }} disabled={planLoading || !storageReady || vocabPacingWorkspace !== workspaceId}>{planLoading ? "生成中…" : planCandidate ? "重新生成" : "生成计划"}</button>
                {!effectivePlan&&<a className="c-free-study-link" href="#study-subjects">自由学习</a>}
                {planCandidate?.day === currentDay && !planApproved && <>
                  <button className="px-5 py-2.5 rounded-xl border border-[var(--line)] text-[var(--ink)] font-bold text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 active:scale-[0.98] transition-all" disabled={planLoading} onClick={() => void rejectTodayPlan()}>拒绝</button>
                  <button className="px-5 py-2.5 rounded-xl border border-[var(--line)] text-[var(--ink)] font-bold text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 active:scale-[0.98] transition-all disabled:opacity-50" disabled={planLoading||!companionPlanClient||syncState==='offline'} title={!companionPlanClient?'连接 Companion 后可写回 Obsidian':syncState==='offline'?'Companion 当前离线，恢复后可写回 Obsidian':'批准后写入主计划中由知学维护的部分，请先核对计划内容'} onClick={() => void approveTodayPlan()}>批准并写回</button>
                </>}
              </div></details>
            </div>
            {effectivePlan && <ul id="today-plan-entries" className="flex flex-col gap-2" aria-label="今日计划条目">
              {effectivePlan.items.map((item) => {
                const practice = inputPoolPractice(item.itemKey);
                const isVocabGroup = practice?.kind === "vocab-group";
                const entrySubjectName = normalizedSubjects.find(subject=>subject.id===practice?.subjectId)?.name;
                // 完成判定：背词组=组内词全部阶段 3；题目条目=该题已有作答记录。
                const entryDone = isDemoMode?isDemoPlanEntryDone(item,normalizedSubjects,uiProgress,data.practiceItems??[]):isPlanEntryDone(item,normalizedSubjects,uiProgress,progressEvents,currentDay);
                const fallbackTitle = item.title || item.itemKey.split(":").slice(1).join(":") || item.itemKey;
                const label = isVocabGroup
                  ? `背词 · 本组 ${practice?.count || ""} 词`
                  : item.itemKey.startsWith("topic:")
                    ? `题目 · ${fallbackTitle}`
                    : `复习 · ${fallbackTitle}`;
                return (
                  <li key={`${item.kind}:${item.itemKey}`} className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 ${entryDone ? "border-[var(--lime)] bg-[var(--lime)]/10" : "border-[var(--line)]"}`}>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)]">
                      {entryDone ? "✓ 已完成" : isVocabGroup ? "背词组" : item.kind === "overdue" ? "逾期复习" : item.kind === "review" ? "到期复习" : "练习"}
                    </span>
                    {practice?.carriedFromPreviousDay && !entryDone && <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-[var(--orange)]/15 text-[var(--orange)]">昨日滚入</span>}
                    <strong className={`font-bold break-all ${entryDone ? "line-through opacity-60" : ""}`}>{label}</strong>
                    {entrySubjectName && <span className="text-xs font-medium opacity-70">{entrySubjectName}{isVocabGroup && practice?.groupIndex !== undefined ? ` · 第 ${practice.groupIndex + 1} 组` : ''}</span>}
                    <span className="opacity-60 text-xs">{item.estimatedMinutes} 分钟 · {item.reasons.join("；")}</span>
                    <span className="ml-auto flex items-center gap-2">
                      {!planApproved && (
                        <button
                          aria-label="删除该条目"
                          title="从候选中移除"
                          className="w-7 h-7 grid place-items-center rounded-lg border border-[var(--line)] text-sm opacity-50 hover:opacity-100 hover:text-[var(--orange)] transition-all"
                          disabled={planLoading}
                          onClick={() => void removePlanEntry(item.itemKey)}
                        >
                          ×
                        </button>
                      )}
                      {isVocabGroup ? (
                        <button className="px-4 py-2 rounded-xl bg-[var(--lime)] text-[var(--lime-dark)] font-black text-sm hover:brightness-110 active:scale-95 transition-all" onClick={() => choosePlanVocabEntry(item.itemKey)}>去背词 →</button>
                      ) : practice?.kind === "question" ? (
                        <button className="px-4 py-2 rounded-xl bg-[var(--lime)] text-[var(--lime-dark)] font-black text-sm hover:brightness-110 active:scale-95 transition-all disabled:opacity-50" onClick={() => void startPlannedQuestionPractice(item.itemKey)} disabled={practiceLoading}>{practiceLoading ? "加载中…" : "去做题 →"}</button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
              {effectivePlan.skipped.map((item) => (
                <li key={`skipped:${item.itemKey}`} className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--line)] px-4 py-3 opacity-50">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)]">跳过</span>
                  <strong className="font-bold break-all">{item.itemKey}</strong>
                  <span className="opacity-60 text-xs">{item.reason}</span>
                </li>
              ))}
            </ul>}
            {effectivePlan?.overloaded && <p className="mt-3 text-xs font-bold text-[var(--orange)]">计划超出当日负荷：到期复习已保留，学习项被跳过。</p>}
            {planCandidate && planCurrent && (() => {
              const diff = planDiff(planCandidate, planCurrent);
              if (diff.added.length === 0 && diff.removed.length === 0) return null;
              return (
                <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[rgba(0,0,0,0.03)] dark:bg-[rgba(255,255,255,0.04)] p-4 text-sm">
                  <p className="text-[10px] font-black uppercase tracking-widest opacity-40 mb-2">与已批准计划的差异</p>
                  {diff.added.length > 0 && <p className="font-bold text-[var(--lime-dark)]">+ 新增：{diff.added.map((item) => item.itemKey).join("、")}</p>}
                  {diff.removed.length > 0 && <p className="font-bold text-[var(--orange)]">− 移除：{diff.removed.map((item) => item.itemKey).join("、")}</p>}
                </div>
              );
            })()}
            {effectivePlan && <details className="study-plan-identifier"><summary>计划标识（排错用）</summary><p>需要排查计划版本时，可核对这个标识。</p><code>{effectivePlan.planHash}</code></details>}
            {planHistory.length > 0 && <details className="mt-5 border-t border-[var(--line)] pt-4">
              <summary className="cursor-pointer text-xs font-black uppercase tracking-widest opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lime-dark)]">修订历史 · 当前版本 {planRevision}</summary>
              <ul className="mt-3 flex flex-col gap-2">
                {planHistory.slice().reverse().slice(0, 8).map((entry) => (
                  <li key={`${entry.sequence ?? entry.appliedAt}:${entry.revision}:${entry.inputHash}`} className="flex flex-wrap items-center gap-3 border border-[var(--line)] rounded-xl px-3 py-2 text-xs">
                    <strong>修订版本 {entry.revision}</strong>
                    <span className="opacity-60">{entry.decision === "rejected" ? "已拒绝候选" : entry.decision === "restored" ? `恢复自 ${entry.undoTarget}` : "已批准"}</span>
                    {entry.reason && <span className="opacity-60">{entry.reason}</span>}
                    {entry.decision !== "rejected" && entry.revision < planRevision && <button className="ml-auto font-bold underline underline-offset-4 focus-visible:ring-2" onClick={() => void restorePlanRevision(entry.revision)}>恢复此版</button>}
                  </li>
                ))}
              </ul>
            </details>}
          </section>}

          {practiceItems !== null && (
            <section key={practiceSessionKey} ref={focusPracticeSurface} tabIndex={-1} aria-label="当前复习" className="c-inline-practice-surface">
            <PracticeSession
              key={practiceSessionKey}
              items={practiceItems}
              groupFor={item=>inlinePracticeGroup(model,item)}
              drafts={learningDrafts}
              temporary={isDemoMode}
              sourcePreferenceScope={JSON.stringify([workspaceId,accountLibraryId??data.localLibraryId??'local'])}
              reviewContextFor={item=>({due:accountLoaded?undefined:uiProgress.fsrsData?.[`practice:${item.itemId}`]?.due,category:activeTaskScope?.plan.tasks.find(task=>task.taskId===activeTaskScope.taskId)?.category})}
              companionClient={companionPlanClient}
              onRecordAttempt={recordPracticeAttempt}
              nonWordScopeFor={item=>inlineNonWordScope(model,item)}
              recallScopeFor={item=>!isDemoMode&&item.contentHash&&(accountLibraryId||data.localLibraryId)?{workspaceId,libraryId:accountLibraryId??data.localLibraryId!,itemKey:stableStudyItemKey(item)??item.itemId,contentHash:item.contentHash}:undefined}
              onFinish={(summary) => { const wasNativeActive=accountAttemptActiveRef.current&&!accountLoadedRef.current;setPracticeItems(null);setPracticeSummary(summary);accountAttemptActiveRef.current=false;const pending=accountPendingLoadedRef.current;if(pending)void applyAccountLoaded(pending);else{const account=accountLoadedRef.current;if(account)setData(accountStudyPayload(account,workspaceId) as unknown as StudyPayload);else if(pendingLocalSourceRef.current?.workspaceId===workspaceId)applyLocalStudySource(pendingLocalSourceRef.current.payload,workspaceId);}if(wasNativeActive)noteEventsChanged(); }}
              context={{
                recallPersistenceRequired:!isDemoMode,paperServices,
                requestAiHint:accountLoaded?(item,selected)=>runAccountQuestionAi('hint',item,selected??'').then(result=>result.text):companionPlanClient?requestAiHint:undefined,
                askTutor:accountLoaded?(question,item)=>runAccountQuestionAi('tutor',item,question).then(result=>result.text):companionPlanClient?requestAiTutor:undefined,
                gradeCalculation: (item,answer,signal)=>companionPlanClient?companionPlanClient.gradePractice(item as PracticeItem,answer):gradeAccountCalculation(item,answer,signal),
                gradeRecall: async (item,answer) =>{if(accountLoaded){const result=await runAccountQuestionAi('recall-grade',item,answer);return{correct:result.verdict==='correct',verdict:result.verdict,rating:result.rating as 'again'|'hard'|'good',source:'ai',feedback:result.text,matchedPointIds:result.matchedPointIds,missedPointIds:result.missedPointIds};}return companionPlanClient?companionPlanClient.gradePractice(item as PracticeItem,answer):{correct:null,verdict:'self-assess',source:'self-assess',aiFallback:true,feedback:`请对照参考内容自评：${String((item as {answer?:unknown;explanation?:unknown}).answer??(item as {explanation?:unknown}).explanation??'')}`};},
              }}
            />
            </section>
          )}

          {practiceSummary && practiceItems === null && (
            <section className="caught-up-state" aria-live="polite">
              <span className="caught-up-mark">✓</span>
              <p className="module-eyebrow">DUE REVIEW · SESSION COMPLETE</p>
              <h2>本轮复习完成</h2>
              <p>共作答 {practiceSummary.answered} 次：答对 {practiceSummary.correct} 次、答错 {practiceSummary.wrong} 次。</p>
              {isDemoMode?<DemoModeBadge/>:<p>作答先保存到本机，再分别同步云端与学习库；实际送达和待重试状态请查看复习诊断。</p>}
              <div>
                <button onClick={() => setPracticeSummary(null)}>关闭</button>
                <button onClick={() => { setPracticeSummary(null); if(taskPlanningEnabled && activeTaskScope?.taskId) void startTaskLearning(activeTaskScope.taskId);else void startPractice(); }}>再来一轮</button>
              </div>
            </section>
          )}

          {legacyPlanningVisibility.constraints && <details className="study-legacy-options"><summary>旧版计划选项</summary><section className="p-8 bg-white dark:bg-zinc-900 border border-[var(--line)] rounded-3xl shadow-sm">
            <div className="flex flex-col sm:flex-row sm:justify-between items-start gap-6 mb-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-2">计划设置 · 用户约束</p>
                <h3 className="font-serif text-2xl tracking-tight text-[var(--ink)] mb-2">每日时间、节奏与截止日期</h3>
                <p className="text-sm text-[var(--ink)] opacity-60 leading-relaxed max-w-2xl">默认由系统根据近 28 天记录估算；你可以临时覆盖，或锁定自己的固定节奏。保存后写入 Obsidian 的“01 学习约束”。</p>
              </div>
              <div className="shrink-0">
                <button className="px-5 py-2.5 rounded-xl bg-[var(--ink)] text-[var(--surface)] font-black text-sm hover:brightness-110 active:scale-[0.98] transition-all focus-visible:ring-2 focus-visible:ring-[var(--lime-dark)]" onClick={() => void savePlanSettings()}>{companionSession ? "保存到 Obsidian" : "保存本机草稿"}</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="学习约束调节模式">
              {([ ["auto", "系统自动"], ["temporary", "临时调整"], ["locked", "固定设置"] ] as [ConstraintMode, string][]).map(([mode, label]) => (
                <button key={mode} className={`px-3 py-2 rounded-lg border text-xs font-bold transition-all active:scale-[0.98] focus-visible:ring-2 ${constraintMode === mode ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--surface)]" : "border-[var(--line)] hover:border-[var(--ink)]"}`} onClick={() => setConstraintMode(mode)}>{label}</button>
              ))}
              {constraintMode === "temporary" && <label className="ml-1 flex items-center gap-2 text-xs font-bold"><span className="opacity-60">有效至</span><input type="date" className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 outline-none focus:border-[var(--ink)]" value={temporaryUntil} onChange={(event) => setTemporaryUntil(event.target.value)} /></label>}
            </div>
            {constraintAuthority?.explanation && <p className="mb-5 border-l-2 border-[var(--lime-dark)] pl-3 text-xs leading-relaxed text-[var(--ink)] opacity-70">系统估算：{constraintAuthority.explanation}</p>}
            <div className={`grid grid-cols-2 md:grid-cols-3 gap-3 text-sm mb-6 ${constraintMode === "auto" ? "opacity-55" : ""}`}>
              <label className="flex flex-col gap-1 text-xs font-bold">
                <span className="opacity-60">每日最少分钟</span>
                <input type="number" min={0} disabled={constraintMode === "auto"} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)] disabled:cursor-not-allowed" value={planSettings.constraints.dailyMinutes.min} onChange={(event) => setPlanSettings((current) => ({ ...current, constraints: { ...current.constraints, dailyMinutes: { ...current.constraints.dailyMinutes, min: Number(event.target.value), source: "user" } } }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold">
                <span className="opacity-60">每日最多分钟</span>
                <input type="number" min={0} disabled={constraintMode === "auto"} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)] disabled:cursor-not-allowed" value={planSettings.constraints.dailyMinutes.max} onChange={(event) => setPlanSettings((current) => ({ ...current, constraints: { ...current.constraints, dailyMinutes: { ...current.constraints.dailyMinutes, max: Number(event.target.value), source: "user" } } }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold">
                <span className="opacity-60">负荷系数（0–1）</span>
                <input type="number" min={0.1} max={1} step={0.05} disabled={constraintMode === "auto"} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)] disabled:cursor-not-allowed" value={planSettings.constraints.loadFactor} onChange={(event) => setPlanSettings((current) => ({ ...current, constraints: { ...current.constraints, loadFactor: Number(event.target.value) } }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold">
                <span className="opacity-60">复习最低保障</span>
                <input type="number" min={0} disabled={constraintMode === "auto"} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)] disabled:cursor-not-allowed" value={planSettings.constraints.minReviewMinutes} onChange={(event) => setPlanSettings((current) => ({ ...current, constraints: { ...current.constraints, minReviewMinutes: Number(event.target.value) } }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold">
                <span className="opacity-60">工作日分钟</span>
                <input type="number" min={0} disabled={constraintMode === "auto"} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)] disabled:cursor-not-allowed" value={planSettings.constraints.weeklyRhythm?.workdayMinutes ?? ""} placeholder="使用每日上限" onChange={(event) => setPlanSettings((current) => ({ ...current, constraints: { ...current.constraints, weeklyRhythm: { workdayMinutes: Number(event.target.value), weekendMinutes: current.constraints.weeklyRhythm?.weekendMinutes ?? current.constraints.dailyMinutes.max } } }))} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold">
                <span className="opacity-60">周末分钟</span>
                <input type="number" min={0} disabled={constraintMode === "auto"} className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)] disabled:cursor-not-allowed" value={planSettings.constraints.weeklyRhythm?.weekendMinutes ?? ""} placeholder="使用每日上限" onChange={(event) => setPlanSettings((current) => ({ ...current, constraints: { ...current.constraints, weeklyRhythm: { workdayMinutes: current.constraints.weeklyRhythm?.workdayMinutes ?? current.constraints.dailyMinutes.max, weekendMinutes: Number(event.target.value) } } }))} />
              </label>
            </div>
            <div className="text-sm mb-4">
              <p className="text-[10px] font-black uppercase tracking-widest opacity-40 mb-2">截止日期</p>
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none" value={planDeadlineDraft.date} onChange={(event) => setPlanDeadlineDraft((current) => ({ ...current, date: event.target.value }))} />
                <input type="text" placeholder="标题（如 期中考试）" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none w-44" value={planDeadlineDraft.title} onChange={(event) => setPlanDeadlineDraft((current) => ({ ...current, title: event.target.value }))} />
                <input type="number" min={1} max={5} aria-label="截止日期优先级" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none w-20" value={planDeadlineDraft.priority} onChange={(event) => setPlanDeadlineDraft((current) => ({ ...current, priority: Number(event.target.value) }))} />
                <input type="text" placeholder="范围：ielts / source:…（可空）" className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none w-56" value={planDeadlineDraft.scopeRef ?? ""} onChange={(event) => setPlanDeadlineDraft((current) => ({ ...current, scopeRef: event.target.value }))} />
                <button className="px-4 py-2 rounded-xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)] text-[var(--ink)] font-bold text-sm hover:bg-[rgba(0,0,0,0.1)] dark:hover:bg-[rgba(255,255,255,0.14)] active:scale-95 transition-all" onClick={() => {
                  if (!planDeadlineDraft.date || !planDeadlineDraft.title) return;
                  setPlanSettings((current) => ({ ...current, deadlines: [...current.deadlines, planDeadlineDraft] }));
                  setPlanDeadlineDraft({ date: "", title: "", priority: 3, scopeRef: "" });
                }}>添加</button>
              </div>
              {planSettings.deadlines.length > 0 && <ul className="mt-3 flex flex-col gap-2">
                {planSettings.deadlines.map((deadline, index) => (
                  <li key={`${deadline.date}:${deadline.title}`} className="flex items-center gap-3 text-xs font-bold">
                    <span className="opacity-70">{deadline.date}</span>
                    <span>{deadline.title}</span>
                    <span className="opacity-40">优先级 {deadline.priority}</span>
                    {deadline.scopeRef && <span className="font-mono opacity-50">范围 {deadline.scopeRef}</span>}
                    <button className="text-[var(--orange)] hover:underline" onClick={() => setPlanSettings((current) => ({ ...current, deadlines: current.deadlines.filter((_, i) => i !== index) }))}>移除</button>
                  </li>
                ))}
              </ul>}
            </div>
          </section></details>}
          </div>
            </>}
            modules={<LearningLibrary showTrial={!isDemoMode} statusFor={id=>{const subject=subjects.find(s=>s.id===id);if(!subject)return '';return isSubjectRoundComplete({pluginType:subject.pluginType,items:subject.items||[],itemStages:uiProgress.itemStages,keyOf:(item,index)=>resolveStudyItemProgressKey(item,index,uiProgress),round:subjectRounds[id]||emptySubjectRound()})?'已完成本轮 ✓':`共 ${subject.items.length} 项内容`;}} key={JSON.stringify([workspaceId,paperLibraryScope])} subjects={subjects} owner={workspaceId} library={paperLibraryScope} onChoose={navigateToStudyTab} paper={<PaperWorkshopLauncher services={paperServices}/>} onSources={()=>openSources('connections')}/>}
            context={<>
              {sessionUser&&!accountOptedOut&&<AccountReadNoticeSlot at="details" hasSource={Boolean(accountLoaded)} state={visibleAccountStatus} onRefresh={()=>void readAccountAgain()} onResolveLibrary={()=>openSources('connections')}/>}
              {data.gateway && <section className="col-span-1 lg:col-span-2 border border-[var(--line)] rounded-xl p-4 sm:p-5" aria-label="学习知识库索引状态">
            <p className="text-sm font-bold">固定索引 · {data.gateway.subjectCount} 个学科 · {data.gateway.itemCount} 个条目</p>
            <p className="mt-1 text-sm opacity-65">内容与学习记录保留在学科内；已登记目录中的合规内容会自动收录，每分钟检查一次，也可立即同步。</p>
            {data.gateway.diagnostics.length > 0 && <div role="alert" className="mt-3 text-sm text-[var(--orange)]">
              <p>有 {data.gateway.diagnostics.length} 项需要检查；问题条目未被静默替换为示例。</p>
              <ul className="mt-2 list-disc pl-5">{data.gateway.diagnostics.map((issue,index)=><li key={`${issue.code}:${index}`}>{issue.message}{issue.path ? `（${issue.path}）` : ''}</li>)}</ul>
            </div>}
          </section>}
              <section className="col-span-1 rounded-2xl sm:rounded-3xl bg-[var(--ink-bg)] text-[var(--ink-text)] p-6 sm:p-8 md:p-10 flex flex-col sm:flex-row items-center justify-between overflow-hidden relative shadow-lg">
            {/* Ambient decorative glow, much cleaner than old ::after */}
            <div className="absolute -right-20 -bottom-20 w-64 h-64 rounded-full bg-[var(--lime)] opacity-10 blur-3xl pointer-events-none"></div>

            <div className="relative z-10 max-w-[420px]">
              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-[var(--lime)] text-[10px] font-black uppercase tracking-widest text-[var(--lime-dark)] mb-4 sm:mb-6 shadow-sm">{taskPlanningEnabled?'自由学习入口':'今日主线'}</span>
              <h2 className="font-serif text-3xl sm:text-4xl lg:text-5xl tracking-tight leading-[1.15] mb-4 text-[var(--ink-text)]">
                {focusPath && !isDemoMode && !accountLoaded && companionSession && syncState==='connected' ? (
                  <a href={getObsidianUri(focusPath)} className="hover:opacity-80 transition-opacity flex items-center gap-3 group" title="在 Obsidian 中打开原笔记">
                    {focusTitle}
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-0 group-hover:opacity-50 transition-opacity"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  </a>
                ) : focusTitle}
              </h2>
              <p className="text-sm opacity-80 mb-5 sm:mb-8 leading-relaxed font-medium">{focusDetail}</p>
              <button className="bg-[var(--lime)] text-[var(--lime-dark)] px-6 py-3.5 rounded-xl font-black text-sm tracking-wide flex items-center gap-2 hover:brightness-110 active:scale-[0.99] transition-all shadow-sm" onClick={() => primarySubject && navigateToStudyTab(primarySubject.id)}>开始学习 <span className="font-serif text-lg leading-none">→</span></button>
            </div>

            <div className="relative flex items-center justify-center mt-6 sm:mt-0 w-24 h-24 sm:w-36 sm:h-36 rounded-full bg-[var(--ink-bg)] border-4 border-[rgba(255,255,255,0.1)] overflow-hidden flex-shrink-0 z-10" style={{ background: `conic-gradient(var(--lime) ${completion}%, rgba(255,255,255,0.05) 0)` }}>
              <div className="absolute inset-2 rounded-full bg-[var(--ink-bg)] flex flex-col items-center justify-center shadow-[inset_0_4px_12px_rgba(0,0,0,0.4)]">
                <strong className="text-2xl sm:text-3xl font-serif tracking-tight text-[var(--ink-text)]">{completion}%</strong>
                <span className="text-[9px] font-bold uppercase tracking-wider opacity-60 mt-0.5">本轮完成</span>
              </div>
            </div>
          </section>
              <section className="col-span-1 border border-[var(--line)] rounded-2xl sm:rounded-3xl bg-[var(--surface)] p-5 sm:p-8 md:p-10 flex flex-col justify-between shadow-sm">
            <div className="flex justify-between items-baseline mb-6">
              <p className="text-[10px] font-black tracking-widest uppercase opacity-50">{taskPlanningEnabled?'模块浏览进度':'今日进度'}</p>
              <strong className="text-5xl font-serif tracking-tight text-[var(--ink)]">{completedItems}<span className="text-lg opacity-40 font-sans tracking-normal ml-1">/ {allItems.length} 项</span></strong>
            </div>
            <div className="flex gap-5 mb-8"><span className="flex items-center gap-1.5 text-xs font-bold text-[var(--ink)] opacity-70"><i className="w-3 h-3 rounded-full bg-[var(--lime)]"/>{primarySubject ? modulePresentation(primarySubject).eyebrow : "学习内容"}</span></div>
            <div>
              {data.dashboard && <p className="text-xs font-medium text-[var(--ink)] opacity-60">已记录 <strong className="opacity-100">{data.dashboard.activityCount}</strong> 次练习 · 估算用时 <strong className="opacity-100">{data.dashboard.activityMinutes}</strong> 分钟</p>}
              {pendingActivities.length > 0 && <p className="mt-3 inline-block px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-500 text-[10px] font-bold tracking-wide border border-amber-200 dark:border-amber-900/50">{pendingActivities.length} 条记录等待同步</p>}
              {(lastStudyReceipts.cloud || lastStudyReceipts.companion) && <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold" aria-label="最近一次学习记录回执">
                {lastStudyReceipts.cloud&&<span className="px-2.5 py-1 rounded-md border border-[var(--line)]">账号：{lastStudyReceipts.cloud === "acked" ? "已接收" : lastStudyReceipts.cloud === "conflict" ? "冲突" : "等待接收"}</span>}
                {lastStudyReceipts.companion&&<span className="px-2.5 py-1 rounded-md border border-[var(--line)]">{lastStudyReceipts.companion==='applied'?'学习库：已写回':lastStudyReceipts.companion==='blocked'?'学习库写回：待处理':lastStudyReceipts.companion==='received'||lastStudyReceipts.companion==='acked'?'Companion：已接收 · 实际写回待核对':lastStudyReceipts.companion==='conflict'?'Companion：记录冲突':'Companion：等待接收或处理'}</span>}
              </div>}
            </div>
          </section>
              {data.dashboard && <section className="col-span-1 lg:col-span-2 border border-[var(--line)] rounded-3xl bg-[#ebe9df] dark:bg-[rgba(0,0,0,0.2)] p-8 flex flex-col md:flex-row md:items-center justify-between gap-6 mt-2 shadow-inner">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest opacity-50 mb-2">Obsidian 今日依据</p>
              <h3 className="font-serif text-2xl tracking-tight text-[var(--ink)] mb-2">{activeProject?.title || "当前没有活跃项目阶段"}</h3>
              <span className="text-xs font-bold opacity-70">{activeProject?.nextAction || data.dashboard.priorities[0] || "等待学习计划"}</span>
            </div>
            <div className="flex items-center gap-5 border-t md:border-t-0 md:border-l border-[var(--line)] pt-6 md:pt-0 md:pl-8">
              <strong className="font-serif text-5xl tracking-tight text-[var(--ink)] leading-none">{data.dashboard.dueReviewCount}</strong>
              <span className="text-xs font-bold opacity-60 leading-snug max-w-[120px]">项到期复习 · {data.dashboard.dueReviews?.length || 0} 份来源笔记</span>
            </div>
          </section>}
            </>}
            contextAlert={Boolean(data.gateway?.diagnostics.length||pendingActivities.length||lastStudyReceipts.cloud==='conflict'||lastStudyReceipts.companion==='conflict')}
            notice={<>{!accountLoaded&&!taskPlanningEnabled&&allSubjectsComplete && <section className="caught-up-state col-span-1 lg:col-span-2" aria-live="polite">
            <span className="caught-up-mark">✓</span>
            <p className="module-eyebrow">TODAY · ALL COMPLETE</p>
            <h2>今天的每一个模块都已完成</h2>
            <p>所有学科的本轮内容都学完了。可以查看学习进度回顾，也可以进入任意模块再学一轮巩固。</p>
            <div><button onClick={() => setTab("progress")}>查看学习进度</button></div>
          </section>}</>}
          />)}</>;
}
