import type {gradeCalculationReference} from './calculation-grade';
// @ts-expect-error TS2307: Vite emits a separate worker asset URL.
import workerUrl from './calculation-worker.ts?worker&url';
export function gradeCalculationInWorker(item:Parameters<typeof gradeCalculationReference>[0],answer:string,signal?:AbortSignal):Promise<ReturnType<typeof gradeCalculationReference>>{
 return new Promise(resolve=>{const cancelled={correct:null,verdict:'unknown',explanation:'已取消本次判题。'};if(signal?.aborted){resolve(cancelled);return;}let worker:Worker;try{worker=new Worker(workerUrl,{type:'module'});}catch{resolve({correct:null,verdict:'unknown',explanation:'判题暂不可用，请重试。'});return;}
 const cancel=()=>finish(cancelled);
 const finish=(result:ReturnType<typeof gradeCalculationReference>)=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);worker.terminate();resolve(result);};
 const timer=setTimeout(()=>finish({correct:null,verdict:'unknown',explanation:'计算超时，未记录评分。'}),2000);
 signal?.addEventListener('abort',cancel,{once:true});worker.onmessage=event=>finish(event.data);worker.onerror=()=>finish({correct:null,verdict:'unknown',explanation:'判题暂不可用，请重试。'});try{worker.postMessage({item,answer});}catch{finish({correct:null,verdict:'unknown',explanation:'题目暂不可读，请重试。'});}});
}
