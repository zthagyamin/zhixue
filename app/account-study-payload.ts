import type {AccountStudyLoaded} from './account-study-client';
export function accountStudyPayload(loaded:AccountStudyLoaded,workspaceId:string){
  type Group={id:string;name:string;pluginType:string;domain:string;eventDomain:'word'|'python'|'due';sourceMode:'gateway';items:unknown[]};
  const groups=new Map<string,Group>();
  for(const item of loaded.bundle.items){
    const subject=loaded.catalog.subjects.find(value=>value.subjectId===item.subjectId),name=subject?.name??item.subjectId;
    const group:Group=groups.get(item.subjectId)??{id:item.subjectId,name,pluginType:item.kind==='word'?item.recommendedPlugin:item.practice.questionType,
      domain:item.kind==='practice'?item.practice.domain:'differential-review',eventDomain:item.eventKind,sourceMode:'gateway',items:[]};
    const identity={...(item.learningSupport?{learningSupport:item.learningSupport}:{}),accountSnapshotId:loaded.bundle.snapshot.snapshotId,accountItemKey:item.itemKey};
    if(item.kind==='word')group.items.push({...identity,id:item.itemKey,itemId:item.itemKey,abilityId:item.itemKey,eventKind:item.eventKind,contentHash:item.contentHash,fingerprint:item.contentHash,pluginType:item.recommendedPlugin,...item.word});
    else{const p=item.practice;group.items.push({id:p.itemId,itemId:p.itemId,abilityId:p.abilityId,contentHash:item.contentHash,pluginType:p.questionType,
      ...identity,eventKind:item.eventKind,fingerprint:item.contentHash,
      topic:p.sourceLabel,prompt:p.prompt,options:p.options,answer:p.questionType==='quiz'&&typeof p.answer==='number'?p.options?.[p.answer]:p.answer,
      explanation:p.explanation,reviewPoint:p.reviewPoint,initialCode:p.initialCode,testCode:p.testCode,solutionCode:p.solutionCode,domain:p.domain,sourceLabel:p.sourceLabel});}
    groups.set(item.subjectId,group);
  }
  return {status:'connected',contentMode:'personal',syncedAt:loaded.bundle.snapshot.generatedAt,source:{title:'账号学习库 · 已验证快照',scope:'同账号设备共享题目；原文与正式进度仍归属于学习知识库'},subjects:[...groups.values()],practiceItems:[],
    gateway:{mode:'indexed',schemaVersion:1,subjectCount:groups.size,itemCount:loaded.bundle.items.length,diagnostics:[],progressEvents:[],capabilities:[],workspaceId}};
}
