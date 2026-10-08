"use client";
import { ChangeEvent,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore } from "react";
import {useSubjectRoundSessions} from '../use-subject-round-sessions';
import {createRestartBatch} from '../restart-batch';
import {useSyncCoordinator,useSyncTriggers,useLegacyCloud} from '../../src/features/sync';
import {useAccountSource,useConnectionValue,useCompanionSource,useSourceTransitions,useSourceMaintenance,useSourceReader,useSourceChanges} from '../../src/features/sources';
import {createCompanionHttp} from '../../src/infrastructure/sources';
import {readWorkspaceSnapshot,WorkspaceReadError,type CompanionNotice} from '../../src/application/sources';
import {updateCompanionReadMessage,usableCompanionSource} from '../../src/domain/sources';
import {prepareAccountSource,projectAccountSource} from './account-source-adapter';
import {migrateLegacyBaselines,type SyncFrame,type SyncNotice} from '../../src/application/sync';
import {drainOriginalEventTargets} from './sync-adapter';
import {readSyncDiagnostics} from './sync-diagnostics-adapter';
import {createDashboardEventDispatcher} from './event-dispatch-adapter';

import {confirmStudyNavigation,prepareStudyNavigation} from '../study-navigation-guard';
import { resolveLegacyPlanningVisibility,shouldUseCaughtUpPage } from "../account-plan-ui";
import { createAccountStudyClient,type AccountStudyLoaded } from "../account-study-client";
import { accountLoadLabel,readStudyIdentity,type AccountLoadStatus } from "../account-study-load-state";
import { accountStudyPayload } from "../account-study-payload";
import { toEngineTaskPlan,type CloudTaskPlanV1 } from "../account-study-planning";
import { composeAccountPlanningInput } from "../account-study-planning-projection";
import { projectAccountProgress,saveAccountProgress,type AccountProgressView } from "../account-study-progress";
import {readWorkspaceSource} from './workspace-source-adapter';
import { createAccountTaskRecord,flushAccountStudyRecords } from "../account-study-record-client";
import { resolveAccountModuleSource,resolveAccountStudyItem,type TaskModuleScope } from "../account-study-runtime";
import {practiceGroupNavigation,practiceSelectionScope} from '../study-practice-groups';
import { studyAIPageContext } from "../ai/study-ai-page-context";
import { createAccountStudyAIService,createLocalStudyAIService } from "../ai/study-ai-service";
import type { StudyAIScope,StudyAIService } from "../ai/study-ai-types";
import { useAccountAILibrary } from "../ai/use-account-ai-library";
import type { AssistanceObservation } from "../assistance-summary";
import { gradeCalculationInWorker } from "../calculation-client";
import {restoreLegacySnapshot,foldCoreReceiptNotice,applyTargetNotice,type RecentStudyReceipts,type CloudLearningEvent,type CloudSyncMetadata,type CloudSyncSnapshot} from '../../src/domain/sync';
import { companionSessionRecordKey,sessionForEndpoint } from "../companion-endpoint";
import {
createCompanionPlanClient,
type ChangeCandidate,
type ConstraintDocument,
type ConstraintMode,
type PendingCapture,

type PracticeItem,
} from "../companion-plan-client";
import type { PlanInput } from "../daily-plan";
import { buildDueReviewItems } from "../due-review-items";
import {
buildDynamicUiModel,
mergeModuleCatalog,
moduleProgressSummary,
normalizeDynamicSubjects,
resolveDynamicTab,
resolveEventAbilityId,
resolveStudyItemProgressKey,
stableStudyItemKey,
type ModuleSummary
} from "../dynamic-ui-model";
import { createLearningDraftStore,learningDraftItemId } from "../learning-draft-store";
import { accuracyByKey,riskRanking } from "../learning-metrics";
import { clearLocalAccountStudy,getLocalStudyRecord } from "../local-account-study";
import { loadLongTermPlanState,saveLongTermPlanState } from "../local-long-term-plan";
import { PlanningOfflineError,loadPlanningCache } from "../local-planning-cache";
import { clearAccountWorkspaceRecords,loadWorkspaceRecord,saveWorkspaceRecord,workspaceIdForUser } from "../local-study-db";
import { listLocalItemEvents,putLocalStudyEvent,updateStudyEventDelivery,type LocalStudyEventRecord } from "../local-study-events";
import { syncTaskEvents } from "../local-task-events";
import { previewLongTermPlan } from "../long-term-editor-model";
import { buildLongTermEditorSource } from "../long-term-editor-source";
import {useAutomaticPlanning,usePlanningNavigation,useLegacyPlanning,useLegacyPlanState,useStudyDayClock} from "../../src/features/planning";
import {createPlanningSourceAdapter,resolvePlanningGroups,type NavigationContext,type AccountNavigationQuery} from './planning-source-adapter';
import {readDashboardBoundHistory} from "./bound-history-adapter";
import { applySavedNativeAttempt,nativeProgressView,nativeSourceScope,type NativeProjection } from "../native-progress-view";
import { readNativeStudyHistory } from "../native-study-history";
import { createPaperLibraryClient } from "../paper-library-client";
import type { PaperWord } from "../paper-study";
import { createPaperVocabularyClient } from "../paper-vocabulary-client";
import { PAPER_VOCABULARY_TARGET,matchPaperVocabulary,type PaperVocabularyReadback } from "../paper-vocabulary-ingest";
import { buildPlanInput,defaultPlanSettings,type PlanDeadline,type StoredPlanSettings } from "../plan-input-builder";
import { loadPlannedPractice,resolvePlanPractice,selectEffectivePlan,selectPlannedPractice,studySubjectsWithPractice } from "../plan-runtime";
import { loadPlanningRecords } from "../planning-context";
import {
emptyPluginOverrides,

isPluginType,
isVocabularySubject,
normalizePluginOverrides,
prunePluginOverrides,
type ItemPluginOverride,
type PluginOverrides,
type PluginType
} from "../plugin-routing";
import { type PracticeAttempt,type PracticeSummary,type PracticePersistenceContext } from "../practice-session";

import { rebuildEventProgress } from "../review-projection";
import { sandboxVisibleSubjects } from "../sandbox-pacing";
import { createLegacyBaselineEvents,recordStudyAttempt,type StudyAttemptInput } from "../study-event-controller";
import type { LocalEventContext,StudyEventV3 } from "../study-event-v3";
import { orderProgressModules } from "../study-progress-model";
import { exportStudyRecovery } from "../study-recovery-export";
import { countSettingsPractice,settingsAccountConnection,settingsAiConnection,settingsCompanionConnection,settingsPendingSummary } from "../study-settings-model";
import { captureSubmissionFrame,persistOriginalSubmission,prepareStudySubmission,type StudySubmissionFrame } from "../study-submission";
import { readAccountLocalPractice } from "../study-submission-history";
import { createSubmissionJournal,persistStudySubmission,type StudySubmissionV1 } from "../study-submission-journal";
import { createSubmissionTransport,type AuxiliaryDelivery } from "../study-submission-transport";
import { serverStudyTheme,studyThemePreference } from "../study-theme";
import { clearItemStages,emptySubjectRound,focusRound,isSubjectRoundComplete } from "../subject-round";
import { supportsTaskPlanning,type PlanningCatalog,type TaskPlanV2 } from "../task-plan-types";
import {assertPlanningStudySources,studyDay} from '../../src/domain/planning';
import { buildDailyPlanningInput } from "../task-planning-input";
import type { TaskPlanningBundle } from "../task-planning-session";
import { useAccountDailyPlan } from "../use-account-daily-plan";
import { useAssistanceHistory } from "../use-assistance-history";
import { useLongTermPlan,type LongTermPlanTransport } from "../use-long-term-plan";
import { useTaskPlanning } from "../use-task-planning";
import { createVaultMappingClient } from "../vault-mapping-client";
import { firstIncompleteGroup,migrateSubjectPacing,pacingForSubject,resolveServedGroup,selectPlanGroup,snapshotServedGroup,splitGroupBounds,type SubjectPacing,type VocabPacingState } from "../vocab-pacing";
import { CompanionSession,Connection,DailyDashboard,EMPTY_CAPABILITIES,EMPTY_GATEWAY_EVENTS,PendingActivity,Progress,SessionUser,SettingsOverviewState,SourceView,StudyItem,StudyPayload,Subject,authorityFromPlanSettings,companionReconnectMs,companionUrl,createEventId,dailySyncMs,domainForSubject,emptyCloudSyncMetadata,emptyProgress,fallbackData,hasProgressData,itemKindForDomain,itemLabel,markdownNotePath,nativeLongTermSnapshot,normalizeProgress,planSettingsFromAuthority,resolvableNotePath,scopeStudyPayload } from "./prelude";

export function useDashboardController(){
  const theme=useSyncExternalStore(studyThemePreference.subscribe,studyThemePreference.getSnapshot,serverStudyTheme);
  const setTheme=studyThemePreference.set;
  const [tab, setTab] = useState<string>("today");
  const [accountAiEntryOwner,setAccountAiEntryOwner]=useState<string|null>(null);
  const [sourceView, setSourceView] = useState<SourceView>("overview");
  const [settingsOverview,setSettingsOverview]=useState<SettingsOverviewState|null>(null);
  const settingsReadEpoch=useRef(0);
  const [curationIndex, setCurationIndex] = useState(0);
  const [curationCategory, setCurationCategory] = useState<string>("words");
  const [progressView, setProgressView] = useState<string>("");
  const [data, setData] = useState<StudyPayload>(fallbackData);
  const [syncState, setSyncState] = useState<StudyPayload["status"]>("offline");

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [nativeProjection,setNativeProjection]=useState<NativeProjection|null>(null);
  const nativeProjectionRef=useRef(nativeProjection);useLayoutEffect(()=>{nativeProjectionRef.current=nativeProjection;},[nativeProjection]);
  const [nativeHistoryError,setNativeHistoryError]=useState('');
  const [accountLoaded,setAccountLoaded]=useState<AccountStudyLoaded|null>(null);
  const [accountProgress,setAccountProgress]=useState<AccountProgressView|null>(null);
  const [lastStudyReceipts,setLastStudyReceipts]=useState<RecentStudyReceipts>({});
  const [progressEvents, setProgressEvents] = useState<StudyEventV3[]>([]);
  const [workspaceId, setWorkspaceId] = useState("guest:local");
  const [eventRevision, setEventRevision] = useState(0);
  const eventMutation = useRef(0);
  const eventProjection = useRef<{workspaceId:string;itemStages:Progress['itemStages'];fsrsData:NonNullable<Progress['fsrsData']>} | null>(null);
  const noteEventsChanged = useCallback(() => {eventMutation.current++; setEventRevision(value=>value+1);}, []);
  const [demoPacingIds,setDemoPacingIds]=useState<string[]|null>(null);
  const [demoProgress, setDemoProgress] = useState<Progress>(emptyProgress);
  const [itemIndices, setItemIndices] = useState<Record<string, number>>({});
  // 同词重出计数：三阶段只剩一个未完成词且判 again 时，nextIndex===currentIndex，
  // key 不变会导致插件状态零变化（按钮看似失灵）；bump 强制重挂载给出反馈。
  const [stageRoundBump, setStageRoundBump] = useState(0);
  // 本轮状态（会话内）：非词汇模块用它跳过已答对的题并在全部答对时出结束
  // 界面；词汇模块只用它的 resets 统计（完成判定读持久化的阶段值）。
  // Task rounds are restored after the day/workspace identity is known below.
  const setItemIndex = (subjectId: string, index: number) => setItemIndices((current) => ({ ...current, [subjectId]: index }));
  const setItemPluginOverride = (itemKey: string, value: string) => {
    setPluginOverrides((current) => {
      const item = { ...current.item };
      if (value === "ai" || isPluginType(value)) item[itemKey] = value as ItemPluginOverride;
      else delete item[itemKey];
      return { ...current, item };
    });
  };
  const [pendingActivities, setPendingActivities] = useState<PendingActivity[]>([]);
  const [cloudOutbox, setCloudOutbox] = useState<CloudLearningEvent[]>([]);
  const [cloudSyncMetadata, setCloudSyncMetadata] = useState<CloudSyncMetadata>(emptyCloudSyncMetadata);
  const [pluginOverrides, setPluginOverrides] = useState<PluginOverrides>(emptyPluginOverrides);
  const [moduleCatalog, setModuleCatalog] = useState<ModuleSummary[]>([]);
  const currentDay = useStudyDayClock();
  const {subjectRounds,setSubjectRounds,activateSubjectRound,getSubjectRound,getVisibleSubjectRound}=useSubjectRoundSessions(workspaceId,currentDay);
  const [cloudStatus, setCloudStatus] = useState<"guest" | "checking" | "needs-migration" | "syncing" | "synced" | "local-only" | "error">("checking");

  const isDemoMode = data.contentMode === "demo" || (
    data.contentMode === undefined
    && !data.syncedAt
    && /ImageNet Classification with Deep Convolutional Neural Networks|AlexNet/i.test(data.source.title)
  );
  const scopedAccountProgress=accountLoaded&&accountProgress?.workspaceId===workspaceId&&accountProgress.libraryId===accountLoaded.bundle.snapshot.libraryId?accountProgress:null;
  const nativeScope=useMemo(()=>nativeSourceScope(workspaceId,data),[workspaceId,data]);
  const nativeView=useMemo(()=>nativeProgressView(progress,nativeProjection,{workspaceId,sourceScope:nativeScope}),[progress,nativeProjection,workspaceId,nativeScope]);
  const uiProgress = isDemoMode ? demoProgress : accountLoaded ? scopedAccountProgress?.progress??emptyProgress : nativeView.progress;
  const activeProject = data.dashboard?.activeProjects?.[0];
  const normalizedSubjects = useMemo<Subject[]>(() => {
    if (data.gateway && data.gateway.workspaceId !== workspaceId) return [];
    const current = studySubjectsWithPractice(normalizeDynamicSubjects(data.subjects),data.practiceItems ?? []) as Subject[];
    if (data.gateway?.mode === 'indexed') return current;
    const hasDueReview = current.some((subject) => subject.domain === "differential-review");
    if (hasDueReview) return current;

    const dueItems = buildDueReviewItems(data.dashboard?.dueReviews) as StudyItem[];
    return dueItems.length === 0 ? current : [...current, { id: "due-reviews", name: "到期差分复习", pluginType: "flashcard", domain: "differential-review", items: dueItems }];
  }, [data.dashboard?.dueReviews, data.subjects, data.practiceItems, data.gateway, workspaceId]);


  const [cloudMessage, setCloudMessage] = useState("");


  const cloudRetryToken=0;
  const [importMessage, setImportMessage] = useState("");

  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const [sessionResolved, setSessionResolved] = useState(false);
  const [workspacePhase,setWorkspacePhase]=useState<'checking-identity'|'loading-local'|'ready'|'identity-error'|'storage-error'>('checking-identity');
  const [identityRetry,setIdentityRetry]=useState(0);
  const [storageReady, setStorageReady] = useState(false);
  const [companionSession,setCompanionSession,getCompanionSession]=useConnectionValue<CompanionSession|null>(null);
  const [accountPreferred,setAccountPreferred]=useState(false);
  const [accountOptedOut,setAccountOptedOut]=useState(false);
  const accountWanted=accountPreferred&&!accountOptedOut,accountIntentRef=useRef(accountWanted);
  const progressHistoryReady=isDemoMode||(accountLoaded?scopedAccountProgress?.historyReady===true:!accountWanted&&nativeView.ready&&nativeView.unresolvedKeys.length===0&&!nativeHistoryError);
  useLayoutEffect(()=>{accountIntentRef.current=accountWanted;},[accountWanted]);
  const [accountProbeRetry,setAccountProbeRetry]=useState(0);
  const [accountReadStatus,setAccountReadStatus]=useState<AccountLoadStatus>({phase:'idle'});
  const [accountReadPaused,setAccountReadPaused]=useState(false);
  const [studySourceEpoch,setStudySourceEpoch]=useState(0);
  const [accountQuestionAiHydrated,setAccountQuestionAiHydrated]=useState(false);
  const [accountDeviceId,setAccountDeviceId]=useState('');
  const [companionVersion,setCompanionVersion]=useState<string|null>(null);
  const [companionDetected, setCompanionDetected] = useState<"unknown" | "checking" | "online" | "offline">("unknown");
  const [companionRetryToken, setCompanionRetryToken] = useState(0);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingMessage, setPairingMessage] = useState("");
  const todayLabel = currentDay.replaceAll('-', ' / ');
  const paperLibraryClient=useMemo(()=>companionSession?createPaperLibraryClient(companionUrl,companionSession.token):undefined,[companionSession]);
  const companionHeaders = useMemo(() => companionSession ? {
    "X-Study-Loop-Session": companionSession.token,
  } as Record<string, string> : {} as Record<string, string>, [companionSession]);
  const accountClient=useMemo(()=>createAccountStudyClient({companionUrl,sessionToken:companionSession?.token,expectedUserId:sessionUser?.userId}),[companionSession,sessionUser?.userId]);
  const accountWorkspaceId=useMemo(()=>sessionUser?`account:${sessionUser.userId}`:null,[sessionUser]);
  const submissionJournal=useMemo(()=>createSubmissionJournal(),[]);
  const [freeStudySubject,setFreeStudySubject]=useState<string|null>(null);
  const accountLibraryId=accountLoaded?.bundle.snapshot.libraryId??null;
  const accountAILibrary=useAccountAILibrary(sessionUser?.userId??null,accountClient);
  const aiLibraryId=accountLibraryId??accountAILibrary.libraryId;
  const [aiEntryOpen,setAiEntryOpen]=useState(false);
  const nativeLibraryId=!accountWanted&&!isDemoMode?data.localLibraryId??null:null;
  const nativeLongTermLibraryId=nativeLibraryId&&data.gateway?.mode==='indexed'&&supportsTaskPlanning(companionSession?.capabilities??[])?nativeLibraryId:null;
  const studyAI=useMemo<{scope:StudyAIScope;service:StudyAIService}|null>(()=>{
    if(accountWorkspaceId&&aiLibraryId&&(accountWanted||!companionSession||!nativeLibraryId))return {scope:{ownerId:accountWorkspaceId,libraryId:aiLibraryId,mode:'account'},service:createAccountStudyAIService(createAccountStudyClient({companionUrl,expectedUserId:accountWorkspaceId.slice(8),libraryId:aiLibraryId}))};
    if(!accountWanted&&companionSession&&nativeLibraryId)return {scope:{ownerId:workspaceId,libraryId:nativeLibraryId,mode:'local'},service:createLocalStudyAIService({baseUrl:companionUrl,token:companionSession.token,libraryId:nativeLibraryId})};
    return null;
  },[accountWorkspaceId,aiLibraryId,accountWanted,companionSession,nativeLibraryId,workspaceId]);
  const longTermScopeKey=accountWorkspaceId&&accountLibraryId?JSON.stringify([accountWorkspaceId,accountLibraryId]):nativeLongTermLibraryId?JSON.stringify([workspaceId,nativeLongTermLibraryId]):null;
  const longTermTransport=useMemo<LongTermPlanTransport|null>(()=>{
    if(accountWorkspaceId&&accountLibraryId){
      const client=createAccountStudyClient({companionUrl,expectedUserId:accountWorkspaceId.slice(8),libraryId:accountLibraryId});
      return{read:()=>client.getLongTermPlanState(),write:mutation=>client.mutateLongTermPlan(mutation)};
    }
    if(!storageReady||!nativeLongTermLibraryId)return null;
    const scope={workspaceId,libraryId:nativeLongTermLibraryId};return{read:()=>loadLongTermPlanState(scope),write:mutation=>saveLongTermPlanState(scope,mutation)};
  },[accountWorkspaceId,accountLibraryId,storageReady,nativeLongTermLibraryId,workspaceId]);
  const longTerm=useLongTermPlan(longTermScopeKey,longTermTransport);
  const [longTermOpenRequest,setLongTermOpenRequest]=useState<{scope:string|null;version:number}|null>(null);
  const openLongTermFromToday=useCallback(()=>setLongTermOpenRequest(current=>({scope:longTermScopeKey,version:(current?.version??0)+1})),[longTermScopeKey]);
  const [longTermEditing,setLongTermEditing]=useState(false),[starterOpen,setStarterOpen]=useState(false);


  const mappingClient=useMemo(()=>companionSession?createVaultMappingClient({companionUrl,sessionToken:companionSession.token}):null,[companionSession]);
  const accountLoadedRef=useRef<AccountStudyLoaded|null>(null);useLayoutEffect(()=>{accountLoadedRef.current=accountLoaded;},[accountLoaded]);
  const accountBundlesRef=useRef(new Map<string,AccountStudyLoaded['bundle']>());
  const accountAttemptActiveRef=useRef(false);
  const canPrepareAccountDay=useCallback(()=>!accountAttemptActiveRef.current,[]);
  const accountDailyPlan=useAccountDailyPlan(accountClient,accountLoaded,currentDay,accountWorkspaceId,{
    canPrepare:canPrepareAccountDay,
  });
  const accountAiRequestIds=useRef(new Map<string,string>());
  const accountModeEpoch=useRef(0);
  const sourceTransitionBusy=useRef<()=>boolean>(()=>false);

  const accountProbeRef=useRef('');
  const taskWorkspaceRef=useRef(workspaceId),taskStudyDataRef=useRef(data);
  const pendingLocalSourceRef=useRef<{workspaceId:string;payload:StudyPayload}|null>(null);
  const [localSourcePending,setLocalSourcePending]=useState(false);
  const applyLocalStudySource=useCallback((payload:StudyPayload,requestedWorkspace:string,notify=true)=>{
    if(requestedWorkspace!==taskWorkspaceRef.current||accountLoadedRef.current||accountIntentRef.current||sourceTransitionBusy.current())return false;
    if(accountAttemptActiveRef.current){pendingLocalSourceRef.current={workspaceId:requestedWorkspace,payload};setLocalSourcePending(true);return false;}
    const scoped=scopeStudyPayload(payload,requestedWorkspace);taskStudyDataRef.current=scoped;setData(scoped);if(notify)setStudySourceEpoch(value=>value+1);pendingLocalSourceRef.current=null;setLocalSourcePending(false);return true;
  },[]);
  const applyLocalDashboard=useCallback((dashboard:DailyDashboard,requestedWorkspace:string)=>{
    if(requestedWorkspace!==taskWorkspaceRef.current||accountLoadedRef.current)return;
    const pending=pendingLocalSourceRef.current?.workspaceId===requestedWorkspace?pendingLocalSourceRef.current:null;
    applyLocalStudySource({...pending?.payload??taskStudyDataRef.current,dashboard},requestedWorkspace,Boolean(pending));
  },[applyLocalStudySource]);
  useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)setAccountQuestionAiHydrated(false);});if(accountWorkspaceId)void loadWorkspaceRecord<Record<string,string>>(accountWorkspaceId,'account-question-ai-requests',{}).then(value=>{if(active){accountAiRequestIds.current=new Map(Object.entries(value));setAccountQuestionAiHydrated(true);}});return()=>{active=false;};},[accountWorkspaceId]);


  const companionHttp=useMemo(()=>createCompanionHttp<StudyPayload>(companionUrl),[]);
  const publishCompanionNotice=(notice:CompanionNotice<CompanionSession,StudyPayload>)=>{
    if(notice.kind==='detect-start'){setCompanionDetected('checking');setPairingMessage('正在检测这台电脑上的 Companion…');}
    else if(notice.kind==='pair-start')setPairingMessage('正在建立本机配对…');
    else if(notice.kind==='detected'){
      setCompanionVersion(notice.version);setCompanionDetected('online');
      setCompanionSession(current=>current?{...current,capabilities:notice.capabilities}:current);
      setPairingMessage(notice.paired?'Companion 已连接，正在读取学习资料…':'已找到已有 Companion。请输入它窗口里显示的一次性配对码，不需要重新下载。');
      if(notice.paired)setCompanionRetryToken(value=>value+1);
    }else if(notice.kind==='paired'){setCompanionSession(notice.connection);setCompanionDetected('online');setSyncState('connected');setPairingCode('');setPairingMessage('已绑定当前账号；学习资料只在这台设备处理。');}
    else if(notice.kind==='expired'){setCompanionSession(null);setCompanionDetected('online');setSyncState('offline');setPairingMessage('本机会话已失效，请用 Companion 窗口中的新配对码重新连接。');}
    else if(notice.kind==='source'){setCompanionDetected('online');setSyncState(notice.payload.status);setPairingMessage(current=>notice.background?updateCompanionReadMessage(current,notice.message):notice.message);}
    else if(notice.kind==='message')setPairingMessage(notice.message);
    else if(notice.kind==='error'){
      if(notice.operation==='detect'){setCompanionDetected('offline');setCompanionVersion(null);setPairingMessage(notice.message);}
      else if(notice.operation==='pair')setPairingMessage(notice.message);
      else{setCompanionDetected(notice.online?'online':'offline');setSyncState(notice.online?'error':'offline');setPairingMessage(current=>notice.operation==='poll'&&!notice.online?updateCompanionReadMessage(current,notice.message):notice.message);}
    }
  };
  const companionSource=useCompanionSource({scope:JSON.stringify([workspaceId,companionUrl]),connection:companionSession,retry:companionRetryToken,retryMs:companionReconnectMs,
    capture:()=>{const owner=workspaceId,epoch=accountModeEpoch.current,connection=companionSession;return{key:owner,connection,current:()=>taskWorkspaceRef.current===owner&&accountModeEpoch.current===epoch&&getCompanionSession()===connection,user:sessionUser,code:pairingCode,account:()=>Boolean(accountLoadedRef.current||accountIntentRef.current)};},
    health:(_frame,signal)=>companionHttp.health(signal),pair:(frame,signal)=>companionHttp.pair({user:frame.user!,code:frame.code},signal),
    source:(frame,kind,signal)=>companionHttp.source(frame.connection!,kind,signal),publish:publishCompanionNotice,
    apply:(payload)=>applyLocalStudySource(payload,workspaceId),flushActivities:()=>flushPendingActivities(),
  });
  const detectExistingCompanion=companionSource.detect,pairCompanion=companionSource.pair,refreshSources=companionSource.refresh,refreshing=companionSource.busy.refresh;
  const accountSources=useAccountSource({scope:JSON.stringify([accountWorkspaceId,currentDay,accountDeviceId]),client:accountClient,
    capture:()=>{const owner=accountWorkspaceId??'',epoch=accountModeEpoch.current;return{key:JSON.stringify([owner,epoch]),owner,modeEpoch:epoch,ready:storageReady&&sessionResolved,
      identity:sessionUser,local:accountOptedOut,paused:accountReadPaused,current:()=>Boolean(owner&&owner===taskWorkspaceRef.current&&epoch===accountModeEpoch.current&&!sourceTransitionBusy.current()),
      studying:()=>accountAttemptActiveRef.current,mutation:()=>eventMutation.current,visible:()=>accountLoadedRef.current,client:accountClient};},
    version:value=>({libraryId:value.bundle.snapshot.libraryId,snapshotId:value.bundle.snapshot.snapshotId,revision:value.bundle.snapshot.revision,eventThrough:value.eventThrough,taskThrough:value.taskThrough,observedAt:value.facts.observedAt}),
    prepare:async(frame,value,current)=>{const receipts=await prepareAccountSource(frame.owner,value,current);if(current())for(const bundle of value.bundles)accountBundlesRef.current.set(bundle.snapshot.snapshotId,bundle);return receipts;},
    project:(frame,value)=>projectAccountSource(frame.owner,value,{day:currentDay,deviceId:accountDeviceId,journal:submissionJournal}),
    receipts:(frame,receipts)=>setLastStudyReceipts(current=>receipts.reduce((notice,receipt)=>foldCoreReceiptNotice(notice,frame.owner,receipt),current)),
    status:(_frame,status)=>setAccountReadStatus(status),clear:()=>setAccountLoaded(null),
    identityChanged:()=>{accountModeEpoch.current++;setSessionResolved(false);setStorageReady(false);setWorkspacePhase('identity-error');accountLoadedRef.current=null;setAccountLoaded(null);setData(fallbackData);},
    publish:(frame,value,result)=>{
      const {projection,history,evidenceHash,pendingKeys,pendingIds,cachedProgress}=result,sameLibrary=accountLoadedRef.current?.bundle.snapshot.libraryId===value.bundle.snapshot.libraryId;
      accountLoadedRef.current=value;setAccountPreferred(true);setAccountOptedOut(false);setAccountLoaded(value);pendingLocalSourceRef.current=null;setLocalSourcePending(false);
      setAccountReadStatus(current=>({...current,deferred:false}));
      const projected=projection?{...emptyProgress,itemStages:projection.itemStages,fsrsData:projection.fsrsData}:null;
      setAccountProgress(current=>projectAccountProgress(current,cachedProgress,{workspaceId:frame.owner,libraryId:value.bundle.snapshot.libraryId,progress:projected,evidenceHash,historyReady:Boolean(projection)},sameLibrary?pendingKeys:new Set()));
      if(projection)setProgressEvents(current=>[...new Map([...history,...(sameLibrary?current.filter(event=>pendingIds.has(event.eventId)):[])].map(event=>[event.eventId,event])).values()]);
      setData(accountStudyPayload(value,frame.owner) as unknown as StudyPayload);noteEventsChanged();
    },now:()=>new Date().toISOString(),
  });
  const applyAccountLoaded=accountSources.apply,refreshAccountRead=accountSources.read,cancelAccountRead=accountSources.cancel;
  const accountPendingLoadedRef=useMemo(()=>({get current(){return accountSources.getPending();}}),[accountSources.getPending]);
  const readAccountAgain=useCallback(async(rebuild=false)=>{
    if(rebuild)await accountClient.clearReadCache();const value=await refreshAccountRead({enable:true});
    if(value){accountProbeRef.current=workspaceId;setAccountReadPaused(false);}return value;
  },[accountClient,refreshAccountRead,workspaceId]);

  const homeHref=new URL(companionUrl).port==='43121'?'/':'/?companionPort='+new URL(companionUrl).port;
  const companionCapabilities=companionSession?.capabilities??EMPTY_CAPABILITIES;
  const deliveryOwnerRef=useRef('');useLayoutEffect(()=>{deliveryOwnerRef.current=storageReady&&sessionResolved?workspaceId:'';},[storageReady,sessionResolved,workspaceId]);
  const submissionTransport=useCallback(()=>createSubmissionTransport({workspaceId,journal:submissionJournal,isCurrent:()=>deliveryOwnerRef.current===workspaceId,
    companion:companionSession?{url:companionUrl,sessionToken:companionSession.token,capabilities:companionCapabilities}:null}),[workspaceId,submissionJournal,companionSession,companionCapabilities]);
  const [auxiliaryDelivery,setAuxiliaryDelivery]=useState<{workspaceId:string;eventId:string;state:AuxiliaryDelivery|'pending'|'not-saved'}|null>(null);
  const assistanceHistory=useAssistanceHistory({workspaceId,ready:storageReady&&sessionResolved&&!isDemoMode&&(!accountWanted||Boolean(accountLoaded)),account:accountLoaded,revision:eventRevision});
  const captureAttemptFrame=useCallback((item:{contentHash?:string;fingerprint?:string;localBindingHash?:string;accountItemKey?:string;abilityId?:string;itemId?:string},mode:PluginType,stage:number):StudySubmissionFrame=>{
    const account=accountLoadedRef.current;
    if(account){const {bundle}=resolveAccountStudyItem({...account,bundles:[...accountBundlesRef.current.values()]},item);
      const old=progressEvents.filter(event=>event.eventType==='practice-attempt'&&event.item.key===(item.accountItemKey??item.abilityId??item.itemId)&&event.attempt.stageAfter===stage).at(-1);
      return captureSubmissionFrame({kind:'account',bundle,practiceMode:mode,originDeviceId:accountDeviceId,...(mode==='three-stage'&&(stage===1||stage===2)?{legacyResume:{stage,anchorEventId:old?.eventId??null,anchorCoreHash:old?.coreHash??null}}:{})});}
    return captureSubmissionFrame({kind:'local',practiceMode:mode,contentHash:item.contentHash??item.fingerprint,localBindingHash:item.localBindingHash});
  },[accountDeviceId,progressEvents]);
  const persistSubmittedEvent=useCallback(async(record:LocalStudyEventRecord,frame:StudySubmissionFrame,observation:AssistanceObservation|null)=>{
    const payload=await prepareStudySubmission(record,frame,observation,submissionJournal),saved=await persistStudySubmission(payload,{journal:submissionJournal,persistCore:persistOriginalSubmission});
    if(deliveryOwnerRef.current===record.workspaceId){
      setAuxiliaryDelivery({workspaceId:record.workspaceId,eventId:record.eventId,state:observation?(saved.auxiliarySaved?'pending':'not-saved'):'unknown'});
      setLastStudyReceipts({workspaceId:record.workspaceId,eventId:record.eventId,libraryId:payload.route.kind==='account'?payload.route.record.libraryId:undefined,cloud:saved.mirror==='conflict'?'conflict':record.cloud==='pending'?'pending':undefined,companion:payload.route.kind==='account'||record.companion==='pending'?'pending':undefined});
      if(saved.mirror==='conflict'||saved.mirror==='failed')setCloudMessage('原作答已经保存，但本机副本存在异常；已暂停这条记录的同步，请核对。不要重新评分。');
      else if(saved.mirror==='pending')setCloudMessage(saved.localMetadataSaved?'原作答与恢复日志已保存；备用副本暂不可用，恢复后可重建。':'原作答核心与题目关联已保存；辅助摘要和本机诊断没有完整保存。');
    }
    return payload;
  },[submissionJournal]);

  const draftScopeKey=JSON.stringify([workspaceId,isDemoMode?'demo':accountLoaded?'account':'local',accountLoaded?.bundle.snapshot.libraryId??data.source.path??null]);
  const learningDrafts=useMemo(()=>createLearningDraftStore(draftScopeKey),[draftScopeKey]);
  // Lifecycle changes only, never keystrokes. A committed sibling mode must get
  // a fresh adapter even when its item, stage and existing Plugin key stay put.
  useSyncExternalStore(learningDrafts.subscribe,learningDrafts.getSnapshot,()=>0);
  const activeLearningDraftsRef=useRef(learningDrafts),visibleLearningRef=useRef<string|null>(null);
  useLayoutEffect(()=>{if(activeLearningDraftsRef.current!==learningDrafts)activeLearningDraftsRef.current.dispose();activeLearningDraftsRef.current=learningDrafts;},[learningDrafts]);
  useLayoutEffect(()=>{taskWorkspaceRef.current=workspaceId;taskStudyDataRef.current=data;},[workspaceId,data]);
  const taskPlanningEnabled=supportsTaskPlanning(companionCapabilities) && data.gateway?.mode==='indexed' && !isDemoMode && !accountLoaded&&!accountWanted;
  const legacyPlanningVisibility=resolveLegacyPlanningVisibility({accountMode:Boolean(accountLoaded)||accountWanted,taskPlanningEnabled,companionConnected:Boolean(companionSession),indexed:data.gateway?.mode==='indexed'});
  useEffect(()=>{
    if(!companionSession) return;
    let active=true;
    void fetch(`${companionUrl}/v1/health`,{cache:'no-store',signal:AbortSignal.timeout(3000)}).then(async response=>{
      if(!response.ok) return;
      const health=await response.json() as {capabilities?:unknown;serverVersion?:unknown};
      if(active&&typeof health.serverVersion==='string'&&health.serverVersion.startsWith('StudyLoopCompanion/'))setCompanionVersion(health.serverVersion.slice('StudyLoopCompanion/'.length));
      const capabilities=Array.isArray(health.capabilities)?health.capabilities.filter((value):value is string=>typeof value==='string'):[];
      if(active) setCompanionSession(current=>current?.token===companionSession.token && JSON.stringify(current.capabilities??[])!==JSON.stringify(capabilities)?{...current,capabilities}:current);
    }).catch(()=>{});
    return ()=>{active=false;};
  },[companionSession,companionRetryToken]);
  const companionPlanClient = useMemo(() => companionSession ? createCompanionPlanClient({
    baseUrl: companionUrl,
    sessionToken: companionSession.token,
    capabilities:companionCapabilities,
  }) : null, [companionSession,companionCapabilities]);
  const updatePendingActivities = useCallback((updater: (current: PendingActivity[]) => PendingActivity[]) => {
    setPendingActivities((current) => updater(current));
  }, [setPendingActivities]);
  const sendActivity = useCallback(async (activity: PendingActivity) => {
    if (!companionSession) return false;
    try {
      const response = await fetch(`${companionUrl}/v1/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...companionHeaders } as Record<string, string> as Record<string, string>,
        body: JSON.stringify(activity),
      });
      if (!response.ok) return false;
      const receipt = await response.json() as { dashboard?: DailyDashboard };
      if (receipt.dashboard) applyLocalDashboard(receipt.dashboard,workspaceId);
      return true;
    } catch { return false; }
  }, [companionHeaders, companionSession,applyLocalDashboard,workspaceId]);

  // Second-browser / recovery bootstrap: download v3 events from the cloud
  // cursor and merge them as cloud-acked local records. An unsupported route
  // keeps v0.6.1 behavior active instead of creating v3 writes.

  const createEventDispatch=useCallback(()=>{
    const owner=workspaceId,epoch=accountModeEpoch.current;
    const isOwnerCurrent=()=>deliveryOwnerRef.current===owner;
    return createDashboardEventDispatcher<DailyDashboard>({workspaceId:owner,accountOwner:accountWorkspaceId,companionUrl,
      companion:companionSession?{url:companionUrl,sessionToken:companionSession.token,capabilities:companionCapabilities}:null,journal:submissionJournal,
      isOwnerCurrent,isViewCurrent:()=>isOwnerCurrent()&&accountModeEpoch.current===epoch,
      notice:(scope,patch)=>setLastStudyReceipts(current=>applyTargetNotice(current,scope,patch)),
      auxiliary:(scope,state)=>setAuxiliaryDelivery(current=>current?.workspaceId===scope.workspaceId&&current.eventId===scope.eventId?{...current,state}:current),
      dashboard:value=>applyLocalDashboard(value,owner),
    });
  },[workspaceId,accountWorkspaceId,companionSession,companionCapabilities,submissionJournal,applyLocalDashboard]);
  const sendV3ToCloud=useCallback((event:StudyEventV3)=>createEventDispatch().cloud(event),[createEventDispatch]);
  const sendV3ToCompanion=useCallback((event:StudyEventV3,context?:LocalEventContext)=>createEventDispatch().companion(event,context),[createEventDispatch]);
  const sendSubmittedCloud=useCallback((payload:StudySubmissionV1)=>createEventDispatch().submittedCloud(payload),[createEventDispatch]);
  const sendSubmittedCompanion=useCallback((payload:StudySubmissionV1)=>createEventDispatch().submittedCompanion(payload),[createEventDispatch]);
  const nativeBootstrap=useSourceReader({scope:JSON.stringify([workspaceId,accountWanted,accountLibraryId,nativeScope,cloudSyncMetadata.decision]),
    capture:()=>{const owner=workspaceId,epoch=accountModeEpoch.current;return{owner,ready:storageReady&&Boolean(sessionUser)&&cloudSyncMetadata.decision==='enabled'&&!accountLoadedRef.current&&!accountIntentRef.current,
      current:()=>taskWorkspaceRef.current===owner&&accountModeEpoch.current===epoch&&!accountLoadedRef.current&&!accountIntentRef.current&&!sourceTransitionBusy.current()};},
    read:(frame,options:{retryUnsupported?:boolean;forceFullBootstrap?:boolean;notify?:boolean;strict?:boolean}|undefined,signal)=>readDashboardBoundHistory(frame.owner,options?.forceFullBootstrap,signal),
    publish:(result,_frame,options)=>{setCloudSyncMetadata(current=>({...current,v3:{...current.v3,supported:true,cursor:result.cursor,projectionMismatchCount:current.v3?.projectionMismatchCount??0}}));if(options?.notify!==false)noteEventsChanged();},
    error:()=>setCloudMessage('最新云端学习历史尚未完整读取；保留上次完整历史和本机新作答，未切换到旧读取接口。'),
  });
  const runV3Bootstrap=useCallback(async(options?:{retryUnsupported?:boolean;forceFullBootstrap?:boolean;notify?:boolean;strict?:boolean})=>
    await nativeBootstrap.read(options,{strict:options?.strict})??{supported:false,cursor:0,projections:[]},[nativeBootstrap.read]);

  const [reviewDiagnostics, setReviewDiagnostics] = useState<Awaited<ReturnType<typeof readSyncDiagnostics>> | null>(null);
  const diagnosticReader=useSourceReader({scope:workspaceId,resource:companionSession,
    capture:()=>{const owner=workspaceId;return{owner,ready:storageReady&&Boolean(sessionUser),current:()=>taskWorkspaceRef.current===owner&&getCompanionSession()===companionSession};},
    read:frame=>readSyncDiagnostics(frame.owner,companionSession,companionUrl,companionHeaders,cloudSyncMetadata),publish:setReviewDiagnostics,
    error:()=>setCloudMessage('同步诊断暂不可用；原学习记录仍保留。'),
  });
  const diagnosticsLoading=diagnosticReader.busy,refreshReviewDiagnostics=useCallback(()=>diagnosticReader.read(undefined),[diagnosticReader.read]);

  const captureSyncFrame=():SyncFrame<PendingActivity>=>{
    const owner=workspaceId,epoch=accountModeEpoch.current,account=accountLoadedRef.current;
    const current=()=>deliveryOwnerRef.current===owner&&accountModeEpoch.current===epoch&&!sourceTransitionBusy.current();
    return{key:JSON.stringify([owner,epoch,account?.bundle.snapshot.libraryId??null]),owner,accountOwner:accountWorkspaceId,ready:storageReady&&sessionResolved,current,
      legacy:{enabled:cloudSyncMetadata.decision==='enabled',events:cloudOutbox,send:async events=>{
        const response=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'events',events})});
        const payload=await response.json() as {processedEventIds?:string[];snapshot?:CloudSyncSnapshot;message?:string};
        if(!response.ok||!payload.snapshot)throw Error(payload.message||'云同步失败');return{...payload,snapshot:payload.snapshot};
      }},
      activities:{items:pendingActivities,send:sendActivity},
      ...(account&&accountWorkspaceId?{account:{drain:()=>flushAccountStudyRecords(accountWorkspaceId,account.bundle.snapshot.libraryId,records=>accountClient.appendRecords(records) as Promise<{results:Array<{eventId:string;durable:boolean;receipt?:unknown}>}>),refresh:()=>refreshAccountRead()}}:{}),
      journal:()=>submissionTransport().drain(),targets:()=>drainOriginalEventTargets(owner,sendV3ToCloud,sendV3ToCompanion),
      bootstrap:()=>runV3Bootstrap({retryUnsupported:true,forceFullBootstrap:true}),diagnostics:refreshReviewDiagnostics,recovery:()=>exportStudyRecovery(owner),
    };
  };
  const publishSyncNotice=(notice:SyncNotice)=>{
    if(notice.kind==='cloud-start')setCloudStatus('syncing');
    else if(notice.kind==='cloud-receipt'){
      const processed=new Set(notice.processed);setCloudOutbox(current=>current.filter(event=>!processed.has(event.eventId)));
      setCloudSyncMetadata({decision:'enabled',cursor:notice.snapshot.cursor,lastSyncedAt:notice.snapshot.syncedAt});setCloudStatus('synced');setCloudMessage('学习进度已安全同步。原始笔记与 API Key 仍只在本机。');
    }else if(notice.kind==='cloud-error'||notice.kind==='manual-result'){setCloudStatus(notice.kind==='cloud-error'?'error':notice.status);setCloudMessage(notice.message);}
    else if(notice.kind==='activities'){const delivered=new Set(notice.delivered);updatePendingActivities(current=>current.filter(item=>!delivered.has(item.eventId)));}
    else if(notice.kind==='journal'){
      if(notice.recovered)noteEventsChanged();const latest=notice.states.at(-1);
      if(latest)setAuxiliaryDelivery(current=>!current||current.workspaceId!==workspaceId||current.eventId===latest.eventId?{workspaceId,...latest}:current);
    }else if(notice.kind==='journal-error')setCloudMessage('恢复日志暂时无法完整读取，已有记录仍保留；未核对部分不会显示为同步成功。');
    else if(notice.kind==='projection-mismatches')setCloudSyncMetadata(current=>{const v3=current.v3??{supported:true,cursor:0,projectionMismatchCount:0};return{...current,v3:{...v3,projectionMismatchCount:v3.projectionMismatchCount+notice.count,lastProjectionMismatchAt:notice.at}};});
    else if(notice.kind==='manual-start')setCloudMessage('正在检查云端复习事件…');
  };
  const syncCoordinator=useSyncCoordinator({scope:JSON.stringify([workspaceId,accountLibraryId,accountWanted,storageReady,sessionResolved,cloudSyncMetadata.decision]),connection:companionSession,capture:captureSyncFrame,publish:publishSyncNotice,now:()=>new Date().toISOString()});
  const flushCloudOutbox=syncCoordinator.flushLegacy,flushPendingActivities=syncCoordinator.flushActivities,flushAccountQueue=syncCoordinator.flushAccount,
    flushSubmissionJournal=syncCoordinator.flushJournal,flushV3Targets=syncCoordinator.flushTargets,syncCloudNow=syncCoordinator.manual;
  const cloudFlushing=syncCoordinator.busy.legacy,manualSyncing=syncCoordinator.busy.manual;
  useSyncTriggers({ready:storageReady&&sessionResolved,accountActive:Boolean(accountLibraryId),journal:flushSubmissionJournal,account:flushAccountQueue,
    legacy:{pending:cloudOutbox.length,synced:cloudStatus==='synced',lastSyncedAt:cloudSyncMetadata.lastSyncedAt,intervalMs:dailySyncMs,flush:flushCloudOutbox},
    bootstrap:{needed:storageReady&&sessionResolved&&Boolean(sessionUser)&&cloudSyncMetadata.decision==='enabled'&&!cloudSyncMetadata.v3,run:runV3Bootstrap}});
  const legacyPlanScope=JSON.stringify([workspaceId,accountWanted,Boolean(accountLoaded),nativeLibraryId,nativeScope]);
  const {candidate:planCandidate,setCandidate:setPlanCandidate,authority:{candidate:planCurrent,revision:planRevision,history:planHistory},publishAuthority:publishLegacyAuthority}=useLegacyPlanState(legacyPlanScope,companionPlanClient);

  const effectivePlan = taskPlanningEnabled || accountLoaded ? null : selectEffectivePlan(currentDay, planCandidate, planCurrent);
  const [activeTaskScope,setActiveTaskScope]=useState<TaskModuleScope|null>(null);
  const [practiceSelection,setPracticeSelection]=useState<{scope:string;taskIds:string[]}|null>(null);
  const [selectedPlanVocabKey, setSelectedPlanVocabKey] = useState<string | null>(null);
  const canApplyDemoPacing=isDemoMode&&!accountLoaded&&data.subjects===fallbackData.subjects&&!learningDrafts.isPending()&&!learningDrafts.hasBuffers();
  const demoVisibleSubjects=useMemo(()=>data.subjects===fallbackData.subjects&&isDemoMode&&!accountLoaded&&demoPacingIds
    ?normalizeDynamicSubjects(sandboxVisibleSubjects(data.subjects??[],fallbackData.subjects??[],demoPacingIds,true)) as Subject[]:normalizedSubjects,
    [data.subjects,isDemoMode,accountLoaded,demoPacingIds,normalizedSubjects]);
  const dynamicUi = useMemo(() => buildDynamicUiModel({
    subjects: demoVisibleSubjects,
    day: currentDay,
    plan: effectivePlan,
    catalog: moduleCatalog,
    demoMode: isDemoMode,
  }), [currentDay, isDemoMode, moduleCatalog, demoVisibleSubjects, effectivePlan]);
  const useCaughtUpPage=(isDemoMode||Boolean(accountLoaded)||nativeView.ready&&nativeView.unresolvedKeys.length===0)&&shouldUseCaughtUpPage({accountMode:Boolean(accountLoaded),isCaughtUp:dynamicUi.isCaughtUp,hasEffectivePlan:Boolean(effectivePlan),taskPlanningEnabled});
  const subjects = dynamicUi.playableSubjects as Subject[];
  // 词库分组与每日配额（默认 20 词/组、20 词/天）：状态存 workspace，
  // 当天固定服务同一组，跨天自动推进到第一个未完成组。
  const [subjectPacing, setSubjectPacing] = useState<SubjectPacing>({schemaVersion:1,subjects:{}});
  const [vocabPacingWorkspace, setVocabPacingWorkspace] = useState<string | null>(null);
  useEffect(() => {
    if (!storageReady) return;
    let active = true;
    void (async () => {
      try {
        const saved = await loadWorkspaceRecord<SubjectPacing | null>(workspaceId, "vocab-pacing-by-subject", null);
        const legacy = saved ? null : await loadWorkspaceRecord<VocabPacingState | null>(workspaceId, "vocab-pacing", null);
        if (active) setSubjectPacing(migrateSubjectPacing(saved,legacy));
      } catch {
        if (active) setSubjectPacing({schemaVersion:1,subjects:{}});
      } finally {
        if (active) setVocabPacingWorkspace(workspaceId);
      }
    })();
    return () => { active = false; };
  }, [storageReady, workspaceId]);
  useEffect(() => {
    if (!storageReady || vocabPacingWorkspace !== workspaceId||!progressHistoryReady) return;
    let changed = false;
    const next: SubjectPacing = {schemaVersion:1,subjects:{...subjectPacing.subjects}};
    for (const subject of normalizedSubjects.filter(isVocabularySubject)) {
      if (effectivePlan?.items.some(entry => entry.practice?.kind === 'vocab-group' && entry.practice.subjectId === subject.id)) continue;
      const total = subject.items.length;
      const vocabPacing = pacingForSubject(subjectPacing,subject.id,subject.groupQuota);
      const bounds = splitGroupBounds(total, vocabPacing.settings.quota);
      const completedAt = (index: number) => {
        const item = subject.items[index];
        return (uiProgress.itemStages[resolveStudyItemProgressKey(item, index, uiProgress)] || 0) >= 3;
      };
      const group = resolveServedGroup({
        todayKey: currentDay,
        saved: vocabPacing.serve,
        firstIncomplete: firstIncompleteGroup(bounds, completedAt),
        override: vocabPacing.settings.override,
        groupCount: bounds.length,
      });
      const snapshot = snapshotServedGroup({ settings: vocabPacing.settings, serve: { dayKey: currentDay, group }, previousServe: vocabPacing.serve.dayKey !== currentDay ? vocabPacing.serve : vocabPacing.previousServe },subject.items.map(item=>stableStudyItemKey(item) ?? ''));
      if (JSON.stringify(vocabPacing) !== JSON.stringify(snapshot)) {
        next.subjects[subject.id] = snapshot;
        changed = true;
      }
    }
    let active = true;
    void saveWorkspaceRecord(workspaceId,"vocab-pacing-by-subject",next).then(()=>{if(active && changed) setSubjectPacing(next);});
    return () => {active = false;};
  }, [storageReady,currentDay,workspaceId,normalizedSubjects,uiProgress,subjectPacing,effectivePlan,vocabPacingWorkspace,progressHistoryReady]);
  // 计划生成方式（默认确定性调度；AI 编排需 Companion + 模型 API）。
  const [planMode, setPlanMode] = useState<"deterministic" | "ai">("deterministic");
  const persistVocabPacing = (subjectId: string, next: VocabPacingState) => {
    if (vocabPacingWorkspace !== workspaceId) return;
    const snapshot = next.serve.itemKeys ? next : snapshotServedGroup(next,(normalizedSubjects.find(subject=>subject.id===subjectId)?.items ?? []).map(item=>stableStudyItemKey(item) ?? ''));
    setSubjectPacing(current => ({schemaVersion:1,subjects:{...current.subjects,[subjectId]:{...snapshot,previousServe:next.previousServe ?? current.subjects[subjectId]?.previousServe}}}));
  };
  const activeCurationCategory = subjects.some((subject) => subject.id === curationCategory) ? curationCategory : subjects[0]?.id || "";
  const progressModules = orderProgressModules(dynamicUi.historicalModules,[...(accountDailyPlan.state?.approvedPlan?.tasks.map(task=>task.subjectId)??[]),...normalizedSubjects.map(subject=>subject.id)]);
  const activeProgressId = progressModules.some((module) => module.id === progressView) ? progressView : progressModules[0]?.id ?? "";
  const activeProgressModule = progressModules.find((module) => module.id === activeProgressId);
  const activeProgressSubject = subjects.find((subject) => subject.id === activeProgressId);
  const activeProgressSummary = activeProgressModule
    ? moduleProgressSummary(activeProgressModule, uiProgress, activeProgressSubject)
    : null;

  // 学习效果仪表盘（主旨三）：进入进度页时加载本 workspace 的 v3 事件，
  // 与 FSRS 状态一起推导到期预测、记忆风险与模块正确率。
  const gatewayEvents = data.gateway?.workspaceId === workspaceId ? data.gateway.progressEvents : EMPTY_GATEWAY_EVENTS;
  useEffect(() => {
    if (!storageReady||accountLoaded||accountWanted||isDemoMode) return;
    let active = true;
    const mutation = eventMutation.current;
    const stillCurrent=()=>active&&mutation===eventMutation.current&&!accountLoadedRef.current&&!accountIntentRef.current&&taskWorkspaceRef.current===workspaceId&&nativeSourceScope(workspaceId,taskStudyDataRef.current)===nativeScope;
    void (async () => {
      try {
        const history = await readNativeStudyHistory(workspaceId,submissionJournal,{companionEvents:gatewayEvents});
        const rebuilt = await rebuildEventProgress(history.events);
        if (!stillCurrent()) return;
        for (const event of gatewayEvents) {
          if (!stillCurrent()) return;
          const outcome = await putLocalStudyEvent({workspaceId,eventId:event.eventId,event,cloud:'not-required',companion:'not-required',occurredAt:event.occurredAt,updatedAt:new Date().toISOString()});
          if (outcome === 'conflict') throw new Error('学科记录与本地事件内容冲突。');
        }
        if (!stillCurrent()) return;
        if(accountAttemptActiveRef.current&&nativeProjectionRef.current?.workspaceId===workspaceId&&nativeProjectionRef.current.sourceScope===nativeScope)return;
        eventProjection.current = {workspaceId,itemStages:rebuilt.itemStages,fsrsData:rebuilt.fsrsData};
        setProgressEvents(rebuilt.events);
        setNativeProjection({workspaceId,sourceScope:nativeScope,excludedKeys:history.excludedKeys,...rebuilt});setNativeHistoryError('');
      } catch (error) {
        if (stillCurrent()){setNativeHistoryError('本机学习历史尚未完整核对，请重试读取。');setCloudMessage(error instanceof Error ? `进度恢复未应用：${error.message}` : '进度记录恢复失败，保留本机已有进度。');}
      }
    })();
    return () => { active = false; };
  }, [storageReady,workspaceId,currentDay,gatewayEvents,eventRevision,accountLoaded,accountWanted,isDemoMode,nativeScope,submissionJournal]);

  const riskyItems = useMemo(() => {
    const metaByKey = new Map<string, { label: string; subject: string }>();
    for (const subject of subjects) {
      (subject.items || []).forEach((item, index) => {
        const key = resolveStudyItemProgressKey(item, index, uiProgress);
        if (key && !metaByKey.has(key)) metaByKey.set(key, { label: itemLabel(item, index), subject: subject.name });
      });
    }
    return riskRanking({ fsrsData: uiProgress.fsrsData || {}, now: new Date(), limit: 5 })
      .map((risk) => ({ ...risk, ...(metaByKey.get(risk.key) || { label: risk.key, subject: "未匹配模块" }) }));
  }, [subjects, uiProgress]);
  const moduleAccuracy = (() => {
    const accuracy = accuracyByKey(progressEvents);
    return progressModules
      .map((module) => {
        let total = 0;
        let correct = 0;
        for (const key of module.itemKeys) {
          const entry = accuracy[key];
          if (entry) { total += entry.total; correct += entry.correct; }
        }
        return { id: module.id, name: module.name, total, correct };
      })
      .filter((entry) => entry.total > 0);
  })();


  const [changeCandidates, setChangeCandidates] = useState<ChangeCandidate[] | null>(null);
  const [lastChangeScan, setLastChangeScan] = useState<string | null>(null);
  // The capture loading pipeline is retained (getCaptures → this state) while
  // the capture card UI is hidden (Task 7); the value may feed a future UI.
  const [, setPendingCaptures] = useState<PendingCapture[] | null>(null);
  const [practiceItems, setPracticeItems] = useState<PracticeItem[] | null>(null);
  const [practiceSessionKey, setPracticeSessionKey] = useState(0);
  useLayoutEffect(()=>{accountAttemptActiveRef.current=!['today','progress','sources'].includes(tab)||practiceItems!==null;},[tab,practiceItems]);
  const [practiceLoading, setPracticeLoading] = useState(false);
  const [practiceSummary, setPracticeSummary] = useState<PracticeSummary | null>(null);
  const practiceRequest = useRef(0);
  useEffect(() => {
    if (storageReady && data.practiceItems) void saveWorkspaceRecord(workspaceId,"practice-cache",data.practiceItems);
  }, [storageReady,workspaceId,data.practiceItems]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changeDecisionId, setChangeDecisionId] = useState<string | null>(null);
  const [changeDecisionMessage, setChangeDecisionMessage] = useState("");
  const planApproved = (!planCandidate || planCandidate.day !== currentDay) && planCurrent?.day === currentDay ? {revision:planRevision} : null;
  const [planLoading, setPlanLoading] = useState(false);
  const [planMessage, setPlanMessage] = useState("");
  const [planSettings, setPlanSettings] = useState<StoredPlanSettings>(defaultPlanSettings);
  const [constraintAuthority, setConstraintAuthority] = useState<ConstraintDocument | null>(null);
  const [constraintMode, setConstraintMode] = useState<ConstraintMode>("auto");
  const [temporaryUntil, setTemporaryUntil] = useState("");
  const [planDeadlineDraft, setPlanDeadlineDraft] = useState<PlanDeadline>({ date: "", title: "", priority: 3, scopeRef: "" });
  useEffect(() => {
    if (!storageReady) return;
    void loadWorkspaceRecord(workspaceId, "plan-constraints", defaultPlanSettings).then(setPlanSettings);
  }, [storageReady, workspaceId]);

  const restoreTaskStudy=useCallback(async(requestedWorkspace:string,bundle:TaskPlanningBundle,onlyIfAbsent=false)=>{
    if(!bundle.studyData || accountLoadedRef.current||accountIntentRef.current||requestedWorkspace!==taskWorkspaceRef.current || (onlyIfAbsent && taskStudyDataRef.current.gateway?.workspaceId===requestedWorkspace)) return;
    const mutation=eventMutation.current;
    const payload=bundle.studyData as StudyPayload;
    assertPlanningStudySources(bundle.context.catalog,payload.subjects);
    // The earlier cache read can precede other async work; reread the actual local journal here.
    const history=await readNativeStudyHistory(requestedWorkspace,submissionJournal,{cachedEvents:bundle.localEvents,companionEvents:bundle.companionRecords.map(row=>row.event)});
    const companionIds=new Set(bundle.companionRecords.map(row=>row.event.eventId)),localEvents=history.events.filter(event=>!companionIds.has(event.eventId));
    const rebuilt=await rebuildEventProgress(history.events);
    const longTermPlan=await nativeLongTermSnapshot(requestedWorkspace,payload);
    if(accountLoadedRef.current||accountIntentRef.current||requestedWorkspace!==taskWorkspaceRef.current || (onlyIfAbsent && taskStudyDataRef.current.gateway?.workspaceId===requestedWorkspace)) return;
    if(mutation!==eventMutation.current) throw new Error('学习记录已更新，请重试同步；未覆盖新的练习进度。');
    if(accountAttemptActiveRef.current){applyLocalStudySource(payload,requestedWorkspace,false);return {...bundle,localEvents,longTermPlan};}
    eventProjection.current={workspaceId:requestedWorkspace,itemStages:rebuilt.itemStages,fsrsData:rebuilt.fsrsData};
    setProgressEvents(rebuilt.events);setNativeProjection({workspaceId:requestedWorkspace,sourceScope:nativeSourceScope(requestedWorkspace,payload),excludedKeys:history.excludedKeys,...rebuilt});setNativeHistoryError('');
    applyLocalStudySource(payload,requestedWorkspace,false);
    return {...bundle,localEvents,longTermPlan};
  },[applyLocalStudySource,submissionJournal]);
  useEffect(()=>{
    if(!storageReady || !companionSession || !supportsTaskPlanning(companionCapabilities)) return;
    let active=true;
    void loadPlanningCache(workspaceId).then(cache=>{if(active && cache) return restoreTaskStudy(workspaceId,cache,true);}).catch(()=>{});
    return ()=>{active=false;};
  },[storageReady,workspaceId,companionSession,companionCapabilities,restoreTaskStudy]);
  const loadTaskBundle=useCallback(async (requestedWorkspace:string,_day:string,full:boolean):Promise<TaskPlanningBundle>=>{
    if(!companionPlanClient || accountLoadedRef.current||accountIntentRef.current||requestedWorkspace!==workspaceId || requestedWorkspace!==taskWorkspaceRef.current) throw new Error('学习工作区已变化，请重新同步。');
    await flushV3Targets();
    if(cloudSyncMetadata.decision==='enabled') {
      const cloud=await runV3Bootstrap({retryUnsupported:full,notify:false,strict:true});
      if(!cloud.supported) throw new PlanningOfflineError('云端学习历史尚未完整读取；旧安排保留，各模块仍可自由学习。');
    }
    const mutation=eventMutation.current;
    const taskEvents=await syncTaskEvents(requestedWorkspace,companionPlanClient);
    const context=await companionPlanClient.getPlanningContext();
    const studyResponse=await fetch(`${companionUrl}/v1/study-data`,{headers:companionHeaders,signal:AbortSignal.timeout(50000)});
    if(!studyResponse.ok) throw new Error('学习资料尚未完整读取，请重新同步。');
    const studyPayload=await studyResponse.json() as StudyPayload;
    assertPlanningStudySources(context.catalog,studyPayload.subjects);
    const companionRecords=await loadPlanningRecords(context,companionPlanClient);
    const authority=await companionPlanClient.getPlanDocument();
    const history=await readNativeStudyHistory(requestedWorkspace,submissionJournal,{companionEvents:companionRecords.map(row=>row.event)});
    const companionIds=new Set(companionRecords.map(row=>row.event.eventId)),localEvents=history.events.filter(event=>!companionIds.has(event.eventId));
    if(mutation!==eventMutation.current || requestedWorkspace!==taskWorkspaceRef.current) throw new Error('学习记录或工作区已变化，请重新同步。');
    const recorded=new Set([...localEvents,...companionRecords.map(row=>row.event)].map(event=>event.item.key));
    const legacyItemKeys=[...new Set([...Object.keys(uiProgress.itemStages).filter(key=>uiProgress.itemStages[key]>0),...Object.keys(uiProgress.fsrsData??{}),...nativeView.unresolvedKeys])].filter(key=>!recorded.has(key));
    const rebuilt=await rebuildEventProgress([...localEvents,...companionRecords.map(row=>row.event)]);
    const longTermPlan=await nativeLongTermSnapshot(requestedWorkspace,studyPayload);
    if(accountLoadedRef.current||accountIntentRef.current||mutation!==eventMutation.current || requestedWorkspace!==taskWorkspaceRef.current) throw new Error('学习记录或工作区已变化，请重新同步。');
    if(!accountAttemptActiveRef.current){eventProjection.current={workspaceId:requestedWorkspace,itemStages:rebuilt.itemStages,fsrsData:rebuilt.fsrsData};setProgressEvents(rebuilt.events);
      setNativeProjection({workspaceId:requestedWorkspace,sourceScope:nativeSourceScope(requestedWorkspace,studyPayload),excludedKeys:history.excludedKeys,...rebuilt});setNativeHistoryError('');}
    applyLocalStudySource(studyPayload,requestedWorkspace,false);setSyncState(studyPayload.status);
    return {context,authority,localEvents,companionRecords,taskEvents,legacyItemKeys,studyData:studyPayload,longTermPlan,
      history:{local:'complete',companion:'complete',tasks:'complete',cloud:cloudSyncMetadata.decision==='enabled'?'complete':'not-applicable'}};
  },[companionPlanClient,companionHeaders,workspaceId,flushV3Targets,cloudSyncMetadata.decision,runV3Bootstrap,uiProgress.itemStages,uiProgress.fsrsData,nativeView.unresolvedKeys,applyLocalStudySource,submissionJournal]);
  const taskDataEpoch=useMemo(()=>JSON.stringify([normalizedSubjects.map(subject=>[subject.id,subject.items.map(item=>[item.abilityId,item.itemId,item.contentHash])]),gatewayEvents.map(event=>[event.eventId,event.coreHash])]),[normalizedSubjects,gatewayEvents]);
  const taskLearning=useTaskPlanning({client:companionPlanClient,enabled:taskPlanningEnabled,storageReady,workspaceId,day:currentDay,
    evidenceEpoch:`${eventRevision}:${studySourceEpoch}:${taskDataEpoch}:${cloudSyncMetadata.decision}:${longTerm.state?.revision??0}`,loadBundle:loadTaskBundle,restoreCachedStudy:restoreTaskStudy});
  const longTermDailyReady=accountLoaded?accountDailyPlan.ready&&!accountDailyPlan.error:Boolean(taskLearning.state?.ready&&!taskLearning.state?.loading&&!taskLearning.state?.busy&&!taskLearning.state?.error);
  const longTermFactsEpoch=JSON.stringify([workspaceId,accountLibraryId,currentDay,taskDataEpoch,accountLoaded?progressEvents.map(event=>[event.eventId,event.coreHash]).sort((a,b)=>a[0].localeCompare(b[0])):eventRevision,studySourceEpoch,accountLoaded?.facts.factsHash,accountLoaded?.catalog.catalogHash,accountLoaded?.eventThrough,accountLoaded?.taskThrough]);
  const longTermSourceEpoch=JSON.stringify([longTermFactsEpoch,longTermDailyReady,accountDailyPlan.state?.revision,taskLearning.state?.draft?.plan.planHash,Boolean(practiceItems)||!['today','progress','sources'].includes(tab)]);
  const longTermSourceStampRef=useRef(longTermSourceEpoch),longTermScopeRef=useRef(longTermScopeKey);
  useLayoutEffect(()=>{longTermSourceStampRef.current=longTermSourceEpoch;longTermScopeRef.current=longTermScopeKey;},[longTermSourceEpoch,longTermScopeKey]);
  const loadLongTermSource=useCallback(async()=>{
    const owner=longTermScopeKey,stamp=longTermSourceStampRef.current,hashes:Record<string,string>=Object.create(null);
    if(!owner||!progressHistoryReady)throw new Error('long-term-planning-unavailable');
    if(accountLoaded&&accountWorkspaceId){
      const local=await readAccountLocalPractice(accountWorkspaceId,accountLoaded.bundle.snapshot.libraryId,submissionJournal);
      const bundles=[...new Map([...accountLoaded.bundles,...local.bundles].map(bundle=>[bundle.snapshot.snapshotId,bundle])).values()];
      const composed=await composeAccountPlanningInput({day:currentDay,catalog:accountLoaded.catalog,facts:accountLoaded.facts,bundle:accountLoaded.bundle,bundles,records:accountLoaded.records,localPracticeRecords:local.records,eventThrough:accountLoaded.eventThrough,taskThrough:accountLoaded.taskThrough,previous:null});
      for(const record of [...accountLoaded.records.map(row=>row.record),...local.records])if(record.provenanceMode!=='task'){
        const item=bundles.find(bundle=>bundle.snapshot.snapshotId===record.snapshotId)?.items.find(item=>item.itemKey===record.event.item.key&&item.contentHash===record.contentHash);
        // Account planning seals each physical source with its portable content version.
        if(item)hashes[record.event.eventId]=item.contentHash;
      }
      const result=await buildLongTermEditorSource({input:composed.input,events:composed.events,sourceHashesByEventId:hashes,sourceReviews:accountLoaded.facts.sourceReviews,sourceReviewsObservedAt:accountLoaded.facts.observedAt,
        todayLocked:Boolean(!longTermDailyReady||accountAttemptActiveRef.current||accountDailyPlan.state?.currentPlan?.day===currentDay||accountDailyPlan.state?.approvedPlan?.day===currentDay||composed.events.some(event=>event.eventType==='practice-attempt'&&studyDay(event.occurredAt)===currentDay))});
      await new Promise(resolve=>window.setTimeout(resolve,0));if(owner!==longTermScopeRef.current||stamp!==longTermSourceStampRef.current)throw new Error('long-term-source-changed');
      return{...result,stamp};
    }
    const bundle=await loadTaskBundle(workspaceId,currentDay,true);
    const composed=await buildDailyPlanningInput({...bundle,day:currentDay,previous:null});
    for(const row of bundle.companionRecords){const observed=row.planningEvidence?.itemSource??row.planningEvidence?.word;if(observed)hashes[row.event.eventId]=observed.sourceHash;}
    const result=await buildLongTermEditorSource({input:composed.input,events:composed.events,sourceHashesByEventId:hashes,sourceReviews:bundle.context.sourceReviews,sourceReviewsObservedAt:bundle.context.observedAt,
      todayLocked:Boolean(!longTermDailyReady||accountAttemptActiveRef.current||taskLearning.state?.draft?.plan.day===currentDay||bundle.authority.candidate&&(!('day' in bundle.authority.candidate)||bundle.authority.candidate.day===currentDay)||composed.events.some(event=>event.eventType==='practice-attempt'&&studyDay(event.occurredAt)===currentDay))});
    await new Promise(resolve=>window.setTimeout(resolve,0));if(owner!==longTermScopeRef.current||stamp!==longTermSourceStampRef.current)throw new Error('long-term-source-changed');
    return{...result,stamp};
  },[longTermScopeKey,progressHistoryReady,accountLoaded,accountWorkspaceId,submissionJournal,currentDay,accountDailyPlan.state,loadTaskBundle,workspaceId,taskLearning.state?.draft?.plan.day,longTermDailyReady]);





  useAutomaticPlanning({
    input:{scope:longTermScopeKey,mode:accountLoaded?'account':'native',day:currentDay,sourceStamp:longTermFactsEpoch,
      trigger:longTermSourceEpoch,state:longTerm.state,ready:longTermDailyReady},
    editing:longTermEditing,historyReady:progressHistoryReady,blocked:Boolean(practiceItems)||!['today','progress','sources'].includes(tab),canContinue:canPrepareAccountDay,
    ports:{loadSource:loadLongTermSource,preview:previewLongTermPlan,save:(_request,mutation)=>longTerm.save(mutation),
      refreshGoals:()=>longTerm.refresh(),now:()=>new Date().toISOString(),
      prepareDaily:async(request,state,isCurrent)=>{
        if(request.mode==='account'){const daily=await accountDailyPlan.prepare(state.revision,isCurrent);return Boolean(daily.currentPlan||daily.approvedPlan||daily.decision!=='none');}
        return state.snapshot?await taskLearning.session?.prepareAutomaticDay(state.snapshot,isCurrent)??false:false;
      },
    },
  });
  // UI callbacks that previously received the raw state setter use the same trial guard.
  const requestStudyTab=(value:string|((current:string)=>string))=>{const destination=typeof value==='function'?value(tab):value;if(destination!==tab){if(!confirmStudyNavigation())return;practiceRequest.current++;setPracticeLoading(false);}setTab(destination);};
  const navigateToStudyTab=(destination:string,entry:'auto'|'free'|'recovery'='auto')=>{
    if(entry==='auto'&&!['today','progress','sources'].includes(destination)&&!isDemoMode&&(accountLoaded||taskPlanningEnabled)){
      void planningNavigation.startSubject(destination);return true;
    }
    if(destination!==tab&&!confirmStudyNavigation())return false;
    if(!['today','progress','sources'].includes(destination))activateSubjectRound(destination,JSON.stringify(['module',workspaceId,nativeScope,accountLoaded?.bundle.snapshot.snapshotId??null,currentDay,destination,accountDailyPlan.source?.plan.planHash??taskLearning.state?.draft?.plan.planHash??null]),emptySubjectRound());
    const wasNativeActive=accountAttemptActiveRef.current&&!accountLoadedRef.current;
    setFreeStudySubject(entry==='free'?destination:null);
    practiceRequest.current++;setPracticeLoading(false);setActiveTaskScope(null);setPracticeItems(null);setPracticeSummary(null);accountAttemptActiveRef.current=false;const pending=accountPendingLoadedRef.current;if(pending)void applyAccountLoaded(pending);else{const account=accountLoadedRef.current;if(account)setData(accountStudyPayload(account,workspaceId) as unknown as StudyPayload);else if(pendingLocalSourceRef.current?.workspaceId===workspaceId)applyLocalStudySource(pendingLocalSourceRef.current.payload,workspaceId);}accountAttemptActiveRef.current=!['today','progress','sources'].includes(destination);setTab(destination);
    if(wasNativeActive&&!accountAttemptActiveRef.current)noteEventsChanged();
    return true;
  };
  const getPracticeGroups=useCallback((plan:TaskPlanV2,catalog:PlanningCatalog,subjects:Subject[]=normalizedSubjects,eligible?:readonly string[])=>
    resolvePlanningGroups(plan,catalog,subjects,uiProgress,pluginOverrides,eligible),[normalizedSubjects,uiProgress,pluginOverrides]);
  const planningSourceAdapter=()=>createPlanningSourceAdapter(()=>({owner:taskWorkspaceRef.current,day:currentDay,nativeScope,subjects:normalizedSubjects,
      latestSubjects:()=>taskStudyDataRef.current.subjects??[],
      progress:uiProgress,overrides:pluginOverrides,selection:practiceSelection,nativeSession:taskLearning.session,
      nativeProjection:nativeProjectionRef.current,nativeReady:nativeView.ready,account:accountLoadedRef.current,accountPlan:accountDailyPlan,journal:submissionJournal,readAccountDay:accountDailyPlan.refresh}));
  const planningNavigation=usePlanningNavigation<NavigationContext,AccountNavigationQuery>({
    scope:{owner:workspaceId,libraryId:accountLoaded?accountLibraryId??'':nativeScope,day:currentDay,mode:accountLoaded?'account':'native'},
    stamp:JSON.stringify([longTermFactsEpoch,pluginOverrides,practiceSelection]),resetKey:JSON.stringify([workspaceId,currentDay,effectivePlan?.planHash]),
    active:()=>accountAttemptActiveRef.current,busy:practiceLoading,pending:()=>learningDrafts.isPending(),
    captureBoundary:()=>{
      const epoch=accountModeEpoch.current;
      return()=>taskWorkspaceRef.current===workspaceId&&accountModeEpoch.current===epoch&&(accountLoaded
        ?accountLoadedRef.current?.bundle.snapshot.libraryId===accountLibraryId
        :!accountLoadedRef.current&&!accountIntentRef.current&&taskStudyDataRef.current.localLibraryId===data.localLibraryId);
    },
    clock:{advance:()=>++practiceRequest.current,matches:id=>id===practiceRequest.current},loading:setPracticeLoading,
    reset:()=>{setPracticeItems(null);setPracticeSummary(null);},
    ports:{loadNative:(lease,continuing)=>planningSourceAdapter().loadNative(lease,continuing),loadAccount:(lease,query)=>planningSourceAdapter().loadAccount(lease,query),loadSubject:lease=>planningSourceAdapter().loadSubject(lease),
      groups:(source,eligible)=>planningSourceAdapter().groups(source,eligible),verify:(source,tasks,latest)=>planningSourceAdapter().verify(source,tasks,latest),
      persistStarted:(source,ids,current)=>planningSourceAdapter().persistStarted(source,ids,current),groupItems:(source,group)=>planningSourceAdapter().groupItems(source,group),
      prepareLeave:prepareStudyNavigation,getRound:getSubjectRound,activateRound:activateSubjectRound,
      enter:({source,task,group,index,selection})=>{
        setPracticeSelection(selection);setFreeStudySubject(null);accountAttemptActiveRef.current=true;
        setActiveTaskScope({plan:source.plan,catalog:source.catalog,taskId:task.taskId,groupTaskIds:group.tasks.map(value=>value.taskId),subjectId:task.subjectId,adapter:group.adapter,...(source.context.accountSource?{accountSource:source.context.accountSource}:{})});
        if(group.adapter.items[0]?.practice?.kind==='vocab-group')setSelectedPlanVocabKey(group.adapter.items[0].itemKey);
        setItemIndices(indices=>({...indices,[task.subjectId]:index}));setTab(task.subjectId);
      },
      returnToday:()=>{navigateToStudyTab('today');},openSubject:(subjectId,free)=>{navigateToStudyTab(subjectId,free?'free':'recovery');},openNote:note=>window.location.assign(`obsidian://open?file=${encodeURIComponent(note)}`),message:setPlanMessage,
    },
  });
  const startTaskLearning=planningNavigation.startNative;
  const startAccountLearning=(plan:TaskPlanV2,taskId:string,catalog:PlanningCatalog,cloud:CloudTaskPlanV1,resumeItemKey?:string,eligibleTaskIds?:string[],isCurrent=()=>true)=>
    planningNavigation.startAccount({plan,taskId,catalog,cloud,resumeItemKey,eligibleTaskIds},isCurrent);
  const continueTodayStudy=planningNavigation.continueToday;
  const completeAccountTask=async(cloudPlan:CloudTaskPlanV1,taskId:string)=>{
    const account=accountLoadedRef.current;if(!account||!accountWorkspaceId||!accountDeviceId)return;
    const modeEpoch=accountModeEpoch.current,ownerCurrent=()=>modeEpoch===accountModeEpoch.current&&taskWorkspaceRef.current===accountWorkspaceId&&accountLoadedRef.current?.bundle.snapshot.libraryId===account.bundle.snapshot.libraryId;let saved=false;
    try{const catalog=account.catalogs.find(value=>value.catalogHash===cloudPlan.catalogHash),bundle=catalog&&account.bundles.find(value=>value.snapshot.snapshotId===catalog.snapshotId);if(!catalog||!bundle)throw new Error('任务依赖的历史快照尚未下载。');const engine=await toEngineTaskPlan(cloudPlan,catalog),task=engine.tasks.find(value=>value.taskId===taskId);if(!task)throw new Error('共享任务不存在。');if(!ownerCurrent())return;const savedRecord=await createAccountTaskRecord({workspaceId:accountWorkspaceId,bundle,plan:cloudPlan,task,originDeviceId:accountDeviceId});saved=true;
      if(!ownerCurrent())return;noteEventsChanged();setPlanMessage('任务完成已存本机，等待账号接收；无需重复标记。');
      await flushAccountStudyRecords(accountWorkspaceId,account.bundle.snapshot.libraryId,records=>{if(!ownerCurrent())throw new Error('study-workspace-changed');return accountClient.appendRecords(records) as Promise<{results:Array<{eventId:string;durable:boolean;receipt?:unknown}>}>;});if(!ownerCurrent())return;
      const received=await getLocalStudyRecord(accountWorkspaceId,savedRecord.libraryId,savedRecord.event.eventId);if(received?.cloud!=='acked'||received.record.envelopeHash!==savedRecord.envelopeHash)throw new Error('task-account-receipt-unconfirmed');
      if(!ownerCurrent())return;noteEventsChanged();const refreshed=await refreshAccountRead();if(ownerCurrent())setPlanMessage(refreshed?'任务完成证据已进入账号；等待 Companion 写回本地计划。':'任务完成证据已进入账号；页面暂未刷新，可稍后核对。');}
    catch(error){const message=saved?'任务完成已存本机，账号状态尚未核对；无需重复标记。':error instanceof Error?error.message:'任务完成记录失败。';if(ownerCurrent())setPlanMessage(message);throw new Error(message);}
  };
  const runAccountQuestionAi=async(kind:'hint'|'tutor'|'recall-grade',raw:unknown,input:string)=>{const account=accountLoadedRef.current;if(!account||!accountWorkspaceId)throw new Error('账号题库尚未加载。');if(!accountQuestionAiHydrated)throw new Error('正在恢复上次 AI 请求，请稍候。');const {bundle,item}=resolveAccountStudyItem(account,raw),requestKey=JSON.stringify([kind,bundle.snapshot.snapshotId,item.itemKey,item.contentHash,input]),attemptId=`attempt:${await crypto.subtle.digest('SHA-256',new TextEncoder().encode(requestKey)).then(buffer=>Array.from(new Uint8Array(buffer),byte=>byte.toString(16).padStart(2,'0')).join(''))}`,requestId=accountAiRequestIds.current.get(requestKey)??crypto.randomUUID();accountAiRequestIds.current.set(requestKey,requestId);await saveWorkspaceRecord(accountWorkspaceId,'account-question-ai-requests',Object.fromEntries(accountAiRequestIds.current));const response=await accountClient.questionAi({requestId,request:{kind,snapshotId:bundle.snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,attemptId,input}}) as {result?:{snapshotId:string;itemKey:string;contentHash:string;attemptId:string;text:string;verdict?:string;rating?:string;matchedPointIds?:string[];missedPointIds?:string[]}};const result=response.result;if(!result||result.snapshotId!==bundle.snapshot.snapshotId||result.itemKey!==item.itemKey||result.contentHash!==item.contentHash||result.attemptId!==attemptId)throw new Error('AI 回复已过期，没有应用到当前题目。');accountAiRequestIds.current.delete(requestKey);await saveWorkspaceRecord(accountWorkspaceId,'account-question-ai-requests',Object.fromEntries(accountAiRequestIds.current));return result;};
  const gradeAccountCalculation=async(item:unknown,answer:string,signal?:AbortSignal)=>gradeCalculationInWorker(item as {answer?:unknown;learningSupport?:unknown},answer,signal);

  // Practice grades reuse the same immutable v3 path as dashboard grades: one
  // recordStudyAttempt per grade with independent cloud/Companion receipts.
  const recordPracticeAttempt = useCallback(async(attempt:PracticeAttempt,receipt:PracticePersistenceContext):Promise<void> => {
    const {item,rating,correct}=attempt;
    if(isDemoMode){
      setDemoProgress(current=>({...current,itemStages:{...current.itemStages,['practice:'+item.itemId]:correct&&['good','easy'].includes(rating)?3:0},answered:current.answered+1,correct:current.correct+(correct?1:0)}));
      receipt?.durable();return;
    }
    if(!receipt)throw new Error('study-attempt-session-required');
    const modeEpoch=accountModeEpoch.current,ownerCurrent=()=>deliveryOwnerRef.current===workspaceId&&accountModeEpoch.current===modeEpoch;
    if(!ownerCurrent())throw new Error('study-workspace-changed');
    const account=accountLoadedRef.current,accountItem=account?resolveAccountStudyItem(account,item).item:null;
    const itemKey=accountItem?.itemKey??`practice:${item.itemId}`,domain=item.domain==='python'?'python':'differential-review';
    if(!account&&(!nativeView.ready||nativeView.unresolvedKeys.includes(itemKey)))throw new Error('本机学习历史待核对，未提交本次作答。');
    const command=receipt.request.capture('inline-persistence',()=>{
      const input:StudyAttemptInput={
        identity:receipt.request.identity,workspaceId,domain,item:{kind:accountItem?.eventKind??'due',key:itemKey},
        rating,correct,stageBefore:1,stageAfter:correct?3:0,reviewedAt:receipt.request.identity.reviewedAt,isThreeStage:false,
        currentFsrs:uiProgress.fsrsData?.[itemKey],
        localContext:{
          title:item.prompt||item.sourceLabel,activityType:'website-practice',durationMin:2,
          weakPoints:correct?[]:[item.prompt||item.sourceLabel],
          sourceNote:markdownNotePath(item.sourceNote)||markdownNotePath(data.source.path),stateRef:resolvableNotePath(item.stateRef),abilityId:item.abilityId,
        },
        delivery:{cloud:account||sessionUser&&cloudSyncMetadata.decision==='enabled'?'pending':'not-required',companion:accountLoaded?'not-required':'pending'},
      };
      return {input,frame:captureAttemptFrame(item,item.questionType,1),observation:attempt.assistance??null};
    });
    if(command.input.workspaceId!==workspaceId||command.input.item.key!==itemKey||(command.frame.kind==='account'?command.frame.bundle.snapshot.libraryId!==account?.bundle.snapshot.libraryId:Boolean(account)))throw new Error('study-workspace-changed');
    let submittedPayload:StudySubmissionV1|undefined;
    await recordStudyAttempt(command.input,{
      persistEvent:async(record)=>{
        eventMutation.current++;submittedPayload=await persistSubmittedEvent(record,command.frame,command.observation);
        if(ownerCurrent()){noteEventsChanged();setProgressEvents(current=>[...current.filter(event=>event.eventId!==record.eventId),record.event]);}
      },
      persistProgress:async({event,clientStateAfter})=>{
        if(!ownerCurrent()){receipt?.durable();return;}
        const update=(current:Progress):Progress=>({
          ...current,itemStages:{...current.itemStages,[itemKey]:command.input.stageAfter},
          fsrsData:clientStateAfter?{...(current.fsrsData||{}),[itemKey]:clientStateAfter}:current.fsrsData,
          answered:current.answered+1,correct:current.correct+(command.input.correct?1:0),
        });
        if(account)setAccountProgress(current=>current?.workspaceId===workspaceId&&current.libraryId===account.bundle.snapshot.libraryId?{...current,progress:update(current.progress)}:current);
        else{setProgress(update);setNativeProjection(current=>applySavedNativeAttempt(current,{workspaceId,sourceScope:nativeScope},event,clientStateAfter));}
        receipt?.durable();
      },
      sendCloud:()=>ownerCurrent()&&submittedPayload?sendSubmittedCloud(submittedPayload):Promise.reject(new Error('study-workspace-changed')),
      sendCompanion:()=>ownerCurrent()&&submittedPayload?sendSubmittedCompanion(submittedPayload):Promise.reject(new Error('study-workspace-changed')),
      updateDelivery:updateStudyEventDelivery,
    }).catch(error=>{if(submittedPayload){receipt?.durable();if(ownerCurrent())setPlanMessage('作答已保存，界面更新未完成。请返回今日重新进入。');}else throw error;});
  },[isDemoMode,accountLoaded,cloudSyncMetadata.decision,data.source.path,uiProgress.fsrsData,nativeView.ready,nativeView.unresolvedKeys,nativeScope,sessionUser,workspaceId,noteEventsChanged,captureAttemptFrame,persistSubmittedEvent,sendSubmittedCloud,sendSubmittedCompanion]);

  const startPractice = useCallback(async () => {
    setPracticeSummary(null);
    const request = ++practiceRequest.current;
    setPracticeLoading(true);
    try {
      const {items:bounded,offline} = await loadPlannedPractice(effectivePlan,normalizedSubjects,{
        loadRemote:companionPlanClient ? async()=>(await companionPlanClient.getPractice()).items : undefined,
        writeCache:async items=>{await saveWorkspaceRecord(workspaceId,"practice-cache",items);},
        readCache:()=>loadWorkspaceRecord<PracticeItem[]>(workspaceId,"practice-cache",[]),
      });
      if (request !== practiceRequest.current) return;
      setPracticeSessionKey(key=>key+1);
      setPracticeItems(bounded);
      setPlanMessage(offline ? 'Companion 离线：按当前计划加载缓存；作答保留在本机等待补写。' : '');
    } catch (error) {
      setPlanMessage(error instanceof Error ? error.message : '复习题加载失败。');
    } finally {
      setPracticeLoading(false);
    }
  }, [companionPlanClient, effectivePlan, normalizedSubjects, workspaceId, setPracticeSummary, setPracticeItems, setPlanMessage]);

  async function savePlanSettings() {
    if (!companionPlanClient) {
      await saveWorkspaceRecord(workspaceId, "plan-constraints", planSettings);
      setPlanMessage("Companion 离线：设置已保存为本机草稿，尚未写入 Obsidian。");
      return;
    }
    if (constraintMode === "temporary" && !temporaryUntil) {
      setPlanMessage("临时覆盖需要选择有效截止日期；未保存的设置仍保留在当前页面。");
      return;
    }
    try {
      const base = constraintAuthority ?? await companionPlanClient.getConstraints();
      const saved = await companionPlanClient.saveConstraints(
        authorityFromPlanSettings(base, planSettings, constraintMode, temporaryUntil),
      );
      setConstraintAuthority(saved);
      setConstraintMode(saved.mode);
      setPlanSettings(planSettingsFromAuthority(saved));
      await saveWorkspaceRecord(workspaceId, "plan-constraints", planSettingsFromAuthority(saved));
      setPlanMessage("学习约束已写入 Obsidian，并作为下一次计划的唯一依据。");
    } catch (error) {
      await saveWorkspaceRecord(workspaceId, "plan-constraints", planSettings);
      setPlanMessage(error instanceof Error ? `${error.message} 本机草稿已保留。` : "约束写回失败，本机草稿已保留。");
    }
  }
  const legacyPlans=useLegacyPlanning({
    frame:{scope:legacyPlanScope,day:currentDay,sourceStamp:longTermFactsEpoch,
      enabled:!accountLoaded&&!accountWanted&&!taskPlanningEnabled,historyReady:progressHistoryReady,storageReady,hasContent:Boolean(normalizedSubjects.length),
      candidate:planCandidate,authority:{revision:planRevision,candidate:planCurrent,history:planHistory},mode:planMode,online:syncState!=='offline',operator:sessionUser?.userId??'local',transport:companionPlanClient},
    ports:{isCurrent:()=>taskWorkspaceRef.current===workspaceId&&!accountLoadedRef.current&&!accountIntentRef.current,
      readInput:async isCurrent=>{
        const mutation=eventMutation.current,sourceScope=nativeScope;
        const sourceCurrent=()=>isCurrent()&&mutation===eventMutation.current&&nativeSourceScope(workspaceId,taskStudyDataRef.current)===sourceScope;
        let planningProgress=uiProgress;
        if(!isDemoMode){
          if(cloudSyncMetadata.decision==='enabled'&&!(await runV3Bootstrap({strict:true,notify:false})).supported)throw Error('云端学习历史尚未完整读取，保留原安排。');
          if(!sourceCurrent())throw Error('学习资料或记录已更新，请重新生成。');
          const history=await readNativeStudyHistory(workspaceId,submissionJournal,{companionEvents:gatewayEvents}),rebuilt=await rebuildEventProgress(history.events);
          const checked=nativeProgressView(progress,{workspaceId,sourceScope,excludedKeys:history.excludedKeys,...rebuilt},{workspaceId,sourceScope});
          if(!checked.ready||checked.unresolvedKeys.length)throw Error('本机学习历史仍有待核对部分，保留原安排。');planningProgress=checked.progress;
        }
        if(!sourceCurrent())throw Error('学习资料或记录已更新，请重新生成。');
        return buildPlanInput({day:currentDay,fsrsData:planningProgress.fsrsData,
          subjects:normalizedSubjects.map(subject=>isVocabularySubject(subject)?{...subject,groupQuota:pacingForSubject(subjectPacing,subject.id,subject.groupQuota).settings.quota}:subject),
          duePractice:data.practiceItems??[],itemStages:planningProgress.itemStages,
          previousServes:Object.fromEntries(Object.entries(subjectPacing.subjects).map(([id,state])=>[id,state.serve.dayKey!==currentDay?state.serve:state.previousServe])),
          constraints:planSettings.constraints,deadlines:planSettings.deadlines});
      },
      replaceCandidate:(before,after)=>setPlanCandidate(value=>value===before?after:value),
      publishAuthority:publishLegacyAuthority,
      loading:setPlanLoading,message:setPlanMessage,resetSelection:()=>setSelectedPlanVocabKey(null),
    },
  });
  const fetchCurrentPlan=legacyPlans.refresh;
  const sourceChanges=useSourceChanges({scope:workspaceId,connection:companionPlanClient,
    current:()=>taskWorkspaceRef.current===workspaceId&&getCompanionSession()===companionSession,
    connected:()=>Boolean(companionPlanClient),account:()=>Boolean(accountLoadedRef.current),
    list:()=>companionPlanClient!.getChanges(),scan:()=>companionPlanClient!.scanChanges(),
    decide:(id,choice)=>companionPlanClient!.decideChange(id,choice,sessionUser?.userId??'local'),
    source:async()=>{const result=await companionHttp.source(companionSession!,'poll',AbortSignal.timeout(3000));if(!result.ok)throw Error('学习池刷新失败。');return result.payload;},
    apply:payload=>{const applied=applyLocalStudySource(payload,workspaceId);setSyncState(payload.status);return applied;},
    publish:value=>{setChangeCandidates(value.changes);setLastChangeScan(value.scannedAt??null);},
    loading:setChangesLoading,deciding:setChangeDecisionId,message:setChangeDecisionMessage,scanError:setPlanMessage,
  });
  const scanChanges=sourceChanges.scan,decideChange=sourceChanges.decide;
  useEffect(() => {
    if (!companionPlanClient) return;
    let active = true;
    const loadAuthority = async () => {
      try {
        const [constraints, , captures] = await Promise.all([
          companionPlanClient.getConstraints().catch(()=>null),
          taskPlanningEnabled?Promise.resolve(null):fetchCurrentPlan(),
          companionPlanClient.getCaptures(),
        ]);
        if (!active) return;
        if(constraints){setConstraintAuthority(constraints);setConstraintMode(constraints.mode);
          setTemporaryUntil(constraints.temporaryUntil?.slice(0, 10) ?? "");setPlanSettings(planSettingsFromAuthority(constraints));}
        setPendingCaptures(captures.pendingCaptures);
      } catch {
        // Keep the offline draft and last known projection.
      }
    };
    void loadAuthority();
    return () => { active = false; };
  }, [companionPlanClient, fetchCurrentPlan, legacyPlanScope,taskPlanningEnabled]);
  // 引用随计划一起持久化；旧计划根据当前资料进行保守解析。
  const inputPoolPractice = (itemKey: string): PlanInput["pool"][number]["practice"] | undefined => {
    const entry=effectivePlan?.items.find(item=>item.itemKey===itemKey);
    return entry ? resolvePlanPractice(entry,normalizedSubjects) : undefined;
  };
  const choosePlanVocabEntry = (itemKey: string) => {
    if(!confirmStudyNavigation())return;
    setSelectedPlanVocabKey(itemKey);
    const practice = inputPoolPractice(itemKey);
    if (practice) {
      const subject = normalizedSubjects.find(item=>item.id===practice.subjectId);
      persistVocabPacing(practice.subjectId,selectPlanGroup(pacingForSubject(subjectPacing,practice.subjectId,subject?.groupQuota),currentDay,practice));
      setTab(practice.subjectId);
    }
  };
  // 直达某条计划题目的练习：拉取到期题并过滤到该题（条目 → 练习会话）。
  // 键家族容错：计划键可能是 abilityId、practice:{itemId}（到期差分复习
  // 的 v3 事件键）或 topic: 前缀；找不到唯一题目时明确报错，不退回全量。
  const startPlannedQuestionPractice = useCallback(async (itemKey: string) => {
    if(!confirmStudyNavigation())return;
    setPracticeLoading(true);
    const request = ++practiceRequest.current;
    try {
      const entry=effectivePlan?.items.find(item=>item.itemKey===itemKey);
      if(!entry) throw new Error('该条目已不在今日计划中。');
      const payload=companionPlanClient?await companionPlanClient.getPractice().catch(()=>({items:data.practiceItems ?? []})):{items:data.practiceItems ?? []};
      if (request !== practiceRequest.current) return;
      const list=selectPlannedPractice(entry,normalizedSubjects,payload.items);
      setPracticeSummary(null);
      setPracticeSessionKey(key=>key+1);
      setPracticeItems(list);
      setPlanMessage('');
    } catch (error) {
      setPlanMessage(error instanceof Error ? error.message : "练习题加载失败，请稍后再试。");
    } finally {
      if(request===practiceRequest.current)setPracticeLoading(false);
    }
  }, [companionPlanClient, effectivePlan, normalizedSubjects, data.practiceItems, setPracticeSummary, setPracticeItems, setPlanMessage]);

  const generateTodayPlan=legacyPlans.generate;
  const approveTodayPlan=legacyPlans.approve;
  const removePlanEntry=legacyPlans.remove;
  const rejectTodayPlan=legacyPlans.reject;
  const restorePlanRevision=legacyPlans.restore;

  const workspaceReader=useSourceReader({scope:String(identityRetry),
    capture:()=>({ready:true,current:()=>true}),
    read:(_frame,_input:undefined,signal)=>readWorkspaceSnapshot({
      identity:async signal=>readStudyIdentity(await fetch('/api/session',{cache:'no-store',signal})),
      owner:user=>workspaceIdForUser(user?.userId??null),storage:readWorkspaceSource,
      identified:user=>{setSessionUser(user);setSessionResolved(true);setWorkspacePhase('loading-local');},
    },signal),
    publish:({identity:user,owner:nextWorkspaceId,stored})=>{
      const {savedProgress,savedPending,savedCompanion,savedCloudOutbox,savedCloudMetadata,savedPluginOverrides,savedModuleCatalog,savedAccountPreference,savedAccountDevice}=stored;
        setSessionUser(user);
        setWorkspaceId(nextWorkspaceId);
        setProgress(normalizeProgress(savedProgress));
        setPendingActivities(Array.isArray(savedPending) ? savedPending : []);
        setCompanionSession(sessionForEndpoint(savedCompanion,companionUrl));
        setCloudOutbox(Array.isArray(savedCloudOutbox) ? savedCloudOutbox : []);
        setCloudSyncMetadata(savedCloudMetadata?.decision ? savedCloudMetadata : emptyCloudSyncMetadata);
        setPluginOverrides(normalizePluginOverrides(savedPluginOverrides));
        setModuleCatalog(Array.isArray(savedModuleCatalog) ? savedModuleCatalog : []);
        setAccountPreferred(savedAccountPreference===true||savedAccountPreference==='account');setAccountOptedOut(savedAccountPreference==='local');setAccountDeviceId(savedAccountDevice||crypto.randomUUID());
        setStorageReady(true);
        setWorkspacePhase('ready');
    },error:error=>{setStorageReady(false);setWorkspacePhase(error instanceof WorkspaceReadError?error.phase:'identity-error');},
  });
  useEffect(()=>{void workspaceReader.read(undefined);return workspaceReader.cancel;},[workspaceReader.read,workspaceReader.cancel]);

  useEffect(() => { if (storageReady) void saveWorkspaceRecord(workspaceId, "progress", progress); }, [progress, storageReady, workspaceId]);
  useEffect(()=>{if(storageReady&&accountProgress?.workspaceId===workspaceId&&accountProgress.historyReady)void saveAccountProgress(accountProgress).catch(()=>setCloudMessage('账号进度视图暂未缓存；原作答记录仍单独保留。'));},[storageReady,workspaceId,accountProgress]);
  useEffect(() => { if (storageReady) void saveWorkspaceRecord(workspaceId, "pending-activities", pendingActivities); }, [pendingActivities, storageReady, workspaceId]);
  useEffect(() => { if (storageReady) void saveWorkspaceRecord(workspaceId, companionSessionRecordKey(companionUrl), {session:companionSession}); }, [companionSession, storageReady, workspaceId]);
  useEffect(() => { if (storageReady) void saveWorkspaceRecord(workspaceId, "cloud-outbox", cloudOutbox); }, [cloudOutbox, storageReady, workspaceId]);
  useEffect(() => { if (storageReady) void saveWorkspaceRecord(workspaceId, "cloud-sync-metadata", cloudSyncMetadata); }, [cloudSyncMetadata, storageReady, workspaceId]);
  useEffect(() => { if (storageReady) void saveWorkspaceRecord(workspaceId, "plugin-overrides", pluginOverrides); }, [pluginOverrides, storageReady, workspaceId]);
  useEffect(()=>{if(storageReady)void saveWorkspaceRecord(workspaceId,'account-study-preference',accountOptedOut?'local':accountPreferred?'account':'auto');},[storageReady,workspaceId,accountPreferred,accountOptedOut]);
  useEffect(()=>{if(storageReady&&accountDeviceId)void saveWorkspaceRecord(workspaceId,'account-study-device',accountDeviceId);},[storageReady,workspaceId,accountDeviceId]);
  useEffect(()=>{
    if(!storageReady||!sessionUser||accountOptedOut||accountReadPaused||accountProbeRef.current===workspaceId)return;accountProbeRef.current=workspaceId;let active=true,retryTimer:number|undefined;
    const initial=window.setTimeout(()=>{void refreshAccountRead().then(value=>{if(active&&!value){if(accountProbeRef.current===workspaceId)accountProbeRef.current='';retryTimer=window.setTimeout(()=>setAccountProbeRetry(value=>value+1),30000);}});},0);
    return()=>{active=false;cancelAccountRead();if(accountProbeRef.current===workspaceId)accountProbeRef.current='';window.clearTimeout(initial);if(retryTimer!==undefined)window.clearTimeout(retryTimer);};
  },[storageReady,sessionUser,workspaceId,accountOptedOut,accountReadPaused,refreshAccountRead,accountProbeRetry,cancelAccountRead]);
  useEffect(()=>{const online=()=>{accountProbeRef.current='';setAccountProbeRetry(value=>value+1);};window.addEventListener('online',online);return()=>window.removeEventListener('online',online);},[]);
  useEffect(() => {
    if (!storageReady || isDemoMode) return;
    const timer = window.setTimeout(() => setModuleCatalog((current) => {
        const next = mergeModuleCatalog(current, normalizedSubjects.filter((subject) => subject.items.length > 0), data.syncedAt ?? new Date().toISOString(), false);
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        void saveWorkspaceRecord(workspaceId, "module-catalog", next);
        return next;
      }), 0);
    return () => window.clearTimeout(timer);
  }, [data.syncedAt, isDemoMode, normalizedSubjects, storageReady, workspaceId]);
  useEffect(() => {
    if (!storageReady || !data.subjects?.length) return;
    const subjectIds = normalizedSubjects.map((subject) => subject.id);
    setPluginOverrides((current) => prunePluginOverrides(current, subjectIds));
  }, [storageReady, data.subjects, normalizedSubjects]);
  useEffect(() => {
    const nextTab = resolveDynamicTab(tab, subjects.map((subject) => subject.id));
    if (nextTab === tab) return;
    const timer = window.setTimeout(() => setTab(nextTab), 0);
    return () => window.clearTimeout(timer);
  }, [subjects, tab]);
  const legacyCloud=useLegacyCloud({scope:workspaceId,ready:storageReady&&sessionResolved,retry:cloudRetryToken,
    capture:()=>{const owner=workspaceId;return{owner,ready:storageReady&&sessionResolved,signedIn:Boolean(sessionUser),progress,metadata:cloudSyncMetadata,
      current:()=>deliveryOwnerRef.current===owner};},
    read:async signal=>{const response=await fetch('/api/sync',{cache:'no-store',signal}),value=await response.json() as CloudSyncSnapshot&{message?:string};if(!response.ok)throw Error(value.message||'无法读取云端进度');return value;},
    migrate:async(value,signal)=>{const response=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'migrate',progress:value,migrationEventId:createEventId('ielts','legacy-indexeddb-migration')}),signal});
      const result=await response.json() as {snapshot?:CloudSyncSnapshot;message?:string};if(!response.ok&&response.status!==409)throw Error(result.message||'迁移失败');if(!result.snapshot)throw Error('没有收到云端进度确认');return{snapshot:result.snapshot,conflict:response.status===409};},
    restore:(snapshot,kind,conflict)=>{
      const overlay=eventProjection.current?.workspaceId===workspaceId?eventProjection.current:null;
      const view=restoreLegacySnapshot(snapshot,{progress,events:cloudOutbox,metadata:cloudSyncMetadata,overlay},kind,conflict);
      if(view.progress){setProgress(view.progress);noteEventsChanged();}setCloudSyncMetadata(view.metadata);setCloudStatus(view.status);setCloudMessage(view.message);
    },
    baselines:(frame,value)=>migrateLegacyBaselines(frame.owner,value,{current:frame.current,now:()=>new Date().toISOString(),
      events:(progress,at,owner)=>createLegacyBaselineEvents(progress,at,{workspaceId:owner}),list:(kind,key)=>listLocalItemEvents(frame.owner,kind,key),put:putLocalStudyEvent,
      send:sendV3ToCloud,ack:eventId=>updateStudyEventDelivery(frame.owner,eventId,'cloud','acked')}),
    bootstrap:runV3Bootstrap,status:setCloudStatus,message:setCloudMessage,
  });
  const retryCloudSync=legacyCloud.retry;
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("pair") !== "1") return;
    const timer = window.setTimeout(() => { setSourceView("connections"); setTab("sources"); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const sourceTransitions=useSourceTransitions({scope:workspaceId,connection:companionSession,client:accountClient,
    capture:()=>{
      const owner=workspaceId,epoch=accountModeEpoch.current,connection=getCompanionSession(),drafts=activeLearningDraftsRef.current;
      return{owner,connection,accountReady:Boolean(accountWorkspaceId&&storageReady&&sessionResolved),
        current:()=>taskWorkspaceRef.current===owner&&accountModeEpoch.current===epoch&&getCompanionSession()===connection,
        pending:()=>activeLearningDraftsRef.current.isPending(),buffers:()=>activeLearningDraftsRef.current.hasBuffers(),
        draftVersion:()=>activeLearningDraftsRef.current===drafts?drafts.getMutationVersion():null};
    },
    confirm:message=>window.confirm(message),
    begin:()=>{cancelAccountRead();companionSource.cancel();syncCoordinator.invalidate();accountModeEpoch.current++;},
    readLocal:async frame=>{
      const response=await companionHttp.source(frame.connection!,'poll',new AbortController().signal);
      if(!response.ok||!usableCompanionSource(response.payload))throw Error('local-source-unavailable');return response.payload;
    },
    adoptAccount:()=>accountClient.prepareLibraryAdoption(),clearDrafts:()=>activeLearningDraftsRef.current.clear(),
    commitLocal:(payload,frame)=>{
      accountSources.clearPending();accountLoadedRef.current=null;accountIntentRef.current=false;pendingLocalSourceRef.current=null;setLocalSourcePending(false);
      const scoped=scopeStudyPayload(payload,frame.owner);taskStudyDataRef.current=scoped;setData(scoped);setSyncState(payload.status);
      setAccountLoaded(null);setAccountPreferred(false);setAccountOptedOut(true);setStudySourceEpoch(value=>value+1);
    },
    commitAccount:()=>{
      accountLoadedRef.current=null;accountSources.clearPending();pendingLocalSourceRef.current=null;setLocalSourcePending(false);
      setAccountLoaded(null);setData(fallbackData);setActiveTaskScope(null);setPracticeItems(null);setPracticeSummary(null);
    },reloadAccount:()=>readAccountAgain(),message:setCloudMessage,
  });
  useLayoutEffect(()=>{sourceTransitionBusy.current=sourceTransitions.isBusy;},[sourceTransitions.isBusy]);
  const acceptCurrentAccountLibrary=sourceTransitions.adoptAccount,switchToLocalMode=sourceTransitions.switchLocal;
  const sourceMaintenance=useSourceMaintenance({scope:workspaceId,client:accountClient,
    capture:()=>{const owner=accountWorkspaceId,workspace=workspaceId;return{owner,ready:storageReady&&sessionResolved,
      current:()=>deliveryOwnerRef.current===workspace,pending:()=>activeLearningDraftsRef.current.isPending(),
      buffers:()=>activeLearningDraftsRef.current.hasBuffers(),version:()=>JSON.stringify([eventMutation.current,activeLearningDraftsRef.current.scopeKey,activeLearningDraftsRef.current.getMutationVersion()])};},
    confirm:message=>window.confirm(message),export:exportStudyRecovery,
    download:value=>{
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),anchor=document.createElement('a');
      try{anchor.href=url;anchor.download='zhixue-study-recovery-'+currentDay+'.json';anchor.click();}finally{URL.revokeObjectURL(url);}
    },
    clearLibrary:clearLocalAccountStudy,clearRead:()=>accountClient.clearReadCache(),clearWorkspace:clearAccountWorkspaceRecords,
    cancelRead:cancelAccountRead,pauseRead:()=>{setAccountReadPaused(true);setAccountReadStatus({phase:'cleared',hasCache:true});},message:setCloudMessage,
    prepareNavigation:prepareStudyNavigation,
    clearViews:async(frame,value)=>{
      const version=frame.version(),current=()=>frame.current()&&!frame.pending()&&frame.version()===version;
      for(const library of value.payload.accountLibraries){if(!current())return;await clearLocalAccountStudy(frame.owner!,library.libraryId);}
      if(!current())return;await accountClient.clearReadCache();if(!current())return;await clearAccountWorkspaceRecords(frame.owner!);
    },
    retire:()=>{activeLearningDraftsRef.current.clear();cancelAccountRead();companionSource.cancel();syncCoordinator.invalidate();legacyCloud.invalidate();accountModeEpoch.current++;},
    captureConnection:()=>{
      const connection=getCompanionSession();return{revoke:()=>connection?companionHttp.revoke(connection):Promise.resolve(),
        clear:()=>{const latest=getCompanionSession();if(latest?.token===connection?.token&&latest?.baseUrl===connection?.baseUrl)setCompanionSession(null);}};
    },
    redirect:()=>window.location.assign('/signout-with-chatgpt?return_to=/'),
  });
  const settingsModal=sourceMaintenance.modal,settingsActionMessage=sourceMaintenance.message,settingsActionOwner=accountWorkspaceId;
  const handleExportRecovery=()=>sourceMaintenance.run('export'),handleClearCacheConfirmed=()=>sourceMaintenance.run('clear');
  const requestClearCache=sourceMaintenance.requestClear,dismissSettingsModal=sourceMaintenance.dismiss,signOut=sourceMaintenance.signOut;

  function openSettingsAi(){
    if(settingsUsesAccount&&accountLoaded&&accountWorkspaceId){
      setAccountAiEntryOwner(accountWorkspaceId);setTab('today');
    }else setSourceView('connections');
  }
  const settingsUsesAccount=Boolean(accountLoaded)||accountWanted;
  const settingsReadScope=JSON.stringify([accountWorkspaceId,settingsUsesAccount,accountLoaded?.bundle.snapshot.libraryId??null]);
  const refreshSettingsOverview=useCallback(async()=>{
    const owner=accountWorkspaceId;
    if(!owner||!storageReady||!sessionResolved||deliveryOwnerRef.current!==owner)return;
    const scope=settingsReadScope,epoch=++settingsReadEpoch.current;
    setSettingsOverview({scope,phase:'loading',pending:null,message:'正在核对本机同步队列…',checkedAt:null,accountAi:null,accountAiFailed:false});
    try{
      const [recovery,ai]=await Promise.allSettled([
        exportStudyRecovery(owner),
        settingsUsesAccount?accountClient.getAiSettings():Promise.resolve(null),
      ] as const);
      if(epoch!==settingsReadEpoch.current||deliveryOwnerRef.current!==owner)return;
      const pending=recovery.status==='fulfilled'?settingsPendingSummary(recovery.value):null;
      setSettingsOverview({scope,phase:pending?'ready':'failed',pending,
        message:pending?'':recovery.status==='rejected'?'本机队列读取失败，请重试；已有记录保留。':'本机队列尚未完整核对，不将未知情况显示为零。',
        checkedAt:recovery.status==='fulfilled'?recovery.value.finishedAt:null,
        accountAi:ai.status==='fulfilled'?ai.value:null,accountAiFailed:ai.status==='rejected'});
    }catch{
      if(epoch===settingsReadEpoch.current&&deliveryOwnerRef.current===owner)
        setSettingsOverview({scope,phase:'failed',pending:null,message:'状态读取未完成，请重试。',checkedAt:null,accountAi:null,accountAiFailed:settingsUsesAccount});
    }
  },[accountWorkspaceId,storageReady,sessionResolved,settingsReadScope,settingsUsesAccount,accountClient]);
  useEffect(()=>{
    // This ref is a read-generation counter, not a rendered DOM node.
    const readGeneration=settingsReadEpoch;
    if(tab!=='sources'||(sourceView!=='overview'&&sourceView!=='sync')){readGeneration.current++;return;}
    const timer=window.setTimeout(()=>void refreshSettingsOverview(),0);
    return()=>{window.clearTimeout(timer);readGeneration.current++;};
  },[tab,sourceView,refreshSettingsOverview,eventRevision]);
  const primarySubject = subjects[0];
  const allItems = primarySubject?.items || [];
  const completedItems = allItems.filter((item, idx) => {
    return (uiProgress.itemStages[resolveStudyItemProgressKey(item,idx,uiProgress)] || 0) >= 3;
  }).length;
  const completion = allItems.length > 0 ? Math.round((completedItems / allItems.length) * 100) : 0;
  const focusTitle = isDemoMode ? "示例：AlexNet 鸟瞰阅读" : data.dashboard?.activeResearch?.[0]?.title || data.dashboard?.priorities?.[0] || data.source.title;
  const focusPath = data.dashboard?.activeResearch?.[0]?.path || data.dashboard?.activeProjects?.[0]?.path || data.source.path;
  const focusDetail = isDemoMode
    ? "这是公开示范内容，不是你的个人资料。连接自己的 Obsidian 或本地笔记目录后会自动替换。"
    : data.dashboard?.priorities.length
    ? `Obsidian 今日优先级：${data.dashboard.priorities.slice(0, 2).join("；")}`
    : data.gateway ? "学习内容来自已登记学科的索引；练习完成只是证据，不等于正式掌握。" : "词汇从今天读过的论文中提取；三阶段完成只代表本轮练习通过。";
  const connections: Connection[] = data.connections || [
    { key: "obsidian", label: "Obsidian 学习库", status: syncState === "offline" ? "offline" : "ready", detail: "当前论文与下一篇材料" },
    { key: "localnotes", label: "本地笔记目录", status: syncState === "offline" ? "offline" : "ready", detail: "Markdown、TXT 与 PDF 笔记" },
    { key: "knowledge", label: "AI Knowledge Base", status: syncState === "offline" ? "offline" : "ready", detail: "仅读取已确认的正式记录" },
    { key: "companion", label: "本地同步助手", status: syncState === "offline" ? "offline" : "connected", detail: "浏览器与本地资料之间的安全桥梁" },
    { key: "deepseek", label: "模型 API", status: syncState === "connected" ? "connected" : syncState === "key_missing" ? "missing" : "offline", detail: syncState === "key_missing" ? "等待本地密钥" : syncState === "provider_unavailable" ? "网络暂时不可达，Companion 仍在线" : "生成词卡与明日预习" },
  ];

  const getObsidianUri = (notePath: string) => {
    if (!notePath) return "#";
    if (notePath.startsWith("/") || /^[a-zA-Z]:\\/.test(notePath)) {
      return `obsidian://open?path=${encodeURIComponent(notePath)}`;
    }
    return `obsidian://open?file=${encodeURIComponent(notePath)}`;
  };


  function openSources(view?: SourceView | unknown) {
    const validViews = ['overview', 'appearance', 'connections', 'sources', 'ai', 'sync', 'privacy', 'danger'];
    const targetView = typeof view === 'string' && validViews.includes(view) ? (view as SourceView) : 'appearance';
    if(navigateToStudyTab("sources"))setSourceView(targetView);
  }
  const migrateLocalProgress=legacyCloud.migrate;
  function keepProgressLocal() {
    syncCoordinator.invalidate();legacyCloud.invalidate();
    setCloudSyncMetadata((current: CloudSyncMetadata) => ({ ...current, decision: "local-only" }));
    setCloudStatus("local-only");
    setCloudMessage("已保持仅本机模式；之后可在“数据与设置”中重新启用。 ");
  }
  function requestCloudSync() {
    syncCoordinator.invalidate();
    if (!sessionUser) return;
    if (hasProgressData(progress)) {
      setCloudSyncMetadata((current: CloudSyncMetadata) => ({ ...current, decision: "pending" }));
      setCloudStatus("needs-migration");
      setCloudMessage("请确认是否把这台设备的现有进度迁移到云端。");
    } else {
      setCloudSyncMetadata((current: CloudSyncMetadata) => ({ ...current, decision: "enabled" }));
      setCloudStatus("synced");
      setCloudMessage("云同步已启用。");
    }
  }

  async function requestAiHint(question: unknown, wrongAnswer: string | null) {
    if (!companionSession) throw new Error("请先连接 Companion，再请求 AI 提示。");
    const response = await fetch(`${companionUrl}/v1/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...companionHeaders },
      body: JSON.stringify({ question, wrongAnswer: wrongAnswer || "" }),
    });
    const payload = await response.json() as { hint?: string; message?: string };
    if (!response.ok || !payload.hint) throw new Error(payload.message || "暂时无法生成提示。");
    return payload.hint;
  }

  // 讲解追问（主旨一）：复用 /v1/hint 的苏格拉底导师通道，把用户自由提问
  // 与当前题目一起交给 Companion；答案只在会话内展示，不写入学习事件。
  async function requestAiTutor(question: string, item: unknown) {
    if (!companionSession) throw new Error("请先连接 Companion，再向 AI 导师提问。");
    const response = await fetch(`${companionUrl}/v1/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...companionHeaders },
      body: JSON.stringify({ question: { userQuestion: question, item }, wrongAnswer: "" }),
    });
    const payload = await response.json() as { hint?: string; message?: string };
    if (!response.ok || !payload.hint) throw new Error(payload.message || "暂时无法获得 AI 导师解答。");
    return payload.hint;
  }

  function prepareCompanionLaunch() {
    setCompanionDetected("checking");
    setPairingMessage("已请求 Windows 启动 Companion；首次使用时请允许浏览器打开本地应用。");
    companionSource.detectAfterLaunch();
  }

  const materialImport=useSourceReader({scope:workspaceId,resource:companionSession,
    capture:()=>{const owner=workspaceId,connection=getCompanionSession();return{owner,connection,ready:true,current:()=>taskWorkspaceRef.current===owner&&getCompanionSession()===connection};},
    read:async(frame,file:File,signal)=>{if(!frame.connection)throw Error('请先登录并配对本机 Companion，再从资料生成学习卡。');setImportMessage('正在生成候选学习卡…');return companionHttp.generate(frame.connection,file,signal);},
    publish:(payload,frame)=>{
      const applied=applyLocalStudySource(payload,frame.owner);setSyncState(payload.status);
      setImportMessage(`已生成 ${payload.subjects.length} 组候选学习内容。${applied?'':accountLoadedRef.current?'当前账号题库仍保持不变。':'离开当前练习后更新。'}`);
      if(applied){setItemIndices({});const subject=payload.subjects[0];if(subject){accountAttemptActiveRef.current=true;setTab(subject.id);}}
    },error:error=>setImportMessage(error instanceof Error?error.message:'本地同步助手或模型 API 尚未就绪，已保留当前词卡。'),
  });
  const importFile=(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];if(file)void materialImport.read(file);};

  const activeSubject = subjects.find((subject) => subject.id === tab);
  // 全局完成态：所有可练学科都达到各自的本轮完成口径（词汇看持久化阶段，
  // 其他模块看会话内本轮答对）时，今日汇总顶部显示庆祝横幅。
  const allSubjectsComplete = subjects.length > 0 && subjects.every((subject) => isSubjectRoundComplete({
    pluginType: subject.pluginType,
    items: subject.items || [],
    itemStages: uiProgress.itemStages,
    keyOf: (item, index) => resolveStudyItemProgressKey(item, index, uiProgress),
    round: subjectRounds[subject.id] || emptySubjectRound(),
  }));

  // 再学一轮：非词汇模块只清会话内本轮记录；词汇模块把每个词按“记错了·
  // 重置本词”的同一条事件链路重置回阶段 1（可回放，不新增机制），然后回
  // 到第一张卡重新开始。
  type RestartItem={item:StudyItem;index:number;key:string;stage:number;record?:LocalStudyEventRecord};
  type RestartWork={scope:string;subjectId:string;keys:string[];mutation:number;batch:ReturnType<typeof createRestartBatch<RestartItem>>};
  const restartWork=useRef<RestartWork|null>(null);
  const [restartStatus,setRestartStatus]=useState<{scope:string;owner:string;library:string;day:string;subjectId:string;completed:number;total:number;busy:boolean;canRetry:boolean;message:string}|null>(null);
  const restartEpoch=useRef(0);
  useLayoutEffect(()=>{restartEpoch.current++;return()=>{restartEpoch.current++;};},[workspaceId,nativeScope,accountLibraryId,currentDay,tab,learningDrafts]);
  const cancelSubjectRestart=()=>{if(learningDrafts.isPending())return;restartWork.current=null;setRestartStatus(null);};
  const restartSubjectRound = async (subjectId: string, onlyKeys?: readonly string[]) => {
    if(learningDrafts.isPending()){setPlanMessage('当前作答或重新开始正在处理，请稍候。');return;}
    const subject=subjects.find(entry=>entry.id===subjectId);if(!subject)return;
    const subjectItems=subject.items??[],itemKeys=subjectItems.map((item,index)=>resolveStudyItemProgressKey(item,index,uiProgress));
    const selected=new Set(onlyKeys??itemKeys),scope=JSON.stringify([workspaceId,accountLibraryId??nativeScope,currentDay,subjectId,itemKeys.filter(key=>selected.has(key)),subjectItems.map(item=>item.contentHash??item.fingerprint??null)]);
    const epoch=restartEpoch.current,modeEpoch=accountModeEpoch.current,nav=practiceRequest.current,storeVersion=learningDrafts.getItemVersion('__restart_guard__');
    const current=()=>restartEpoch.current===epoch&&accountModeEpoch.current===modeEpoch&&practiceRequest.current===nav&&taskWorkspaceRef.current===workspaceId&&activeLearningDraftsRef.current===learningDrafts&&learningDrafts.getItemVersion('__restart_guard__')===storeVersion;
    const resetView=()=>{
      if(!current())return;
      for(const [index,item]of subjectItems.entries())if(selected.has(itemKeys[index]))learningDrafts.clearItem(learningDraftItemId(subjectId,itemKeys[index],item));
      setSubjectRounds(rounds=>({...rounds,[subjectId]:onlyKeys?focusRound(itemKeys,onlyKeys):emptySubjectRound()}));
      setItemIndex(subjectId,0);
    };
    if(subject.pluginType!=='three-stage'||!subjectItems.length){resetView();return;}
    if(isDemoMode){resetView();setDemoProgress(value=>({...value,itemStages:clearItemStages(value.itemStages,[...selected])}));return;}
    if(accountLoaded){resetView();setAccountProgress(value=>value?.workspaceId===workspaceId&&value.libraryId===accountLoaded.bundle.snapshot.libraryId?{...value,progress:{...value.progress,itemStages:clearItemStages(value.progress.itemStages,[...selected])}}:value);return;}
    if(restartWork.current?.scope===scope&&restartWork.current.mutation!==eventMutation.current){restartWork.current=null;setRestartStatus({scope,owner:workspaceId,library:accountLibraryId??nativeScope,day:currentDay,subjectId,completed:0,total:1,busy:false,canRetry:false,message:'学习记录已变化，已停止旧的重启请求；请核对当前阶段后重新选择。'});return;}
    const work=restartWork.current?.scope===scope?restartWork.current:{scope,subjectId,keys:[...selected],mutation:eventMutation.current,batch:createRestartBatch(subjectItems.map((item,index)=>({item,index,key:itemKeys[index],stage:uiProgress.itemStages[itemKeys[index]]??0})).filter(job=>selected.has(job.key)&&job.stage>0))};
    restartWork.current=work;
    const publish=(busy:boolean,message:string)=>{if(current())setRestartStatus({scope,owner:workspaceId,library:accountLibraryId??nativeScope,day:currentDay,subjectId,completed:work.batch.completed,total:work.batch.total,busy,canRetry:!busy&&restartWork.current===work&&work.batch.completed<work.batch.total,message});};
    publish(true,'正在重新开始；完成本机保存后才能继续作答。');
    const apply=async(job:RestartItem)=>{
      const persist=async(record:LocalStudyEventRecord)=>{
        if(!current())throw new Error('学习范围已变化；已保存的重启记录保留，未处理项已停止。');
        job.record=record;
        const outcome=await putLocalStudyEvent(record);if(outcome==='conflict')throw new Error('重启记录发生冲突，请核对历史；没有覆盖原事件。');
        eventMutation.current++;work.mutation=eventMutation.current;
      };
      const project=async({event,clientStateAfter}:{event:StudyEventV3;clientStateAfter?:NonNullable<Progress['fsrsData']>[string]})=>{
        if(!current())return;
        const records=await listLocalItemEvents(workspaceId,event.item.kind,event.item.key);
        const latest=records.map(row=>row.event).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId)).at(-1);
        if(!current()||latest&&latest.eventId!==event.eventId){if(current())noteEventsChanged();return;}
        setProgress(value=>({...value,itemStages:{...value.itemStages,[job.key]:0},fsrsData:clientStateAfter?{...(value.fsrsData??{}),[job.key]:clientStateAfter}:value.fsrsData}));
        setNativeProjection(value=>applySavedNativeAttempt(value,{workspaceId,sourceScope:nativeScope},event,clientStateAfter));noteEventsChanged();
      };
      if(job.record){await persist(job.record);await project({event:job.record.event,clientStateAfter:job.record.event.eventType==='practice-attempt'?job.record.event.scheduling?.clientStateAfter:undefined});return;}
      await recordStudyAttempt({workspaceId,domain:domainForSubject(subject),item:{kind:isVocabularySubject(subject)?'word':subject.sourceMode==='gateway'?'due':itemKindForDomain(domainForSubject(subject)),key:job.key,...(job.item.stateHandle===undefined?{}:{stateHandle:job.item.stateHandle})},rating:'again',correct:false,stageBefore:job.stage,stageAfter:0,reviewedAt:new Date().toISOString(),isThreeStage:true,currentFsrs:uiProgress.fsrsData?.[job.key],
        localContext:{title:`需要复习：${itemLabel(job.item,job.index)}`,activityType:'website-practice',durationMin:1,weakPoints:[],sourceNote:markdownNotePath(job.item.sourceNote)||markdownNotePath(data.source.path),stateRef:markdownNotePath(job.item.stateRef),abilityId:resolveEventAbilityId(job.item,job.index,uiProgress)},
        delivery:{cloud:sessionUser&&cloudSyncMetadata.decision==='enabled'?'pending':'not-required',companion:'pending'}},
        {persistEvent:persist,persistProgress:project,
          // Durable pending events are delivered by the existing outbox, outside the local reset lock.
          sendCloud:async()=>({}),sendCompanion:async()=>({}),updateDelivery:updateStudyEventDelivery});
    };
    try{
      await learningDrafts.grade(async()=>{
        const status=await work.batch.run(apply,current);
        if(status==='complete'){resetView();restartWork.current=null;publish(false,'已完成本机重启。需要发送的记录保留在同步队列中。');}
      });
    }catch(error){publish(false,`已处理 ${work.batch.completed} / ${work.batch.total} 项。${error instanceof Error?error.message:'本机保存失败，请重试未完成项。'}`);}
    finally{work.mutation=eventMutation.current;if(!current()&&restartWork.current===work){restartWork.current=null;setRestartStatus(value=>value?.scope===scope?{...value,busy:false,canRetry:false,message:'已离开原练习，剩余重启已停止；已保存记录保留。'}:value);}if(current()){setRestartStatus(value=>value?.scope===scope?{...value,busy:false}:value);void flushV3Targets().catch(()=>{});}}
  };
  const retrySubjectRestart=()=>{const work=restartWork.current;if(work)void restartSubjectRound(work.subjectId,work.keys);};
  const setSubjectPluginOverride = (subjectId: string, value: string) => {
    setPluginOverrides((current) => {
      const subject = { ...current.subject };
      if (isPluginType(value)) subject[subjectId] = value;
      else delete subject[subjectId];
      return { ...current, subject };
    });
  };
  const heading = tab === "today"
    ? "今日学习"
    : tab === "sources"
      ? "数据与设置"
      : tab === "progress"
        ? "学习进度"
        : tab === "curation"
          ? "先审查，再进入学习队列。"
          : activeSubject?.name || "学习内容暂不可用。";
  const visibleAccountStatus:AccountLoadStatus=accountOptedOut?{phase:'local'}:accountReadPaused?{phase:'cleared'}:accountReadStatus;
  const visibleSyncState=accountLoaded||['loading','cached'].includes(visibleAccountStatus.phase)
    ? visibleAccountStatus.phase==='ready'?'connected':visibleAccountStatus.phase==='failed'||visibleAccountStatus.phase==='not-connected'?'offline':visibleAccountStatus.phase==='cached'?'key_missing':'pending'
    : syncState;
  const syncLabel = accountLoaded||['loading','cached'].includes(visibleAccountStatus.phase)?accountLoadLabel(visibleAccountStatus):!companionSession ? "本机助手未连接" : syncState === "connected" ? "本机资料已连接" : syncState === "key_missing" ? "资料已连接 · AI 待配置" : syncState === "provider_unavailable" ? "资料已连接 · AI 暂不可用" : syncState === "offline" ? "本机助手离线" : "本机资料读取失败";
  const syncTimeLabel = accountLoaded?`账号题库 · 版本 ${accountLoaded.bundle.snapshot.revision}`:data.syncedAt ? `更新于 ${new Date(data.syncedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "尚未同步个人资料";
  const cloudStatusLabel = cloudStatus === "guest" ? "仅本机" : cloudStatus === "needs-migration" ? "等待迁移确认" : cloudStatus === "syncing" || cloudStatus === "checking" ? "正在检查云端" : cloudStatus === "synced" ? "云端进度已启用" : cloudStatus === "local-only" ? "此设备仅本机" : "云同步待重试";
  const cloudStatusDetail = cloudOutbox.length ? `${cloudOutbox.length} 条事件等待每日同步` : cloudSyncMetadata.lastSyncedAt ? `最近同步 ${new Date(cloudSyncMetadata.lastSyncedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : cloudMessage || "尚未产生云端学习记录";

  const accountModuleSource=accountLoaded
    ? resolveAccountModuleSource({day:currentDay,subjectId:tab,active:activeTaskScope,approved:accountDailyPlan.source,freeStudy:freeStudySubject===tab})
    : null;
  const moduleSubjects=accountLoaded&&accountModuleSource
    ? normalizeDynamicSubjects(accountStudyPayload({...accountLoaded,bundle:accountModuleSource.bundle,catalog:accountModuleSource.cloudCatalog},workspaceId).subjects) as Subject[]
    : demoVisibleSubjects;
  const moduleNavigationSubjects=accountLoaded?moduleSubjects:subjects;
  const navigationSource=accountLoaded?accountDailyPlan.source:taskLearning.state?.draft&&taskLearning.state.catalog?{plan:taskLearning.state.draft.plan,catalog:taskLearning.state.catalog}:null;
  const navigationSubjects=accountLoaded&&accountDailyPlan.source?normalizeDynamicSubjects(accountStudyPayload({...accountLoaded,bundle:accountDailyPlan.source.bundle,catalog:accountDailyPlan.source.cloudCatalog},workspaceId).subjects) as Subject[]:normalizedSubjects;
  const onReviewSelectionChange=(ids:string[])=>{if(!navigationSource)return;setPracticeSelection({scope:practiceSelectionScope(workspaceId,accountLoaded?accountLibraryId??'':nativeScope,navigationSource.plan),taskIds:ids.filter(id=>navigationSource.plan.tasks.some(task=>task.taskId===id))});};
  const studyTaskNavigation={...(navigationSource?practiceGroupNavigation(getPracticeGroups(navigationSource.plan,navigationSource.catalog,navigationSubjects),getSubjectRound,workspaceId,accountLoaded?accountLibraryId??'':nativeScope,currentDay,navigationSource.plan.tasks):{finishedPassTaskIds:[],practiceGroupByTask:{}}),
    reviewSelectionTaskIds:navigationSource&&practiceSelection?.scope===practiceSelectionScope(workspaceId,accountLoaded?accountLibraryId??'':nativeScope,navigationSource.plan)?practiceSelection.taskIds:[],onReviewSelectionChange};
  const studyFocus=moduleNavigationSubjects.some(subject=>subject.id===tab);
  const settingsReadView=settingsOverview?.scope===settingsReadScope?settingsOverview:null;
  const settingsAccountStatus=settingsAccountConnection(visibleAccountStatus,Boolean(sessionUser));
  const settingsCompanionStatus=settingsCompanionConnection({paired:Boolean(companionSession),detected:companionDetected,syncState});
  const settingsAiStatus=settingsAiConnection({mode:settingsUsesAccount?'account':'local',signedIn:Boolean(sessionUser),
    accountAi:settingsReadView?.accountAi??null,accountAiFailed:settingsReadView?.accountAiFailed,
    companionOnline:companionDetected==='online',
    localStatus:['key_missing','provider_unavailable'].includes(syncState)?syncState:syncState==='connected'?connections.find(item=>item.key==='deepseek')?.status:undefined});
  const settingsHistoryReady=accountLoaded?Boolean(scopedAccountProgress?.historyReady):!accountWanted&&!isDemoMode&&!nativeHistoryError&&nativeView.ready&&nativeView.unresolvedKeys.length===0;
  const settingsRecordCount=countSettingsPractice(progressEvents,settingsHistoryReady);
  const settingsRegisteredCount=accountLoaded?accountLoaded.bundle.items.length:!accountWanted&&!isDemoMode?normalizedSubjects.reduce((sum,subject)=>sum+subject.items.length,0):null;
  const settingsDeliveryLabel=settingsReadView?.pending?(settingsReadView.pending.total?settingsReadView.pending.total+' 项本机待同步':'当前本机队列为空'):'待同步情况待核对';
  const accountProgressChecking=accountWanted&&(!accountLoaded||!scopedAccountProgress?.historyReady);
  const nativeProgressChecking=!isDemoMode&&!accountLoaded&&!accountWanted&&(!nativeView.ready||nativeView.unresolvedKeys.length>0||Boolean(nativeHistoryError));
  const showMigrationBanner=!studyFocus&&!accountLoaded&&cloudStatus==="needs-migration";
  const paperLibraryScope=accountLoaded?`account:${accountLibraryId}`:`local:${data.localLibraryId??'offline'}`;
  const paperScopeCurrent=()=>taskWorkspaceRef.current===workspaceId&&(accountLibraryId?accountLoadedRef.current?.bundle.snapshot.libraryId===accountLibraryId:!accountLoadedRef.current&&!accountIntentRef.current&&taskStudyDataRef.current.localLibraryId===data.localLibraryId);
  async function refreshPaperVocabulary(entries:PaperWord[],localLibraryId:string):Promise<PaperVocabularyReadback>{
    const owner=workspaceId,epoch=accountModeEpoch.current,account=accountLibraryId;
    const current=()=>{if(taskWorkspaceRef.current!==owner||epoch!==accountModeEpoch.current||!paperScopeCurrent())throw new Error('资料库已变化，请在原资料库重新核对。');};
    current();if(!companionSession)throw new Error('Companion 未连接。');
    const response=await fetch(`${companionUrl}/v1/study-data`,{headers:companionHeaders,cache:'no-store',signal:AbortSignal.timeout(30000)});
    const source=await response.json() as StudyPayload;current();
    if(!response.ok||source.localLibraryId!==localLibraryId||!Array.isArray(source.subjects))throw new Error('本机资料尚未完整核对。');
    const localItems=source.subjects.flatMap(subject=>subject.items).filter(item=>item.sourceNote===PAPER_VOCABULARY_TARGET&&typeof item.word==='string'&&typeof item.meaning==='string'&&typeof item.abilityId==='string').map(item=>({itemKey:item.abilityId!,word:item.word!,meaning:item.meaning!}));
    const localMatch=matchPaperVocabulary(entries,localItems);
    if(account){
      const latest=await refreshAccountRead();current();
      if(!latest||latest.bundle.snapshot.libraryId!==account)throw new Error('账号资料尚未完成读取。');
      const words=latest.bundle.items.flatMap(item=>item.kind==='word'?[{itemKey:item.itemKey,word:item.word.word,meaning:item.word.meaning}]:[]);
      const match=matchPaperVocabulary(entries,words,localMatch.itemKeys);
      const visible=accountLoadedRef.current?.bundle.items.flatMap(item=>item.kind==='word'?[{itemKey:item.itemKey,word:item.word.word,meaning:item.word.meaning}]:[])??[];
      const shown=matchPaperVocabulary(entries,visible,localMatch.itemKeys);
      const complete=match.matched===match.total&&match.total>0;
      return{...match,mode:'account',status:complete?(shown.matched===shown.total?'visible':accountPendingLoadedRef.current?.bundle.snapshot.snapshotId===latest.bundle.snapshot.snapshotId?'deferred':'pending'):'pending'};
    }
    const applied=applyLocalStudySource(source,owner);
    return{...localMatch,mode:'local',status:localMatch.matched===localMatch.total&&localMatch.total>0?(applied?'visible':'deferred'):'pending'};
  }
  const paperServices={libraryClient:paperLibraryClient,onSources:()=>openSources('connections'),isCurrent:paperScopeCurrent,refreshVocabulary:refreshPaperVocabulary,owner:workspaceId,library:paperLibraryScope,accountLibraryId:accountLoaded?accountLibraryId??undefined:undefined,localLibraryId:data.localLibraryId??undefined,client:companionSession?createPaperVocabularyClient(companionUrl,companionSession.token):undefined};
  const aiPage=studyAIPageContext({page:practiceItems?'practice':tab,day:currentDay,
    subjects:moduleNavigationSubjects.map(subject=>({subjectId:subject.id,name:subject.name,itemCount:subject.items.length})),
    activeSubjectIndex:studyFocus?moduleNavigationSubjects.findIndex(subject=>subject.id===tab):undefined,
    tasks:accountLoaded?(accountDailyPlan.state?.approvedPlan?.tasks??accountDailyPlan.state?.currentPlan?.tasks??[]):taskPlanningEnabled?(taskLearning.state?.draft?.plan.tasks??[]):effectivePlan?.items.map(item=>({subjectId:item.practice?.subjectId??item.domain,title:item.title??'学习任务',category:item.kind==='review'||item.kind==='overdue'?'review':item.practice?.kind==='vocab-group'?'new-word':'subject',quantity:item.practice?.count??1}))??[],
    planState:accountLoaded?(!accountDailyPlan.ready?'unknown':accountDailyPlan.state?.approvedPlan?'approved':accountDailyPlan.state?.currentPlan?'draft':'none'):taskPlanningEnabled?(!taskLearning.state?.ready?'unknown':taskLearning.state.draft?'local':'none'):effectivePlan?'local':'none',
    historyReady:progressHistoryReady,practiceCount:settingsRecordCount,
    activeProgress:activeProgressModule&&activeProgressSummary?{name:activeProgressModule.name,evidenceCount:activeProgressSummary.evidenceCount,knownItemCount:activeProgressSummary.knownItemCount,completionPercent:activeProgressSummary.completionPercent}:null});


 const retryWorkspace=()=>{accountSources.cancel();workspaceReader.cancel();companionSource.cancel();syncCoordinator.invalidate();legacyCloud.invalidate();deliveryOwnerRef.current='' ;accountModeEpoch.current++;setStorageReady(false);setSessionResolved(false);setSessionUser(null);setWorkspacePhase('checking-identity');setData(fallbackData);setIdentityRetry(value=>value+1);};

  const acceptCompanionCapabilities=(values:string[])=>{
    if(taskWorkspaceRef.current!==workspaceId||getCompanionSession()!==companionSession)return;
    setCompanionSession(current=>current?{...current,capabilities:values}:current);
  };
  const applyDemoPacing=(ids:string[]|null)=>{if(!canApplyDemoPacing)return;setDemoPacingIds(ids);setItemIndices({});setSubjectRounds({});requestStudyTab('today');};
  const currentLongTermSourceStamp=()=>longTermSourceStampRef.current;
  const finishLongTermOpenRequest=(version:number)=>setLongTermOpenRequest(current=>current?.version===version?null:current);
  const sourcesModel={
    appearance: {theme, setTheme, canApplyDemoPacing, currentDay, loadLongTermSource, longTerm, longTermOpenRequest, longTermScopeKey, setLongTermEditing, applyDemoPacing, currentLongTermSourceStamp, finishLongTermOpenRequest},
    connection: {acceptCurrentAccountLibrary, accountClient, accountDailyPlan, accountLoaded, accountWorkspaceId, companionCapabilities, companionDetected, companionSession, companionVersion, connections, detectExistingCompanion, pairCompanion, pairingCode, pairingMessage, prepareCompanionLaunch, readAccountAgain, refreshSources, refreshing, sessionResolved, sessionUser, storageReady, switchToLocalMode, syncState, visibleAccountStatus, acceptCompanionCapabilities},
    catalog: {changeCandidates, changeDecisionId, changeDecisionMessage, changesLoading, data, decideChange, importFile, importMessage, isDemoMode, lastChangeScan, mappingClient, scanChanges, taskLearning},
    sync: {cloudFlushing, cloudMessage, cloudStatus, cloudStatusDetail, cloudStatusLabel, diagnosticsLoading, keepProgressLocal, manualSyncing, migrateLocalProgress, refreshReviewDiagnostics, requestCloudSync, reviewDiagnostics, syncCloudNow, retryCloudSync},
    recovery: {dismissSettingsModal, handleClearCacheConfirmed, handleExportRecovery, openSettingsAi, refreshSettingsOverview, requestClearCache, settingsAccountStatus, settingsActionMessage, settingsActionOwner, settingsAiStatus, settingsCompanionStatus, settingsDeliveryLabel, settingsModal, settingsReadView, settingsRecordCount, settingsRegisteredCount, settingsUsesAccount},
    navigation: {homeHref, setAiEntryOpen, setPairingCode, setSourceView, setStarterOpen, setTab:requestStudyTab, sourceView, starterOpen, studyAI, tab}
  };
 return {
  sourcesModel,
  retryWorkspace,
  acceptCurrentAccountLibrary,
  accountAILibrary,
  accountAiEntryOwner,
  accountAttemptActiveRef,
  accountClient,
  accountDailyPlan,
  accountLibraryId,
  accountLoaded,
  accountLoadedRef,
  accountModeEpoch,
  accountModuleSource,
  accountOptedOut,
  accountPendingLoadedRef,
  accountProgressChecking,
  accountWorkspaceId,
  activeCurationCategory,
  activeLearningDraftsRef,
  activeProgressId,
  activeProgressModule,
  activeProgressSubject,
  activeProgressSummary,
  activeProject,
  activeTaskScope,
  aiEntryOpen,
  aiPage,
  allItems,
  allSubjectsComplete,
  applyAccountLoaded,
  applyLocalStudySource,
  approveTodayPlan,
  assistanceHistory,
  auxiliaryDelivery,
  canApplyDemoPacing,
  captureAttemptFrame,
  changeCandidates,
  changeDecisionId,
  changeDecisionMessage,
  changesLoading,
  choosePlanVocabEntry,
  cloudFlushing,
  cloudMessage,
  cloudStatus,
  cloudStatusDetail,
  cloudStatusLabel,
  cloudSyncMetadata,
  retryCloudSync,
  companionCapabilities,
  companionDetected,
  companionPlanClient,
  companionSession,
  companionVersion,
  completeAccountTask,
  completedItems,
  completion,
  connections,
  constraintAuthority,
  constraintMode,
  curationIndex,
  currentDay,
  data,
  decideChange,
  detectExistingCompanion,
  diagnosticsLoading,
  dismissSettingsModal,
  effectivePlan,
  eventMutation,
  eventRevision,
  focusDetail,
  focusPath,
  focusTitle,
  freeStudySubject,
  generateTodayPlan,
  getObsidianUri,
  gradeAccountCalculation,
  handleClearCacheConfirmed,
  handleExportRecovery,
  heading,
  homeHref,
  importFile,
  importMessage,
  inputPoolPractice,
  isDemoMode,
  itemIndices,
  keepProgressLocal,
  lastChangeScan,
  lastStudyReceipts,
  learningDrafts,
  legacyPlanningVisibility,
  loadLongTermSource,
  localSourcePending,
  longTerm,
  longTermOpenRequest,
  longTermScopeKey,
  longTermSourceStampRef,
  manualSyncing,
  mappingClient,
  migrateLocalProgress,
  moduleAccuracy,
  moduleNavigationSubjects,
  moduleSubjects,
  nativeHistoryError,
  nativeProgressChecking,
  nativeScope,
  nativeView,
  navigateToStudyTab,
  normalizedSubjects,
  noteEventsChanged,
  openLongTermFromToday,
  openSettingsAi,
  openSources,
  pairCompanion,
  pairingCode,
  pairingMessage,
  paperLibraryScope,
  paperServices,
  pendingActivities,
  pendingLocalSourceRef,
  persistSubmittedEvent,
  persistVocabPacing,
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
  pluginOverrides,
  practiceItems,
  practiceLoading,
  practiceRequest,
  practiceSessionKey,
  practiceSummary,
  prepareCompanionLaunch,
  primarySubject,
  progressEvents,
  progressHistoryReady,
  progressModules,
  readAccountAgain,
  recordPracticeAttempt,
  refreshReviewDiagnostics,
  refreshSettingsOverview,
  refreshSources,
  refreshing,
  rejectTodayPlan,
  removePlanEntry,
  requestAiHint,
  requestAiTutor,
  requestClearCache,
  requestCloudSync,
  restartSubjectRound,
  restartStatus:restartStatus?.owner===workspaceId&&restartStatus.library===(accountLibraryId??nativeScope)&&restartStatus.day===currentDay?restartStatus:null,
  retrySubjectRestart,
  cancelSubjectRestart,
  restorePlanRevision,
  reviewDiagnostics,
  riskyItems,
  runAccountQuestionAi,
  savePlanSettings,
  scanChanges,
  scopedAccountProgress,
  selectedPlanVocabKey,
  sendSubmittedCloud,
  sendSubmittedCompanion,
  sessionResolved,
  sessionUser,
  setAccountAiEntryOwner,
  setAccountProgress,
  setActiveTaskScope,
  setAiEntryOpen,
  setCompanionSession,
  setConstraintMode,
  setCurationCategory,
  setCurationIndex,
  setData,
  setDemoPacingIds,
  setDemoProgress,
  setFreeStudySubject,
  setIdentityRetry,
  setItemIndex,
  setItemIndices,
  setItemPluginOverride,
  setLongTermEditing,
  setLongTermOpenRequest,
  setNativeProjection,
  setPairingCode,
  setPlanDeadlineDraft,
  setPlanMessage,
  setPlanMode,
  setPlanSettings,
  setPracticeItems,
  setPracticeSummary,
  setProgress,
  setProgressEvents,
  setProgressView,
  setSelectedPlanVocabKey,
  setSessionResolved,
  setSessionUser,
  setSourceView,
  setStageRoundBump,
  setStarterOpen,
  setStorageReady,
  setSubjectPluginOverride,
  setSubjectRounds,
  setTab:requestStudyTab,
  setTemporaryUntil,
  setTheme,
  setWorkspacePhase,
  settingsAccountStatus,
  settingsActionMessage,
  settingsActionOwner,
  settingsAiStatus,
  settingsCompanionStatus,
  settingsDeliveryLabel,
  settingsModal,
  settingsReadView,
  settingsRecordCount,
  settingsRegisteredCount,
  settingsUsesAccount,
  showMigrationBanner,
  signOut,
  sourceView,
  stageRoundBump,
  startAccountLearning,
  continueTodayStudy,
  studyTaskNavigation,
  startPlannedQuestionPractice,
  startPractice,
  startTaskLearning,
  starterOpen,
  storageReady,
  studyAI,
  studyFocus,
  subjectPacing,
  subjectRounds,
  getVisibleSubjectRound,
  subjects,
  submissionJournal,
  switchToLocalMode,
  syncCloudNow,
  syncLabel,
  syncState,
  syncTimeLabel,
  tab,
  taskLearning,
  taskPlanningEnabled,
  taskWorkspaceRef,
  temporaryUntil,
  theme,
  todayLabel,
  uiProgress,
  useCaughtUpPage,
  visibleAccountStatus,
  visibleLearningRef,
  visibleSyncState,
  vocabPacingWorkspace,
  workspaceId,
  workspacePhase,
 };
}
export type DashboardController=ReturnType<typeof useDashboardController>;
