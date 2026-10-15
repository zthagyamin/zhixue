// @ts-expect-error TS5097: standalone Node source contracts.
import {accountSyncNotice,accountSyncError,type AccountSyncStatus,type AccountSyncNotice} from '../../domain/sources/index.ts';

export type AccountConnectionView={label:string;message:string;busy:boolean;replacement:boolean;grant:string|null;sync:AccountSyncNotice|null};
export type AccountConnectionPorts<Loaded>={
  current:()=>boolean;view:()=>AccountConnectionView;publish:(patch:Partial<AccountConnectionView>)=>void;now:()=>number;
  status:()=>Promise<AccountSyncStatus>;
  prepare:(label:string,options:{replaceLibrary:boolean;rotateGrant:boolean})=>Promise<{grantId:string}>;
  start:(id:string)=>Promise<unknown>;stop:(id:string)=>Promise<unknown>;read:(kind:'refresh'|'rebuild'|'adopt')=>Promise<Loaded|null>;
  count:(value:Loaded)=>number;replacementRequired:(error:unknown)=>boolean;
  loaded?:(value:Loaded|null)=>void;
};
export function createAccountConnection<Loaded>(ports:AccountConnectionPorts<Loaded>){
  let disposed=false,busy=false,revision=0,statusRevision=0;
  const current=()=>!disposed&&ports.current();
  const publish=(patch:Partial<AccountConnectionView>)=>{if(current())ports.publish(patch);};
  const read=async(kind:'refresh'|'rebuild'|'adopt',valid:()=>boolean)=>{
    const value=await ports.read(kind);if(!valid())return null;if(kind==='refresh')ports.loaded?.(value);
    publish({message:value?`已读取 ${ports.count(value)} 个账号题目。`:''});return value;
  };
  const readAfterSync=async(valid:()=>boolean)=>{
    try{await read('refresh',valid);}
    catch(error){if(valid()&&!(error instanceof Error&&error.name==='AbortError'))publish({message:accountSyncError(error).message});}
  };
  const status=async(valid:()=>boolean=current)=>{
    const expected=revision,ticket=++statusRevision;
    const accepted=()=>valid()&&current()&&expected===revision&&ticket===statusRevision;
    try{
      const value=await ports.status();if(!accepted())return;
      const links=[...value.links].reverse(),link=links.find(item=>['active','paused','prepared'].includes(item.state))??links[0]??null;
      publish({grant:link?.grantId??null,...(link&&link.grantId!==ports.view().grant?{label:link.label}:{}),sync:accountSyncNotice(link,ports.now())});
    }catch(error){
      if(!accepted()||error instanceof Error&&error.name==='AbortError')return;
      publish({sync:accountSyncError(error)});
    }
  };
  const run=async(operation:(valid:()=>boolean)=>Promise<unknown>,changesSync=false)=>{
    if(!current()||busy)return;
    busy=true;const ticket=++revision,valid=()=>current()&&revision===ticket;publish({busy:true,message:''});
    let failure:unknown,failed=false;
    try{await operation(valid);}
    catch(error){failure=error;failed=true;}
    finally{
      if(valid())await status(valid);
      if(valid()){
        if(failed&&!(failure instanceof Error&&failure.name==='AbortError')){
          if(ports.replacementRequired(failure))publish({replacement:true,message:'账号已关联另一学习库，请先确认是否切换。'});
          else{
            const notice=accountSyncError(failure);
            publish({message:changesSync?'':notice.message,...(changesSync?{sync:notice}:{})});
          }
        }
        busy=false;publish({busy:false});
      }
    }
  };
  return{
    status,
    refresh:()=>run(valid=>read('refresh',valid)),rebuild:()=>run(valid=>read('rebuild',valid)),adopt:()=>run(valid=>read('adopt',valid)),
    prepare:(replaceLibrary=false,rotateGrant=false)=>run(async valid=>{
      const value=await ports.prepare(ports.view().label,{replaceLibrary,rotateGrant});if(!valid())return;
      publish({grant:value.grantId});await ports.start(value.grantId);if(!valid())return;
      publish({replacement:false});await readAfterSync(valid);
    },true),
    resume:()=>run(async valid=>{
      const {grant,sync}=ports.view();if(!grant||sync?.action!=='resume')return;
      await ports.start(grant);if(!valid())return;
      await readAfterSync(valid);
    },true),
    stop:()=>run(async valid=>{
      const grant=ports.view().grant;if(!grant)return;
      await ports.stop(grant);if(valid())publish({message:'停止请求已提交，待同步记录保留。'});
    },true),
    cancel(){revision++;statusRevision++;busy=false;publish({busy:false});},
    dispose(){disposed=true;statusRevision++;},
  };
}
