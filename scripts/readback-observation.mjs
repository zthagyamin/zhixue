/** QA-only readback observation. Await values and predicates; never treat a Promise as a receipt. */
export async function waitForReadback(read,accept,{
 timeoutMs=15000,intervalMs=25,label='Expected receipt',
 now=()=>performance.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
}={}){
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(intervalMs)||intervalMs<0)
  throw Error('Invalid readback observation deadline');
 const deadline=now()+timeoutMs,failed=()=>Error(label+' not observed before deadline');
 let stopped=false,timer;
 const observe=(async()=>{
  while(!stopped){
   if(now()>=deadline)throw failed();
   const value=await read();
   if(stopped||now()>=deadline)throw failed();
   const accepted=await accept(value);
   if(stopped||now()>=deadline)throw failed();
   if(accepted===true)return value;
   const remaining=deadline-now();
   if(remaining<=0)throw failed();
   await sleep(Math.min(intervalMs,remaining));
  }
  throw failed();
 })();
 try{
  return await Promise.race([observe,new Promise((_,reject)=>{
   timer=setTimeout(()=>{stopped=true;reject(failed());},timeoutMs);
  })]);
 }finally{stopped=true;clearTimeout(timer);}
}
