/** Page-local retry cursor. A successful write is not repeated after a later write fails. */
export function createRestartBatch<T>(items:readonly T[]){
 let running=false,completed=0;
 return {get completed(){return completed;},get total(){return items.length;},get running(){return running;},
  async run(apply:(item:T)=>Promise<void>,isCurrent:()=>boolean){
   if(running)return 'busy' as const;
   running=true;
   try{while(completed<items.length){if(!isCurrent())return 'stale' as const;await apply(items[completed]);completed++;}return isCurrent()?'complete' as const:'stale' as const;}
   finally{running=false;}
  }
 };
}
