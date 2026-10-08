import type {StudyIdentity,CompanionSourcePayload} from '../../domain/sources';
// @ts-expect-error TS5097: standalone Node source contracts.
import {COMPANION_READ_MESSAGES,usableCompanionSource} from '../../domain/sources/index.ts';
export type CompanionOperation='detect'|'pair'|'refresh'|'poll';
export type CompanionFrame<Connection>={key:string;connection:Connection|null;current:()=>boolean;user:StudyIdentity|null;code:string;account:()=>boolean};
export type CompanionNotice<Connection,Source>=
  |{kind:'detect-start'}|{kind:'pair-start'}
  |{kind:'detected';version:string;capabilities:string[];paired:boolean}
  |{kind:'paired';connection:Connection}
  |{kind:'expired'}
  |{kind:'source';payload:Source;message:string;background:boolean}
  |{kind:'error';operation:CompanionOperation;message:string;online?:boolean}
  |{kind:'message';message:string};
export type CompanionPorts<Connection,Source extends CompanionSourcePayload>={
  capture:()=>CompanionFrame<Connection>;
  health:(frame:CompanionFrame<Connection>,signal:AbortSignal)=>Promise<{version:string;capabilities:string[]}>;
  pair:(frame:CompanionFrame<Connection>,signal:AbortSignal)=>Promise<Connection>;
  source:(frame:CompanionFrame<Connection>,kind:'refresh'|'poll',signal:AbortSignal)=>Promise<{ok:boolean;httpStatus:number;payload:Source}>;
  publish:(notice:CompanionNotice<Connection,Source>)=>void;apply:(source:Source,frame:CompanionFrame<Connection>)=>boolean;
  flushActivities:()=>Promise<unknown>;busy:(kind:CompanionOperation,value:boolean)=>void;abort:()=>{signal:AbortSignal;abort:()=>void};
};

/** Manual connection intent supersedes older work; a background poll never supersedes that intent. */
export function createCompanionSession<Connection,Source extends CompanionSourcePayload>(ports:CompanionPorts<Connection,Source>){
  type Job={kind:CompanionOperation;frame:CompanionFrame<Connection>;control:ReturnType<typeof ports.abort>;promise:Promise<boolean>};
  let active:Job|null=null,disposed=false;
  const current=(job:Job)=>!disposed&&active===job&&!job.control.signal.aborted&&job.frame.current();
  const cancel=()=>{const old=active;active=null;if(old){old.control.abort();if(old.frame.current())ports.busy(old.kind,false);}};
  const publish=(job:Job,notice:CompanionNotice<Connection,Source>)=>{if(current(job))ports.publish(notice);};
  const run=(kind:CompanionOperation,work:(job:Job)=>Promise<boolean>):Promise<boolean>=>{
    if(disposed)return Promise.resolve(false);
    if(kind==='poll'&&active&&current(active))return active.promise;
    const frame=ports.capture();if(!frame.current())return Promise.resolve(false);
    cancel();const job:Job={kind,frame,control:ports.abort(),promise:Promise.resolve(false)};active=job;ports.busy(kind,true);
    job.promise=Promise.resolve().then(()=>current(job)?work(job):false).finally(()=>{if(active===job){active=null;if(job.frame.current())ports.busy(kind,false);}});
    return job.promise;
  };
  const read=(kind:'refresh'|'poll')=>run(kind,async job=>{
    if(!job.frame.connection){if(kind==='refresh')publish(job,{kind:'message',message:'请先登录并配对本机 Companion。'});return false;}
    try{
      const response=await ports.source(job.frame,kind,job.control.signal);if(!current(job))return false;
      if(response.httpStatus===401){publish(job,{kind:'expired'});return false;}
      if(!response.ok){publish(job,{kind:'error',operation:kind,online:true,message:response.payload.message||`Companion 已启动，但${kind==='refresh'?'刷新':'读取'}学习资料失败。`});return false;}
      const payload=response.payload,account=job.frame.account();
      if(usableCompanionSource(payload)&&!account){ports.apply(payload,job.frame);if(kind==='poll')void ports.flushActivities();}
      const message=kind==='poll'
        ?account?COMPANION_READ_MESSAGES.account:usableCompanionSource(payload)?payload.status==='connected'?COMPANION_READ_MESSAGES.local:payload.message||COMPANION_READ_MESSAGES.status:payload.message||'Companion 已连接，但没有返回可用的学习内容。'
        :account?'本机资料已刷新；账号题库会单独更新。':payload.status==='connected'?'学习资料已同步。':payload.message||'Companion 已连接，但资料尚未生成完成。';
      publish(job,{kind:'source',payload,message,background:kind==='poll'&&(account||usableCompanionSource(payload))});return true;
    }catch{
      publish(job,{kind:'error',operation:kind,message:kind==='poll'?COMPANION_READ_MESSAGES.failed:'无法访问本机 Companion；请确认窗口仍在运行后重试。'});return false;
    }
  });
  return {
    poll:()=>read('poll'),refresh:()=>read('refresh'),
    detect:()=>run('detect',async job=>{
      publish(job,{kind:'detect-start'});
      try{const health=await ports.health(job.frame,job.control.signal);if(!current(job))return false;publish(job,{kind:'detected',...health,paired:Boolean(job.frame.connection)});return true;}
      catch(error){publish(job,{kind:'error',operation:'detect',message:error instanceof TypeError||error instanceof Error&&error.name==='TimeoutError'
        ?'网页暂时无法访问本机 Companion，尚不能判断程序是否未运行。请检查窗口、端口和浏览器本地网络权限，按下方排查步骤继续。'
        :error instanceof Error?error.message:'本机状态检查未完成。'});return false;}
    }),
    pair:()=>run('pair',async job=>{
      if(!job.frame.user){publish(job,{kind:'message',message:'请先登录，再把本机 Companion 绑定到这个账号。'});return false;}
      if(!job.frame.code.trim()){publish(job,{kind:'message',message:'请输入 Companion 窗口显示的一次性配对码。'});return false;}
      publish(job,{kind:'pair-start'});
      try{const connection=await ports.pair(job.frame,job.control.signal);if(!current(job))return false;publish(job,{kind:'paired',connection});return true;}
      catch(error){publish(job,{kind:'error',operation:'pair',message:error instanceof TypeError?'网页无法访问本机 Companion，请先检测连接并检查浏览器本地网络权限。':error instanceof Error?error.message:'无法连接本机 Companion。'});return false;}
    }),
    cancel,
    dispose(){cancel();disposed=true;},
  };
}
