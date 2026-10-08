import type {GradePayload,FSRSRating} from '../src/domain/assessment/index';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateRecallEvaluation,validateRecallModelEvaluation} from '../src/domain/assessment/index.ts';
// @ts-expect-error TS5097: compatibility entrypoint for existing callers.
export {recallReference} from '../src/domain/assessment/index.ts';
export function recallResultRating(result:GradePayload|null):FSRSRating|null{
  if(!result)return null;
  try{return (result.source==='ai'?validateRecallModelEvaluation:validateRecallEvaluation)({source:result.source,verdict:result.verdict,rating:result.rating,correct:result.correct}).rating;}catch{return null;}
}
/** Never promote the same forgotten response after the learner reads its reference. */
export function recallChosenRating(forgotten:boolean,selection:FSRSRating|null,result:GradePayload|null):FSRSRating|null{
  if(forgotten)return 'again';
  const suggested=result?.source==='ai'?recallResultRating(result):null;
  const rank={again:0,hard:1,good:2,easy:3};
  if(suggested&&selection&&rank[selection]>rank[suggested])return suggested;
  return selection??suggested;
}
/** A cancelled UI request must not keep the host's grading lock indefinitely. */
export function waitForRecallResult<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal?.aborted)return Promise.reject(new Error('recall-check-cancelled'));
  return new Promise<T>((resolve,reject)=>{
    const cancel=()=>{cleanup();reject(new Error('recall-check-cancelled'));};
    const cleanup=()=>signal?.removeEventListener('abort',cancel);
    signal?.addEventListener('abort',cancel,{once:true});
    Promise.resolve().then(()=>{if(signal?.aborted)throw new Error('recall-check-cancelled');return operation();}).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
