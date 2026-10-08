export type SourceChangesPorts<Change,Source>={
  current:()=>boolean;connected:()=>boolean;account:()=>boolean;
  list:()=>Promise<{changes:Change[];scannedAt?:string|null}>;scan:()=>Promise<{changes:Change[];scannedAt?:string|null}>;
  decide:(id:string,decision:'approved'|'rejected'|'later')=>Promise<unknown>;source:()=>Promise<Source>;
  apply:(source:Source)=>boolean;publish:(value:{changes:Change[];scannedAt?:string|null})=>void;
  loading:(value:boolean)=>void;deciding:(id:string|null)=>void;message:(message:string)=>void;scanError:(message:string)=>void;
};
export function createSourceChanges<Change,Source>(ports:SourceChangesPorts<Change,Source>){
  let disposed=false,reading=0,decisionBusy=false;
  const current=()=>!disposed&&ports.current();
  const read=async(scan=false)=>{
    if(!current()||!ports.connected())return;const ticket=++reading;ports.loading(true);
    try{const value=await(scan?ports.scan():ports.list());if(current()&&reading===ticket)ports.publish(value);}
    catch(error){if(scan&&current()&&reading===ticket)ports.scanError(error instanceof Error?error.message:'资料扫描失败。');}
    finally{if(current()&&reading===ticket)ports.loading(false);}
  };
  return{
    read:()=>read(),scan:()=>read(true),
    async decide(id:string,decision:'approved'|'rejected'|'later'){
      if(!current()||decisionBusy)return;
      if(!ports.connected()){ports.message('请先连接 Companion 后再审批资料变更。');return;}
      decisionBusy=true;ports.deciding(id);ports.message('');
      try{
        await ports.decide(id,decision);if(!current())return;
        let message=decision==='approved'?'资料已批准，已加入学习流。':decision==='rejected'?'已拒绝该资料变更。':'已将该资料变更留待稍后处理。';
        if(decision==='approved'){
          try{
            const value=await ports.source();if(!current())return;
            if(!ports.apply(value))message=ports.account()?'本机资料已批准；账号题库将在 Companion 发布后更新。':'资料已批准，离开当前练习后更新题面。';
          }catch{message='资料已批准，但学习池刷新失败；请点击立即同步资料重试。';}
        }
        if(!current())return;await read();if(current())ports.message(message);
      }catch(error){if(current())ports.message(error instanceof Error?error.message:'资料审批失败，请检查 Companion 后重试。');}
      finally{decisionBusy=false;if(current())ports.deciding(null);}
    },
    dispose(){disposed=true;reading++;},
  };
}
