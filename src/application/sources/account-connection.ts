export type AccountConnectionView={label:string;message:string;busy:boolean;replacement:boolean;grant:string|null};
export type AccountConnectionPorts<Loaded>={
  current:()=>boolean;view:()=>AccountConnectionView;publish:(patch:Partial<AccountConnectionView>)=>void;
  status:()=>Promise<{links?:Array<{grantId:string;label:string;state:string;workerStatus:string}>}>;
  prepare:(label:string,options:{replaceLibrary:boolean;rotateGrant:boolean})=>Promise<{grantId:string}>;
  start:(id:string)=>Promise<unknown>;stop:(id:string)=>Promise<unknown>;read:(kind:'refresh'|'rebuild'|'adopt')=>Promise<Loaded|null>;
  count:(value:Loaded)=>number;replacementRequired:(error:unknown)=>boolean;
  loaded?:(value:Loaded|null)=>void;
};
export function createAccountConnection<Loaded>(ports:AccountConnectionPorts<Loaded>){
  let disposed=false,busy=false,revision=0;
  const current=()=>!disposed&&ports.current();
  const publish=(patch:Partial<AccountConnectionView>)=>{if(current())ports.publish(patch);};
  const read=async(kind:'refresh'|'rebuild'|'adopt',valid:()=>boolean)=>{
    const value=await ports.read(kind);if(!valid())return null;if(kind==='refresh')ports.loaded?.(value);
    publish({message:value?`已读取 ${ports.count(value)} 个账号题目；手机可以在电脑关闭时继续学习。`:''});return value;
  };
  const run=async(operation:(valid:()=>boolean)=>Promise<unknown>)=>{
    if(!current()||busy)return;busy=true;const ticket=++revision,valid=()=>current()&&revision===ticket;publish({busy:true});
    try{await operation(valid);}
    catch(error){if(!valid())return;if(ports.replacementRequired(error))publish({replacement:true,message:'云端已关联另一学习库。只有明确确认后才会切换，旧数据不会删除。'});
      else publish({message:error instanceof Error?error.message:'连接失败。'});}
    finally{if(valid()){busy=false;publish({busy:false});}}
  };
  return{
    async status(){
      const expected=revision;
      try{const value=await ports.status();if(!current()||expected!==revision)return;
        const link=[...(value.links??[])].reverse().find(item=>['active','paused','prepared'].includes(item.state));
        if(link)publish({grant:link.grantId,label:link.label,message:link.state==='active'?`后台同步${link.workerStatus==='stopped'?'将在 Companion 恢复后继续。':'正在运行。'}`:'已有本机授权，可继续启动或停止。'});
      }catch{/* A disconnected local helper leaves the account source readable. */}
    },
    refresh:()=>run(valid=>read('refresh',valid)),rebuild:()=>run(valid=>read('rebuild',valid)),adopt:()=>run(valid=>read('adopt',valid)),
    prepare:(replaceLibrary=false,rotateGrant=false)=>run(async valid=>{
      const value=await ports.prepare(ports.view().label,{replaceLibrary,rotateGrant});if(!valid())return;
      publish({grant:value.grantId});await ports.start(value.grantId);if(!valid())return;
      publish({replacement:false,message:'本机后台同步已授权，正在读取账号资料…'});await read('refresh',valid);
    }),
    stop:()=>run(async valid=>{const grant=ports.view().grant;if(!grant)return;await ports.stop(grant);if(valid())publish({message:'已停止本机后台同步；待写回记录仍保留，云端授权未被冒充撤销。'});}),
    cancel(){revision++;busy=false;publish({busy:false});},
    dispose(){disposed=true;},
  };
}
