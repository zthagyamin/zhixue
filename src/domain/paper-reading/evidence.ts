export type PaperReadingSource={
    ownerId:string;libraryId:string;materialFingerprint:string;sourceVersion:string;sectionId:string;
    paragraphs:{id:string;rawEn:string;pageNumber?:number}[];
};
export type PaperReadingReference={point:string;paragraphId:string;quote:string};
export type PaperReadingTaskV1={
    schemaVersion:1;taskId:string;revision:number;source:PaperReadingSource;origin:'prepared'|'ai';
    goal:string;ability:'definition'|'mechanism'|'comparison'|'condition'|'application';question:string;
    reference:PaperReadingReference[];evidenceMode:'reading-supported';
    status:'ready'|'needs-improvement';reason?:'source-budget'|'question-scope'|'reference-missing';
};
export type PaperReadingEvaluation={status:'pending';reason:'not-requested'|'offline'|'insufficient-evidence'}|
    {status:'resolved';outcome:'correct'|'partial'|'incorrect';matched:string[];issues:string[];explanation:string};
export type PaperReadingAttemptV1={
    schemaVersion:1;attemptId:string;task:PaperReadingTaskV1;revision:number;answerRevision:number;
    purpose:'first'|'assisted'|'remediation';parentAttemptId:string|null;evidenceMode:'reading-supported';
    referenceSeen:boolean;
    submission:{answer:string;submittedAt:string;answerRevision:number}|null;evaluation:PaperReadingEvaluation;
    operations:{operationId:string;payload:string}[];
};
const clone=<T>(value:T):T=>structuredClone(value);
const nonempty=(value:unknown,max=8000)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function sourceValid(source:PaperReadingSource){
    return nonempty(source.ownerId,200)&&nonempty(source.libraryId,200)&&nonempty(source.sectionId,400)
        &&typeof source.materialFingerprint==='string'&&typeof source.sourceVersion==='string'
        &&/^[a-f0-9]{64}$/.test(source.materialFingerprint)&&/^[a-f0-9]{64}$/.test(source.sourceVersion)
        &&Array.isArray(source.paragraphs)&&source.paragraphs.length>0
        &&new Set(source.paragraphs.map(p=>p.id)).size===source.paragraphs.length
        &&source.paragraphs.every(p=>nonempty(p.id,400)&&typeof p.rawEn==='string'&&p.rawEn.trim().length>0
            &&(p.pageNumber===undefined||Number.isInteger(p.pageNumber)&&p.pageNumber>0&&p.pageNumber<=200));
}
export function parsePaperReadingSource(raw:unknown):PaperReadingSource{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('paper-source-binding');
    const source=raw as PaperReadingSource;
    if(Object.keys(source).some(key=>!['ownerId','libraryId','materialFingerprint','sourceVersion','sectionId','paragraphs'].includes(key))
        ||!sourceValid(source)||source.paragraphs.some(p=>Object.keys(p).some(key=>!['id','rawEn','pageNumber'].includes(key))))throw Error('paper-source-binding');
    return clone(source);
}
/** Structural source checks precede semantic model checks; neither proves learning quality. */
export function paperReadingTask(input:Omit<PaperReadingTaskV1,'schemaVersion'|'status'|'reason'|'evidenceMode'>):PaperReadingTaskV1{
    parsePaperReadingSource(input.source);
    if(!nonempty(input.taskId,200)||!Number.isInteger(input.revision)||input.revision<1
        ||!['prepared','ai'].includes(input.origin)||!['definition','mechanism','comparison','condition','application'].includes(input.ability))throw Error('paper-task-binding');
    if(Object.keys(input).some(key=>!['schemaVersion','taskId','revision','source','origin','goal','ability','question','reference','evidenceMode','status','reason'].includes(key)))throw Error('paper-task-fields');
    const task:PaperReadingTaskV1={schemaVersion:1,taskId:input.taskId,revision:input.revision,source:clone(input.source),origin:input.origin,
        goal:input.goal,ability:input.ability,question:input.question,reference:clone(input.reference),status:'ready',evidenceMode:'reading-supported'};
    const total=task.source.paragraphs.map(p=>p.rawEn).join('\n\n').length;
    if(total>8000){task.status='needs-improvement';task.reason='source-budget';}
    else if(!nonempty(task.goal,1200)||!nonempty(task.question,2000)||/^(?:请)?(?:回忆本节核心要点|概括核心要点|总结全文)[。？?]?$/u.test(task.question.trim())){
        task.status='needs-improvement';task.reason='question-scope';
    }else if(!Array.isArray(task.reference)||task.reference.length===0||task.reference.length>16||task.reference.some(point=>
        !nonempty(point.point,2000)||!nonempty(point.quote,2000)||!task.source.paragraphs.some(p=>p.id===point.paragraphId&&p.rawEn.includes(point.quote)))){
        task.status='needs-improvement';task.reason='reference-missing';
    }
    return task;
}
export function createPaperReadingAttempt(task:PaperReadingTaskV1,input:{attemptId:string;purpose:PaperReadingAttemptV1['purpose'];parentAttemptId:string|null}):PaperReadingAttemptV1{
    if(task.status!=='ready'||paperReadingTask(task).status!=='ready'||!nonempty(input.attemptId,200)
        ||!['first','assisted','remediation'].includes(input.purpose)
        ||(input.purpose==='first'?input.parentAttemptId!==null:!nonempty(input.parentAttemptId,200)))throw Error('paper-attempt-binding');
    return {...clone(input),schemaVersion:1,task:clone(task),revision:0,answerRevision:0,submission:null,
        evidenceMode:'reading-supported',referenceSeen:false,evaluation:{status:'pending',reason:'not-requested'},operations:[]};
}
type Mutation={operationId:string;expectedRevision:number};
function replay(attempt:PaperReadingAttemptV1,input:Mutation){
    if(!nonempty(input.operationId,200))throw Error('paper-operation-binding');
    const prior=attempt.operations.find(op=>op.operationId===input.operationId);
    if(prior){if(prior.payload!==JSON.stringify(input))throw Error('paper-operation-conflict');return true;}
    if(input.expectedRevision!==attempt.revision)throw Error('paper-revision-conflict');
    return false;
}
function changed(attempt:PaperReadingAttemptV1,input:Mutation):PaperReadingAttemptV1{
    return {...clone(attempt),revision:attempt.revision+1,operations:[...attempt.operations,{operationId:input.operationId,payload:JSON.stringify(input)}]};
}
export function submitPaperReadingAnswer(attempt:PaperReadingAttemptV1,input:Mutation&{answer:string;submittedAt:string}):PaperReadingAttemptV1{
    if(replay(attempt,input))return clone(attempt);
    if(attempt.submission)throw Error('paper-submission-conflict');
    if(!nonempty(input.answer,20000)||!/^\d{4}-\d{2}-\d{2}T/.test(input.submittedAt)||!Number.isFinite(Date.parse(input.submittedAt)))throw Error('paper-answer-binding');
    const next=changed(attempt,input);next.answerRevision=attempt.answerRevision+1;
    next.submission={answer:input.answer,submittedAt:input.submittedAt,answerRevision:next.answerRevision};
    return next;
}
export function applyPaperReadingFeedback(attempt:PaperReadingAttemptV1,input:Mutation&{answerRevision:number;taskRevision:number;evaluation:PaperReadingEvaluation}):PaperReadingAttemptV1{
    if(replay(attempt,input))return clone(attempt);
    if(!attempt.submission||input.answerRevision!==attempt.answerRevision||input.taskRevision!==attempt.task.revision)throw Error('paper-feedback-binding');
    if(attempt.evaluation.status==='resolved')throw Error('paper-feedback-conflict');
    const e=input.evaluation;
    if(e.status==='pending'){
        if(!['not-requested','offline','insufficient-evidence'].includes(e.reason))throw Error('paper-feedback-binding');
    }else if(e.status!=='resolved'||!['correct','partial','incorrect'].includes(e.outcome)||!Array.isArray(e.matched)||!Array.isArray(e.issues)
        ||e.matched.length>16||e.issues.length>16||![...e.matched,...e.issues].every(text=>nonempty(text,2000))||!nonempty(e.explanation,4000)
        ||e.outcome!=='correct'&&e.issues.length===0)throw Error('paper-feedback-binding');
    return {...changed(attempt,input),evaluation:clone(e)};
}
