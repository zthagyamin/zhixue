import type {FSRSRating} from './contracts';
import type {RecallPolicyEvidence} from './recall-policy';
// @ts-expect-error TS5097: standalone contracts.
import {parseRecallPolicy} from './recall-policy.ts';
// @ts-expect-error TS5097: standalone contracts.
import {capRecallRating, isNonWordOriginal} from '../content/index.ts';
export const ASSISTANCE_ACTIONS=['meaning-check','meaning-study','reference-answer','ai-hint','ai-tutor','answer-feedback'] as const;
export type AssistanceAction=typeof ASSISTANCE_ACTIONS[number];
export type AssistanceCount={action:AssistanceAction;count:number};
export type AssistanceObservation={observationScope:'current-page-attempt';preSubmitAssistance:AssistanceCount[];postSubmitFeedback:AssistanceCount[];recallPolicy?:RecallPolicyEvidence};
export type AttemptEvidenceDraft={read:<T>(field:string,initial:T)=>T;assistance?:{snapshot:()=>AssistanceObservation|null}};
/** Existing hint cap and original-rating semantics shared by both formal hosts. */
export function prepareAttemptEvidence(input:{rating:FSRSRating;mode:string;recallConfigured:boolean;original?:unknown},draft:AttemptEvidenceDraft){
    let rating=input.rating,recallPolicy:RecallPolicyEvidence|undefined;
    const original=input.original&&typeof input.original==='object'?input.original as {learningSupport?:{schemaVersion?:unknown;type?:unknown}}:{};
    const course=original.learningSupport?.schemaVersion===2&&original.learningSupport.type==='recall'&&isNonWordOriginal(input.mode,input.original);
    if(input.mode==='recall'&&input.recallConfigured&&!course){
        const state=draft.read<{attemptId:string;maxPreHintLevel:number}|null>('recallAttempt',null);
        if(!state||draft.read('recallPolicyPending',false)||draft.read('recallPolicyError',false))throw Error('study-attempt-policy-unready');
        const requested=draft.read('recallRequestedRating',rating);
        const raw=capRecallRating(requested,state.maxPreHintLevel)===rating?requested:rating;
        rating=capRecallRating(raw,state.maxPreHintLevel);
        recallPolicy=parseRecallPolicy({policyVersion:'recall-hints-v1',attemptId:state.attemptId,maxPreHintLevel:state.maxPreHintLevel,requestedRating:raw,appliedRating:rating});
    }
    const base=draft.assistance?.snapshot()??null;
    const observation:AssistanceObservation|null=recallPolicy?{observationScope:'current-page-attempt',preSubmitAssistance:base?.preSubmitAssistance??[],postSubmitFeedback:base?.postSubmitFeedback??[],recallPolicy}:base;
    return {rating,observation:structuredClone(observation)};
}
