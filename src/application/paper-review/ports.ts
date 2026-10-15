import type {StudyAIContext,StudyAISettings} from '../../domain/ai';
import type {StudyAIService} from '../ai';

export type PaperReviewPrepared={
    prompt:string;
    context:StudyAIContext;
    truncated:boolean;
    notice:string;
};
export type PaperReviewState={
    status:'idle'|'confirmation-required'|'streaming';
    prompt:string;
    notice:string;
    text:string;
    message:string;
};
export type PaperReviewPorts={
    prepare:(action:string)=>PaperReviewPrepared;
    currentScope:()=>string|null;
    settings:()=>StudyAISettings|null;
    requestId:()=>string;
    ai?:Pick<StudyAIService,'chat'>;
};
