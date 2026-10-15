import type {StudyAIService} from '../../application/ai';
import type {StudyAISettings} from '../../domain/ai';
import type {PaperReadingAiPort} from '../../application/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingPreparation,paperReadingModelEvaluation} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingPrompts} from './provider.ts';
/** Local records remain in the local repository; configured AI uses the existing controlled service. */
export function createLocalPaperReadingAi(current:()=>{service:StudyAIService;settings:StudyAISettings|null}|null,isCurrent:()=>boolean):PaperReadingAiPort{
    async function run(kind:'prepare'|'evaluate',input:unknown,requestId:string,signal:AbortSignal){
        const selected=current();
        if(!selected?.settings?.enabled||!selected.settings.configured)throw Error('paper-reading-ai-unavailable');
        const {service}=selected,settings={...selected.settings};
        const payload=JSON.stringify(input);
        const request={requestId:'paper-chat:'+await studyHash([requestId,settings.provider,settings.model,settings.revision]),provider:settings.provider,model:settings.model,settingsRevision:settings.revision,
            context:{id:requestId,title:'论文阅读理解核对',pageKind:'paper'},
            messages:[{role:'user' as const,content:paperReadingPrompts[kind]},...Array.from({length:Math.ceil(payload.length/8000)},(_,i)=>({role:'user' as const,content:`来源数据 ${i+1}：\n`+payload.slice(i*8000,(i+1)*8000) }))]};
        if(JSON.stringify(request).length>50000)throw Error('paper-reading-ai-input-budget');
        let text='',done=false;
        for await(const event of service.chat(request,signal)){
            signal.throwIfAborted();const latest=current();
            if(!isCurrent()||latest?.service!==service||latest.settings?.revision!==settings.revision)throw Error('paper-reading-request-cancelled');
            if(event.type==='delta'){text+=event.text;if(text.length>40000)throw Error('paper-ai-output-limit');}else done=true;
        }
        signal.throwIfAborted();if(!done)throw Error('paper-ai-output-incomplete');
        try{return JSON.parse(text);}catch{throw Error('paper-ai-output-invalid');}
    }
    return {
        prepare:async(unit,requestId,signal)=>paperReadingPreparation(await run('prepare',{title:unit.title,goal:unit.goal,sectionId:unit.source.sectionId,paragraphs:unit.source.paragraphs},requestId,signal),unit,'paper-task:'+unit.unitId),
        evaluate:async(task,answer,requestId,signal)=>paperReadingModelEvaluation(await run('evaluate',{goal:task.goal,ability:task.ability,question:task.question,reference:task.reference,sectionId:task.source.sectionId,paragraphs:task.source.paragraphs,answer},requestId,signal),task,answer),
    };
}
