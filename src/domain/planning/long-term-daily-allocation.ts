import type {LongTermPlanSnapshot} from './long-term-plan-types';
import type {PracticeBudgetGroup} from './practice-budget';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parsePracticeBudgetGroups} from './practice-budget.ts';
import type {LongTermInventoryBinding} from './long-term-planning-input';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parsePlanDate} from './long-term-plan-types.ts';
export type LongTermDailyItem=Omit<LongTermInventoryBinding,'title'> & {sourceHash:string};
export type LongTermDailyAllocation={schemaVersion:1;planId:string;day:string;vocabularyTarget:number;items:LongTermDailyItem[];reviewTarget?:number|null;budgetMinutes?:number;practiceBudgetGroups?:PracticeBudgetGroup[]};
function check(ok:unknown):asserts ok {if(!ok)throw new Error('invalid-long-term-allocation');}
function record(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{check(value!==null&&typeof value==='object'&&!Array.isArray(value));const v=value as Record<string,unknown>;check(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...required,...optional].includes(k)));return v;}
function text(v:unknown):asserts v is string {check(typeof v==='string'&&v.trim().length>0&&v.length<=500&&![...v].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)&&!['__proto__','constructor','prototype'].includes(v));}
function strings(v:unknown):asserts v is string[]{check(Array.isArray(v));v.forEach(text);check(new Set(v).size===v.length);}
export function parseLongTermDailyAllocation(value:unknown):LongTermDailyAllocation{
 const v=record(value,['schemaVersion','planId','day','vocabularyTarget','items'],['reviewTarget','budgetMinutes','practiceBudgetGroups']);check(v.schemaVersion===1);text(v.planId);parsePlanDate(v.day);check(Number.isSafeInteger(v.vocabularyTarget)&&(v.vocabularyTarget as number)>=0);check(Array.isArray(v.items));
 if(v.practiceBudgetGroups!==undefined)parsePracticeBudgetGroups(v.practiceBudgetGroups);
 if(v.reviewTarget!==undefined&&v.reviewTarget!==null)check(Number.isSafeInteger(v.reviewTarget)&&(v.reviewTarget as number)>=0&&(v.reviewTarget as number)<=10000);
 if(v.budgetMinutes!==undefined)check(typeof v.budgetMinutes==='number'&&Number.isSafeInteger(v.budgetMinutes)&&v.budgetMinutes>=0&&v.budgetMinutes<=1440);
 const ids=new Set(),physical=new Set(),lexemes=new Set();let count=0;
 for(const raw of v.items){const i=record(raw,['itemId','subjectId','kind','itemKeys','unitIds','sourceHash'],['lexemeKey']);text(i.itemId);text(i.subjectId);check(!ids.has(i.itemId));ids.add(i.itemId);check(['vocabulary','practice','material'].includes(i.kind as string));strings(i.itemKeys);strings(i.unitIds);check(typeof i.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(i.sourceHash));
 for(const key of i.itemKeys){check(!physical.has(key));physical.add(key);}
 if(i.kind==='vocabulary'){check(i.itemKeys.length===1&&i.itemKeys[0]===i.itemId&&i.unitIds.length===0);text(i.lexemeKey);check(!lexemes.has(i.lexemeKey));lexemes.add(i.lexemeKey);count++;}
 else {check(i.lexemeKey===undefined);check(i.kind==='material'?i.itemKeys.length===0&&i.unitIds.length===1&&i.unitIds[0]===i.itemId:i.itemKeys.length>0);}}
 check(count===v.vocabularyTarget);return structuredClone(v) as LongTermDailyAllocation;
}
export function deriveLongTermDailyAllocation(snapshot:LongTermPlanSnapshot,bindings:LongTermInventoryBinding[],day:string):LongTermDailyAllocation|null{
 parsePlanDate(day);if(day<snapshot.spec.startDate||day>snapshot.spec.targetDeadline)return null;
 const slot=snapshot.schedule.find(s=>s.date===day);if(!slot)throw new Error('missing-long-term-day');
 const items=slot.newItemIds.map(itemId=>{const binding=bindings.find(b=>b.itemId===itemId);if(!binding)throw new Error(`missing-long-term-identity: ${itemId}`);const {title,...identity}=binding;void title;return {...identity,sourceHash:slot.newItemSourceHashes[itemId]};});
 return parseLongTermDailyAllocation({schemaVersion:1,planId:snapshot.spec.planId,day,vocabularyTarget:items.filter(i=>i.kind==='vocabulary').length,items,reviewTarget:snapshot.spec.dailyReviewTarget??null,budgetMinutes:Math.round(slot.budgetMinutes),...(snapshot.spec.practiceBudgetGroups===undefined?{}:{practiceBudgetGroups:snapshot.spec.practiceBudgetGroups})});
}

export const LONG_TERM_PREREQUISITE_BLOCK='实际前置学习或学科映射尚未核实，不能开始此项。';
