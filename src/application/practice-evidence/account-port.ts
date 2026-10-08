import type {AttemptBinding, LearningAttempt} from '../../domain/learning-attempt';
import type {PracticeEvidenceMutationV1, PracticeEvidenceReceipt, PracticeEvidenceV1} from '../../domain/practice-evidence';
import type {MathVariantMappingV1} from '../../domain/guided-math';
export type AccountPracticeEvidenceScope = {userId:string; libraryId:string};
export type PracticeEvidencePage = {records:PracticeEvidenceV1[]; nextCursor:string|null; complete:boolean};
export interface AccountPracticeEvidenceStorePort {
    supported():Promise<boolean>;
    read(scope:AccountPracticeEvidenceScope, attemptId:string):Promise<PracticeEvidenceV1|null>;
    list(scope:AccountPracticeEvidenceScope, page?:{cursor?:string;limit?:number}):Promise<PracticeEvidencePage>;
    mutate(scope:AccountPracticeEvidenceScope, mutation:PracticeEvidenceMutationV1):Promise<PracticeEvidenceReceipt>;
    trustedWriter():{mutate(scope:AccountPracticeEvidenceScope, mutation:PracticeEvidenceMutationV1):Promise<PracticeEvidenceReceipt>};
}
/** Immutable original source is resolved by the existing published-snapshot adapter. */
export interface AccountPracticeEvidenceOriginalPort {
    readAttempt(scope:AccountPracticeEvidenceScope, id:string):Promise<LearningAttempt|null>;
    readItem(scope:AccountPracticeEvidenceScope, binding:AttemptBinding):Promise<{
        itemKey:string;contentHash:string;learningSupport?:unknown;practice?:{questionType?:string};
    }|null>;
}
/** Explicit approved mapping authority; no heuristic topic matching. */
export interface AccountPracticeEvidenceMappingPort {
    resolveMapping(scope:AccountPracticeEvidenceScope, binding:AttemptBinding):Promise<MathVariantMappingV1|null>;
}
