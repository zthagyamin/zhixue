// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyText,studyCount,studyDigest,studyId} from '../sync/index.ts';
import type {StudyAIProvider} from './types';
export type PlanAiRequest={planHash:string;intent:'standard'|'less'|'more'|'reorder';confirmed:true;
  candidates:{unitId:string;subjectId:string;label:string;priority:number}[];currentOptionalTaskIds:string[]};

export type AccountAiTrace={provider?:StudyAIProvider;modelId:string;providerModel?:string;promptVersion:string;ruleVersion:string};

export type PlanAiResult={selectedUnitIds:string[];optionalOrder:string[];message:string;trace:AccountAiTrace;usageTokens?:number};

export function accountStudyPlanAiTrace(model:string):Omit<AccountAiTrace,'providerModel'>{return{modelId:model.trim(),promptVersion:'plan-ai-json-v1',ruleVersion:'plan-ai-selection-v1'};}

export function parsePlanAiRequest(raw:unknown):PlanAiRequest{
  const value=studyObject(raw,['planHash','intent','confirmed','candidates','currentOptionalTaskIds']);studyDigest(value.planHash);
  if(!['standard','less','more','reorder'].includes(String(value.intent)))throw new Error('invalid-ai-intent');if(value.confirmed!==true)throw new Error('cloud-ai-confirmation-required');
  if(!Array.isArray(value.candidates)||value.candidates.length>100||!Array.isArray(value.currentOptionalTaskIds))throw new Error('invalid-ai-candidates');
  const candidates=value.candidates.map(rawCandidate=>{const candidate=studyObject(rawCandidate,['unitId','subjectId','label','priority']);studyId(candidate.unitId);studyId(candidate.subjectId);studyText(candidate.label,'candidate-label',200);studyCount(candidate.priority,'priority',1);if(candidate.priority>5)throw new Error('invalid-ai-priority');return structuredClone(candidate) as PlanAiRequest['candidates'][number];});
  const ids=candidates.map(c=>c.unitId);if(new Set(ids).size!==ids.length)throw new Error('duplicate-ai-candidate');
  for(const id of value.currentOptionalTaskIds)studyId(id);if(new Set(value.currentOptionalTaskIds).size!==value.currentOptionalTaskIds.length)throw new Error('duplicate-ai-order');
  return {planHash:value.planHash as string,intent:value.intent as PlanAiRequest['intent'],confirmed:true,candidates,currentOptionalTaskIds:structuredClone(value.currentOptionalTaskIds) as string[]};
}
