import type {FSRSRating} from './contracts';
// @ts-expect-error TS5097: standalone contracts.
import {capRecallRating} from '../content/index.ts';
export type RecallPolicyEvidence={policyVersion:'recall-hints-v1';attemptId:string;maxPreHintLevel:number;requestedRating:FSRSRating;appliedRating:FSRSRating};
export function parseRecallPolicy(raw:unknown):RecallPolicyEvidence{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid-recall-policy');
    const value=raw as RecallPolicyEvidence;
    if(Object.keys(value).some(key=>!['policyVersion','attemptId','maxPreHintLevel','requestedRating','appliedRating'].includes(key))||value.policyVersion!=='recall-hints-v1'||typeof value.attemptId!=='string'||!/^[a-zA-Z0-9:_.-]{1,120}$/.test(value.attemptId)||!Number.isInteger(value.maxPreHintLevel)||value.maxPreHintLevel<0||value.maxPreHintLevel>3||!['again','hard','good','easy'].includes(value.requestedRating)||value.appliedRating!==capRecallRating(value.requestedRating,value.maxPreHintLevel))throw new Error('invalid-recall-policy');
    return structuredClone(value);
}
