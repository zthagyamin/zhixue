"use client";
import { useEffect, useMemo, useRef } from 'react';
import type { LearningAttempt } from '../../src/domain/learning-attempt';
import type { NonWordPendingOriginal } from '../../src/infrastructure/nonword-study';
import type { StudyRecordEnvelope } from '../account-study-record';
import type { StudySubmissionFrame } from '../study-submission';
import type { StudySubmissionV1 } from '../study-submission-journal';
import type { FSRSRating, PluginContext, PluginGradeOptions } from '../plugins/registry';
import type { AssistanceObservation } from '../../src/domain/assessment';
import type { LocalStudyEventRecord } from '../local-study-events';
import type { StudyAttemptInput } from '../../src/application/study-attempt';
import { assertPendingCanPublish, type OriginalOfficialEvidence } from '../../src/application/nonword-study';
import { createSubjectGradeHandler } from '../../src/features/study-attempt';
import { createLearningDraftStore } from '../learning-draft-store';
import { LearningDraftBoundary, LearningDraftLeaveGuard } from '../learning-draft';
import { prepareAttemptEvidence } from '../../src/domain/assessment';
import { recordStudyAttempt } from '../study-event-controller';
import { updateStudyEventDelivery } from '../local-study-events';
import { registry } from '../plugins';
import { routableStudyItem } from '../account-study-content';
import { adaptStudyItemForPlugin, type PluginType } from '../plugin-routing';
import { StudyAIOfflineContext } from '../components/ai-sidebar/study-ai-workspace';
import { NonWordPluginHost } from './nonword-plugin-host';
import { gradeCalculationInWorker } from '../calculation-client';
import { originalQuestionService } from './original-question-service';
import { canonicalAttemptJson } from '../../src/domain/learning-attempt';
import { createLocalAttemptRepository } from '../../src/infrastructure/learning-attempt';
import type { NativeCourseTransport } from '../../src/application/course-study';
import type { NativeMathTransport } from '../../src/domain/math-study';
type Services = {
    workspaceId: string;
    ownerId: string;
    libraryId: string;
    cloud: boolean;
    current: () => boolean;
    records: () => StudyRecordEnvelope[];
    readAttempt?: (id: string) => Promise<LearningAttempt | null>;
    questionAi?: (request: {
        requestId: string;
        request: unknown;
    }) => Promise<Record<string, unknown>>;
    persist: (record: LocalStudyEventRecord, frame: StudySubmissionFrame, observation: AssistanceObservation | null) => Promise<StudySubmissionV1>;
    sendCloud: (payload: StudySubmissionV1) => Promise<unknown>;
    sendCompanion: (payload: StudySubmissionV1) => Promise<unknown>;
    changed: () => void;
    nativeFrame?: (attempt: LearningAttempt) => StudySubmissionFrame | null;
    nativeCourse?: NativeCourseTransport;
    nativeMath?: NativeMathTransport;
};
export type PendingReviewServices = Services;
function evidence(records: StudyRecordEnvelope[]): OriginalOfficialEvidence[] { return records.flatMap(record => record.provenanceMode !== 'task' && record.event.eventType === 'practice-attempt' ? [{ eventId: record.event.eventId, itemKey: record.event.item.key, contentHash: record.contentHash, snapshotId: record.snapshotId, reviewedAt: record.event.scheduling?.reviewedAt ?? record.event.occurredAt, rating: record.event.attempt.rating, coreHash: record.event.coreHash }] : []); }
/** A recovered answer uses its existing identity and the original event writer. */
export function PendingAttemptReview({ original, deviceId, services, onClose }: {
    original: NonWordPendingOriginal;
    deviceId: string;
    services: Services;
    onClose: () => void;
}) {
    const attempt = original.attempt, nativeCapture = !services.cloud ? original.nativeCapture : undefined, nativeMathCapture = !services.cloud ? original.nativeMathCapture : undefined;
    const item = nativeMathCapture?.item ?? nativeCapture?.item ?? original.item, mode = attempt.checkpoint.mode as PluginType;
    const drafts = useMemo(() => createLearningDraftStore(`reconcile:${attempt.attemptId}`), [attempt.attemptId]);
    const repository = useMemo(() => createLocalAttemptRepository({ userId: services.ownerId, libraryId: services.libraryId }), [services.ownerId, services.libraryId]);
    const draft = drafts.adapter(attempt.attemptId, mode), live = useRef(true);
    useEffect(() => { live.current = true; return () => { live.current = false; drafts.dispose(); }; }, [drafts]);
    const current = () => live.current && services.current();
    if (!original.resumable || !original.referenceVerified || !item || item.kind !== 'practice'
        || attempt.binding.ownerId !== services.ownerId || attempt.binding.libraryId !== services.libraryId
        || nativeCapture && (attempt.binding.snapshotId !== 'local' || nativeCapture.identity.libraryId !== services.libraryId
            || nativeCapture.identity.itemKey !== attempt.binding.itemKey || nativeCapture.identity.contentHash !== attempt.binding.contentHash
            || nativeCapture.item.practice.questionType !== mode)
        || nativeMathCapture && (attempt.binding.snapshotId !== 'local' || mode !== 'calculation'
            || nativeMathCapture.identity.libraryId !== services.libraryId || nativeMathCapture.identity.itemKey !== attempt.binding.itemKey
            || nativeMathCapture.identity.contentHash !== attempt.binding.contentHash))
        return <section role="status"><p>{original.notice || '原参考尚未可靠恢复，原答案已保留。'}</p><button onClick={onClose}>返回待核对列表</button></section>;
    // Native display fields are never portable publication or local writeback authority.
    const title = original.item?.title ?? item.itemKey.slice('practice:'.length);
    const sourceLabel = original.item?.kind === 'practice' ? original.item.practice.sourceLabel
        : nativeMathCapture?.item.practice.sourceLabel ?? nativeCapture?.item.learningSupport.task.sources.map(part => part.label).join(' · ') ?? '';
    const source = nativeMathCapture ? { id: item.itemKey.slice('practice:'.length), ...nativeMathCapture.item.practice, learningSupport: nativeMathCapture.item.learningSupport } : nativeCapture ? { id: item.itemKey.slice('practice:'.length), prompt: item.practice.prompt,
        learningSupport: item.learningSupport } : routableStudyItem(original.item!);
    const data = adaptStudyItemForPlugin(mode, source), plugin = registry.get<Record<string, unknown>>(`@zhixue/plugin-${mode}`);
    if (!data || !plugin)
        return <section role="status"><p>原题暂不能安全显示，原答案已保留。</p><button onClick={onClose}>返回待核对列表</button></section>;
    const scope = { workspaceId: services.workspaceId, ...attempt.binding, cloud: services.cloud,
        ...(nativeMathCapture ? { nativeMathIdentity: nativeMathCapture.identity, nativeMathCapture } : nativeCapture ? { nativeCourseIdentity: nativeCapture.identity, nativeCourseCapture: nativeCapture }
            : original.item && original.snapshot && (mode === 'calculation' || original.item.learningSupport?.schemaVersion === 2 && 'task' in original.item.learningSupport) ? { courseReference: { item: original.item, snapshot: original.snapshot } } : {}) };
    const request = !nativeCapture && !nativeMathCapture && services.questionAi ? originalQuestionService(services.workspaceId, attempt, services.questionAi) : null;
    const context: PluginContext = { guidanceScope: services.workspaceId, draft, nonWordScope: scope,
        ...(nativeCapture ? { nativeCourse: services.nativeCourse } : nativeMathCapture ? { nativeMath: services.nativeMath } : {}),
        contentSource: { mode: item.practice.questionType, data: { ...source, eventKind: item.eventKind, kind: item.kind, contentHash: item.contentHash } },
        nonWordNavigation: { continuePending: onClose, resumeFormal: () => { services.changed(); onClose(); } },
        gradeCalculation: (question, answer, signal) => gradeCalculationInWorker(question as Parameters<typeof gradeCalculationInWorker>[0], answer, signal),
        gradeRecall: request ? async (_, answer) => { const result = await request('recall-grade', answer); return { correct: result.verdict === 'correct', source: 'ai', verdict: result.verdict, rating: result.rating as 'again' | 'hard' | 'good', feedback: result.text, matchedPointIds: result.matchedPointIds, missedPointIds: result.missedPointIds }; } : undefined,
        requestAiHint: request ? (_, selected) => request('hint', selected ?? '').then(result => result.text) : undefined,
        askTutor: request ? question => request('tutor', question).then(result => result.text) : undefined };
    const grade = async (rating: FSRSRating, options?: PluginGradeOptions) => {
        if (!current())
            throw Error('资料库或用户已切换，原作答保留。');
        const latest = await (services.readAttempt?.(attempt.attemptId) ?? repository.read(attempt.attemptId));
        if (!current() || !latest || latest.attemptId !== attempt.attemptId || latest.revision < attempt.revision
            || canonicalAttemptJson(latest.binding) !== canonicalAttemptJson(attempt.binding)
            || latest.startedAt!==attempt.startedAt
            || latest.checkpoint.mode !== mode || latest.parentAttemptId || latest.checkpoint.purpose !== 'first'
            || attempt.submitted && canonicalAttemptJson(latest.submitted) !== canonicalAttemptJson(attempt.submitted))
            throw Error('原作答身份或最新保存状态尚未可靠核对，未生成成绩。');
        return createSubjectGradeHandler<typeof draft, {
        input: StudyAttemptInput;
        frame: StudySubmissionFrame;
        observation: AssistanceObservation | null;
    }, StudySubmissionV1>({ mode, completedStage: 0, isDemoMode: false, draft }, {
        drafts, modeEpoch: () => 0, ownerCurrent: current, canPresent: current,
        prepare(ticket, requested) {
            if (!current())
                throw Error('资料库或用户已切换，原答案保留。');
            const official = evidence(services.records());
            assertPendingCanPublish(latest, official);
            if (!attempt.submitted && official.some(record => record.itemKey === attempt.binding.itemKey
                && record.eventId !== latest.formal?.eventId && (!attempt.startedAt||!Number.isFinite(Date.parse(attempt.startedAt))||Date.parse(record.reviewedAt) > Date.parse(attempt.startedAt))))
                throw Error('暂停后原题已有新的正式作答；草稿保留，尚未覆盖新的结果。');
            const prepared = prepareAttemptEvidence({ rating: requested, mode, recallConfigured: item.learningSupport?.type === 'recall', original: item }, draft), correct = ['good', 'easy'].includes(prepared.rating);
            if (latest.evaluation.status !== 'resolved' || !latest.formal || latest.formal.eventId !== ticket.identity.eventId
                || latest.formal.occurredAt !== ticket.identity.reviewedAt || latest.formal.rating !== prepared.rating)
                throw Error('最新正式认领与原核对结果尚未一致，原作答保留。');
            const prior = services.records().filter(record => record.provenanceMode !== 'task' && record.event.eventType === 'practice-attempt' && record.event.item.key === attempt.binding.itemKey && record.contentHash === attempt.binding.contentHash && Date.parse(record.event.occurredAt) < Date.parse(ticket.identity.reviewedAt)).sort((a, b) => a.event.occurredAt.localeCompare(b.event.occurredAt)).at(-1);
            const input: StudyAttemptInput = { identity: ticket.identity, workspaceId: services.workspaceId, domain: item.eventKind === 'python' ? 'python' : 'differential-review', item: { kind: item.eventKind, key: attempt.binding.itemKey }, rating: prepared.rating, correct, stageBefore: 0, stageAfter: correct ? 3 : 0, reviewedAt: ticket.identity.reviewedAt, isThreeStage: false, currentFsrs: prior?.event.eventType === 'practice-attempt' ? prior.event.scheduling?.clientStateAfter : undefined,
                localContext: { title, activityType: 'website-practice', durationMin: 0, weakPoints: correct ? [] : [title] }, delivery: { cloud: services.cloud ? 'pending' : 'not-required', companion: services.cloud ? 'not-required' : 'pending' } };
            const nativeFrame = services.cloud ? null : services.nativeFrame?.(attempt);
            if (!services.cloud && !nativeFrame)
                throw Error('原本机题目的来源关联尚未恢复，原答案保留，未生成未绑定成绩。');
            if (nativeCapture && (nativeFrame?.kind !== 'local' || nativeFrame.practiceMode !== mode
                || nativeFrame.contentHash !== nativeCapture.identity.contentHash
                || nativeFrame.localBindingHash !== nativeCapture.identity.localBindingHash))
                throw Error('原本机来源关联与捕获版本不匹配，原答案保留，未生成成绩。');
            if (nativeMathCapture && (nativeFrame?.kind !== 'local' || nativeFrame.practiceMode !== 'calculation'
                || nativeFrame.contentHash !== nativeMathCapture.identity.contentHash
                || nativeFrame.localBindingHash !== nativeMathCapture.identity.localBindingHash))
                throw Error('原本机计算来源关联与捕获版本不匹配，原答案保留。');
            const frame: StudySubmissionFrame = services.cloud && original.snapshot && original.item ? { kind: 'account', practiceMode: mode, bundle: { snapshot: original.snapshot, items: [original.item] }, originDeviceId: deviceId } : nativeFrame!;
            return { input, frame, observation: prepared.observation };
        }, advance: () => { services.changed(); onClose(); }, publishDemo() { }, record: recordStudyAttempt, persist: services.persist,
        publishEvent: () => services.changed(), publishProgress: async () => services.changed(), sendCloud: services.sendCloud, sendCompanion: services.sendCompanion, updateDelivery: updateStudyEventDelivery,
        setMessage() { }, invalidateView() { },
    })(rating, options);
    };
    const lookupFormal = async (eventId: string) => {
        const record = services.records().find(record => record.provenanceMode === 'verified-round' && record.event.eventId === eventId);
        if (!record || record.provenanceMode !== 'verified-round' || record.event.eventType !== 'practice-attempt' || record.libraryId !== services.libraryId || record.snapshotId !== attempt.binding.snapshotId || record.contentHash !== attempt.binding.contentHash || record.event.item.key !== attempt.binding.itemKey)
            return null;
        return { eventId, coreHash: record.event.coreHash, itemKey: record.event.item.key, contentHash: record.contentHash, snapshotId: record.snapshotId, reviewedAt: record.event.scheduling?.reviewedAt ?? record.event.occurredAt, rating: record.event.attempt.rating, authoritativeRecord: { attemptId: record.attemptId, roundId: record.roundId } };
    };
    return <StudyAIOfflineContext pageContext={{ id: attempt.attemptId, title }}><section className="study-session-shell" aria-label="恢复原始作答"><header><h2>{title} · {attempt.submitted ? '原作答核对' : '原草稿续学'}</h2><p>{sourceLabel} · 保存于 {attempt.submitted?.submittedAt ?? attempt.updatedAt}{!attempt.submitted && ' · 打开时尚未提交，续学不自动形成成绩。'}</p><button type="button" onClick={onClose}>暂时保留，返回列表</button></header>
        <LearningDraftLeaveGuard store={drafts}/><LearningDraftBoundary store={drafts}><NonWordPluginHost lookupFormal={lookupFormal} recovered={attempt} plugin={plugin} data={data} context={context} onGrade={grade}/></LearningDraftBoundary>
    </section></StudyAIOfflineContext>;
}
