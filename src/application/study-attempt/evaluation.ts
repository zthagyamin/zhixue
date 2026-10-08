const aborted=()=>Object.assign(new Error('本次判定已停止。'),{name:'AbortError'});
/** Shared evaluation lock; invalidation revokes the old lock generation while preserving legacy return values. */
export function createStudyEvaluation(ports:{blocked:()=>boolean;notify:()=>void}){
    let busy=false,generation=0;
    const notify=()=>{try{ports.notify();}catch{/* Presentation cannot own the lock. */}};
    return {
        isBusy:()=>busy,
        invalidate(notifyChange=true){generation++;busy=false;if(notifyChange)notify();},
        async run<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
            if(signal?.aborted)throw aborted();
            if(busy||ports.blocked())throw Error('上一份作答正在处理，请稍候。');
            const run=++generation;busy=true;notify();let cancel:()=>void=()=>{};
            try{
                const cancellation=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(aborted());signal?.addEventListener('abort',cancel,{once:true});});
                return await (signal?Promise.race([operation(),cancellation]):operation());
            }finally{
                signal?.removeEventListener('abort',cancel);
                if(run===generation){busy=false;notify();}
            }
        },
    };
}
