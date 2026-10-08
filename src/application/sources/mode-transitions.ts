export type SourceTransitionFrame<Connection>={owner:string;connection:Connection|null;accountReady?:boolean;current:()=>boolean;pending:()=>boolean;buffers:()=>boolean;draftVersion:()=>unknown};
export type SourceTransitionPorts<Connection,Local,Account>={
  capture:()=>SourceTransitionFrame<Connection>;confirm:(message:string)=>boolean;begin:()=>void;
  readLocal:(frame:SourceTransitionFrame<Connection>)=>Promise<Local>;
  adoptAccount:(frame:SourceTransitionFrame<Connection>)=>Promise<void|(()=>unknown)>;
  clearDrafts:(frame:SourceTransitionFrame<Connection>)=>void;
  commitLocal:(source:Local,frame:SourceTransitionFrame<Connection>)=>void;commitAccount:(frame:SourceTransitionFrame<Connection>)=>void;
  reloadAccount:(frame:SourceTransitionFrame<Connection>)=>Promise<Account|null>;message:(message:string)=>void;busy:(value:boolean)=>void;
};

/** A source is prepared before any input is cleared; new work during that wait invalidates the old consent. */
export function createSourceTransitions<Connection,Local,Account>(ports:SourceTransitionPorts<Connection,Local,Account>){
  type Job={kind:'local'|'account';frame:SourceTransitionFrame<Connection>;promise:Promise<unknown>};
  let active:Job|null=null,disposed=false;
  const valid=(job:Job)=>!disposed&&active===job&&job.frame.current();
  const message=(frame:SourceTransitionFrame<Connection>,value:string)=>{if(!disposed&&frame.current())ports.message(value);};
  const release=(job:Job)=>{if(active===job){active=null;if(job.frame.current())ports.busy(false);}};
  const run=<Result>(kind:Job['kind'],initial:SourceTransitionFrame<Connection>,work:(job:Job,version:unknown)=>Promise<Result>):Promise<Result|null>=>{
    if(disposed||!initial.current())return Promise.resolve(null);
    const version=initial.draftVersion(),job:Job={kind,frame:initial,promise:Promise.resolve(null)};active=job;ports.busy(true);ports.begin();job.frame=ports.capture();
    job.promise=Promise.resolve().then(()=>valid(job)?work(job,version):null).finally(()=>release(job));return job.promise as Promise<Result|null>;
  };
  const unchanged=(job:Job,version:unknown)=>{
    if(!valid(job))return false;
    if(job.frame.pending()||job.frame.draftVersion()!==version){message(job.frame,'当前作答或临时输入已变化，已保留原页面；请完成后再切换。');return false;}
    return true;
  };
  return {
    isBusy:()=>Boolean(active&&!disposed&&active.frame.current()),
    async switchLocal():Promise<boolean>{
      if(active&&active.frame.current())return active.kind==='local'?Boolean(await active.promise):false;
      const frame=ports.capture();if(disposed||!frame.current())return false;
      if(frame.pending()){message(frame,'当前作答正在处理，完成后再切换学习空间。');return false;}
      if(frame.buffers()&&!ports.confirm('切换学习空间会清除当前页未提交的临时输入，不会删除已保存记录。继续吗？'))return false;
      if(!frame.connection){message(frame,'本机 Companion 未连接，已保留账号题面和账号传输；连接后才能原子切回本机模式。');return false;}
      return await run('local',frame,async(job,version)=>{
        try{
          const source=await ports.readLocal(job.frame);if(!unchanged(job,version))return false;
          ports.clearDrafts(job.frame);ports.commitLocal(source,job.frame);message(job.frame,'已切回本机 Companion 模式；账号后台队列仍保留。');return true;
        }catch{message(job.frame,'本机资料尚未完整读取，未替换当前题面；已有学习记录保留。');return false;}
      })??false;
    },
    async adoptAccount():Promise<Account|null>{
      if(active&&active.frame.current())return active.kind==='account'?await active.promise as Account|null:null;
      const frame=ports.capture();if(disposed||!frame.current())return null;
      if(frame.accountReady===false){message(frame,'请先确认账号，再切换学习库。');return null;}
      if(frame.pending()){message(frame,'当前作答正在处理，请完成后再切换学习库。');return null;}
      if(!ports.confirm('确认使用账号当前关联的学习库？旧库记录和进度保留，不自动合并到新库；当前页未提交的输入会清除。'))return null;
      return run('account',frame,async(job,version)=>{
        try{
          const commit=await ports.adoptAccount(job.frame);if(!unchanged(job,version))return null;commit?.();
          ports.clearDrafts(job.frame);ports.commitAccount(job.frame);release(job);
          return !disposed&&job.frame.current()?await ports.reloadAccount(job.frame):null;
        }catch(error){message(job.frame,error instanceof Error?error.message:'学习库尚未切换完成，原有记录保留。');return null;}
      });
    },
    dispose(){if(active)release(active);disposed=true;},
  };
}
