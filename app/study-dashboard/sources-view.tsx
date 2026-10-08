"use client";
import {StudyTermHelp} from "../study-term-help";
import { useState } from "react";
import { AccountStudyConnection } from "../account-study-controls";
import { CompanionSettingsCard } from "../companion-settings-card";
import { StudyAISettings } from "../components/ai-sidebar";
import { KnowledgeStarterDialog } from "../knowledge-starter-dialog";
import { KNOWLEDGE_STARTER_LABEL } from "../knowledge-starter-prompts";
import { LongTermPlanPanel } from "../long-term-plan-panel";
import { NoteSourcesPanel } from "../note-sources-panel";
import { OnboardingButton } from "../onboarding";
import { ReleaseSupport } from "../release-support";
import { ShowReleaseAnnouncementButton } from "../release-announcement";
import { summarizeReplicaState } from "../review-diagnostics";
import { StudyLayoutControl } from "../study-layout-control";
import { SettingsActionDialog } from "../study-settings-dialog";
import { VaultMappingPanel } from "../vault-mapping-panel";
import { companionUrl, type SourceView } from "./prelude";
import type { DashboardController } from "./use-dashboard-controller";

type Props = {model: DashboardController['sourcesModel']};

export type SettingsSectionId =
  | "appearance"
  | "connections"
  | "sources"
  | "ai"
  | "sync"
  | "privacy"
  | "danger";

interface NavItem {
  id: SettingsSectionId;
  icon: React.ReactNode;
  label: string;
  desc: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "appearance",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.2 0-.9.8-1.7 1.7-1.7h2c3.3 0 6-2.7 6-6 0-5.5-4.5-10.3-10.6-10.3z"/>
      </svg>
    ),
    label: "学习与外观",
    desc: "界面主题、布局模式与学习计划",
  },
  {
    id: "connections",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>
        <path d="M12 18h.01"/>
      </svg>
    ),
    label: "连接与设备",
    desc: "本地资料助手与账号题库连接",
  },
  {
    id: "sources",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/>
        <path d="M6 6h10"/>
        <path d="M6 10h10"/>
      </svg>
    ),
    label: "资料来源",
    desc: "选择笔记、对应学科与确认更新",
  },
  {
    id: "ai",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z"/>
      </svg>
    ),
    label: "AI 与密钥",
    desc: "选择 AI 服务并管理连接密钥",
  },
  {
    id: "sync",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
        <path d="M21 3v5h-5"/>
        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
        <path d="M8 16H3v5"/>
      </svg>
    ),
    label: "同步与记录",
    desc: "查看学习记录是否已经同步",
  },
  {
    id: "privacy",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
    label: "数据与隐私",
    desc: "了解数据保存位置与恢复方式",
  },
  {
    id: "danger",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
        <line x1="12" x2="12" y1="9" y2="13"/>
        <line x1="12" x2="12.01" y1="17" y2="17"/>
      </svg>
    ),
    label: "维护与公告",
    desc: "修复显示、查看版本与更新说明",
  },
];

export function SourcesView({ model }: Props) {
  const {
    appearance: {theme, setTheme, canApplyDemoPacing, currentDay, loadLongTermSource, longTerm, longTermOpenRequest, longTermScopeKey, setLongTermEditing, applyDemoPacing, currentLongTermSourceStamp, finishLongTermOpenRequest},
    connection: {acceptCurrentAccountLibrary, accountClient, accountDailyPlan, accountLoaded, accountWorkspaceId, companionCapabilities, companionDetected, companionSession, companionVersion, connections, detectExistingCompanion, pairCompanion, pairingCode, pairingMessage, prepareCompanionLaunch, readAccountAgain, refreshSources, refreshing, sessionResolved, sessionUser, storageReady, switchToLocalMode, syncState, visibleAccountStatus, acceptCompanionCapabilities},
    catalog: {changeCandidates, changeDecisionId, changeDecisionMessage, changesLoading, data, decideChange, importFile, importMessage, isDemoMode, lastChangeScan, mappingClient, scanChanges, taskLearning},
    sync: {cloudFlushing, cloudMessage, cloudStatus, cloudStatusDetail, cloudStatusLabel, diagnosticsLoading, keepProgressLocal, manualSyncing, migrateLocalProgress, refreshReviewDiagnostics, requestCloudSync, reviewDiagnostics, syncCloudNow, retryCloudSync},
    recovery: {dismissSettingsModal, handleClearCacheConfirmed, handleExportRecovery, openSettingsAi, refreshSettingsOverview, requestClearCache, settingsAccountStatus, settingsActionMessage, settingsActionOwner, settingsAiStatus, settingsCompanionStatus, settingsDeliveryLabel, settingsModal, settingsReadView, settingsRecordCount, settingsRegisteredCount, settingsUsesAccount},
    navigation: {homeHref, setAiEntryOpen, setPairingCode, setSourceView, setStarterOpen, setTab, sourceView, starterOpen, studyAI, tab}
  } = model;

  const [userSection, setUserSection] = useState<{ sourceView: SourceView; section: SettingsSectionId } | null>(null);

  // 默认进入核心“学习与外观”；响应外部显式传入的 sourceView 快捷入口（UX-01 / UX-03）
  const activeSection: SettingsSectionId =
    userSection && userSection.sourceView === sourceView
      ? userSection.section
      : sourceView === "overview" || sourceView === "appearance"
      ? "appearance"
      : (sourceView as SettingsSectionId);

  const handleSelectSection = (id: SettingsSectionId) => {
    setUserSection({ sourceView: id, section: id });
    setSourceView(id);
  };

  return (
    <>
      {tab === "sources" && <section className="study-settings flex-1 flex flex-col gap-6">
          {/* 顶部标题行 */}
          <header className="settings-page-heading">
            <div>
              <h2>系统设置</h2>
              <p>
                个性化外观、资料连接与系统维护
                {isDemoMode ? " · 体验模式" : ""}
              </p>
            </div>
            <a href={homeHref} className="study-secondary-action text-xs font-bold">
              返回首页 →
            </a>
          </header>

          {/* 双栏设置主布局：左侧导航 + 右侧单层聚焦内容 */}
          <div className="settings-layout-container">
            {/* 左侧侧边栏导航（移动端自适应为顶部横滑药丸栏） */}
            <aside className="settings-sidebar">
              <nav className="settings-nav" aria-label="设置功能导航">
                {NAV_ITEMS.map((item) => {
                  const isActive = activeSection === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`settings-nav-item ${isActive ? "active" : ""}`}
                      onClick={() => handleSelectSection(item.id)}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <span className="settings-nav-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <div className="settings-nav-text">
                        <span className="settings-nav-label">{item.label}</span>
                        <span className="settings-nav-desc">{item.desc}</span>
                      </div>
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* 右侧主内容面板 */}
            <div className="settings-main-pane">
              {/* 1. 学习与外观面板（核心痛点：常驻置顶，切换主题 ≤2 步） */}
              {activeSection === "appearance" && (
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>学习与外观</h3>
                    <p>选择顺手的主题和布局，再设置适合自己的学习节奏</p>
                  </div>

                  {/* 视觉主题切换卡片 - 常驻可见，无需折叠 */}
                  <section className="settings-card">
                    <h4 className="font-bold text-sm text-[var(--ink)] mb-1">界面主题</h4>
                    <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                      切换后立即生效，并在当前浏览器记住选择。
                    </p>
                    <div className="theme-switcher-grid">
                      <button
                        type="button"
                        className={`theme-option-card ${theme !== "dark" ? "active" : ""}`}
                        onClick={() => setTheme("light")}
                        aria-pressed={theme !== "dark"}
                      >
                        <div className="theme-preview-box theme-preview-light">
                          <div className="theme-preview-dots">
                            <span/><span/><span/>
                          </div>
                          <div className="theme-preview-body">
                            <div className="theme-preview-sidebar"/>
                            <div className="theme-preview-content">
                              <div className="theme-preview-line line-header"/>
                              <div className="theme-preview-line line-body"/>
                              <div className="theme-preview-line line-sub"/>
                            </div>
                          </div>
                        </div>
                        <div className="theme-option-meta">
                          <div className="theme-option-title-row">
                            <span className="font-bold text-sm">浅色模式</span>
                            {theme !== "dark" && <span className="theme-active-dot" aria-label="已选中">✓</span>}
                          </div>
                          <p className="text-[11px] text-[var(--muted)]">使用浅色背景</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        className={`theme-option-card ${theme === "dark" ? "active" : ""}`}
                        onClick={() => setTheme("dark")}
                        aria-pressed={theme === "dark"}
                      >
                        <div className="theme-preview-box theme-preview-dark">
                          <div className="theme-preview-dots">
                            <span/><span/><span/>
                          </div>
                          <div className="theme-preview-body">
                            <div className="theme-preview-sidebar"/>
                            <div className="theme-preview-content">
                              <div className="theme-preview-line line-header"/>
                              <div className="theme-preview-line line-body"/>
                              <div className="theme-preview-line line-sub"/>
                            </div>
                          </div>
                        </div>
                        <div className="theme-option-meta">
                          <div className="theme-option-title-row">
                            <span className="font-bold text-sm">深色模式</span>
                            {theme === "dark" && <span className="theme-active-dot" aria-label="已选中">✓</span>}
                          </div>
                          <p className="text-[11px] text-[var(--muted)]">使用深色背景</p>
                        </div>
                      </button>
                    </div>
                  </section>

                  {/* 工作台显示与新手帮助卡片 */}
                  <section className="settings-card">
                    <h4 className="font-bold text-sm text-[var(--ink)] mb-1">工作台显示与辅助</h4>
                    <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                      调整排版密度与新手教学指引
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <StudyLayoutControl />
                      <OnboardingButton />
                      <button
                        type="button"
                        className="study-secondary-action"
                        onClick={() => setStarterOpen(true)}
                      >
                        {KNOWLEDGE_STARTER_LABEL}
                      </button>
                    </div>
                  </section>

                  {/* 长期自适应计划卡片 */}
                  <section className="settings-card">
                    <h4 className="font-bold text-sm text-[var(--ink)] mb-1">长期学习安排</h4>
                    <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                      设置目标考试日期与每日节奏，系统会结合学习记录安排复习。<StudyTermHelp term="review"/>
                    </p>
                    <LongTermPlanPanel
                      onOpenRequestHandled={finishLongTermOpenRequest}
                      openRequest={
                        longTermOpenRequest?.scope === longTermScopeKey
                          ? longTermOpenRequest.version
                          : 0
                      }
                      key={longTermScopeKey ?? "unavailable"}
                      scopeKey={longTermScopeKey}
                      today={currentDay}
                      model={longTerm}
                      loadSource={loadLongTermSource}
                      currentSourceStamp={currentLongTermSourceStamp}
                      onAISettings={() => setAiEntryOpen(true)}
                      canApplyDemo={canApplyDemoPacing}
                      onApplyDemo={applyDemoPacing}
                      onConnectSources={() => {
                        setTab("sources");
                        handleSelectSection("sources");
                        requestAnimationFrame(() =>
                          document
                            .getElementById("note-source-entry")
                            ?.scrollIntoView({ block: "start", behavior: "smooth" })
                        );
                      }}
                      onEditingChange={setLongTermEditing}
                      onSaved={() => {
                        void taskLearning.session?.refresh(false).catch(() => {});
                        void accountDailyPlan.refresh().catch(() => {});
                      }}
                    />
                  </section>
                </div>
              )}

              {/* 2. 连接与设备面板 */}
              {activeSection === "connections" && ( /* sourceView === "connections" */
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>连接与设备</h3>
                    <p>连接本地资料助手与账号学习库</p>
                  </div>

                  {/* 本机 Companion 设置 */}
                  <CompanionSettingsCard
                    key={companionUrl}
                    endpoint={companionUrl}
                    signedIn={Boolean(sessionUser)}
                    paired={Boolean(companionSession)}
                    connected={syncState === "connected" && companionDetected !== "offline"}
                    detected={companionDetected}
                    version={companionVersion}
                    message={pairingMessage}
                    code={pairingCode}
                    refreshing={refreshing}
                    onCode={setPairingCode}
                    onLaunch={prepareCompanionLaunch}
                    onDetect={() => void detectExistingCompanion()}
                    onPair={() => void pairCompanion()}
                    onSync={()=>void refreshSources()}
                  />

                  {/* 账号题库连接 */}
                  <AccountStudyConnection
                    client={accountClient}
                    loaded={accountLoaded}
                    readStatus={visibleAccountStatus}
                    canPair={Boolean(companionSession)}
                    onRefresh={() => readAccountAgain()}
                    onRebuild={() => readAccountAgain(true)}
                    onAdoptLibrary={acceptCurrentAccountLibrary}
                    onUseLocal={() => void switchToLocalMode()}
                  />

                  {/* 连接概览三段式卡片 */}
                  <section className="settings-card">
                    <h4 className="font-bold text-sm text-[var(--ink)] mb-1">连接状态概览</h4>
                    <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                      实时检测各数据端与辅助服务的连通状态 · {connections.filter((item) => item.status === "ready" || item.status === "connected").length} 个连接可用
                    </p>

                    <div className="flex flex-col gap-3">
                      {/* 1. 账号题库 */}
                      <div className="c-settings-connection-row flex items-center justify-between p-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-[var(--blue)] flex items-center justify-center shrink-0">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
                            </svg>
                          </div>
                          <div>
                            <h5 className="font-bold text-sm text-[var(--ink)]">账号题库</h5>
                            <p className="text-xs text-[var(--ink)] opacity-60">
                              学习知识库与云端登记数据
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`flex items-center justify-end gap-1.5 text-xs font-bold ${
                              settingsAccountStatus.tone === "good"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-zinc-500"
                            }`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                settingsAccountStatus.tone === "good"
                                  ? "bg-emerald-500"
                                  : "bg-zinc-400"
                              }`}
                            />
                            {settingsAccountStatus.label}
                          </div>
                          <p className="text-[11px] text-[var(--ink)] opacity-50 mt-0.5">
                            {settingsAccountStatus.detail}
                          </p>
                        </div>
                      </div>

                      {/* 2. 本机 Companion */}
                      <div className="c-settings-connection-row flex items-center justify-between p-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)]">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>
                              <path d="M12 18h.01"/>
                            </svg>
                          </div>
                          <div>
                            <h5 className="font-bold text-sm text-[var(--ink)]">本地资料助手</h5>
                            <p className="text-xs text-[var(--ink)] opacity-60">本机笔记与数据缓存</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`flex items-center justify-end gap-1.5 text-xs font-bold ${
                              settingsCompanionStatus.tone === "good"
                                ? "text-emerald-600 dark:text-emerald-400"
                                : settingsCompanionStatus.tone === "warning"
                                ? "text-amber-500"
                                : "text-zinc-500"
                            }`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                settingsCompanionStatus.tone === "good"
                                  ? "bg-emerald-500"
                                  : settingsCompanionStatus.tone === "warning"
                                  ? "bg-amber-400"
                                  : "bg-zinc-400"
                              }`}
                            />
                            {settingsCompanionStatus.label}
                          </div>
                          <p className="text-[11px] text-[var(--ink)] opacity-50 mt-0.5">
                            {settingsCompanionStatus.detail}
                          </p>
                        </div>
                      </div>

                      {/* 3. AI 辅助服务（保留被单测点击测试的字面契约） */}
                      <button
                        type="button"
                        className="c-settings-connection-row flex items-center justify-between p-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[rgba(0,0,0,0.02)] dark:hover:bg-[rgba(255,255,255,0.02)] transition-colors cursor-pointer text-left w-full"
                        onClick={openSettingsAi}
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z"/>
                            </svg>
                          </div>
                          <div>
                            <h5 className="font-bold text-sm text-[var(--ink)]">
                              {settingsUsesAccount ? "账号 AI" : "本机 AI"}
                            </h5>
                            <p className="text-xs text-[var(--ink)] opacity-60">智能辅助服务</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-right">
                          <div>
                            <div
                              className={`flex items-center justify-end gap-1.5 text-xs font-bold ${
                                settingsAiStatus.tone === "good"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : "text-amber-500"
                              }`}
                            >
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  settingsAiStatus.tone === "good"
                                    ? "bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.2)]"
                                    : "bg-amber-400"
                                }`}
                              />
                              {settingsAiStatus.label}
                            </div>
                            <p className="text-[11px] text-[var(--ink)] opacity-50 mt-0.5">
                              {settingsAiStatus.detail}
                            </p>
                          </div>
                          <span className="text-[var(--ink)] opacity-30 text-lg" aria-hidden="true">
                            &gt;
                          </span>
                        </div>
                      </button>
                    </div>
                  </section>
                </div>
              )}

              {/* 3. 资料来源与映射面板 */}
              {activeSection === "sources" && (
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>资料来源与映射</h3>
                    <p>选择允许读取的笔记目录，并核对笔记更新</p>
                  </div>

                  {!companionSession && (
                    <div className="mb-4 p-4 rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/70 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <span className="font-semibold block text-sm mb-0.5">尚未连接本地资料助手</span>
                        <span className="opacity-80">接入电脑上的笔记需要先连接本地资料助手（Companion），连接后才能读取你授权的目录。</span>
                      </div>
                      <button
                        type="button"
                        className="study-secondary-action shrink-0 text-xs px-3 py-1.5 font-bold"
                        onClick={() => handleSelectSection("connections")}
                      >
                        前往连接设备 →
                      </button>
                    </div>
                  )}

                  {/* 笔记源面板：保留 div id="note-source-entry" 满足契约 */}
                  <section className="settings-card">
                    <h4 className="font-bold text-sm text-[var(--ink)] mb-1">授权笔记目录</h4>
                    <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                      Companion 仅读取已授权目录中的 Markdown、TXT、PDF 文件，不修改原始笔记
                    </p>
                    <div id="note-source-entry">
                      <NoteSourcesPanel
                        endpoint={companionUrl}
                        token={companionSession?.token ?? null}
                        capabilities={companionCapabilities}
                        onChanged={() => void refreshSources()}
                        onDetected={acceptCompanionCapabilities}
                      />
                    </div>
                  </section>

                  {/* 知识库映射面板 */}
                  <section className="settings-card">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-1">笔记库与学科对应关系</h4>
                        <p className="text-xs text-[var(--ink)] opacity-60">
                          映射学科笔记对应的 Vault 路径，支持双链题卡提取
                        </p>
                      </div>
                      <button
                        type="button"
                        className="study-secondary-action"
                        onClick={() => setStarterOpen(true)}
                      >
                        {KNOWLEDGE_STARTER_LABEL}
                      </button>
                    </div>
                    <VaultMappingPanel client={mappingClient} onChanged={() => void refreshSources()} />
                  </section>

                  {/* 资料变更审批 */}
                  <section className="settings-card">
                    <div className="flex flex-col sm:flex-row sm:justify-between items-start gap-4 mb-4">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-1">
                          {data.gateway ? "当前使用的资料范围" : "资料变更 · 等待确认"}
                        </h4>
                        <p className="text-xs text-[var(--ink)] opacity-60 leading-relaxed max-w-2xl">
                          {data.gateway
                            ? "固定入口位于学习库 gateway/。合规内容在已登记学科内自动收录。"
                            : "检测资料区的新增、修改、删除与重命名；审批后才进入学习流。"}
                        </p>
                        {lastChangeScan && (
                          <p className="mt-2 text-[10px] font-mono opacity-50">
                            最近自动检测：{new Date(lastChangeScan).toLocaleString("zh-CN")}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        className="study-secondary-action"
                        onClick={() => void scanChanges()}
                        disabled={changesLoading}
                      >
                        {changesLoading ? "扫描中…" : "立即扫描"}
                      </button>
                    </div>
                    {changeDecisionMessage && (
                      <p role="status" className="mb-4 text-sm font-medium text-[var(--ink)]">
                        {changeDecisionMessage}
                      </p>
                    )}
                    {changeCandidates !== null && changeCandidates.length > 0 && (
                      <ul className="flex flex-col gap-2 text-sm">
                        {changeCandidates.map((change) => {
                          const deciding = changeDecisionId === change.changeId;
                          return (
                            <li
                              key={change.changeId}
                              className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--line)] px-4 py-3"
                            >
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)]">
                                {{
                                  added: "新增",
                                  modified: "修改",
                                  removed: "删除",
                                  renamed: "重命名",
                                }[change.kind] ?? change.kind}
                              </span>
                              <span className="font-bold break-all">{change.path}</span>
                              {change.oldPath && (
                                <span className="opacity-50 text-xs break-all">
                                  原路径：{change.oldPath}
                                </span>
                              )}
                              <span className="opacity-40 text-xs font-mono">
                                {change.contentHash.slice(0, 10)}…
                              </span>
                              <span className="ml-auto flex gap-2">
                                <button
                                  type="button"
                                  className="px-3 py-1.5 rounded-xl bg-[var(--ink)] text-[var(--surface)] font-black text-xs hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
                                  onClick={() => void decideChange(change.changeId, "approved")}
                                  disabled={changeDecisionId !== null}
                                >
                                  {deciding ? "处理中…" : "批准"}
                                </button>
                                <button
                                  type="button"
                                  className="px-3 py-1.5 rounded-xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)] text-[var(--ink)] font-bold text-xs hover:bg-[rgba(0,0,0,0.1)] dark:hover:bg-[rgba(255,255,255,0.14)] active:scale-95 transition-all disabled:opacity-50"
                                  onClick={() => void decideChange(change.changeId, "rejected")}
                                  disabled={changeDecisionId !== null}
                                >
                                  拒绝
                                </button>
                                <button
                                  type="button"
                                  className="px-3 py-1.5 rounded-xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.08)] text-[var(--ink)] font-bold text-xs hover:bg-[rgba(0,0,0,0.1)] dark:hover:bg-[rgba(255,255,255,0.14)] active:scale-95 transition-all disabled:opacity-50"
                                  onClick={() => void decideChange(change.changeId, "later")}
                                  disabled={changeDecisionId !== null}
                                >
                                  稍后
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>

                  {/* 临时文件导入生成 */}
                  {!data.gateway && (
                    <section className="settings-card">
                      <h4 className="font-bold text-sm text-[var(--ink)] mb-1">从单文件生成题卡</h4>
                      <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                        上传 Markdown 或纯文本文件生成候选练习，原文件不受影响
                      </p>
                      <label className="relative inline-flex justify-center items-center h-10 px-6 rounded-xl bg-[rgba(0,0,0,0.05)] dark:bg-[rgba(255,255,255,0.05)] text-[var(--ink)] font-bold text-sm cursor-pointer hover:bg-[rgba(0,0,0,0.1)] dark:hover:bg-[rgba(255,255,255,0.1)] transition-all">
                        选择文件
                        <input
                          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                          type="file"
                          accept=".md,.txt,text/plain,text/markdown"
                          onChange={importFile}
                        />
                      </label>
                      {importMessage && (
                        <span className="block mt-3 text-xs font-bold text-amber-600 dark:text-amber-400">
                          {importMessage}
                        </span>
                      )}
                    </section>
                  )}
                </div>
              )}

              {/* 4. AI 模型与密钥面板 */}
              {activeSection === "ai" && (
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>AI 模型与密钥</h3>
                    <p>配置大语言模型解析、解题思路辅导与自带密钥 (BYOK) 安全录入</p>
                  </div>

                  <section className="settings-card">
                    {studyAI ? (
                      <StudyAISettings />
                    ) : (
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-1">AI 学习助手</h4>
                        <p className="text-xs text-[var(--ink)] opacity-60 mb-4">
                          支持配置云端服务商或个人 API Key。密钥将在客户端安全使用。
                        </p>
                        <button
                          type="button"
                          className="study-primary-action"
                          onClick={() => setAiEntryOpen(true)}
                        >
                          打开 AI 与 API Key 设置
                        </button>
                      </div>
                    )}
                  </section>
                </div>
              )}

              {/* 5. 同步与记录面板（包含复习状态 · 只读诊断） */}
              {activeSection === "sync" && (
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>同步概况与记录</h3>
                    <p>核对学习库已登记题目、作答历史记录与多端复习事件同步</p>
                  </div>

                  {/* 题库与作答统计 */}
                  <section className="settings-card">
                    <div className="flex justify-between items-center mb-4">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)]">数据统计概况</h4>
                        <p className="text-xs text-[var(--ink)] opacity-60">
                          当前学习库题目与记录统计
                        </p>
                      </div>
                      <button
                        type="button"
                        className="study-secondary-action"
                        disabled={!accountWorkspaceId || settingsReadView?.phase === "loading"}
                        onClick={() => void refreshSettingsOverview()}
                      >
                        {settingsReadView?.phase === "loading" ? "核对中…" : "刷新同步统计"}
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                      <div className="p-4 rounded-xl border border-[var(--line)] bg-[var(--surface)]">
                        <span className="text-xs text-[var(--ink)] opacity-60 block mb-1">
                          📄 当前学习库题目
                        </span>
                        <strong className="text-xl font-bold font-mono text-[var(--ink)]">
                          {settingsRegisteredCount === null
                            ? "待核对"
                            : settingsRegisteredCount.toLocaleString() + " 个"}
                        </strong>
                      </div>
                      <div className="p-4 rounded-xl border border-[var(--line)] bg-[var(--surface)]">
                        <span className="text-xs text-[var(--ink)] opacity-60 block mb-1">
                          📝 已核对作答记录
                        </span>
                        <strong className="text-xl font-bold font-mono text-[var(--ink)]">
                          {settingsRecordCount === null
                            ? "待核对"
                            : settingsRecordCount.toLocaleString() + " 条"}
                        </strong>
                      </div>
                      <div className="p-4 rounded-xl border border-[var(--line)] bg-[var(--surface)]">
                        <span className="text-xs text-[var(--ink)] opacity-60 block mb-1">
                          🕒 本机待同步队列
                        </span>
                        <strong className="text-xl font-bold font-mono text-[var(--ink)]">
                          {settingsReadView?.pending
                            ? settingsReadView.pending.total.toLocaleString() + " 项"
                            : "待核对"}
                        </strong>
                      </div>
                    </div>

                    {settingsReadView?.message && (
                      <p role="status" className="text-xs font-medium text-[var(--ink)] mb-1">
                        {settingsReadView.message}
                      </p>
                    )}
                    {settingsReadView?.checkedAt && (
                      <p className="text-[11px] text-[var(--ink)] opacity-50">
                        最近核对于 {new Date(settingsReadView.checkedAt).toLocaleString()}
                      </p>
                    )}
                    {settingsDeliveryLabel && (
                      <p className="text-[11px] text-[var(--ink)] opacity-50 mt-1" title={settingsDeliveryLabel}>
                        {settingsDeliveryLabel} · 上传、知识库写回及辅助摘要分别核对。
                      </p>
                    )}
                  </section>

                  {/* 云端进度同步 */}
                  <section
                    className={`p-6 rounded-2xl border ${
                      cloudStatus === "synced"
                        ? "bg-[var(--lime)]/10 border-[var(--lime)]"
                        : cloudStatus === "error"
                        ? "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900/50"
                        : "bg-[var(--blue)]/10 border-[var(--blue)]/20"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-1">
                          云端同步 · Cloud Progress
                        </p>
                        <h4 className="font-serif text-2xl tracking-tight text-[var(--ink)] mb-2">
                          {cloudStatusLabel}
                        </h4>
                        <p className="text-xs font-medium text-[var(--ink)] opacity-80 leading-relaxed max-w-xl">
                          {cloudMessage || cloudStatusDetail}
                        </p>
                      </div>
                      <div className="shrink-0 flex gap-2">
                        {cloudStatus === "needs-migration" ? (
                          <>
                            <button
                              type="button"
                              className="study-secondary-action"
                              onClick={keepProgressLocal}
                            >
                              保持仅本地
                            </button>
                            <button
                              type="button"
                              className="study-primary-action"
                              onClick={migrateLocalProgress}
                            >
                              迁移现有进度
                            </button>
                          </>
                        ) : cloudStatus === "local-only" ? (
                          <button
                            type="button"
                            className="study-primary-action"
                            onClick={requestCloudSync}
                          >
                            启用云同步
                          </button>
                        ) : cloudStatus === "error" ? (
                          <button
                            type="button"
                            className="study-primary-action"
                            onClick={retryCloudSync}
                          >
                            重新检查
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="study-primary-action"
                            onClick={syncCloudNow}
                            disabled={cloudFlushing || manualSyncing}
                          >
                            {cloudFlushing || manualSyncing ? "正在同步..." : "立即同步进度"}
                          </button>
                        )}
                      </div>
                    </div>
                  </section>

                  {/* 复习状态 · 只读诊断（保留给 round-completion.test.mjs 契约） */}
                  <section className="settings-card">
                    <div className="flex flex-col sm:flex-row sm:justify-between items-start gap-4 mb-4">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-1">
                          复习状态 · 只读诊断
                        </p>
                        <h4 className="font-serif text-xl tracking-tight text-[var(--ink)] mb-1">
                          {reviewDiagnostics
                            ? summarizeReplicaState(reviewDiagnostics).label
                            : "尚未检查"}
                        </h4>
                        <p className="text-xs text-[var(--ink)] opacity-60 leading-relaxed max-w-xl">
                          检查这台设备、账号与本地资料助手收到的学习记录；这里只检查，不会修改记录
                        </p>
                      </div>
                      <button
                        type="button"
                        className="study-secondary-action"
                        onClick={() => void refreshReviewDiagnostics()}
                        disabled={diagnosticsLoading}
                      >
                        {diagnosticsLoading ? "检查中…" : "重新检查"}
                      </button>
                    </div>

                    {reviewDiagnostics && (
                      <details><summary>查看技术排错信息</summary><div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                        <div className="rounded-xl bg-[rgba(0,0,0,0.03)] dark:bg-[rgba(255,255,255,0.04)] p-3">
                          <span className="text-[10px] uppercase opacity-50 block mb-1">调度器</span>
                          <strong className="font-mono text-[var(--ink)]">
                            {reviewDiagnostics.schedulerVersion || "—"}
                          </strong>
                        </div>
                        <div className="rounded-xl bg-[rgba(0,0,0,0.03)] dark:bg-[rgba(255,255,255,0.04)] p-3">
                          <span className="text-[10px] uppercase opacity-50 block mb-1">
                            本机事件 / 待送达
                          </span>
                          <strong className="font-mono text-[var(--ink)]">
                            {reviewDiagnostics.localEventCount ?? 0} /{" "}
                            {reviewDiagnostics.localPending}
                          </strong>
                        </div>
                        <div className="rounded-xl bg-[rgba(0,0,0,0.03)] dark:bg-[rgba(255,255,255,0.04)] p-3">
                          <span className="text-[10px] uppercase opacity-50 block mb-1">
                            D1 游标 / 冲突
                          </span>
                          <strong className="font-mono text-[var(--ink)]">
                            {reviewDiagnostics.cloudCursor ?? "—"} / {reviewDiagnostics.conflicts}
                          </strong>
                        </div>
                        <div className="rounded-xl bg-[rgba(0,0,0,0.03)] dark:bg-[rgba(255,255,255,0.04)] p-3">
                          <span className="text-[10px] uppercase opacity-50 block mb-1">
                            投影不一致
                          </span>
                          <strong className="font-mono text-[var(--orange)]">
                            {reviewDiagnostics.projectionMismatchCount}
                          </strong>
                        </div>
                      </div></details>
                    )}
                  </section>
                </div>
              )}

              {/* 6. 数据边界与隐私面板 */}
              {activeSection === "privacy" && ( /* sourceView === "privacy" */
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>数据保存与隐私</h3>
                    <p>了解哪些内容保存在浏览器、哪些会随所选连接方式发送</p>
                  </div>

                  <div className="flex flex-col gap-3">
                    <div className="settings-card flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-[var(--blue)] flex items-center justify-center shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="16" x2="8" y1="13" y2="13"/>
                          <line x1="16" x2="8" y1="17" y2="17"/>
                          <line x1="10" x2="8" y1="9" y2="9"/>
                        </svg>
                      </div>
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-0.5">
                          原始资料由你选择读取
                        </h4>
                        <p className="text-xs text-[var(--ink)] opacity-65 leading-relaxed">
                          读取笔记或导入材料不会自动改写原文件。论文草稿可保存在浏览器中；你主动选择写回、同步或 AI 功能时，按对应操作说明处理。
                        </p>
                      </div>
                    </div>

                    <div className="settings-card flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                          <path d="M21 3v5h-5"/>
                          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                          <path d="M8 16H3v5"/>
                        </svg>
                      </div>
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-0.5">
                          仅已登记的题目与作答同步
                        </h4>
                        <p className="text-xs text-[var(--ink)] opacity-65 leading-relaxed">
                          账号题库用于已登记题目和作答的跨设备复习；实际发送范围取决于当前连接方式与同步设置。
                        </p>
                      </div>
                    </div>

                    <div className="settings-card flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 3v18h18"/>
                          <path d="m19 9-5 5-4-4-3 3"/>
                        </svg>
                      </div>
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-0.5">
                          区分 AI 请求与学习摘要
                        </h4>
                        <p className="text-xs text-[var(--ink)] opacity-65 leading-relaxed">
                          主动使用 AI 时，所需题目和你提供的回答会发送给配置的模型服务；学习辅助摘要另按允许的字段记录。不要把不愿发送的私密内容提交给 AI。
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 数据备份导出 */}
                  <section className="settings-card">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-sm text-[var(--ink)] mb-1">导出恢复数据包</h4>
                        <p className="text-xs text-[var(--ink)] opacity-60">
                          导出当前账号在此浏览器中的恢复数据。仅当前页面暂存、尚未提交的输入不等于已保存记录，请先处理；具体内容以恢复包为准。
                        </p>
                      </div>
                      <button
                        type="button"
                        className="study-secondary-action"
                        disabled={!accountWorkspaceId || !storageReady || !sessionResolved}
                        onClick={() => void handleExportRecovery()}
                      >
                        导出恢复数据包
                      </button>
                    </div>
                  </section>
                </div>
              )}

              {/* 7. 高级与危险区面板（隔离破坏性操作） */}
              {activeSection === "danger" && (
                <div className="settings-content-pane">
                  <div className="settings-section-header">
                    <h3>维护与公告</h3>
                    <p>查看更新；遇到题目显示异常时，可先检查再修复</p>
                  </div>

                  {/* 破坏性缓存清理卡片 - 红色视觉隔离 */}
                  <section className="settings-card settings-card-danger">
                    <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500 shrink-0" aria-hidden="true">
                            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                            <line x1="12" x2="12" y1="9" y2="13"/>
                            <line x1="12" x2="12.01" y1="17" y2="17"/>
                          </svg>
                          <h4 className="font-bold text-sm text-red-700 dark:text-red-400">
                            修复题目显示 · 会清理读取缓存
                          </h4>
                        </div>
                        <p className="text-xs text-[var(--ink)] opacity-70 leading-relaxed max-w-xl mb-2">
                          此操作清理题目读取缓存与临时视图，不是删除云端记录或原笔记。请先处理未提交作答；系统会先核对能否安全清理，不能清理时请按弹窗提示处理。
                        </p>
                      </div>
                      <button
                        type="button"
                        className="px-4 py-2 rounded-xl bg-red-600 text-white font-bold text-xs hover:bg-red-700 active:scale-95 transition-all disabled:opacity-50 shrink-0"
                        disabled={!accountWorkspaceId || !storageReady || !sessionResolved}
                        onClick={requestClearCache}
                      >
                        清理读取缓存…
                      </button>
                    </div>
                  </section>

                  {/* 版本与系统诊断报告 */}
                  <section className="settings-card">
                    <ReleaseSupport companionVersion={companionVersion} />
                  </section>

                  {/* 更新公告回看 */}
                  <section className="settings-card flex items-center justify-between">
                    <div>
                      <h4 className="font-bold text-sm text-[var(--ink)] mb-1">产品更新日志</h4>
                      <p className="text-xs text-[var(--ink)] opacity-60">
                        随时主动重新查看当前版本的更新公告与特性变化
                      </p>
                    </div>
                    <div className="release-recall-row">
                      <ShowReleaseAnnouncementButton/>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>

          {/* 浮层与弹窗组件 */}
          <KnowledgeStarterDialog
            open={starterOpen}
            onClose={() => setStarterOpen(false)}
            onConnect={() => {
              setTab("sources");
              handleSelectSection("sources");
              requestAnimationFrame(() =>
                document.getElementById("note-source-entry")?.scrollIntoView({ block: "start" })
              );
            }}
          />

          <SettingsActionDialog
            kind={settingsActionOwner === accountWorkspaceId ? settingsModal : null}
            message={settingsActionMessage}
            onClose={dismissSettingsModal}
            onConfirm={() => void handleClearCacheConfirmed()}
          />

          {data.message && (
            <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 rounded-2xl">
              <p className="text-sm font-bold text-amber-800 dark:text-amber-500">
                {data.message}
              </p>
            </div>
          )}
        </section>}
    </>
  );
}
