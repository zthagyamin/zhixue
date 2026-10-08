// @ts-expect-error TS5097: standalone Node contracts.
import {compareExpressions,type MathVerdict} from '../math/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {defineMath,MATH_TEMPLATES,seededParameters,type TemplateId,type MathDefinition} from './templates.ts';
export type ParentBinding={parentItemKey:string;parentContentHash:string;hashKind:'content'|'visible-snapshot'};
export type MathVariant={schemaVersion:1;templateVersion:1;templateId:TemplateId;familyKey:string;parent:ParentBinding;seed:number;parameters:Record<string,number>;variantHash:string;exposureKey:string;definition:MathDefinition};
export type MathInput={answerKind:string;answer:string;method?:string;condition?:string;transformation?:string};
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
export async function mathFingerprint(value:unknown){
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function createMathVariant(input:{parent:ParentBinding;templateId:TemplateId;seed:number;parameters?:Record<string,number>}):Promise<MathVariant>{
    const template=MATH_TEMPLATES.find(value=>value.id===input.templateId);
    if(!template||!Number.isSafeInteger(input.seed)||input.seed<0||input.seed>0xffffffff)throw Error('unsupported-template-or-seed');
    const p=input.parent;
    if(!p||!text(p.parentItemKey,1000)||!text(p.parentContentHash,500)||!['content','visible-snapshot'].includes(p.hashKind))throw Error('invalid-template-parent');
    const parent:ParentBinding={parentItemKey:p.parentItemKey,parentContentHash:p.parentContentHash,hashKind:p.hashKind};
    const raw=input.parameters??seededParameters(template.id,input.seed);
    const parameters=Object.fromEntries(Object.keys(raw).sort().map(key=>[key,raw[key]]));
    const definition=defineMath(template.id,parameters);
    const problem={schemaVersion:1 as const,templateVersion:1 as const,templateId:template.id,familyKey:template.familyKey,parent,parameters,definition};
    const identity={...problem,seed:input.seed};
    Object.freeze(parameters);Object.freeze(parent);
    return Object.freeze({...identity,variantHash:await mathFingerprint(identity),exposureKey:await mathFingerprint(problem)});
}
const verdict=(value:'correct'|'wrong'|'unknown',explanation:string):MathVerdict=>({verdict:value,correct:value==='unknown'?null:value==='correct',explanation});

/** Definition is rebuilt from closed parameters; a caller cannot supply its own expected answer. */
export function evaluateMathVariant(variant:MathVariant,input:MathInput,withSteps=false){
    if(variant.schemaVersion!==1||variant.templateVersion!==1||!MATH_TEMPLATES.some(template=>template.id===variant.templateId))throw Error('unsupported-template-version');
    const rule=defineMath(variant.templateId,variant.parameters);
    let final:MathVerdict;
    const kinds=['number','none','all','allowed','not-allowed'];
    if(!kinds.includes(input.answerKind))final=verdict('unknown','请先选择结论类型。');
    else if(input.answerKind!==rule.answerKind)final=verdict('wrong','结论类型与本题条件不一致，请核对是否有唯一数值结果。');
    else if(rule.answerKind==='number')final=compareExpressions(input.answer.trim(),rule.answer,[]);
    else final=verdict('correct','该结论与本题声明的条件一致。');
    if(!withSteps)return {final,steps:null};
    const method=!input.method||!rule.methods.some(choice=>choice.id===input.method)?verdict('unknown','方法尚未选择或不在本模板支持范围。'):verdict(rule.methodsAccepted.includes(input.method)?'correct':'wrong',rule.methodsAccepted.includes(input.method)?'方法符合本题给定条件。':'所选方法不符合本题给定条件。');
    const condition=!input.condition||!rule.conditions.some(choice=>choice.id===input.condition)?verdict('unknown','条件尚未选择或不在本模板支持范围。'):verdict(input.condition===rule.condition?'correct':'wrong',input.condition===rule.condition?'条件与题目一致。':'不能省略或假定题目没有给出的条件。');
    const transformation=compareExpressions(input.transformation?.trim()??'',rule.transformation,rule.variables);
    const checks=[method,condition,transformation];
    const state:'wrong'|'unknown'|'correct'=checks.some(item=>item.verdict==='wrong')?'wrong':checks.some(item=>item.verdict==='unknown')?'unknown':'correct';
    return {final,steps:{verdict:state,method,condition,transformation}};
}
