import type {LearningAttempt} from '../../domain/learning-attempt';

export class AttemptRevisionConflict extends Error {
    readonly code='attempt-revision-conflict';
    constructor(){super('另一设备已修改这份作答。当前输入已保留，请核对后恢复。');}
}
export function isAttemptRevisionConflict(error:unknown):boolean {
    return error instanceof Error && 'code' in error && error.code==='attempt-revision-conflict';
}
/** Only recovery fields and elapsed time may differ; learning evidence stays exact. */
export function pendingCheckpointCore(attempt:LearningAttempt){
    const checkpoint=attempt.checkpoint;
    return {schemaVersion:attempt.schemaVersion,attemptId:attempt.attemptId,binding:attempt.binding,
        parentAttemptId:attempt.parentAttemptId,answer:attempt.answer,answerRevision:attempt.answerRevision,
        startedAt:attempt.startedAt??null,submitted:attempt.submitted,evaluation:attempt.evaluation,formal:attempt.formal,
        checkpoint:{position:checkpoint.position,traversed:checkpoint.traversed,mode:checkpoint.mode??null,
            intent:checkpoint.intent??null,purpose:checkpoint.purpose??null,visited:checkpoint.visited??null,
            pending:checkpoint.pending??null,skipped:checkpoint.skipped??null,view:checkpoint.view??null,
            startActiveSeconds:checkpoint.startActiveSeconds??null}};
}
