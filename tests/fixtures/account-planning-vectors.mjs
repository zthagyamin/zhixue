import {vocabularyInput,courseSubject} from './task-plan-input.mjs';
import {sealStudySnapshot} from '../../app/account-study-content.ts';
import {toCloudPlanningCatalog,toEnginePlanningCatalog,sealCloudPlanningFacts,sealCloudTaskPlan} from '../../app/account-study-planning.ts';
import {generateTaskPlan} from '../../app/task-plan-engine.ts';

export async function accountPlanningVectors(){
  const input=vocabularyInput(0),course=courseSubject(1,{targetCount:1});input.catalog.subjects.push(course);
  const snapshot=await sealStudySnapshot({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',revision:1,generatedAt:'2026-09-01T00:00:00.000Z',sourceHash:'a'.repeat(64),eventCursor:0,taskCursor:0,items:[]});
  const {catalog,materials}=await toCloudPlanningCatalog(input.catalog,{snapshot,items:[]}),engine=await toEnginePlanningCatalog(catalog);
  const plan=await generateTaskPlan({day:'2026-09-01',catalog:engine,words:[],reviews:[],completions:[],previous:null});
  const facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
  const cloudPlan=await sealCloudTaskPlan(plan,catalog,{baseRevision:0,factsHash:facts.factsHash,eventThrough:0,taskThrough:0,nativeBaseRevision:0});
  return {catalog,materials,facts,cloudPlan,nativeCatalog:input.catalog};
}
