// Exercise the real M4 use cases and Root assembly with the older tests' isolated I/O ports.
// Defaults below are empty presentation state, never a substitute for delivery/replay policy.
import {createAccountSourceSession,createCompanionSession,createSourceTransitions,createSourceReader} from '../../src/application/sources/index.ts';
import {createEventDispatcher,createSyncCoordinator} from '../../src/application/sync/index.ts';
import {applyTargetNotice,foldCoreReceiptNotice} from '../../src/domain/sync/index.ts';
import {updateCompanionReadMessage,usableCompanionSource} from '../../src/domain/sources/index.ts';
import {createCompanionHttp} from '../../src/infrastructure/sources/index.ts';
import {sendLegacyBoundEvent,sendLegacyCompanionActivity} from '../../src/infrastructure/sync/index.ts';
import {extract,createHooks,loader} from '../helpers/causal-harness.mjs';
const noop=()=>{},closedFetch=async()=>{throw Error('Unexpected network I/O in isolated Dashboard test');};
const sessions=new WeakMap();
export function m4Bindings(name,original,options,fn){
  const workspace=original.workspaceId??original.accountWorkspaceId??original.deliveryOwnerRef?.current??'account:fixture';
  const drafts=original.learningDrafts??{isPending:()=>false,hasBuffers:()=>false,clear:noop};
  const defaults={isDemoMode:false,accountLoaded:null,taskPlanningEnabled:false,workspaceId:workspace,accountWorkspaceId:workspace.startsWith('account:')?workspace:null,accountDeviceId:'fixture',storageReady:true,sessionResolved:true,
    sessionUser:{userId:workspace.slice(8),email:'',displayName:'Fixture'},accountOptedOut:false,accountReadPaused:false,currentDay:'2026-09-19',
    accountModeEpoch:{current:0},sourceTransitionBusy:{current:()=>false},taskWorkspaceRef:{current:workspace},deliveryOwnerRef:{current:workspace},
    eventMutation:{current:0},accountLoadedRef:{current:null},accountIntentRef:{current:false},accountAttemptActiveRef:{current:false},accountBundlesRef:{current:new Map()},accountWanted:false,accountLibraryId:null,nativeScope:'fixture',
    learningDrafts:drafts,activeLearningDraftsRef:{current:Object.assign(drafts,{getMutationVersion:drafts.getMutationVersion??(()=>0),hasBuffers:drafts.hasBuffers??(()=>false)})},
    companionSession:null,companionUrl:'http://synthetic.invalid',companionRetryToken:0,companionReconnectMs:5000,pairingCode:'123456',accountClient:{},submissionJournal:{},
    setAccountReadStatus:noop,setAccountLoaded:noop,setAccountPreferred:noop,setAccountOptedOut:noop,setSessionResolved:noop,setStorageReady:noop,setWorkspacePhase:noop,
    setLocalSourcePending:noop,pendingLocalSourceRef:{current:null},setLastStudyReceipts:noop,setCloudMessage:noop,setCompanionVersion:noop,setCompanionDetected:noop,
    setPairingMessage:noop,setCompanionSession:noop,setSyncState:noop,setPairingCode:noop,setCompanionRetryToken:noop,
    setAuxiliaryDelivery:noop,applyLocalDashboard:noop,flushPendingActivities:async()=>{},cancelAccountRead:noop,companionSource:{cancel:noop},syncCoordinator:{invalidate:noop},accountSources:{clearPending:noop,cancel:noop},
    getCompanionSession:()=>original.companionSession??null,updateCompanionReadMessage,usableCompanionSource,applyTargetNotice,foldCoreReceiptNotice,
    cloudSyncMetadata:{decision:'local-only',cursor:0},cloudOutbox:[],pendingActivities:[],sendActivity:async()=>false,
    submissionTransport:()=>({drain:async()=>({recovered:0,failed:0,states:[]})}),drainOriginalEventTargets:async()=>({projectionMismatches:[]}),sendV3ToCloud:async()=>({}),sendV3ToCompanion:async()=>({}),
    legacyCloud:{invalidate:noop},clearLocalAccountStudy:async()=>{throw Error('Unexpected cache clear');},clearAccountWorkspaceRecords:async()=>{throw Error('Unexpected workspace clear');},
  };
  const env={...defaults,...original};
  const adapter=(file,name,bindings=env)=>extract(file,name)(bindings);
  const account=()=>{
    const prepared=adapter('app/study-dashboard/account-source-adapter.ts','prepareAccountSource');
    const projected=adapter('app/study-dashboard/account-source-adapter.ts','projectAccountSource');
    const ports=options('accountSources',{...env,prepareAccountSource:prepared,projectAccountSource:projected});
    const source=createAccountSourceSession({...ports,abort:()=>new AbortController()});
    if(original.accountPendingLoadedRef)Object.defineProperty(original.accountPendingLoadedRef,'current',{configurable:true,get:()=>source.pending(),set:value=>{if(value===null)source.clearPending();}});
    return{...source,getPending:source.pending};
  };
  if(name==='applyAccountLoaded'||name==='cancelAccountRead'||name==='refreshAccountRead')env.accountSources=original.accountSources??account();
  if(name==='acceptCurrentAccountLibrary'||name==='switchToLocalMode'){
    env.sourceTransitions=createSourceTransitions({...options('sourceTransitions',env),busy:noop});
  }
  if(['detectExistingCompanion','pairCompanion','refreshSources','fetchStudyData'].includes(name)){
    const connection=original.companionSession??(name==='fetchStudyData'?{token:'fixture'}:null);
    env.companionSession=connection;env.getCompanionSession=()=>connection;
    const http=createCompanionHttp(env.companionUrl,original.fetch??closedFetch);
    const ports=options('companionSource',{...env,companionHttp:http,publishCompanionNotice:fn('publishCompanionNotice',env)});
    const capture=ports.capture;
    env.companionSource=createCompanionSession({...ports,capture:()=>{const frame=capture();return{...frame,current:()=>original.active!==false&&frame.current()};},busy:noop,abort:()=>new AbortController()});
    if(name==='fetchStudyData')return{env,result:env.companionSource.poll};
  }
  if(['sendV3ToCloud','sendV3ToCompanion','sendSubmittedCloud','sendSubmittedCompanion'].includes(name)){
    const transport=original.createSubmissionTransport??original.submissionTransport??(()=>({core:async()=>{throw Error('unexpected submitted route');},summary:async()=> 'unknown'}));
    const factory=adapter('app/study-dashboard/event-dispatch-adapter.ts','createDashboardEventDispatcher',{
      ...env,createEventDispatcher,createSubmissionTransport:transport,
      readJournalForDelivery:original.readJournalForDelivery??(async()=>null),findLocalAccountStudyRecord:original.findLocalAccountStudyRecord??(async()=>null),
      sendLegacyBoundEvent:(owner,event)=>sendLegacyBoundEvent(owner,event,original.fetch??closedFetch),
      sendLegacyCompanionActivity:(connection,event,context)=>sendLegacyCompanionActivity(connection,event,context,original.fetch??closedFetch),
    });
    env.createEventDispatch=fn('createEventDispatch',{...env,createDashboardEventDispatcher:factory});
  }
  if(['syncCloudNow','flushCloudOutbox','flushAccountQueue','flushSubmissionJournal','flushV3Targets','flushPendingActivities'].includes(name)&&!original.syncCoordinator){
    const capture=fn('captureSyncFrame',env),publish=fn('publishSyncNotice',env);
    env.syncCoordinator=createSyncCoordinator({capture,publish,busy:noop,now:()=>new Date().toISOString()});
  }
  if(name==='runV3Bootstrap'&&!original.nativeBootstrap){
    env.readDashboardBoundHistory=(owner,full,signal)=>original.readBoundStudyHistory({workspaceId:owner,forceFull:full,signal,isCurrent:()=>!signal.aborted});
    env.nativeBootstrap=createSourceReader({...options('nativeBootstrap',env),busy:noop});
  }
  if(['exportAccountCache','clearAccountCache','runSettingsRecovery','handleExportRecovery','handleClearCacheConfirmed','signOut','requestClearCache','dismissSettingsModal'].includes(name)){
    let fixture=sessions.get(original);
    if(!fixture){
      const hooks=createHooks(),state=hooks.api.useState;
      hooks.api.useState=init=>{const [value,set]=state(init);return[value,next=>{set(next);if(next&&'modal'in next){original.setSettingsModal?.(next.modal);original.setSettingsActionMessage?.(next.message);}}];};
      env.companionHttp=createCompanionHttp(env.companionUrl,original.fetch??closedFetch);
      const useSourceMaintenance=loader(hooks.api)('src/features/sources/use-source-maintenance.ts').useSourceMaintenance;
      const ports=options('sourceMaintenance',env);hooks.mount(useSourceMaintenance,ports);hooks.flush();fixture=hooks.view();sessions.set(original,fixture);
    }
    env.sourceMaintenance=fixture;
    const aliases={exportAccountCache:fixture.exportData,clearAccountCache:fixture.clearCache,runSettingsRecovery:fixture.run};
    if(aliases[name])return{env,result:aliases[name]};
  }
  return{env};
}
