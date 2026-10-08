import type {CalculationSupport} from '../content';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCalculationSupport} from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {numericEquivalent} from '../math/index.ts';

/** The caller must supply the immutable authoritative source reference, never learner input.
 * Legacy sources may opt into numeric-only comparison by having no authored support at all.
 * Invalid or explicitly unsupported source metadata never grants a fallback or inferred domain.
 */
export function resolveCalculationReferenceSupport(learningSupport:unknown,reference:unknown):CalculationSupport|null{
    if(learningSupport!==undefined){
        try{return parseCalculationSupport(learningSupport);}catch{return null;}
    }
    const numeric=typeof reference==='string'?reference:typeof reference==='number'&&Number.isFinite(reference)?String(reference):null;
    if(numeric===null||numericEquivalent(numeric,numeric,'0.000001')!==true)return null;
    return {schemaVersion:1,type:'calculation',mode:'numeric',variables:[],domain:'real',tolerance:'0.000001'};
}
