// @ts-expect-error TS5097: standalone Node contracts.
import {providerRequest} from './provider.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {accountStudyPlanAiTrace,parsePlanAiRequest} from '../../domain/ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyText,studyCount} from '../../domain/sync/index.ts';
import type {StudyAIProvider,PlanAiResult} from '../../domain/ai';
type Options={provider?:StudyAIProvider;enabled:boolean;key:string;model:string;baseUrl?:string;fetcher?:typeof fetch;timeoutMs?:number};

export function createAccountStudyPlanAi(options:Options){
  const timeout=Math.min(40000,Math.max(1000,options.timeoutMs??20000)),trace={...accountStudyPlanAiTrace(options.model),provider:options.provider??'deepseek'};
  return {trace,available:Boolean(options.enabled&&options.key.trim()&&options.model.trim()),async recommend(raw:unknown,budget:{maxOutputTokens:number}={maxOutputTokens:500}):Promise<PlanAiResult>{
    if(!options.enabled)throw new Error('cloud-ai-disabled');if(!options.key.trim()||!options.model.trim())throw new Error('cloud-ai-unconfigured');
    const request=parsePlanAiRequest(raw);studyCount(budget.maxOutputTokens,'max-output-tokens',100);if(budget.maxOutputTokens>2000)throw new Error('invalid-ai-token-budget');
    const prompt=JSON.stringify({intent:request.intent,candidates:request.candidates,currentOptionalTaskIds:request.currentOptionalTaskIds});
    const body={model:options.model,messages:[{role:'system',content:'Return JSON only: {"selectedUnitIds":[],"optionalOrder":[],"message":""}. Select at most 3 candidate unit IDs, at most one per subject. Never invent IDs.'},
      {role:'user',content:`JSON candidate input: ${prompt}`}],response_format:{type:'json_object'},thinking:{type:'disabled'},stream:false,max_tokens:budget.maxOutputTokens};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);let response:Response,text:string;
    try{response=await providerRequest(options,body,controller.signal);text=await response.text();}
    catch{throw new Error('cloud-ai-provider-error');}finally{clearTimeout(timer);}
    if(!response.ok||new TextEncoder().encode(text).byteLength>65536)throw new Error('cloud-ai-provider-error');
    let provider:unknown;try{provider=JSON.parse(text);}catch{throw new Error('cloud-ai-output-invalid');}
    const wrapper=studyObject(provider,['choices'],['usage','id','created','model','object','system_fingerprint']);
    if(!Array.isArray(wrapper.choices)||wrapper.choices.length!==1)throw new Error('cloud-ai-output-invalid');
    const choice=studyObject(wrapper.choices[0],['finish_reason','message'],['index','logprobs']);if(choice.finish_reason!=='stop')throw new Error('cloud-ai-output-invalid');
    const message=studyObject(choice.message,['content'],['role','reasoning_content']);if(typeof message.content!=='string'||!message.content.trim())throw new Error('cloud-ai-output-invalid');
    let output:Record<string,unknown>;try{output=studyObject(JSON.parse(message.content),['selectedUnitIds','optionalOrder','message']);}catch{throw new Error('cloud-ai-output-invalid');}
    if(!Array.isArray(output.selectedUnitIds)||!Array.isArray(output.optionalOrder)||typeof output.message!=='string')throw new Error('cloud-ai-output-invalid');
    const selected=output.selectedUnitIds as unknown[],order=output.optionalOrder as unknown[];if(selected.length>3)throw new Error('cloud-ai-output-invalid');
    const allowed=new Map(request.candidates.map(c=>[c.unitId,c])),current=new Set(request.currentOptionalTaskIds);
    if(selected.some(id=>typeof id!=='string'||!allowed.has(id))||order.some(id=>typeof id!=='string'||!current.has(id))||new Set(selected).size!==selected.length||new Set(order).size!==order.length)throw new Error('cloud-ai-output-invalid');
    if(new Set(selected.map(id=>allowed.get(id as string)!.subjectId)).size!==selected.length)throw new Error('cloud-ai-output-invalid');studyText(output.message,'ai-message',500,true);
    const usage=(wrapper.usage&&typeof wrapper.usage==='object'&&(wrapper.usage as {total_tokens?:unknown}).total_tokens!==undefined)?(wrapper.usage as {total_tokens:unknown}).total_tokens:undefined;
    const providerModel=wrapper.model;if(providerModel!==undefined)studyText(providerModel,'provider-model',160);if(usage!==undefined)studyCount(usage,'ai-usage');return {selectedUnitIds:selected as string[],optionalOrder:order as string[],message:output.message,trace:{...trace,...(providerModel===undefined?{}:{providerModel:providerModel as string})},...(usage===undefined?{}:{usageTokens:usage as number})};
  }};
}
