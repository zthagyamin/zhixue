import {confirmStudyNavigation,prepareStudyNavigation} from '../../app/study-navigation-guard.ts';
import {createSubjectRoundSessions} from '../../app/subject-round-resume.ts';
import {emptySubjectRound,focusRound} from '../../app/subject-round.ts';
import {createRestartBatch} from '../../app/restart-batch.ts';
import {recordStudyAttempt} from '../../app/study-event-controller.ts';
import {applySavedNativeAttempt} from '../../app/native-progress-view.ts';
import {studyPracticeGroups,practiceGroupScope,practiceSelectionScope} from '../../app/study-practice-groups.ts';
import {reviewGoalView} from '../../app/study-review-goal.ts';
import {createPlanningNavigator,createLegacyPlanActions} from '../../src/application/planning/index.ts';
import {createHooks,loader} from '../helpers/causal-harness.mjs';
import {dashboardValue} from './dashboard-functions.mjs';
import * as scheduler from 'ts-fsrs';
const ref=current=>({current});
const noop=()=>{};
/** Real navigation/round helpers; callers still supply the state mutations under test. */
export function attachNavigationBindings(env){
 const defaults={tab:'today',confirmStudyNavigation,prepareStudyNavigation,accountLoaded:null,nativeScope:'local:test',currentDay:'2026-09-15',accountDailyPlan:{source:null},taskLearning:{state:null},emptySubjectRound,activateSubjectRound:createSubjectRoundSessions().activate,
   practiceSelection:null,setPracticeSelection:noop,practiceGroupScope,practiceSelectionScope,reviewGoalView,
   getPracticeGroups:(plan,catalog,_subjects,ids)=>studyPracticeGroups(plan,catalog,()=> 'synthetic-mode',ids)};
 for(const [key,value]of Object.entries(defaults))if(!Object.hasOwn(env,key))env[key]=value;
 const overrides={'ts-fsrs':scheduler};
 if(env.readAccountLocalPractice)overrides['app/study-submission-history.ts']={readAccountLocalPractice:env.readAccountLocalPractice};
 if(env.accountTaskCompletedItems)overrides['app/account-study-planning-projection.ts']={accountTaskCompletedItems:env.accountTaskCompletedItems,accountTaskActivity:env.accountTaskActivity};
 const load=loader(createHooks().api,overrides);
 env.createPlanningSourceAdapter=load('app/study-dashboard/planning-source-adapter.ts').createPlanningSourceAdapter;
 const native=env.taskLearning.session;
 if(native){
  const original=native.snapshot,edit=native.edit;env.currentDay=original().draft?.plan.day??env.currentDay;
  native.snapshot=()=>({workspaceId:env.workspaceId,day:env.currentDay,ready:true,completedTaskIds:[],reviewRounds:[],...original()});
  native.edit=async(...args)=>{await edit(...args);return true;};
 }
 Object.assign(env,{accountLoaded:env.accountLoadedRef?.current??null,accountLibraryId:env.accountLoadedRef?.current?.bundles?.[0]?.snapshot.libraryId??null,
  longTermFactsEpoch:'fixture',pluginOverrides:{subject:{},item:{}},effectivePlan:null,practiceLoading:false,learningDrafts:{isPending:()=>false},uiProgress:env.uiProgress??{itemStages:{},fsrsData:{}},
  nativeProjectionRef:ref(null),nativeView:{ready:true},submissionJournal:env.submissionJournal??{},
  taskWorkspaceRef:env.taskWorkspaceRef??ref(env.workspaceId),accountLoadedRef:env.accountLoadedRef??ref(null),
  setPracticeItems:env.setPracticeItems??noop,setPracticeSummary:env.setPracticeSummary??noop,setPracticeLoading:env.setPracticeLoading??noop,
  getSubjectRound:env.getSubjectRound??(()=>undefined),navigateToStudyTab:env.navigateToStudyTab??noop,normalizedSubjects:env.normalizedSubjects??[],setPlanMessage:env.setPlanMessage??noop,
  taskStudyDataRef:env.taskStudyDataRef??ref({subjects:env.normalizedSubjects??[]})});
 env.usePlanningNavigation=options=>{env.navigationOptions=options;return createPlanningNavigator({...options.ports,
  begin:()=>{const id=options.clock.advance();return{scope:options.scope,current:()=>options.clock.matches(id)};},finish:()=>{},canContinue:()=>true,setContinuing:()=>{}});};
 env.planningSourceAdapter=dashboardValue('planningSourceAdapter',env);
 env.planningNavigation=dashboardValue('planningNavigation',env);
 return env;
}
/** Old controller tests now exercise the public use case, keeping their original state assertions. */
export function attachLegacyBindings(env){
 const transport=env.companionPlanClient;
 env.legacyPlans=createLegacyPlanActions({readFrame:()=>({scope:env.workspaceId,day:env.currentDay,sourceStamp:'fixture',enabled:true,
  historyReady:env.progressHistoryReady??true,storageReady:env.storageReady??true,hasContent:true,candidate:env.planCandidate??null,
  authority:{revision:0,candidate:null,history:[]},mode:'deterministic',online:env.syncState!=='offline',operator:'local',transport}),
  isCurrent:()=>!env.deliveryOwnerRef||env.deliveryOwnerRef.current===env.workspaceId,readInput:()=>{throw Error('Input should not be read');},
  replaceCandidate:(before,after)=>env.setPlanCandidate(value=>value===before?after:value),publishAuthority:()=>{},message:env.setPlanMessage,
  loading:env.setPlanLoading,resetSelection:()=>{}});return env;
}
/** Run the actual event controller and scheduler against an explicit in-memory persistence adapter. */
export function attachRestartBindings(env,recorded){
 const rows=[];let status=null;
 Object.assign(env,{accountLibraryId:null,nativeScope:'local:test',currentDay:'2026-09-15',restartEpoch:ref(0),accountModeEpoch:ref(0),practiceRequest:ref(0),eventMutation:ref(0),restartWork:ref(null),taskWorkspaceRef:ref(env.workspaceId),activeLearningDraftsRef:ref(env.learningDrafts),createRestartBatch,focusRound,emptySubjectRound,
  setRestartStatus:value=>{status=typeof value==='function'?value(status):value;},setPlanMessage:noop,flushV3Targets:async()=>{},
  putLocalStudyEvent:async row=>{rows.push(row);return'inserted';},listLocalItemEvents:async(owner,kind,key)=>rows.filter(row=>row.workspaceId===owner&&row.event.item.kind===kind&&row.event.item.key===key),
  setNativeProjection:noop,applySavedNativeAttempt,noteEventsChanged:noop,updateStudyEventDelivery:async()=>{},
  recordStudyAttempt:async(input,deps)=>{recorded.push(input);return recordStudyAttempt(input,deps);}
 });
 return env;
}
