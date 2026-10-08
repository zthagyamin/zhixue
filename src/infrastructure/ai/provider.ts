// @ts-expect-error TS5097: standalone Node contracts.
import {providerEndpoint,providerFailureCode,assertStudyAIModel} from '../../domain/ai/index.ts';
import type {StudyAIProvider,StudyAIStreamEvent} from '../../domain/ai';
export type ProviderOptions={provider?:StudyAIProvider;key:string;model:string;baseUrl?:string;fetcher?:typeof fetch};

export async function providerRequest(options:ProviderOptions,body:Record<string,unknown>,signal?:AbortSignal):Promise<Response>{
 if(!options.key.trim()||!options.model.trim())throw new Error('cloud-ai-unconfigured');
 assertStudyAIModel(options.provider??'deepseek',options.model,options.baseUrl);
 const payload:Record<string,unknown>={...body,model:options.model};
 if(options.provider==='chatgpt'){delete payload.thinking;if(payload.max_tokens!==undefined){payload.max_completion_tokens=payload.max_tokens;delete payload.max_tokens;}delete payload.temperature;}
 else if(payload.thinking===undefined)payload.thinking={type:'disabled'};
 const endpoint=providerEndpoint(options);
 let response:Response;
 try{response=await (options.fetcher??fetch)(endpoint,{method:'POST',redirect:'manual',headers:{Authorization:`Bearer ${options.key}`,'Content-Type':'application/json',Accept:body.stream?'text/event-stream':'application/json'},body:JSON.stringify(payload),signal});}
 catch(error){if(signal?.aborted)throw error;throw new Error('ai-provider-network');}
 if(response.status>=300&&response.status<400)throw new Error('ai-provider-redirect');
 if(!response.ok){let body:unknown;try{const text=await response.text();if(text.length<=12000)body=JSON.parse(text);}catch{/* Never forward an upstream body. */}throw new Error(providerFailureCode(response.status,body));}
 return response;
}

export async function listProviderModels(options:Omit<ProviderOptions,'model'>,signal?:AbortSignal):Promise<string[]>{
 if(!options.key.trim())throw new Error('account-ai-key-required');
 const endpoint=providerEndpoint(options).replace(/\/chat\/completions$/,'/models');let response:Response;
 try{response=await(options.fetcher??fetch)(endpoint,{method:'GET',redirect:'manual',headers:{Authorization:`Bearer ${options.key}`,Accept:'application/json'},signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(15000)])});}
 catch(error){if(signal?.aborted)throw error;throw new Error(error instanceof Error&&error.name==='TimeoutError'?'ai-provider-timeout':'ai-provider-network');}
 if(response.status>=300&&response.status<400)throw new Error('ai-provider-redirect');
 if(!response.ok)throw new Error(providerFailureCode(response.status,{}));
 const text=await response.text();if(text.length>200000)throw new Error('ai-model-list-empty');let raw;try{raw=JSON.parse(text);}catch{throw new Error('ai-model-list-empty');}
 if(!Array.isArray(raw.data))throw new Error('ai-model-list-empty');
 const ids=[...new Set<string>(raw.data.map((row:{id?:unknown})=>row?.id).filter((id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)))].sort().slice(0,300);
 if(!ids.length)throw new Error('ai-model-list-empty');return ids;
}

export async function* decodeProviderStream(stream:ReadableStream<Uint8Array>,signal?:AbortSignal):AsyncGenerator<StudyAIStreamEvent>{
 const reader=stream.getReader(),decoder=new TextDecoder();let buffer='',model:string|undefined,usageTokens:number|undefined,finished=false,done=false;
 const abort=()=>{void reader.cancel();};signal?.addEventListener('abort',abort,{once:true});
 try{while(!done){signal?.throwIfAborted();const chunk=await reader.read();signal?.throwIfAborted();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});if(buffer.length>262144)throw new Error('cloud-ai-provider-stream-limit');
 let match:RegExpExecArray|null;while((match=/\r?\n\r?\n/.exec(buffer))){const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;if(data==='[DONE]'){if(!finished)throw new Error('cloud-ai-provider-incomplete');done=true;yield{type:'done',model,usageTokens};break;}
 let event;try{event=JSON.parse(data);}catch{throw new Error('cloud-ai-provider-stream-invalid');}if(event.error)throw new Error('cloud-ai-provider-error');if(typeof event.model==='string')model=event.model;if(Number.isSafeInteger(event.usage?.total_tokens))usageTokens=event.usage.total_tokens;
 const choice=event.choices?.[0];if(choice?.finish_reason){if(choice.finish_reason!=='stop')throw new Error(choice.finish_reason==='length'?'ai-provider-output-limit':'cloud-ai-provider-incomplete');finished=true;}if(typeof choice?.delta?.content==='string')yield{type:'delta',text:choice.delta.content};}
 if(chunk.done&&!done)throw new Error('cloud-ai-provider-incomplete');}
 }finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
