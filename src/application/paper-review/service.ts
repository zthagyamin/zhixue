import type {PaperReviewPorts,PaperReviewPrepared,PaperReviewState} from './ports';
import type {StudyAISettings} from '../../domain/ai';
type ReviewJob={prepared:PaperReviewPrepared;scope:string;settings:StudyAISettings;generation:number};
/** Ephemeral source-bound review: no grading, persistence or scheduling capability. */
export function createPaperReviewService(options:PaperReviewPorts){
    let state:PaperReviewState={status:'idle',prompt:'',notice:'',text:'',message:''};
    const listeners=new Set<()=>void>();
    let generation=0,active:AbortController|null=null,pending:ReviewJob|null=null;
    function publish(change:Partial<PaperReviewState>){state={...state,...change};for(const listener of listeners)listener();}
    function cancel(clear=false){
        generation++;active?.abort();active=null;pending=null;
        publish({status:'idle',...(clear?{prompt:'',notice:'',text:'',message:''}:{})});
    }
    function current(job:ReviewJob){
        const settings=options.settings();
        return generation===job.generation&&options.currentScope()===job.scope&&settings?.enabled&&settings.configured
            &&settings.provider===job.settings.provider&&settings.model===job.settings.model&&settings.revision===job.settings.revision;
    }
    async function send(job:ReviewJob){
        if(!current(job)||!options.ai){cancel(true);return;}
        const controller=new AbortController();active=controller;pending=null;
        publish({status:'streaming'});
        try{
            for await(const event of options.ai.chat({requestId:options.requestId(),provider:job.settings.provider,model:job.settings.model,
                settingsRevision:job.settings.revision,context:job.prepared.context,messages:[{role:'user',content:job.prepared.prompt}]},controller.signal)){
                if(controller.signal.aborted||active!==controller)return;
                if(!current(job)){cancel(true);return;}
                if(event.type==='delta')publish({text:state.text+event.text});
            }
            if(active===controller&&!current(job))cancel(true);
        }catch(error){
            if(!controller.signal.aborted&&active===controller){
                if(current(job))publish({text:`AI 暂不可用：${String(error)}。可复制下方问题继续。`});
                else cancel(true);
            }
        }finally{if(active===controller){active=null;publish({status:'idle'});}}
    }
    async function review(action:string){
        cancel();publish({text:'',message:''});
        let prepared:PaperReviewPrepared;
        try{prepared=structuredClone(options.prepare(action));}
        catch(error){publish({notice:error instanceof Error?error.message:'请缩小本次审阅范围。'});return;}
        publish({prompt:prepared.prompt,notice:prepared.notice});
        const scope=options.currentScope(),settings=options.settings();
        if(!scope){publish({message:'当前论文范围已变化，请重新提问。'});return;}
        if(!options.ai||!settings?.enabled||!settings.configured){publish({message:'可复制审稿问题；连接 AI 后再提问。'});return;}
        const job:ReviewJob={prepared,scope,settings:structuredClone(settings),generation};
        if(prepared.truncated){pending=job;publish({status:'confirmation-required'});return;}
        await send(job);
    }
    async function confirmExcerpt(){const job=pending;if(job){pending=null;await send(job);}}
    return {snapshot:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},review,confirmExcerpt,cancel};
}
export type PaperReviewService=ReturnType<typeof createPaperReviewService>;
