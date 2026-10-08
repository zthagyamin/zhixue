/** Bound optional external work even when a transport ignores AbortSignal. */
export async function withinDeadline<T>(operation:(signal:AbortSignal)=>Promise<T>,milliseconds:number):Promise<{status:'fulfilled';value:T}|{status:'rejected'}|{status:'timeout'}>{
 if(!Number.isFinite(milliseconds)||milliseconds<1)throw new Error('invalid-action-deadline');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const work=Promise.resolve().then(()=>operation(controller.signal)).then(value=>({status:'fulfilled' as const,value}),()=>({status:'rejected' as const}));
 try{return await Promise.race([work,new Promise<{status:'timeout'}>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:'timeout'});},milliseconds);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
