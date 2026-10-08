import type { LearningAttempt } from '../../domain/learning-attempt';
export type OriginalOfficialEvidence = {
    eventId: string;
    itemKey: string;
    contentHash: string;
    reviewedAt: string;
    rating: string;
    coreHash: string;
    snapshotId: string;
};
/** A historical assessment cannot silently replace a later official outcome. */
export function assertPendingCanPublish(attempt: LearningAttempt, records: readonly OriginalOfficialEvidence[]) {
    if (!attempt.submitted || attempt.parentAttemptId || attempt.checkpoint.purpose !== 'first')
        throw Error('这份作答不是可恢复的首轮记录。');
    const related = records.filter(record => record.itemKey === attempt.binding.itemKey && record.contentHash === attempt.binding.contentHash);
    const own = attempt.formal ? related.find(record => record.eventId === attempt.formal!.eventId) : undefined;
    if (own) {
        if (own.snapshotId !== attempt.binding.snapshotId || own.reviewedAt !== attempt.formal!.occurredAt || own.rating !== attempt.formal!.rating)
            throw Error('已有正式结果与原作答冲突，尚未覆盖或重复评分。');
        return own;
    }
    if (records.filter(record => record.itemKey === attempt.binding.itemKey).some(record => Date.parse(record.reviewedAt) > Date.parse(attempt.submitted!.submittedAt)))
        throw Error('原题已有更新的正式作答；旧答案保留，需核对记录，尚未覆盖新的结果。');
    return null;
}
