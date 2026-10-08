// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyText,studyDigest,studyId} from '../sync/index.ts';
import type {StudyAIProvider} from './types';
export type QuestionAiRequest = {
    kind: 'hint' | 'tutor' | 'recall-grade';
    snapshotId: string;
    itemKey: string;
    contentHash: string;
    attemptId: string;
    input: string;
};

export type QuestionAiResult = {
    snapshotId: string;
    itemKey: string;
    contentHash: string;
    attemptId: string;
    text: string;
    trace: {
        provider?: StudyAIProvider;
        modelId: string;
        providerModel?: string;
        promptVersion: string;
        ruleVersion: string;
    };
    verdict?: 'correct' | 'partial' | 'incorrect' | 'self-assess';
    rating?: 'again' | 'hard' | 'good';
    usageTokens?: number;
    matchedPointIds?: string[];
    missedPointIds?: string[];
};

export function parseQuestionAiRequest(raw: unknown): QuestionAiRequest { const value = studyObject(raw, ['kind', 'snapshotId', 'itemKey', 'contentHash', 'attemptId', 'input']); if (!['hint', 'tutor', 'recall-grade'].includes(String(value.kind)))
    throw new Error('invalid-question-ai-kind'); studyId(value.snapshotId, 'snapshot'); studyId(value.itemKey, 'item'); studyDigest(value.contentHash); studyId(value.attemptId, 'attempt'); studyText(value.input, 'question-ai-input', 4000, true); if (value.kind !== 'hint' && !String(value.input).trim())
    throw new Error('invalid-question-ai-input'); return structuredClone(value) as QuestionAiRequest; }

export function accountStudyQuestionAiTrace(model: string) { return { modelId: model.trim(), promptVersion: 'question-ai-json-v2', ruleVersion: 'recall-evaluation-v1' }; }
