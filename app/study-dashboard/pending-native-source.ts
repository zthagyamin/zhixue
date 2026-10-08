import type { LearningAttempt } from '../../src/domain/learning-attempt';
import type { StudySubmissionFrame } from '../study-submission';
import type { PluginType } from '../plugin-routing';
/** Only the still-matching registered native source can supply its original association. */
export function nativeOriginalFrame<T extends {
    contentHash?: string;
}>(attempt: LearningAttempt, input: {
    libraryId?: string | null;
    items: readonly T[];
    keyOf: (item: T) => string;
    capture: (item: T, mode: PluginType, stage: number) => StudySubmissionFrame;
}): StudySubmissionFrame | null {
    if (input.libraryId !== attempt.binding.libraryId)
        return null;
    const item = input.items.find(item => input.keyOf(item) === attempt.binding.itemKey && item.contentHash === attempt.binding.contentHash);
    if (!item)
        return null;
    const frame = input.capture(item, attempt.checkpoint.mode as PluginType, 0);
    return frame.kind === 'local' && frame.contentHash === attempt.binding.contentHash && Boolean(frame.localBindingHash) ? frame : null;
}
