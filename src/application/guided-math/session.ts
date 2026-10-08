// @ts-expect-error TS5097: standalone Node contracts.
import {createMathVariant,evaluateMathVariant,type MathVariant,type ParentBinding,type TemplateId} from '../../domain/guided-math/index.ts';
import type {TemporaryDraft} from '../temporary-practice';

export const mathDraftFields={templateId:'cancel-domain',seed:'1',approved:'',answerKind:'',answer:'',method:'',condition:'',transformation:''};
type Result=ReturnType<typeof evaluateMathVariant>;
type State={phase:'choose'|'preparing'|'answering';variant:MathVariant|null;result:Result|null;stepsVisible:boolean;assisted:boolean;notice:string};
type Builder=(input:Parameters<typeof createMathVariant>[0])=>Promise<MathVariant>;

/** One source scope, one page lifetime. Never evict exposure and call it unseen. */
export function createMathExposureLedger(){
    const seen=new Set<string>();let saturated=false;
    return {has:(key:string)=>saturated||seen.has(key),mark(key:string){if(seen.size>=128)saturated=true;else seen.add(key);}};
}

/** Page-only use case. No event, AI, formal grade, plan, or persistence port exists. */
export function createGuidedMathSession(draft:TemporaryDraft,parent:ParentBinding,build:Builder=createMathVariant,exposure=createMathExposureLedger()){
    let state:State={phase:'choose',variant:null,result:null,stepsVisible:false,assisted:false,notice:''};
    let revision=0,epoch=0,disposed=false;
    const listeners=new Set<()=>void>();
    const active=()=>!disposed&&draft.isActive();
    const notify=()=>{revision++;for(const listener of [...listeners])listener();};
    const patch=(change:Partial<State>)=>{state={...state,...change};notify();};
    const edit=(field:string,value:string)=>{
        if(!active()||state.phase==='preparing'||(state.variant&&['templateId','seed','approved'].includes(field)))return false;
        if(!draft.write(field,value))return false;
        patch({result:null,notice:'',assisted:state.assisted||state.result!==null});return true;
    };
    return {
        snapshot:()=>state,
        subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
        getSnapshot:()=>revision,
        edit,
        async prepare(){
            if(!active()||state.phase==='preparing'||state.variant)return;
            const seedText=draft.read('seed');
            if(draft.read('approved')!=='yes'){patch({notice:'请先确认模板与原题的训练目标相关。'});return;}
            if(!/^\d{1,10}$/.test(seedText)){patch({notice:'题目编号应为 0–4294967295 的整数。'});return;}
            const request=++epoch;draft.setBusy(true);patch({phase:'preparing',notice:''});
            try{
                const variant=await build({parent,templateId:draft.read('templateId') as TemplateId,seed:Number(seedText)});
                if(!active()||request!==epoch)return;
                patch({variant,phase:'answering',result:null,assisted:exposure.has(variant.exposureKey),stepsVisible:false});
            }catch{
                if(active()&&request===epoch)patch({phase:'choose',notice:'这个模板或编号暂时无法准备，请检查后重试；原题保持不变。'});
            }finally{if(request===epoch)draft.setBusy(false);}
        },
        showSteps(){if(active()&&state.variant){exposure.mark(state.variant.exposureKey);patch({stepsVisible:true,assisted:true,result:null});}},
        showReference(){if(active()&&state.variant){exposure.mark(state.variant.exposureKey);patch({assisted:true});}},
        check(){
            if(!active()||!state.variant||state.phase!=='answering'||state.result)return;
            const result=evaluateMathVariant(state.variant,{answerKind:draft.read('answerKind'),answer:draft.read('answer'),method:draft.read('method'),condition:draft.read('condition'),transformation:draft.read('transformation')},state.stepsVisible);
            exposure.mark(state.variant.exposureKey);
            patch({result});
        },
        acknowledge(){if(active()&&state.result){draft.acknowledge();patch({notice:'本次核对已结束。原题的答案、成绩与复习安排没有改变。'});}},
        restart(confirmed:boolean){
            if(!active()||state.phase==='preparing'||(draft.hasUnsavedInput()&&!confirmed))return false;
            epoch++;for(const [field,value] of Object.entries(mathDraftFields))draft.write(field,value);
            draft.acknowledge();state={phase:'choose',variant:null,result:null,stepsVisible:false,assisted:false,notice:''};notify();return true;
        },
        cancel(){if(!active())return;epoch++;draft.setBusy(false);patch({phase:state.variant?'answering':'choose',notice:'已停止准备，原题未改变。'});},
        dispose(){if(disposed)return;disposed=true;epoch++;draft.setBusy(false);listeners.clear();},
    };
}
export type GuidedMathSession=ReturnType<typeof createGuidedMathSession>;
