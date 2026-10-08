"use client";
import { type ReactNode } from "react";
import {StudyWelcome} from "../onboarding";
import {NoteTrial} from '../note-trial';
import { AccountReadNoticeSlot,StudyWorkspaceGate } from "../account-study-status";
import type { StudyAIContext,StudyAIScope,StudyAIService } from "../ai/study-ai-types";
import { AssistanceHistory } from "../assistance-history";
import { companionSignInLink } from "../companion-endpoint";
import { StudyAISettings,StudyAISidebar,StudyAITrigger,StudyAIWorkspace } from "../components/ai-sidebar";
import { StudyAICopyPrompt } from "../components/ai-sidebar/study-ai-copy-prompt";
import { StudyAIOfflineContext } from "../components/ai-sidebar/study-ai-workspace";
import {
modulePresentation,
stableStudyItemKey
} from "../dynamic-ui-model";
import { LearningDraftNotice,LearningDraftLeaveGuard } from "../learning-draft";
import { LongTermPlanPanel } from "../long-term-plan-panel";
import { PaperWorkshopLauncher } from "../paper-workshop-launcher";
import { StudyProgressOverview } from "../study-progress-overview";
import { StudyPanel,StudyRecoveryState } from "../study-session-shell";
import { StudyWorkspaceNavigation } from "../study-workspace-navigation";
import { cloudWordKey,companionUrl,itemLabel } from "./prelude";
import {createLazyComponent} from '../plugins/lazy-plugin';
import { TodayView } from './today-view';
import type { DashboardController } from './use-dashboard-controller';
const SourcesView=createLazyComponent<Parameters<typeof import('./sources-view').SourcesView>[0]>(async()=>({default:(await import('./sources-view')).SourcesView}),'资料与设置');
const SubjectView=createLazyComponent<Parameters<typeof import('./subject-view').SubjectView>[0]>(async()=>({default:(await import('./subject-view')).SubjectView}),'学科练习');
export function DashboardView({model}:{model:DashboardController}){
 const {
  retryWorkspace,
  accountAILibrary,
  accountDailyPlan,
  accountLoaded,
  accountOptedOut,
  accountProgressChecking,
  accountWorkspaceId,
  activeCurationCategory,
  activeProgressId,
  activeProgressModule,
  activeProgressSubject,
  activeProgressSummary,
  aiEntryOpen,
  aiPage,
  assistanceHistory,
  canApplyDemoPacing,
  changeCandidates,
  curationIndex,
  currentDay,
  eventRevision,
  heading,
  homeHref,
  isDemoMode,
  keepProgressLocal,
  learningDrafts,
  loadLongTermSource,
  longTerm,
  longTermOpenRequest,
  longTermScopeKey,
  longTermSourceStampRef,
  migrateLocalProgress,
  moduleAccuracy,
  moduleNavigationSubjects,
  nativeHistoryError,
  nativeProgressChecking,
  navigateToStudyTab,
  normalizedSubjects,
  noteEventsChanged,
  openSources,
  paperServices,
  progressEvents,
  progressHistoryReady,
  progressModules,
  readAccountAgain,
  riskyItems,
  sessionResolved,
  sessionUser,
  setAiEntryOpen,
  setCurationCategory,
  setCurationIndex,
  setDemoPacingIds,
  setItemIndices,
  setLongTermEditing,
  setLongTermOpenRequest,
  setProgressView,
  setSourceView,
  setSubjectRounds,
  setTab,
  setTheme,
  showMigrationBanner,
  signOut,
  studyAI,
  studyFocus,
  subjects,
  submissionJournal,
  syncLabel,
  syncTimeLabel,
  tab,
  taskLearning,
  theme,
  todayLabel,
  uiProgress,
  visibleAccountStatus,
  visibleSyncState,
  workspacePhase,
 }=model;
 if(workspacePhase!=='ready')return <StudyWorkspaceGate phase={workspacePhase} onRetry={retryWorkspace}/>;
 return <DashboardAIWorkspace connection={studyAI} pageContext={aiPage}><main data-study-ai-content className={`app-shell study-app${studyFocus?' study-focus':''}`} data-page={tab}>
    <LearningDraftLeaveGuard store={learningDrafts}/>
    <StudyWorkspaceNavigation
      homeHref={homeHref}
      paperEntry={<PaperWorkshopLauncher services={paperServices}/>}
      aiSection={<StudyAITrigger onUnavailable={()=>setAiEntryOpen(true)}/>}
      hidden={studyFocus}
      activeId={tab}
      subjects={subjects}
      settingsCount={changeCandidates?.length ?? 0}
      onLibrary={()=>{navigateToStudyTab('today');requestAnimationFrame(()=>document.getElementById('study-subjects')?.scrollIntoView({block:'start'}));}}
      onNavigate={navigateToStudyTab}
      onSettings={openSources}
      accountSection={<details className="c-workspace-account"><summary aria-label="账号与连接"><span className="c-account-nav-label">账号与连接</span><svg className="c-account-nav-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg></summary><div className="study-header-actions flex flex-wrap items-center gap-3">
        <button className={`flex items-center gap-2.5 border border-zinc-200 dark:border-zinc-800 rounded-full px-4 py-2 bg-white dark:bg-zinc-900 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/80 transition-colors ${visibleSyncState}`} onClick={() => openSources("sync")}>
          <i className={`w-2 h-2 rounded-full ${visibleSyncState === "connected" ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]" : visibleSyncState === "key_missing" ? "bg-amber-400" : visibleSyncState === "provider_unavailable" ? "bg-orange-400" : visibleSyncState === "offline" ? "bg-rose-400" : "bg-zinc-400"}`} />
          <span className="flex flex-col">
            <strong className="text-[10px] uppercase font-bold text-zinc-900 dark:text-zinc-100 leading-none">{syncLabel}</strong>
            <small className="text-[9px] text-zinc-500 mt-0.5 leading-none">{syncTimeLabel}</small>
          </span>
        </button>
        <div className="flex items-center gap-3 border border-zinc-200 dark:border-zinc-800 rounded-full p-1 bg-white dark:bg-zinc-900">
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} title="切换主题">{theme === 'light' ? '🌙' : '☀️'}</button>
          <div className="hidden md:flex flex-col pr-3 pl-1">
            <strong className="text-[10px] font-bold text-zinc-900 dark:text-zinc-100 leading-none">{sessionResolved ? sessionUser?.displayName || "本地游客" : "正在确认身份…"}</strong>
            <span className="text-[9px] text-zinc-500 mt-0.5 leading-none">{sessionUser ? "此账号的本地学习空间" : "游客数据仅在本设备"}</span>
          </div>
          <button className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 font-bold text-sm text-zinc-600 dark:text-zinc-300 flex items-center justify-center" aria-label="查看数据源" onClick={() => openSources("sources")}>{sessionUser?.displayName?.slice(0, 1).toUpperCase() || "客"}</button>
        </div>
        {sessionUser ? <button className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors ml-1" onClick={signOut}>退出</button> : <a className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors ml-1" href="/signin-with-chatgpt?return_to=/study">登录</a>}
      </div></details>}
    />

    <section className="workspace">
      {tab !== 'today' && tab !== 'progress' && tab !== 'sources' && <header hidden={studyFocus} className="study-global-header flex flex-col md:flex-row md:items-end justify-between gap-4 md:gap-6 max-w-6xl mx-auto mb-8 md:mb-12 border-b border-zinc-200 dark:border-zinc-800 pb-4 md:pb-6">
        <div>
          <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase mb-2">{todayLabel}</p>
          <h1 className="font-serif text-3xl sm:text-4xl lg:text-5xl tracking-tight text-zinc-900 dark:text-zinc-50 m-0 leading-none">{heading}</h1>
        </div>
      </header>}
        {tab==='today'&&!studyFocus&&isDemoMode&&<NoteTrial key={JSON.stringify([model.workspaceId,model.paperLibraryScope])} owner={model.workspaceId} library={model.paperLibraryScope} featured onConnect={()=>openSources('sources')}/>}
        {tab==='today'&&!studyFocus&&!isDemoMode&&<StudyWelcome scope={model.workspaceId} isDemo={isDemoMode}/>}
        {!studyFocus&&<LearningDraftNotice store={learningDrafts}/>}
        {!studyFocus&&['today','progress'].includes(tab)&&<div className="long-term-tools"><LongTermPlanPanel onOpenRequestHandled={version=>setLongTermOpenRequest(current=>current?.version===version?null:current)} openRequest={longTermOpenRequest?.scope===longTermScopeKey?longTermOpenRequest.version:0} key={longTermScopeKey??'unavailable'} scopeKey={longTermScopeKey} today={currentDay} model={longTerm} loadSource={loadLongTermSource} currentSourceStamp={()=>longTermSourceStampRef.current} onAISettings={()=>setAiEntryOpen(true)} canApplyDemo={canApplyDemoPacing} onApplyDemo={ids=>{if(!canApplyDemoPacing)return;setDemoPacingIds(ids);setItemIndices({});setSubjectRounds({});setTab('today');}} onConnectSources={()=>{setTab('sources');setSourceView('sources');requestAnimationFrame(()=>document.getElementById('note-source-entry')?.scrollIntoView({block:'start',behavior:'smooth'}));}} onEditingChange={setLongTermEditing} onSaved={()=>{void taskLearning.session?.refresh(false).catch(()=>{});void accountDailyPlan.refresh().catch(()=>{});}}/></div>}
        {tab==='today'&&sessionUser&&!accountOptedOut&&<AccountReadNoticeSlot at="above" hasSource={Boolean(accountLoaded)} state={visibleAccountStatus} onRefresh={()=>void readAccountAgain()} onResolveLibrary={()=>openSources('connections')}/>}
        {tab==='today'&&nativeProgressChecking&&<p className="study-source-update-note" role="status">{nativeHistoryError||'部分本机历史待核对；保留原记录，暂不据此判断今日已完成。'}<button type="button" onClick={noteEventsChanged}>重新核对历史</button></p>}
        {isDemoMode && !studyFocus && tab!=='sources' && !(tab==='today'&&model.practiceSummary&&model.practiceItems===null) && <details className="study-demo-notice study-demo-notice-calm max-w-6xl mx-auto mb-6">
          <summary>公开示例 · 作答不计入个人学习记录</summary>
          <div className="study-demo-notice-body"><div><strong className="study-demo-detail-title">你现在看到的是公开示例，不是你的个人学习内容。</strong><span className="study-demo-detail-copy">可以直接在浏览器练习这些公开示例。要使用自己的资料，再通过 Companion 连接本地笔记或 Notion。示例作答不写入个人学习记录。</span></div><button className="study-secondary-action" onClick={() => openSources("sources")}>配置我的资料来源 →</button></div>
        </details>}
        {showMigrationBanner && <section className="max-w-6xl mx-auto mb-8 border border-amber-200 dark:border-amber-900/50 rounded-2xl bg-amber-50 dark:bg-amber-950/20 p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-6"><div><p className="text-[10px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-500 mb-1">CLOUD PROGRESS</p><strong className="block text-amber-900 dark:text-amber-200 text-lg mb-1">这台设备已有学习进度</strong><span className="text-amber-700/80 dark:text-amber-400/70 text-sm">只有点击确认后，词汇阶段、Python 完成项和到期复习状态才会写入你的云端空间；原始笔记和 API Key 不会上传。</span></div><div className="flex gap-3"><button className="whitespace-nowrap px-4 py-2 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 font-bold text-sm rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors" onClick={keepProgressLocal}>暂时只留本机</button><button className="whitespace-nowrap px-4 py-2 bg-amber-600 text-white font-bold text-sm rounded-lg hover:bg-amber-700 transition-colors" onClick={migrateLocalProgress}>确认迁移进度</button></div></section>}
        <TodayView model={model}/>

      {moduleNavigationSubjects.some(subject=>subject.id===tab)&&<SubjectView model={model}/>}
        {tab==='progress'&&(accountProgressChecking||nativeProgressChecking)&&<StudyRecoveryState onExit={()=>navigateToStudyTab('today')}><h2>进度还在核对</h2><p>学习记录仍然保留，未核对的历史不会当作零进度。</p><button type="button" className="study-rating" onClick={()=>openSources('sync')}>查看同步状态</button></StudyRecoveryState>}
        {tab === "progress" && !accountProgressChecking&&!nativeProgressChecking && <StudyProgressOverview
          ready={progressHistoryReady} modules={progressModules} activeId={activeProgressId} onSelect={setProgressView} subjects={normalizedSubjects}
          stages={uiProgress.itemStages} events={progressEvents} accountRecords={accountLoaded?.records??[]} accountItems={accountLoaded?.bundles.flatMap(bundle=>bundle.items)??[]}
          assistance={assistanceHistory.entries} assistancePhase={assistanceHistory.phase} fsrsData={uiProgress.fsrsData??{}}
          accountPlan={accountLoaded&&accountWorkspaceId?{workspaceId:accountWorkspaceId,loaded:accountLoaded,plan:accountDailyPlan.state?.approvedPlan??null,journal:submissionJournal,revision:eventRevision}:null}
          onSettings={()=>openSources('connections')} onSync={()=>openSources('sync')} onSources={()=>openSources('sources')} onDataInfo={()=>openSources('privacy')}>
            {activeProgressModule && activeProgressSummary && <article className="progress-module-detail col-span-full">
              <header>
                <div><p className="module-eyebrow">{modulePresentation(activeProgressModule).eyebrow} · HISTORY</p><h2>{activeProgressModule.name}</h2></div>
                <span>{activeProgressSummary.todayLabel}</span>
              </header>
              <div className="progress-metrics">
                <div><strong>{activeProgressSummary.evidenceCount}</strong><span>项已有学习证据</span></div>
                <div><strong>{activeProgressSummary.knownItemCount}</strong><span>项历史内容</span></div>
                <div><strong>{activeProgressSummary.completionPercent === null ? "—" : `${activeProgressSummary.completionPercent}%`}</strong><span>可验证完成度</span></div>
              </div>
              {activeProgressSubject ? <div className="progress-item-list">
                {activeProgressSubject.items.map((item, index) => {
                  const key = stableStudyItemKey(item) ?? cloudWordKey(item.word || item.id || String(index));
                  const stage = Math.max(uiProgress.itemStages[key] || 0, uiProgress.itemStages[cloudWordKey(item.word || item.id || String(index))] || 0);
                  return <div key={key}><strong>{itemLabel(item, index)}</strong><span>{stage > 0 ? `已有记录 · 阶段 ${stage}` : "等待开始"}</span></div>;
                })}
              </div> : <p className="historical-module-note">这个模块今天没有任务；历史学习证据已保留，不会因为资料暂时未出现而丢失。</p>}
            </article>}
          <article className="progress-module-detail learning-metrics" aria-label="学习效果">
              {riskyItems.length > 0 && <div className="metrics-block">
                <p className="module-eyebrow">最需要巩固 · 记忆保留率最低</p>
                {riskyItems.map((risk) => (
                  <div key={risk.key} className="metrics-row">
                    <strong>{risk.label}</strong><span>{risk.subject}</span>
                    <b className={risk.retrievability < 0.9 ? "low" : ""}>{Math.round(risk.retrievability * 100)}%</b>
                  </div>
                ))}
              </div>}
              {moduleAccuracy.length > 0 && <div className="metrics-block">
                <p className="module-eyebrow">作答正确率 · 全部历史</p>
                {moduleAccuracy.map((entry) => (
                  <div key={entry.id} className="metrics-row">
                    <strong>{entry.name}</strong><span>{entry.total} 次作答</span>
                    <b>{Math.round((entry.correct / entry.total) * 100)}%</b>
                  </div>
                ))}
              </div>}
          </article>
          <AssistanceHistory entries={assistanceHistory.entries} phase={assistanceHistory.phase} onRefresh={assistanceHistory.refresh}/>
        </StudyProgressOverview>}

      {tab === "curation" && <section className="max-w-6xl mx-auto h-[80vh] flex flex-col gap-6">
          <div className="flex gap-2">
            {subjects.map((subject) => (
              <button key={subject.id} onClick={() => { setCurationCategory(subject.id); setCurationIndex(0); }} className={`px-4 py-2 rounded-full font-bold text-sm transition-colors ${activeCurationCategory === subject.id ? "bg-[var(--ink)] text-[var(--surface)]" : "bg-[var(--surface)] text-[var(--ink)] border border-[var(--line)] hover:bg-[rgba(0,0,0,0.05)] dark:hover:bg-[rgba(255,255,255,0.05)]"}`}>{subject.name}</button>
            ))}
          </div>
          <div className="flex-1 flex flex-col md:flex-row gap-6 min-h-0">
            <aside className="w-full md:w-1/3 flex flex-col border border-[var(--line)] rounded-3xl bg-[var(--surface)] overflow-hidden shadow-sm">
              <div className="p-6 border-b border-[var(--line)]">
                <h3 className="font-serif text-xl tracking-tight text-[var(--ink)]">内容审查</h3>
                <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mt-1">
                  共 {(subjects.find((subject) => subject.id === activeCurationCategory)?.items || []).length} 条记录
                </p>
              </div>
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                {(subjects.find((subject) => subject.id === activeCurationCategory)?.items || []).map((item, index) => (
                  <button key={item.id || index} onClick={() => setCurationIndex(index)} className={`text-left p-4 rounded-2xl transition-all ${curationIndex === index ? "bg-[var(--lime)] text-[var(--lime-dark)] shadow-sm" : "hover:bg-[rgba(0,0,0,0.02)] dark:hover:bg-[rgba(255,255,255,0.02)] text-[var(--ink)]"}`}>
                    <strong className="block font-serif text-sm tracking-tight mb-1">{itemLabel(item, index)}</strong>
                    <span className={`text-xs font-bold line-clamp-1 ${curationIndex === index ? "opacity-70" : "opacity-40"}`}>{item.meaning || item.prompt || item.back || ""}</span>
                  </button>
                ))}
              </div>
            </aside>
            <div className="flex-1 flex flex-col border border-[var(--line)] rounded-3xl bg-[var(--surface)] overflow-hidden shadow-sm">
              <div className="m-auto text-center opacity-40 font-bold text-sm p-8">只读模式：动态生成的题目暂不支持在网页端直接编辑。</div>
            </div>
          </div>
        </section>}
        {tab==='sources'&&<SourcesView model={model.sourcesModel}/>}
    </section>
        <StudyPanel open={aiEntryOpen} onClose={()=>setAiEntryOpen(false)} title="AI 与 API Key 设置" variant="center"><div data-ai-private>{studyAI?<StudyAISettings/>:<div className="study-ai-settings"><h3>在手机、平板或电脑上使用 AI</h3>{!sessionUser?<><p>先登录自己的账号，即可读取账号学习库和 AI 设置。手机不需要连接这台电脑的本地服务。</p><a href={companionSignInLink(companionUrl)}>登录知学</a></>:<><p>{accountAILibrary.phase==='loading'?'正在读取账号学习库信息，无需等待全部题目加载。':accountAILibrary.phase==='failed'?'账号学习库信息暂时无法读取，请重试。':'你的账号尚未关联学习库。先在电脑上接入一份材料并启用账号题库，之后可直接在手机或平板配置账号 API Key。'}</p><button type="button" onClick={accountAILibrary.refresh}>重新读取账号信息</button><button type="button" onClick={()=>{setAiEntryOpen(false);setTab('sources');setSourceView('sources');}}>前往知识库接入</button></>}</div>}<details className="study-context"><summary>没有 API Key：复制提示词到网页 AI</summary><StudyAICopyPrompt/></details></div></StudyPanel>
  </main></DashboardAIWorkspace>;
}
function DashboardAIWorkspace({connection,pageContext,children}:{connection:{scope:StudyAIScope;service:StudyAIService}|null;pageContext:StudyAIContext;children:ReactNode}){
  if(!connection)return <StudyAIOfflineContext pageContext={pageContext}>{children}</StudyAIOfflineContext>;
  return <StudyAIWorkspace {...connection} pageContext={pageContext}>{children}<StudyAISidebar/></StudyAIWorkspace>;
}
