export type SourceChangesPorts<Change,Source>={
  current:()=>boolean;connected:()=>boolean;account:()=>boolean;
  list:()=>Promise<{changes:Change[];scannedAt?:string|null}>;scan:()=>Promise<{changes:Change[];scannedAt?:string|null}>;
  decide:(id:string,decision:'approved'|'rejected'|'later')=>Promise<unknown>;source:()=>Promise<Source>;
  apply:(source:Source)=>boolean;publish:(value:{changes:Change[];scannedAt?:string|null})=>void;
  loading:(value:boolean)=>void;deciding:(id:string|null)=>void;message:(message:string)=>void;scanError:(message:string)=>void;
};
export function createSourceChanges<Change,Source>(ports:SourceChangesPorts<Change,Source>){
  let disposed=false,reading=0,decisionBusy=false,decisionVersion=0,scanFlight:Promise<void>|null=null;
  const current=()=>!disposed&&ports.current();
  const read=(scan=false,afterDecision=false):Promise<void>=>{
    if(!current())return Promise.resolve();
    if(scanFlight)return afterDecision?scanFlight.then(()=>read(false,true)):scanFlight;
    if(decisionBusy&&!afterDecision)return Promise.resolve();
    if(!ports.connected()){if(scan)ports.message('请先连接 Companion，再扫描资料变更。');return Promise.resolve();}
    const ticket=++reading,version=decisionVersion;ports.loading(true);if(scan)ports.message('正在扫描资料变更…');
    const job=Promise.resolve().then(async()=>{
      try{const value=await(scan?ports.scan():ports.list());if(current()&&reading===ticket&&version===decisionVersion){ports.publish(value);if(scan)ports.message(value.changes.length?`发现 ${value.changes.length} 项资料变更，请核对后确认。`:'扫描完成，未发现需要确认的资料变更。');}}
      catch(error){if(scan&&current()&&reading===ticket&&version===decisionVersion)ports.scanError(error instanceof Error?error.message:'资料扫描失败。');}
    }).finally(()=>{if(scanFlight===job)scanFlight=null;if(current()&&reading===ticket)ports.loading(false);});
    if(scan)scanFlight=job;
    return job;
  };
  return{
    read:()=>read(),scan:()=>read(true),
    async decide(id:string,decision:'approved'|'rejected'|'later'){
      if(!current()||decisionBusy)return;
      if(!ports.connected()){ports.message('请先连接 Companion 后再审批资料变更。');return;}
      decisionBusy=true;decisionVersion++;ports.deciding(id);ports.message('');
      try{
        await ports.decide(id,decision);if(!current())return;
        let message=decision==='approved'?'资料已批准，已加入学习流。':decision==='rejected'?'已拒绝该资料变更。':'已将该资料变更留待稍后处理。';
        if(decision==='approved'){
          try{
            const value=await ports.source();if(!current())return;
            if(!ports.apply(value))message=ports.account()?'本机资料已批准；账号题库将在 Companion 发布后更新。':'资料已批准，离开当前练习后更新题面。';
          }catch{message='资料已批准，但学习池刷新失败；请点击立即同步资料重试。';}
        }
        if(!current())return;await read(false,true);if(current())ports.message(message);
      }catch(error){if(current())ports.message(error instanceof Error?error.message:'资料审批失败，请检查 Companion 后重试。');}
      finally{decisionBusy=false;if(current())ports.deciding(null);}
    },
    dispose(){disposed=true;reading++;},
  };
}
