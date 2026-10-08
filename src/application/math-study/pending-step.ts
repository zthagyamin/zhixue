import type {LearningAttempt} from '../../domain/learning-attempt';
import type {StudyItemVersion,StudySnapshot} from '../../domain/sync';
import type {NativeMathCapture} from '../../domain/math-study';
import type {PracticeEvidenceV1,PracticeEvidenceDiagnostic} from '../../domain/practice-evidence';
/** Read-only projection of one owned saved original and its optional step. */
export type PendingMathStep = {
    original: {
        attempt:LearningAttempt;
        item:StudyItemVersion|null;
        snapshot?:StudySnapshot;
        nativeMathCapture?:NativeMathCapture;
        referenceVerified:boolean;
        resumable:boolean;
        capability:'complete'|'item-only'|'reference-unavailable'|'conflict'|'not-nonword';
        notice:string;
    };
    evidence:PracticeEvidenceV1;
    title:string;
    sourceLabel:string;
    prompt:string;
    stepPrompt:string;
    stepText:string;
    diagnostic?:PracticeEvidenceDiagnostic;
    canEvaluate:boolean;
    notice:string;
};
export type PendingMathStepPage = {rows:PendingMathStep[];complete:boolean;notice:string};
/** Explicit evaluation has no grade, event or scheduling capability. */
export type PendingMathStepPort = {
    list():Promise<PendingMathStepPage>;
    load(id:string):Promise<PendingMathStep|null>;
    evaluate(row:PendingMathStep,signal?:AbortSignal):Promise<PracticeEvidenceDiagnostic|null>;
};
