// @ts-expect-error TS5097: standalone Node contracts.
import {completionDay} from './study-day.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validPlanDay} from './task-plan-types.ts';
import type {CloudFSRSData} from '../evidence';
import type {DailyPlanningInput,LearningUnit,PlanningPracticeSource,PlanningWord} from './task-plan-types';
import type {LongTermInventoryItem} from './long-term-plan-types';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {lexemeKey,compareEvidenceText} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {completionBasis} from './task-plan-engine.ts';

export type LongTermInventoryBinding={
  itemId:string;subjectId:string;title:string;kind:'vocabulary'|'practice'|'material';
  itemKeys:string[];unitIds:string[];lexemeKey?:string;
};
export type LongTermEstimates={vocabularyMinutes:number;practiceMinutes:number;materialMinutes:number;reviewMinutes:number};
export type VersionedReviewCard={sourceHash:string;card:CloudFSRSData};
export type LongTermPlanningSource={
  inventory:LongTermInventoryItem[];bindings:LongTermInventoryBinding[];fsrsMap:Record<string,CloudFSRSData>;
  assumptions:string[];diagnostics:{code:string;itemId:string;message:string}[];
};

/** Takes already verified daily-planning facts; projections cannot create evidence. */
export function buildLongTermPlanningInput(input:DailyPlanningInput,options:{
  preferredWordItemKeys?:readonly string[];
  estimates?:LongTermEstimates;fsrsByItemKey?:Record<string,VersionedReviewCard>;
  completedPracticeDays?:Record<string,{sourceHash:string;days:string[]}>;
}={}):LongTermPlanningSource {
  const estimates=options.estimates??{vocabularyMinutes:3,practiceMinutes:12,materialMinutes:20,reviewMinutes:2};
  const estimateKeys=['vocabularyMinutes','practiceMinutes','materialMinutes','reviewMinutes'] as const;
  if(Object.keys(estimates).length!==4||estimateKeys.some(key=>!Number.isFinite(estimates[key])||estimates[key]<=0||estimates[key]>1440))throw new Error('invalid-long-term-estimate');
  const result:LongTermPlanningSource={inventory:[],bindings:[],fsrsMap:{},diagnostics:[],assumptions:[
    `缺少逐项耗时时，暂按词汇 ${estimates.vocabularyMinutes} 分钟、练习 ${estimates.practiceMinutes} 分钟、材料 ${estimates.materialMinutes} 分钟估算。`,
    `复习暂按每项 ${estimates.reviewMinutes} 分钟估算；这些数值不是实际学习耗时。`,
  ]};
  const physicalWords=new Map<string,PlanningWord>();
  for(const subject of input.catalog.subjects)for(const word of subject.words){
    const previous=physicalWords.get(word.itemKey);
    if(previous&&(previous.subjectId!==word.subjectId||previous.sourceHash!==word.sourceHash||lexemeKey(previous)!==lexemeKey(word)))throw new Error('conflicting-long-term-item');
    physicalWords.set(word.itemKey,word);
  }
  const practiceSources=new Map<string,PlanningPracticeSource>();
  for(const source of input.catalog.practiceSources??[]){
    const previous=practiceSources.get(source.itemKey);
    if(previous&&(previous.subjectId!==source.subjectId||previous.sourceHash!==source.sourceHash))throw new Error('conflicting-long-term-item');
    if(!previous)practiceSources.set(source.itemKey,source);
  }
  const states=new Map(input.words.map(word=>[word.lexemeKey,word]));
  const chosen=new Map<string,PlanningWord>();
  for(const subject of [...input.catalog.subjects].sort((a,b)=>b.priority-a.priority||compareEvidenceText(a.subjectId,b.subjectId))){
    for(const word of [...subject.words].sort((a,b)=>compareEvidenceText(a.itemKey,b.itemKey))){
      const key=lexemeKey(word);
      if(!chosen.has(key))chosen.set(key,word);
    }
  }
  const preferredLexemes=new Set<string>();
  for(const key of options.preferredWordItemKeys??[]){const word=physicalWords.get(key);if(word&&!preferredLexemes.has(lexemeKey(word))){chosen.set(lexemeKey(word),word);preferredLexemes.add(lexemeKey(word));}}
  for(const [key,word] of chosen){
    const state=states.get(key),preferredKey=state?.firstStartedItemKey??state?.firstLearnedItemKey;
    const preferred=preferredKey?physicalWords.get(preferredKey):undefined;
    if(preferred&&lexemeKey(preferred)===key)chosen.set(key,preferred);
    else if(preferredKey&&!preferred)result.diagnostics.push({code:'missing-started-source',itemId:word.itemKey,message:'先前使用的词汇来源已不在当前目录中，需核对来源后继续。'});
  }
  const ids=new Set<string>(),claimedPhysical=new Set<string>();
  function add(item:LongTermInventoryItem,binding:LongTermInventoryBinding){
    if(ids.has(item.itemId))throw new Error('conflicting-long-term-item');
    ids.add(item.itemId);result.inventory.push(item);result.bindings.push(binding);
    for(const key of binding.itemKeys)claimedPhysical.add(key);
    // A review card is tied to one versioned physical item, never a whole lesson.
    if(binding.itemKeys.length===1){
      const saved=options.fsrsByItemKey?.[binding.itemKeys[0]];
      if(saved?.sourceHash===item.sourceHash)result.fsrsMap[item.itemId]=structuredClone(saved.card);
      else if(saved)result.diagnostics.push({code:'stale-review-card',itemId:item.itemId,message:'复习状态对应旧内容版本，未用于当前内容的预测。'});
    }
  }
  for(const [key,word] of chosen){
    const state=states.get(key),sourceMissing=result.diagnostics.some(entry=>entry.code==='missing-started-source'&&entry.itemId===word.itemKey);
    const unknown=!state||state.status==='history-unknown';
    add({itemId:word.itemKey,subjectId:word.subjectId,sourceHash:word.sourceHash,estimatedMinutes:estimates.vocabularyMinutes,reviewMinutes:estimates.reviewMinutes,
      completedRounds:state?.status==='learned'?1:0,
      ...(unknown?{blockedReason:'历史学习状态尚未核实。'}:sourceMissing?{blockedReason:'先前学习来源待核对。'}:{})},
    {itemId:word.itemKey,subjectId:word.subjectId,title:word.word,kind:'vocabulary',itemKeys:[word.itemKey],unitIds:[],lexemeKey:key});
  }
  // Other physical copies of an already represented lexeme are not fresh supply.
  for(const key of physicalWords.keys())claimedPhysical.add(key);
  function completionDays(unit:LearningUnit):Set<string> {
    if(unit.completionRule.startsWith('formal-'))return new Set(unit.formalComplete===true?['formal-complete']:[]);
    return new Set(input.completions.filter(entry=>entry.unitId===unit.unitId&&entry.basis===completionBasis(unit)
      &&completionDay(entry)<=input.day).map(entry=>completionDay(entry)));
  }
  const rounds=(unit:LearningUnit)=>completionDays(unit).size;
  const practiceDays=(source:PlanningPracticeSource)=>{
    const evidence=options.completedPracticeDays?.[source.itemKey];
    return new Set(evidence?.sourceHash===source.sourceHash?evidence.days.filter(day=>validPlanDay(day)&&day<=input.day):[]);
  };
  const unitInventoryIds=new Map<string,string[]>();
  const practiceInventory=new Map<string,{source:PlanningPracticeSource;estimatedMinutes:number;completionDays:Set<string>;unitIds:string[];invalid:boolean}>();
  let sharedPracticeCostAssumption=false;
  for(const subject of [...input.catalog.subjects].sort((a,b)=>compareEvidenceText(a.subjectId,b.subjectId))){
    for(const unit of [...subject.units].sort((a,b)=>a.order-b.order||compareEvidenceText(a.unitId,b.unitId))){
      const itemKeys=unit.action.kind==='practice'?unit.action.itemKeys:[];
      // A word's initial learning already has a physical binding above.
      if(itemKeys.length&&itemKeys.every(key=>physicalWords.has(key))){
        const mapped=[...new Set(itemKeys.map(key=>chosen.get(lexemeKey(physicalWords.get(key)!))!.itemKey))];
        unitInventoryIds.set(unit.unitId,mapped);
        continue;
      }
      const sources=[...new Set(itemKeys)].map(key=>practiceSources.get(key));
      if(itemKeys.length&&sources.every((source):source is NonNullable<typeof source>=>source!==undefined)){
        if(sources.some(source=>source.subjectId!==unit.subjectId))throw new Error('conflicting-long-term-item');
        const estimate=unit.estimatedMinutes??estimates.practiceMinutes;
        if(!Number.isFinite(estimate)||estimate<=0||estimate>1440)throw new Error('invalid-long-term-estimate');
        const unitCompletionDays=completionDays(unit),itemEstimate=estimate/sources.length;
        for(const source of sources){
          const previous=practiceInventory.get(source.itemKey);
          if(previous){
            if(previous.source.subjectId!==source.subjectId||previous.source.sourceHash!==source.sourceHash)throw new Error('conflicting-long-term-item');
            previous.estimatedMinutes=Math.max(previous.estimatedMinutes,itemEstimate);
            for(const day of unitCompletionDays)previous.completionDays.add(day);
            if(!previous.unitIds.includes(unit.unitId))previous.unitIds.push(unit.unitId);
            previous.invalid ||= subject.planningStatus==='invalid';
            if(!sharedPracticeCostAssumption){
              result.assumptions.push('多个单元共享同一物理练习时，只计一次获取成本，并采用各单元分摊值中的较大值。');
              sharedPracticeCostAssumption=true;
            }
          }else practiceInventory.set(source.itemKey,{source,estimatedMinutes:itemEstimate,completionDays:new Set(unitCompletionDays),unitIds:[unit.unitId],invalid:subject.planningStatus==='invalid'});
        }
        unitInventoryIds.set(unit.unitId,sources.map(source=>source.itemKey));
        continue;
      }
      const kind=itemKeys.length?'practice':'material';
      const estimate=unit.estimatedMinutes??(kind==='practice'?estimates.practiceMinutes:estimates.materialMinutes);
      if(!Number.isFinite(estimate)||estimate<=0||estimate>1440)throw new Error('invalid-long-term-estimate');
      add({itemId:unit.unitId,subjectId:unit.subjectId,sourceHash:unit.sourceHash,estimatedMinutes:estimate,reviewMinutes:estimates.reviewMinutes,
        completedRounds:rounds(unit),...(unit.completionRule==='formal-mastered'&&unit.formalComplete===true?{mastered:true}:{}),
        ...(subject.planningStatus==='invalid'?{blockedReason:'学科资料映射尚未通过核验。'}:{})},
      {itemId:unit.unitId,subjectId:unit.subjectId,title:unit.title,kind,itemKeys:[...itemKeys],unitIds:[unit.unitId]});
      unitInventoryIds.set(unit.unitId,[unit.unitId]);
      if(itemKeys.length>1)result.diagnostics.push({code:'grouped-review-estimate',itemId:unit.unitId,message:'此练习包含多项内容；逐项复习仍以实际到期队列为准。'});
    }
  }
  for(const entry of practiceInventory.values()){
    const {source}=entry,saved=options.fsrsByItemKey?.[source.itemKey],completedRounds=new Set([...entry.completionDays,...practiceDays(source)]).size;
    add({itemId:source.itemKey,subjectId:source.subjectId,sourceHash:source.sourceHash,estimatedMinutes:entry.estimatedMinutes,reviewMinutes:estimates.reviewMinutes,
      completedRounds,...(!completedRounds&&saved?.sourceHash===source.sourceHash?{blockedReason:'已有复习状态，但缺少可核验的首次完成证据。'}:{}),
      ...(entry.invalid?{blockedReason:'学科资料映射尚未通过核验。'}:{})},
    {itemId:source.itemKey,subjectId:source.subjectId,title:source.title,kind:'practice',itemKeys:[source.itemKey],unitIds:entry.unitIds});
  }
  for(const source of [...input.catalog.practiceSources??[]].sort((a,b)=>compareEvidenceText(a.itemKey,b.itemKey))){
    if(claimedPhysical.has(source.itemKey))continue;
    const subject=input.catalog.subjects.find(entry=>entry.subjectId===source.subjectId);
    if(!subject)throw new Error('unknown-long-term-subject');
    const saved=options.fsrsByItemKey?.[source.itemKey],completedRounds=practiceDays(source).size;
    add({itemId:source.itemKey,subjectId:source.subjectId,sourceHash:source.sourceHash,estimatedMinutes:estimates.practiceMinutes,reviewMinutes:estimates.reviewMinutes,completedRounds,
      ...(!completedRounds&&saved?.sourceHash===source.sourceHash?{blockedReason:'已有复习状态，但缺少可核验的首次完成证据。'}:{}),
      ...(subject.planningStatus==='invalid'?{blockedReason:'学科资料映射尚未通过核验。'}:{})},
    {itemId:source.itemKey,subjectId:source.subjectId,title:source.title,kind:'practice',itemKeys:[source.itemKey],unitIds:[]});
  }
  const units=input.catalog.subjects.flatMap(subject=>subject.units);
  for(const unit of units){
    const targets=(unitInventoryIds.get(unit.unitId)??[]).map(id=>result.inventory.find(entry=>entry.itemId===id)).filter((item):item is LongTermInventoryItem=>item!==undefined);
    if(!targets.length||!unit.prerequisites.length)continue;
    const missing=unit.prerequisites.some(id=>!unitInventoryIds.has(id));
    const prerequisites=[...new Set(unit.prerequisites.flatMap(id=>unitInventoryIds.get(id)??[]))];
    for(const item of targets){
      if(missing){
        item.blockedReason=[item.blockedReason,'前置资料已移除或尚未完成映射。'].filter(Boolean).join(' ');
        result.diagnostics.push({code:'missing-prerequisite',itemId:item.itemId,message:'前置资料不在可排期清单中。'});
      }
      const withoutSelf=prerequisites.filter(id=>id!==item.itemId);
      if(withoutSelf.length)item.prerequisiteItemIds=[...new Set([...(item.prerequisiteItemIds??[]),...withoutSelf])];
    }
  }
  return result;
}
