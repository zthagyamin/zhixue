import type {StudyIdentity,CompanionSourcePayload} from '../../domain/sources';
export type PairedCompanion={token:string;accountLabel:string;capabilities?:string[];baseUrl?:string};
/** Cancellation and timeout also cover response-body decoding and transports that ignore the signal. */
async function request<T>(parent:AbortSignal,milliseconds:number,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  parent.throwIfAborted();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,stop=()=>{};
  const ended=new Promise<never>((_resolve,reject)=>{
    stop=()=>{controller.abort(parent.reason);reject(parent.reason??new DOMException('Cancelled','AbortError'));};
    parent.addEventListener('abort',stop,{once:true});timer=setTimeout(()=>{const error=new DOMException('Timed out','TimeoutError');controller.abort(error);reject(error);},milliseconds);
  });
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return run(controller.signal);}),ended]);}
  finally{if(timer!==undefined)clearTimeout(timer);parent.removeEventListener('abort',stop);}
}
export function createCompanionHttp<Source extends CompanionSourcePayload>(endpoint:string,fetcher:typeof fetch=fetch){
  return {
    generate:async(connection:PairedCompanion,file:{name:string;size:number;text:()=>Promise<string>},signal:AbortSignal)=>{
      if(file.size>1_500_000)throw Error('第一版仅接受 1.5MB 以内的 Markdown 或文本文件。');
      const content=await file.text();signal.throwIfAborted();
      return request(signal,50000,async signal=>{
        const response=await fetcher(`${endpoint}/v1/generate`,{method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':connection.token},body:JSON.stringify({title:file.name,content}),signal});
        const value=await response.json() as Source;if(!response.ok||!value.subjects?.length)throw Error(value.message||'生成失败');return value;
      });
    },
    revoke:(connection:PairedCompanion)=>request(new AbortController().signal,2000,signal=>fetcher(`${endpoint}/v1/session/revoke`,{
      method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':connection.token},body:'{}',signal,
    })),
    health:(signal:AbortSignal)=>request(signal,2500,async signal=>{
      const response=await fetcher(`${endpoint}/v1/health`,{cache:'no-store',signal});
      if(!response.ok)throw Error(`Companion 状态检查失败（HTTP ${response.status}）。`);
      const health=await response.json() as {serverVersion?:string;capabilities?:unknown[]};
      if(typeof health.serverVersion!=='string'||!health.serverVersion.startsWith('StudyLoopCompanion/'))throw Error('此端口响应的不是 Companion，请核对程序窗口中的端口。');
      return{version:health.serverVersion.slice('StudyLoopCompanion/'.length),capabilities:Array.isArray(health.capabilities)?health.capabilities.filter((value):value is string=>typeof value==='string'):[]};
    }),
    pair:(input:{user:StudyIdentity;code:string},signal:AbortSignal)=>request(signal,10000,async signal=>{
      const response=await fetcher(`${endpoint}/v1/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:input.code.trim(),userId:input.user.userId,displayName:input.user.displayName}),signal});
      const payload=await response.json() as {sessionToken?:string;accountLabel?:string;message?:string};
      if(!response.ok||!payload.sessionToken)throw Error(payload.message||'配对失败');
      return{token:payload.sessionToken,accountLabel:payload.accountLabel||input.user.email,baseUrl:endpoint} satisfies PairedCompanion;
    }),
    source:(connection:PairedCompanion,kind:'refresh'|'poll',signal:AbortSignal)=>request(signal,50000,async signal=>{
      const response=await fetcher(`${endpoint}/v1/${kind==='refresh'?'refresh':'study-data'}`,{...(kind==='refresh'?{method:'POST',body:'{}'}:{}),headers:{...(kind==='refresh'?{'Content-Type':'application/json'}:{}),'X-Study-Loop-Session':connection.token},signal});
      return{ok:response.ok,httpStatus:response.status,payload:await response.json() as Source};
    }),
  };
}
