// @ts-expect-error TS5097: standalone contracts.
import {parseRecallPolicy} from '../assessment/index.ts';
import type {PracticeMode as PluginType} from '../content';
// @ts-expect-error TS5097: standalone Node contract tests.
import {studyObject,studyId,studyDigest,studyCount,studySize,studyHash} from './validation.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import {parseCloudStudyEventV3} from '../evidence/index.ts';

// @ts-expect-error TS5097: standalone Node contracts.
import {ASSISTANCE_ACTIONS,type AssistanceAction,type AssistanceCount,type AssistanceObservation} from '../assessment/index.ts';
export {ASSISTANCE_ACTIONS,type AssistanceAction,type AssistanceCount,type AssistanceObservation};
export type AssistanceSummaryInput=AssistanceObservation&{schemaVersion:1|2;attemptEventId:string;attemptCoreHash:string;practiceMode:PluginType};
export type AssistanceSummaryV1=AssistanceSummaryInput&{summaryId:string;summaryHash:string};
const MODES=['three-stage','quiz','recall','calculation','code','flashcard','spelling'];
const MAX_BYTES=4096;

function counts(raw:unknown,pre:boolean):AssistanceCount[]{
  if(!Array.isArray(raw)||raw.length>ASSISTANCE_ACTIONS.length)throw new Error('invalid-assistance-counts');
  const seen=new Set<string>();
  return raw.map(value=>{
    const row=studyObject(value,['action','count']);
    if(typeof row.action!=='string'||!ASSISTANCE_ACTIONS.some(action=>action===row.action)||(pre&&row.action==='answer-feedback'))throw new Error('invalid-assistance-action');
    if(seen.has(row.action))throw new Error('duplicate-assistance-action');seen.add(row.action);
    studyCount(row.count,'assistance-count',1);if(row.count>10000)throw new Error('invalid-assistance-count');
    return{action:row.action as AssistanceAction,count:row.count};
  }).sort((a,b)=>ASSISTANCE_ACTIONS.indexOf(a.action)-ASSISTANCE_ACTIONS.indexOf(b.action));
}
function body(raw:unknown,sealed:boolean):AssistanceSummaryInput{
  studySize(raw,MAX_BYTES);
  const value=studyObject(raw,['schemaVersion','attemptEventId','attemptCoreHash','practiceMode','observationScope','preSubmitAssistance','postSubmitFeedback'],['recallPolicy',...(sealed?['summaryId','summaryHash']:[])]);
  if(value.schemaVersion!==1&&value.schemaVersion!==2||value.schemaVersion===1&&Object.hasOwn(value,'recallPolicy')||value.schemaVersion===2&&!Object.hasOwn(value,'recallPolicy'))throw new Error('unsupported-assistance-version');
  const policy=value.schemaVersion===2?parseRecallPolicy(value.recallPolicy):undefined;
  if(policy&&value.practiceMode!=='recall')throw new Error('invalid-recall-policy-mode');
  studyId(value.attemptEventId,'assistance-attempt');studyDigest(value.attemptCoreHash);
  if(typeof value.practiceMode!=='string'||!MODES.includes(value.practiceMode))throw new Error('invalid-assistance-mode');
  if(value.observationScope!=='current-page-attempt')throw new Error('invalid-assistance-scope');
  if(sealed){studyId(value.summaryId,'assistance-identifier');studyDigest(value.summaryHash);}
  return{schemaVersion:value.schemaVersion as 1|2,...(policy?{recallPolicy:policy}:{}),attemptEventId:value.attemptEventId,attemptCoreHash:value.attemptCoreHash,practiceMode:value.practiceMode as PluginType,observationScope:'current-page-attempt',
    preSubmitAssistance:counts(value.preSubmitAssistance,true),postSubmitFeedback:counts(value.postSubmitFeedback,false)};
}
async function identifier(value:AssistanceSummaryInput){return`assistance:${await studyHash([value.schemaVersion,value.attemptEventId,value.attemptCoreHash])}`;}
export async function sealAssistanceSummary(raw:unknown):Promise<AssistanceSummaryV1>{
  const input=body(raw,false),sealed={...input,summaryId:await identifier(input)};
  const summary={...sealed,summaryHash:await studyHash(sealed)};studySize(summary,MAX_BYTES);return summary;
}
export async function parseAssistanceSummary(raw:unknown):Promise<AssistanceSummaryV1>{
  const input=body(raw,true),summaryId=(raw as AssistanceSummaryV1).summaryId,summaryHash=(raw as AssistanceSummaryV1).summaryHash;
  if(summaryId!==await identifier(input))throw new Error('invalid-assistance-identifier');
  const sealed={...input,summaryId};if(summaryHash!==await studyHash(sealed))throw new Error('assistance-summary-integrity');
  return{...sealed,summaryHash};
}
/** Known mode comes from the verified account envelope or the paired attempt binding,
 * never from the current settings or a guessed historic plugin. No state projection. */
export async function validateAssistanceParent(raw:unknown,parent:unknown,knownMode:PluginType):Promise<AssistanceSummaryV1>{
  const frozen=structuredClone(parent),summary=await parseAssistanceSummary(raw),event=await parseCloudStudyEventV3(frozen);
  if(event.eventType!=='practice-attempt'||event.eventId!==summary.attemptEventId||event.coreHash!==summary.attemptCoreHash)throw new Error('assistance-parent-binding');
  if(summary.practiceMode!==knownMode)throw new Error('assistance-parent-mode');
  if(summary.recallPolicy&&summary.recallPolicy.appliedRating!==event.attempt.rating)throw new Error('recall-policy-parent-rating');
  return summary;
}
export function assistanceObservationLabel(summary:AssistanceSummaryV1|null|undefined):string{
  return !summary?'辅助情况未知':summary.preSubmitAssistance.length?'本次记录了作答前辅助':'本次页面未记录作答前辅助';
}
