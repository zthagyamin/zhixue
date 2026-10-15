/** Authorized synthetic publisher: actual versioned handlers, no provider or formal-history reset. */
export async function publishNonwordRevision({post,libraryId,day,scenario,title,body,revision,planRevision,predecessorOperationId,modules}) {
  const {sealStudyItem,sealStudySnapshot,snapshotBody,planning,generateTaskPlan,editTaskPlan}=modules;
  const item=await sealStudyItem(body),items=[item];
  const snapshot=await sealStudySnapshot(snapshotBody(items,{libraryId,snapshotId:`synthetic-${scenario}-v${revision}`,
    revision,sourceHash:item.sourceHash,generatedAt:day+'T00:00:00.000Z'}));
  await post('begin-snapshot',{snapshot});
  await post('stage-items',{snapshotId:snapshot.snapshotId,entries:[{position:0,item}]});
  await post('complete-snapshot',{snapshotId:snapshot.snapshotId,expectedRevision:revision-1});
  const native={schemaVersion:1,sourceHash:item.sourceHash,diagnostics:[],
    subjects:[{subjectId:item.subjectId,name:title,priority:1,planningStatus:'none',words:[],units:[],goals:[]}],
    practiceSources:[{itemKey:item.itemKey,subjectId:item.subjectId,title:item.title,sourceHash:item.sourceHash,completionRule:item.completionRule}]};
  const {catalog}=await planning.toCloudPlanningCatalog(native,{snapshot,items});
  await post('publish-planning-catalog',{catalog});
  const facts=await planning.sealCloudPlanningFacts({schemaVersion:1,libraryId,snapshotId:snapshot.snapshotId,
    catalogHash:catalog.catalogHash,observedAt:day+'T00:00:00.000Z',nativePlanRevision:0,
    sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
  await post('publish-planning-facts',{facts});
  const engine=await planning.toEnginePlanningCatalog(catalog);
  let plan=await generateTaskPlan({day,catalog:engine,words:[],reviews:[],completions:[],previous:null});
  plan=await editTaskPlan(plan,{type:'upsert',task:{taskId:`synthetic:${scenario}`,subjectId:item.subjectId,title:item.title,
    category:'subject',origin:'manual',required:false,unitIds:[],quantity:1,action:{kind:'practice',itemKeys:[item.itemKey]},
    completionRule:item.completionRule,sourceHash:engine.practiceSources.find(entry=>entry.itemKey===item.itemKey).sourceHash}},engine);
  const cloud=await planning.sealCloudTaskPlan(plan,catalog,{baseRevision:planRevision,factsHash:facts.factsHash,
    eventThrough:0,taskThrough:0,nativeBaseRevision:0});
  await post('mutate-plan',{mutation:{action:'save',operationId:`synthetic-save-v${revision}`,expectedRevision:planRevision,plan:cloud}},false);
  await post('mutate-plan',{mutation:{action:'approve',operationId:`synthetic-approve-v${revision}`,expectedRevision:planRevision+1,
    day,planHash:cloud.cloudPlanHash,predecessorOperationId}},false);
  return {item,snapshot,catalog,plan:cloud};
}
