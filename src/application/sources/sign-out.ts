import type {MaintenanceFrame,RecoveryPack} from './maintenance';
// @ts-expect-error TS5097: standalone Node contracts.
import {recoveryPending} from './maintenance.ts';
export type SignOutPorts<Pack extends RecoveryPack>={
  capture:()=>MaintenanceFrame;prepareNavigation:()=>null|(()=>boolean);confirm:(message:string)=>boolean;
  export:(owner:string)=>Promise<Pack>;clearViews:(frame:MaintenanceFrame,value:Pack)=>Promise<void>;
  retire:()=>void;captureConnection:()=>{revoke:()=>Promise<unknown>;clear:()=>void};redirect:()=>void;
};
/** Logout is owner-scoped; offline Companion cannot prevent site logout. No history deletion exists here. */
export function createSignOut<Pack extends RecoveryPack>(ports:SignOutPorts<Pack>){
  let busy=false,disposed=false;
  return{
    async run(){
      if(busy||disposed)return;const leave=ports.prepareNavigation();if(!leave)return;
      const frame=ports.capture(),connection=ports.captureConnection(),current=()=>!disposed&&frame.current();if(!current())return;busy=true;
      try{
        if(frame.pending()&&!ports.confirm('还有正在判定或保存的作答。退出将放弃尚未完成的判定和临时输入；已保存记录不会删除。仍要退出吗？'))return;
        if(!frame.pending()&&frame.buffers()&&!ports.confirm('当前页还有尚未提交的输入，退出后不会保留。已保存的学习记录不受影响。仍要退出吗？'))return;
        const version=frame.version();
        try{
          if(frame.owner){
            const value=await ports.export(frame.owner);if(!current())return;
            if(recoveryPending(value)||frame.version()!==version||frame.pending()){
              if(!ports.confirm('还有待同步、待写回或待恢复的记录（包括辅助摘要）。退出后会保留全部本机数据；重新登录这个账号后可继续同步。仍要退出吗？'))return;
            }else if(ports.confirm('退出时是否同时清理可重建的读取视图？题库快照、学习记录、摘要、回执和规则仍保留。'))await ports.clearViews(frame,value);
          }
        }catch{if(current()&&!ports.confirm('暂时无法核对本机待同步状态；不会继续清理数据。仍要退出登录吗？'))return;}
        if(!current()||!leave())return;ports.retire();
        try{await connection.revoke();}catch{/* Local availability does not determine site authentication. */}
        if(!current())return;connection.clear();ports.redirect();
      }finally{busy=false;}
    },
    dispose(){disposed=true;},
  };
}
