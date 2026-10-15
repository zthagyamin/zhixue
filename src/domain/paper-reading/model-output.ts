import type {PaperReadingUnitV1} from './workspace';
import type {PaperReadingTaskV1,PaperReadingEvaluation} from './evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingTask} from './evidence.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject} from '../sync/index.ts';
const pending:PaperReadingEvaluation={status:'pending',reason:'insufficient-evidence'};
function text(value:unknown,max=2000):value is string{return typeof value==='string'&&value.trim().length>0&&value.length<=max;}
export function paperReadingPreparation(raw:unknown,unit:PaperReadingUnitV1,taskId:string):PaperReadingTaskV1{
    const result=studyObject(raw,['status'],['ability','question','reference','quality','reason']);
    if(!['ready','needs-improvement'].includes(result.status as string))throw Error('paper-model-output-invalid');
    let valid=result.status==='ready';
    if(valid){
        const quality=studyObject(result.quality,['sourceSufficient','taskSpecific','referenceConsistent','missingVisuals']);
        if(Object.values(quality).some(value=>typeof value!=='boolean'))throw Error('paper-model-output-invalid');
        valid=quality.sourceSufficient===true&&quality.taskSpecific===true&&quality.referenceConsistent===true&&quality.missingVisuals===false;
    }
    if(valid){
        if(!text(result.question)||!['definition','mechanism','comparison','condition','application'].includes(result.ability as string)||!Array.isArray(result.reference))throw Error('paper-model-output-invalid');
        for(const reference of result.reference)studyObject(reference,['point','paragraphId','quote']);
    }
    return paperReadingTask({taskId,revision:1,source:unit.source,origin:'ai',goal:unit.goal,
        ability:valid?result.ability as PaperReadingTaskV1['ability']:'mechanism',question:valid?result.question as string:'',
        reference:valid?result.reference as PaperReadingTaskV1['reference']:[]});
}
/** All semantic judgments remain model evidence; exact quotes only validate their provenance. */
export function paperReadingModelEvaluation(raw:unknown,task:PaperReadingTaskV1,answer:string):PaperReadingEvaluation{
    try{
        const result=studyObject(raw,['status'],['outcome','matches','issues','explanation','reason']);
        if(result.status==='pending')return {...pending};
        if(result.status!=='resolved'||!['correct','partial','incorrect'].includes(result.outcome as string)||!text(result.explanation,4000)
            ||!Array.isArray(result.matches)||!Array.isArray(result.issues)||result.matches.length+result.issues.length!==task.reference.length)return {...pending};
        const covered=new Set<number>(),matched:string[]=[],issues:string[]=[];
        function proof(rawPoint:unknown,match:boolean){
            const point=studyObject(rawPoint,['pointIndex','sourceQuote','reason'],match?['answerQuote']:['kind','answerQuote']);
            const index=point.pointIndex;
            if(!Number.isSafeInteger(index)||(index as number)<0||(index as number)>=task.reference.length||covered.has(index as number)
                ||!text(point.sourceQuote)||!text(point.reason))throw Error('paper-model-evidence-invalid');
            const reference=task.reference[index as number],paragraph=task.source.paragraphs.find(p=>p.id===reference.paragraphId);
            if(!paragraph?.rawEn.includes(point.sourceQuote)||!point.sourceQuote.includes(reference.quote)&&!reference.quote.includes(point.sourceQuote))throw Error('paper-model-source-invalid');
            if(match||point.kind==='error'){
                if(!text(point.answerQuote,20000)||!answer.includes(point.answerQuote))throw Error('paper-model-answer-invalid');
            }else if(!['missing','error'].includes(point.kind as string))throw Error('paper-model-evidence-invalid');
            covered.add(index as number);return reference.point+' '+point.reason;
        }
        for(const point of result.matches)matched.push(proof(point,true));
        for(const point of result.issues)issues.push(proof(point,false));
        if(result.outcome==='correct'&&issues.length||result.outcome!=='correct'&&!issues.length||result.outcome==='partial'&&!matched.length)return {...pending};
        return {status:'resolved',outcome:result.outcome as 'correct'|'partial'|'incorrect',matched,issues,explanation:result.explanation};
    }catch{return {...pending};}
}
