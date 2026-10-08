import type {StudyIdentity,AccountLoadStatus} from '../../domain/sources';
// @ts-expect-error TS5097: standalone Node source contracts.
import {accountLoadError} from '../../domain/sources/index.ts';
const ACCOUNT_UNCONNECTED_CODES=new Set(['study-library-not-configured','account-study-disabled']);

export async function readAccountSource<Loaded>(input:{identity:StudyIdentity|null;local:boolean;signal?:AbortSignal;
  client:{cached:()=>Promise<Loaded|null>;load:(options:{signal?:AbortSignal})=>Promise<Loaded>};now:()=>string;
  onStatus:(value:AccountLoadStatus)=>void;apply:(value:Loaded,freshness:'cache'|'latest')=>Promise<boolean>;onIdentityChanged?:()=>void;
}):Promise<Loaded|null>{
  const {signal}=input;let hasCache=false;
  const publish=(value:AccountLoadStatus)=>{signal?.throwIfAborted();input.onStatus(value);};
  try{
    signal?.throwIfAborted();if(!input.identity){publish({phase:'guest'});return null;}if(input.local){publish({phase:'local'});return null;}
    publish({phase:'loading'});
    const cached=await input.client.cached();signal?.throwIfAborted();
    if(cached){hasCache=true;const applied=await input.apply(cached,'cache');signal?.throwIfAborted();publish({phase:'cached',hasCache:true,deferred:!applied});}
    const fresh=await input.client.load({signal});signal?.throwIfAborted();const applied=await input.apply(fresh,'latest');signal?.throwIfAborted();
    publish({phase:'ready',hasCache:true,deferred:!applied,checkedAt:input.now()});return fresh;
  }catch(error){
    if(signal?.aborted)return null;const code=error instanceof Error?error.message:'';
    if(code==='account-mismatch'||code==='authentication-required'){publish({phase:'identity-changed',message:accountLoadError(error)});input.onIdentityChanged?.();}
    else{
      const phase=ACCOUNT_UNCONNECTED_CODES.has(code)&&!hasCache?'not-connected':code==='account-library-changed'||code==='library-mismatch'?'library-changed':'failed';
      const message=code==='account-study-disabled'
        ?hasCache?'账号题库服务当前未启用，暂时无法读取最新变化；已保存的资料与作答仍保留。':'当前站点尚未启用账号题库，您正在使用公开示例进行体验。如需同步个人笔记，可在设置中选择接入本机资料。'
        :phase==='not-connected'?undefined:accountLoadError(error);
      publish({phase,hasCache,message});
    }
    return null;
  }
}