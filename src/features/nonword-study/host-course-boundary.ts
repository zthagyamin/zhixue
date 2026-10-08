import type {FSRSRating} from '../../domain/assessment';
import {prepareAttemptEvidence} from '../../domain/assessment';
import {canonicalAttemptJson} from '../../domain/learning-attempt';
import {courseTaskHash, courseDiagnosticHash} from '../../domain/course-study';
import type {HostDriver, HostDraft, HostProps} from './host-contracts';

/** A course result must already be durable; legacy rating intents cannot create one. */
export async function requireCourseFeedback(driver: HostDriver): Promise<void> {
    if (!driver.course) return;
    const attempt = driver.runtime.session.snapshot(), evidence = driver.course.evidence();
    if (!attempt?.submitted || attempt.evaluation.status !== 'resolved' || !evidence?.diagnostic
        || evidence.diagnostic.status === 'undetermined' || evidence.attemptId !== attempt.attemptId
        || evidence.answerRevision !== attempt.submitted.answerRevision
        || evidence.taskId !== driver.course.task.taskId
        || canonicalAttemptJson(evidence.binding) !== canonicalAttemptJson(attempt.binding)
        || evidence.attemptEvaluationHash !== attempt.evaluation.evaluationHash
        || evidence.taskHash !== await courseTaskHash(driver.course.task)
        || evidence.diagnosticHash !== await courseDiagnosticHash(evidence.diagnostic, evidence.trace))
        throw Error('本题还没有可靠核对结果，原答案已保留，不能生成成绩。');
}

export function hostFormalRating(props: Pick<HostProps, 'mode' | 'recallConfigured'>,
    driver: HostDriver, draft: HostDraft, rating: FSRSRating): FSRSRating {
    const evidence = prepareAttemptEvidence({rating, mode: props.mode,
        recallConfigured: props.recallConfigured && !driver.course}, draft);
    const level = driver.runtime.session.snapshot()?.submitted?.maxPreHintLevel;
    return props.mode === 'recall' && level !== undefined
        ? level >= 3 ? 'again' : level >= 2 && ['good', 'easy'].includes(evidence.rating) ? 'hard' : evidence.rating
        : evidence.rating;
}
