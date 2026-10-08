import type {CodeRunReportV1} from '../../domain/code-execution';
import type {PracticeEvidenceV1,PreparedPracticeEvidenceChild,PracticeEvidenceHint,PracticeVariantRecoveryV1} from '../../domain/practice-evidence';
import type {CalculationSupport} from '../../domain/content';
import type {MathStudyResultV1} from '../math-study';
import type {MathVariant} from '../../domain/guided-math';

export interface CalculationLearningPort{
    readonly support?:CalculationSupport;
    readonly sourceLabel?:string;
    evaluate(mode:'final'|'step',signal?:AbortSignal):Promise<MathStudyResultV1>;
    activeVariant?():MathVariant|null;
    readonly canVariant?:boolean;
    getVariant?(seed:number,signal?:AbortSignal):Promise<{variant:MathVariant;descriptor:PracticeVariantRecoveryV1}|null>;
    prepareVariant?(descriptor:PracticeVariantRecoveryV1):Promise<void>;
}

/** Learner intents only; adapters own source resolution, storage and synchronization. */
export interface PracticeLearningPort{
    readonly calculation?:CalculationLearningPort;
    snapshot():PracticeEvidenceV1|null;
    refresh():Promise<void>;
    recordPrepared(pointer:PreparedPracticeEvidenceChild):Promise<void>;
    recordCodeReport(report:CodeRunReportV1,output?:string):Promise<void>;
    codeFeedback():Promise<{first?:CodeRunReportV1;latest?:CodeRunReportV1;output?:string;hint?:PracticeEvidenceHint;
        firstState?:{status:'pending'|'correct'|'incorrect'|'forgotten';explanation:string}}>;
    recordCodeHint(hint:PracticeEvidenceHint):Promise<void>;
    requestCodeHint?:(report:CodeRunReportV1)=>Promise<string>;
    saveStep(text:string):Promise<void>;
    stageStep?:(text:string)=>void;
    flush?:()=>Promise<void>;
    beforeSubmit?:()=>Promise<void>;
    status():Promise<string>;
}
