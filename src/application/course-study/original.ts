import type { CourseEvidenceOriginalPort } from './ports';
import type { StudyStorePort } from '../account-study';
import type { LearningAttemptStorePort } from '../learning-attempt';

/** An old complete published snapshot is valid; the current head is never substituted. */
export function courseEvidenceOriginal(study: StudyStorePort, attempts: LearningAttemptStorePort): CourseEvidenceOriginalPort {
    return {
        readAttempt: (scope, id) => attempts.read(scope, id),
        async readItem(scope, binding) {
            if (binding.ownerId !== scope.userId || binding.libraryId !== scope.libraryId) return null;
            const [item, snapshot] = await Promise.all([
                study.getSnapshotItem(scope, binding.snapshotId, binding.itemKey), study.getSnapshot(scope, binding.snapshotId),
            ]);
            if (!item || !snapshot || snapshot.libraryId !== scope.libraryId || snapshot.snapshotId !== binding.snapshotId
                || item.itemKey !== binding.itemKey || item.contentHash !== binding.contentHash
                || !snapshot.items.some(member => member.itemKey === item.itemKey && member.contentHash === item.contentHash)) return null;
            return item;
        },
    };
}
