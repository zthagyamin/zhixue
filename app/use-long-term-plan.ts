'use client';
import type {LongTermPlanTransport} from '../src/application/planning';
import {useLongTermPlanView} from '../src/features/planning';
import {longTermMessage} from './long-term-editor-model';
export type {LongTermPlanTransport} from '../src/application/planning';
const newId=()=>crypto.randomUUID();
/** Compatibility assembly for the existing account and local transports. */
export function useLongTermPlan(scopeKey:string|null,transport:LongTermPlanTransport|null){
  return useLongTermPlanView(scopeKey,transport,{newId,message:longTermMessage});
}