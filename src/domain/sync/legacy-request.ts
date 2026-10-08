import type { CloudFSRSData, CloudProgress } from '../evidence';
import type { CloudLearningEvent } from './cloud-contracts';
const allowedKinds = new Set(["word", "python", "due", "activity"]);
const allowedEventTypes = new Set(["set-stage", "python-result", "due-result", "activity"]);
const allowedDomains = new Set(["ielts", "python", "differential-review"]);
const allowedOutcomes = new Set(["completed", "needs-review"]);
export function safeText(value: unknown, maxLength: number) {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
        return null;
    const hasControlCharacter = Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
    });
    return hasControlCharacter ? null : value;
}
export function parseEvent(value: unknown): CloudLearningEvent | null {
    if (!value || typeof value !== "object")
        return null;
    const input = value as Record<string, unknown>;
    const eventId = safeText(input.eventId, 160);
    const itemKey = safeText(input.itemKey, 256);
    const occurredAt = safeText(input.occurredAt, 40);
    if (!eventId || !itemKey || !occurredAt)
        return null;
    if (!/^[A-Za-z0-9._:-]+$/.test(eventId))
        return null;
    if (!allowedDomains.has(String(input.domain)) || !allowedKinds.has(String(input.itemKind)) || !allowedEventTypes.has(String(input.eventType)) || !allowedOutcomes.has(String(input.outcome)))
        return null;
    const occurredDate = new Date(occurredAt);
    if (Number.isNaN(occurredDate.valueOf()))
        return null;
    const numericValue = input.numericValue === undefined ? undefined : Number(input.numericValue);
    const answeredDelta = input.answeredDelta === undefined ? 0 : Number(input.answeredDelta);
    const correctDelta = input.correctDelta === undefined ? 0 : Number(input.correctDelta);
    if (numericValue !== undefined && (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 3))
        return null;
    if (![0, 1].includes(answeredDelta) || ![0, 1].includes(correctDelta) || correctDelta > answeredDelta)
        return null;
    return {
        eventId,
        domain: input.domain as CloudLearningEvent["domain"],
        itemKind: input.itemKind as CloudLearningEvent["itemKind"],
        itemKey,
        eventType: input.eventType as CloudLearningEvent["eventType"],
        outcome: input.outcome as CloudLearningEvent["outcome"],
        numericValue,
        answeredDelta,
        correctDelta,
        occurredAt: occurredDate.toISOString(),
    };
}
export function parseCloudFSRSData(value: unknown): CloudFSRSData | null {
    const fsrs = value as Record<string, unknown> | null;
    if (!fsrs || typeof fsrs !== "object" || Array.isArray(fsrs))
        return null;
    const due = safeText(fsrs.due, 40);
    const stability = Number(fsrs.stability);
    const difficulty = Number(fsrs.difficulty);
    const elapsed_days = Number(fsrs.elapsed_days);
    const scheduled_days = Number(fsrs.scheduled_days);
    const learning_steps = Number(fsrs.learning_steps);
    const reps = Number(fsrs.reps);
    const lapses = Number(fsrs.lapses);
    const state = Number(fsrs.state);
    if (!due)
        return null;
    if (Number.isNaN(new Date(due).valueOf()))
        return null;
    for (const number of [stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state]) {
        if (!Number.isFinite(number))
            return null;
    }
    if (![0, 1, 2, 3].includes(state))
        return null;
    return {
        due,
        stability,
        difficulty,
        elapsed_days,
        scheduled_days,
        learning_steps,
        reps,
        lapses,
        state: state as 0 | 1 | 2 | 3,
        ...(fsrs.last_review === undefined ? {} : { last_review: String(fsrs.last_review) }),
    };
}
export function parseProgress(value: unknown): CloudProgress | null {
    if (!value || typeof value !== "object")
        return null;
    const input = value as Record<string, unknown>;
    if (!input.itemStages || typeof input.itemStages !== "object" || Array.isArray(input.itemStages))
        return null;
    const answered = Number(input.answered);
    const correct = Number(input.correct);
    if (!Number.isInteger(answered) || !Number.isInteger(correct) || answered < 0 || correct < 0 || correct > answered)
        return null;
    const itemStages: Record<string, number> = {};
    for (const [key, value] of Object.entries(input.itemStages as Record<string, unknown>)) {
        const stage = Number(value);
        if (!key || key.length > 256 || isNaN(stage) || stage < 0)
            return null;
        itemStages[key] = stage;
    }
    const fsrsData: Record<string, CloudFSRSData> = {};
    if (input.fsrsData !== undefined) {
        if (!input.fsrsData || typeof input.fsrsData !== "object" || Array.isArray(input.fsrsData))
            return null;
        for (const [key, value] of Object.entries(input.fsrsData as Record<string, unknown>)) {
            if (!key || key.length > 256)
                return null;
            const fsrs = parseCloudFSRSData(value);
            if (!fsrs)
                return null;
            fsrsData[key] = fsrs;
        }
    }
    return {
        itemStages,
        answered,
        correct,
        ...(Object.keys(fsrsData).length === 0 ? {} : { fsrsData }),
    };
}
