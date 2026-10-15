// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingTask,parsePaperReadingSource,createPaperReadingAttempt,submitPaperReadingAnswer,applyPaperReadingFeedback} from './evidence.ts';
import type {PaperReadingSource,PaperReadingTaskV1,PaperReadingAttemptV1,PaperReadingEvaluation} from './evidence';
export type PaperReadingUnitV1={schemaVersion:1;unitId:string;title:string;goal:string;source:PaperReadingSource};
type Base={schemaVersion:1;operationId:string;unitId:string;expectedRevision:number};
export type PaperReadingMutation=Base&(
    {kind:'register';unit:PaperReadingUnitV1}|{kind:'task';task:PaperReadingTaskV1}|
    {kind:'draft';answer:string;referenceSeen:boolean}|
    {kind:'submit';answer:string;submittedAt:string;referenceSeen:boolean}|
    {kind:'retry';attemptId:string;purpose:'assisted'|'remediation'}|{kind:'reference'}|
    {kind:'feedback';attemptId:string;answerRevision:number;taskRevision:number;evaluation:PaperReadingEvaluation}|
    {kind:'pause';paused:boolean;activeSeconds:number});
export type PaperReadingWorkspaceV1={
    schemaVersion:1;revision:number;unit:PaperReadingUnitV1;task:PaperReadingTaskV1|null;
    attempts:PaperReadingAttemptV1[];activeAttemptId:string|null;answer:string;referenceSeen:boolean;
    paused:boolean;activeSeconds:number;operations:PaperReadingMutation[];
};
export type PaperReadingMutationResult={status:'accepted'|'duplicate'|'conflict';workspace:PaperReadingWorkspaceV1|null};
const clone=<T>(value:T):T=>structuredClone(value);
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
function object(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))
        ||required.some(key=>!Object.hasOwn(value,key)))throw Error('paper-reading-invalid-fields');
    return value as Record<string,unknown>;
}
function text(value:unknown,max=200):asserts value is string{
    if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('paper-reading-invalid-text');
}
export function paperReadingUnit(raw:unknown):PaperReadingUnitV1{
    const value=object(raw,['schemaVersion','unitId','title','goal','source']);
    if(value.schemaVersion!==1)throw Error('paper-unit-binding');
    text(value.unitId);text(value.title,1200);text(value.goal,1200);
    const source=parsePaperReadingSource(value.source);
    if(source.paragraphs.map(p=>p.rawEn).join('\n\n').length>8000)throw Error('paper-unit-source-budget');
    return {schemaVersion:1,unitId:value.unitId,title:value.title,goal:value.goal,source};
}
export function parsePaperReadingMutation(raw:unknown):PaperReadingMutation{
    const kind=(raw as {kind?:unknown})?.kind;
    const fields:Record<string,string[]>={register:['unit'],task:['task'],draft:['answer','referenceSeen'],submit:['answer','submittedAt','referenceSeen'],
        retry:['attemptId','purpose'],reference:[],feedback:['attemptId','answerRevision','taskRevision','evaluation'],pause:['paused','activeSeconds']};
    if(typeof kind!=='string'||!Object.hasOwn(fields,kind))throw Error('paper-reading-invalid-kind');
    const value=clone(object(raw,['schemaVersion','operationId','unitId','expectedRevision','kind',...fields[kind]]));
    if(value.schemaVersion!==1||!Number.isSafeInteger(value.expectedRevision)||(value.expectedRevision as number)<0)throw Error('paper-reading-invalid-revision');
    text(value.operationId);text(value.unitId);
    if(kind==='register'){const unit=paperReadingUnit(value.unit);if(unit.unitId!==value.unitId)throw Error('paper-unit-binding');value.unit=unit;}
    if(kind==='task'){value.task=paperReadingTask(value.task as PaperReadingTaskV1);}
    if(kind==='draft'||kind==='submit'){
        if(typeof value.answer!=='string'||value.answer.length>20000||typeof value.referenceSeen!=='boolean')throw Error('paper-answer-binding');
        if(kind==='submit')text(value.submittedAt,100);
    }
    if(kind==='retry'){text(value.attemptId);if(!['assisted','remediation'].includes(value.purpose as string))throw Error('paper-attempt-binding');}
    if(kind==='feedback'){text(value.attemptId);if(!Number.isSafeInteger(value.answerRevision)||!Number.isSafeInteger(value.taskRevision))throw Error('paper-feedback-binding');}
    if(kind==='pause'&&(typeof value.paused!=='boolean'||!Number.isSafeInteger(value.activeSeconds)||(value.activeSeconds as number)<0||(value.activeSeconds as number)>31536000))throw Error('paper-duration-binding');
    return clone(value) as PaperReadingMutation;
}
export function applyPaperReadingMutation(current:PaperReadingWorkspaceV1|null,raw:unknown,authority:'public'|'service'='public'):PaperReadingMutationResult{
    const input=parsePaperReadingMutation(raw);
    if((input.kind==='task'||input.kind==='feedback')&&authority!=='service')throw Error('paper-reading-service-only');
    if(current){
        if(current.unit.unitId!==input.unitId)throw Error('paper-unit-binding');
        const previous=current.operations.find(op=>op.operationId===input.operationId);
        if(previous)return {status:same(previous,input)?'duplicate':'conflict',workspace:clone(current)};
    }
    if(input.expectedRevision!==(current?.revision??0))return {status:'conflict',workspace:clone(current)};
    if(!current){
        if(input.kind!=='register')throw Error('paper-unit-not-registered');
        return {status:'accepted',workspace:{schemaVersion:1,revision:1,unit:clone(input.unit),task:null,attempts:[],activeAttemptId:null,
            answer:'',referenceSeen:false,paused:false,activeSeconds:0,operations:[input]}};
    }
    if(input.kind==='register')return {status:'conflict',workspace:clone(current)};
    const next=clone(current);
    const active=next.attempts.find(a=>a.attemptId===next.activeAttemptId);
    switch(input.kind){
        case 'task':{
            const task=input.task;
            if(!same(task.source,current.unit.source)||task.goal!==current.unit.goal)throw Error('paper-task-binding');
            if(current.task&&(current.task.status==='ready'||current.attempts.length||task.revision!==current.task.revision+1))return {status:'conflict',workspace:clone(current)};
            next.task=task;
            if(task.status==='ready'){
                const first=createPaperReadingAttempt(task,{attemptId:task.taskId+':first',purpose:'first',parentAttemptId:null});
                next.attempts.push(first);next.activeAttemptId=first.attemptId;
            }
            break;
        }
        case 'draft':
            if(!active||active.submission)throw Error('paper-draft-not-open');
            if(next.referenceSeen&&!input.referenceSeen)throw Error('paper-reference-observation-conflict');
            next.answer=input.answer;next.referenceSeen=input.referenceSeen;active.referenceSeen=input.referenceSeen;break;
        case 'submit':{
            if(!active||active.submission)throw Error('paper-submission-conflict');
            if(next.referenceSeen&&!input.referenceSeen)throw Error('paper-reference-observation-conflict');
            const submitted={...submitPaperReadingAnswer(active,{operationId:input.operationId,expectedRevision:active.revision,answer:input.answer,submittedAt:input.submittedAt}),referenceSeen:input.referenceSeen};
            next.attempts=next.attempts.map(a=>a.attemptId===active.attemptId?submitted:a);
            next.answer=input.answer;next.referenceSeen=input.referenceSeen;break;
        }
        case 'retry':{
            if(!active||!active.submission||!next.task)throw Error('paper-retry-not-submitted');
            if(next.attempts.some(a=>a.attemptId===input.attemptId))throw Error('paper-attempt-binding');
            const retry=createPaperReadingAttempt(next.task,{attemptId:input.attemptId,purpose:input.purpose,parentAttemptId:active.attemptId});
            next.attempts.push(retry);next.activeAttemptId=retry.attemptId;next.answer='';next.referenceSeen=false;break;
        }
        case 'reference':
            if(!active)throw Error('paper-reference-not-open');
            next.referenceSeen=true;if(!active.submission)active.referenceSeen=true;break;
        case 'feedback':{
            const original=next.attempts.find(a=>a.attemptId===input.attemptId);
            if(!original)throw Error('paper-feedback-binding');
            const evaluated=applyPaperReadingFeedback(original,{operationId:input.operationId,expectedRevision:original.revision,answerRevision:input.answerRevision,taskRevision:input.taskRevision,evaluation:input.evaluation});
            next.attempts=next.attempts.map(a=>a.attemptId===original.attemptId?evaluated:a);break;
        }
        case 'pause':
            if(input.activeSeconds<next.activeSeconds)throw Error('paper-duration-conflict');
            next.paused=input.paused;next.activeSeconds=input.activeSeconds;break;
    }
    next.revision++;next.operations.push(input);
    return {status:'accepted',workspace:next};
}
/** Verify stored aggregates by replaying their immutable journal; corrupt data never becomes empty work. */
export function parsePaperReadingWorkspace(raw:unknown):PaperReadingWorkspaceV1{
    const value=object(raw,['schemaVersion','revision','unit','task','attempts','activeAttemptId','answer','referenceSeen','paused','activeSeconds','operations']);
    if(!Array.isArray(value.operations)||!value.operations.length)throw Error('paper-reading-corrupt');
    let reconstructed:PaperReadingWorkspaceV1|null=null;
    for(const mutation of value.operations){
        const result=applyPaperReadingMutation(reconstructed,mutation,'service');
        if(result.status!=='accepted')throw Error('paper-reading-corrupt-journal');
        reconstructed=result.workspace;
    }
    if(!reconstructed||!same(reconstructed,value))throw Error('paper-reading-corrupt');
    return reconstructed;
}
