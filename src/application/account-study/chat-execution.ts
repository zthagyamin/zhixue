import type {StudyAISettings,StudyAIChatRequest} from '../../domain/ai';
import type {AiStorePort,ChatProviderPort,StudyScope} from './ports';
import type {AccountReply,AccountStreamEvent} from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyAIErrorCode} from '../../domain/ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';

/** Reservation already exists. Cancellation covers provider construction as well as output. */
export async function startAccountChat(input:{
  owner:StudyScope;request:StudyAIChatRequest;settings:StudyAISettings;inputHash:string;reservedTokens:number;
  store:AiStorePort;load:()=>Promise<ChatProviderPort>;signal:AbortSignal;
}):Promise<AccountReply>{
  const {owner,request,settings,inputHash,reservedTokens,store,signal}=input;
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const detach=()=>signal.removeEventListener('abort',abort);
  let service:ChatProviderPort;
  try{
    controller.signal.throwIfAborted();service=await input.load();controller.signal.throwIfAborted();
  }catch{
    const cancelled=controller.signal.aborted,code=cancelled?'ai-provider-timeout':'ai-settings-stale';
    try{await store.fail(owner,request.requestId,inputHash,code);}finally{detach();}
    throw new AccountFailure(cancelled?502:409,code);
  }
  async function* events():AsyncGenerator<AccountStreamEvent>{
    let text='',providerModel=settings.model,usageTokens:number|undefined;
    try{
      controller.signal.throwIfAborted();
      for await(const event of service.stream(request,settings.maxOutputTokens,controller.signal)){
        controller.signal.throwIfAborted();
        if(event.type==='delta'){text+=event.text;yield event;}
        else{providerModel=event.model??settings.model;usageTokens=event.usageTokens;}
      }
      controller.signal.throwIfAborted();
      const result={text,trace:{provider:settings.provider,modelId:settings.model,providerModel,promptVersion:'chat-v1',ruleVersion:'chat-no-evidence-v1'},...(usageTokens===undefined?{}:{usageTokens})};
      await store.complete(owner,request.requestId,inputHash,result,usageTokens??reservedTokens);
      yield{type:'done',model:providerModel,provider:settings.provider,usageTokens};
    }catch(error){
      const code=studyAIErrorCode(error);await store.fail(owner,request.requestId,inputHash,code);yield{type:'error',error:code};
    }finally{detach();}
  }
  return{kind:'stream',events:events(),cancel:()=>{controller.abort();detach();}};
}
