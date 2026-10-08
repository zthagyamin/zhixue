"use client";
import { DashboardView } from './study-dashboard/dashboard-view';
import { useDashboardController } from './study-dashboard/use-dashboard-controller';
import {nativeOriginalFrame} from './study-dashboard/pending-native-source';
import {stableStudyItemKey} from './dynamic-ui-model';
import {PendingAnswerWorkspace} from './study-dashboard/pending-workspace';
import { ReleaseAnnouncement } from './release-announcement';
import './study-settings-readability.css';

export default function Home(){
 const model=useDashboardController();
 // A first arrival sees an inline guide. Only returning version upgrades can interrupt an idle workspace.
 return <><DashboardView model={model}/>{(model.accountLibraryId||model.data.localLibraryId)&&<PendingAnswerWorkspace
   key={JSON.stringify([model.workspaceId,model.accountLibraryId??model.data.localLibraryId])}
   workspaceId={model.workspaceId} ownerId={model.accountLoaded?model.sessionUser?.userId??model.workspaceId:model.workspaceId}
   libraryId={model.accountLibraryId??model.data.localLibraryId!} cloud={Boolean(model.accountLoaded)}
   ready={!model.isDemoMode&&model.storageReady&&model.workspacePhase==='ready'} records={model.accountLoaded?.records.map(row=>row.record)??[]}
   questionAi={model.accountLoaded?model.accountClient.questionAi:undefined}
   nativeCourse={model.accountLoaded?undefined:model.companionPlanClient?.nativeCourse}
   nativeMath={model.accountLoaded?undefined:model.companionPlanClient?.nativeMath}
   persist={model.persistSubmittedEvent} sendCloud={model.sendSubmittedCloud} sendCompanion={model.sendSubmittedCompanion} changed={model.noteEventsChanged}
   nativeFrame={attempt=>nativeOriginalFrame(attempt,{libraryId:model.data.localLibraryId,items:model.normalizedSubjects.flatMap(subject=>subject.items),keyOf:item=>stableStudyItemKey(item)??'',capture:model.captureAttemptFrame})}/>} <ReleaseAnnouncement key={model.workspaceId} scope={model.workspaceId}
   ready={model.workspacePhase==='ready'&&model.sessionResolved&&model.storageReady}
   blocked={model.tab!=='today'||model.studyFocus||model.practiceItems!==null||model.learningDrafts.isPending()||model.learningDrafts.hasUnsavedInput()||model.learningDrafts.failureTitles().length>0}/></>;
}
