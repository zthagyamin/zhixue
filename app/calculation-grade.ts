// @ts-expect-error TS5097: standalone Node contract tests.
import {parseCalculationSupport} from './calculation-support.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import {compareExpressions,numericEquivalent} from './symbolic-math.ts';
export function gradeCalculationReference(item:{answer?:unknown;learningSupport?:unknown},answer:string){
 const unknown={correct:null,verdict:'unknown',explanation:'暂不能可靠判定，原答案保留待核对。'};
 try{const support=item.learningSupport===undefined?undefined:parseCalculationSupport(item.learningSupport),expected=String(item.answer??'').trim();if(!expected||!answer.trim())return unknown;
  if(support?.mode==='symbolic'){
   const result=compareExpressions(answer,expected,support.variables);
   if(support.schemaVersion===2&&support.conditions?.length&&result.verdict==='wrong')return {...unknown,explanation:'当前内核不能核对这些附加条件下的表达式差异，原答案保留待核对。'};
   return result;
  }
  const correct=numericEquivalent(answer,expected,support?.tolerance??'0.000001');if(correct===null)return unknown;
  return{correct,verdict:correct?'correct':'wrong',explanation:correct?'答案一致。':`参考答案：${expected}`};
 }catch{return unknown;}
}
