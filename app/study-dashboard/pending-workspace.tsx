"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LearningAttempt } from '../../src/domain/learning-attempt';
import type { NativeMathTransport } from '../../src/domain/math-study';
import {createNativeMathSourceCache,createPendingMathStepRuntime} from '../../src/infrastructure/math-study';
import {PendingMathStepQueue} from '../../src/features/calculation-study';
import type { NativeCourseTransport } from '../../src/application/course-study';
import { createNativeCourseSourceCache } from '../../src/infrastructure/course-study';
import type { StudySubmissionFrame } from '../study-submission';
import type { StudyRecordEnvelope } from '../account-study-record';
import type { StudySubmissionV1 } from '../study-submission-journal';
import type { LocalStudyEventRecord } from '../local-study-events';
import type { AssistanceObservation } from '../../src/domain/assessment';
import type { PendingAnswerQueuePort, PendingAnswerSource } from '../../src/features/nonword-study';
import type { NonWordPendingOriginal } from '../../src/infrastructure/nonword-study';
import { PendingAnswerQueue } from '../../src/features/nonword-study';
import { createNonWordPendingRuntime, cacheOriginalPendingBundle } from '../../src/infrastructure/nonword-study';
import { createAccountAttemptClient } from '../../src/infrastructure/learning-attempt';
import { parseStudyItem, parseStudySnapshot, validateStudyBundle } from '../account-study-content';
import { cacheLocalStudySnapshot } from '../local-account-study';
import { loadWorkspaceRecord } from '../local-study-db';
import { MathText } from '../math-text';
import { PendingAttemptReview } from './pending-review';
import '../../src/features/nonword-study/study.css';
export type PendingWorkspaceProps = {
    workspaceId: string;
    ownerId: string;
    libraryId: string;
    cloud: boolean;
    ready: boolean;
    questionAi?: (request: {
        requestId: string;
        request: unknown;
    }) => Promise<Record<string, unknown>>;
    records: StudyRecordEnvelope[];
    persist: (record: LocalStudyEventRecord, frame: StudySubmissionFrame, observation: AssistanceObservation | null) => Promise<StudySubmissionV1>;
    nativeFrame?: (attempt: LearningAttempt) => StudySubmissionFrame | null;
    nativeCourse?: NativeCourseTransport;
    nativeMath?: NativeMathTransport;
    sendCloud: (payload: StudySubmissionV1) => Promise<unknown>;
    sendCompanion: (payload: StudySubmissionV1) => Promise<unknown>;
    changed: () => void;
};
/** Owner-scoped composition. Reading the queue does not start grading or alter events. */
export function PendingAnswerWorkspace(props: PendingWorkspaceProps) {
    const key = JSON.stringify([props.workspaceId, props.ownerId, props.libraryId, props.cloud]), currentKey = useRef(key), live = useRef(true);
    const records = useRef(props.records);
    useLayoutEffect(() => { currentKey.current = key; records.current = props.records; }, [key, props.records]);
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const runtime = useMemo(() => {
        const native = !props.cloud && /^local-vault:[a-f0-9]{64}$/.test(props.libraryId)
            ? createNativeCourseSourceCache({ userId: props.ownerId, libraryId: props.libraryId }) : null;
        const math = native ? createNativeMathSourceCache({ userId: props.ownerId, libraryId: props.libraryId }) : null;
        return createNonWordPendingRuntime({ ownerId: props.ownerId, libraryId: props.libraryId,
            cloud: props.cloud ? createAccountAttemptClient({ ownerId: props.ownerId, libraryId: props.libraryId }) : null,
            parseItem: parseStudyItem, parseSnapshot: parseStudySnapshot,
            ...(native ? { nativeReference: (attempt: LearningAttempt) => native.read(attempt.binding, attempt.attemptId) } : {}),
            ...(math ? {nativeMathReference: (attempt: LearningAttempt) => math.read(attempt.binding, attempt.attemptId)} : {}) });
    }, [props.ownerId, props.libraryId, props.cloud]);
    const steps = useMemo(() => {
        const math = !props.cloud && /^local-vault:[a-f0-9]{64}$/.test(props.libraryId)
            ? createNativeMathSourceCache({userId:props.ownerId,libraryId:props.libraryId}) : null;
        return createPendingMathStepRuntime({workspaceId:props.workspaceId,ownerId:props.ownerId,libraryId:props.libraryId,
            current:()=>live.current&&currentKey.current===key,
            cloud:props.cloud?createAccountAttemptClient({ownerId:props.ownerId,libraryId:props.libraryId}):null,
            parseItem:parseStudyItem,parseSnapshot:parseStudySnapshot,nativeMath:props.nativeMath,
            ...(math?{nativeMathReference:(attempt:LearningAttempt)=>math.read(attempt.binding,attempt.attemptId)}:{})});
    },[props.workspaceId,props.ownerId,props.libraryId,props.cloud,props.nativeMath,key]);
    const [active, setActive] = useState<{
        key: string;
        original: NonWordPendingOriginal;
        deviceId: string;
    } | null>(null), [version, setVersion] = useState(0);
    const current = () => live.current && currentKey.current === key;
    const port = useMemo<PendingAnswerQueuePort>(() => ({ list: runtime.list,notice:runtime.notice,
        async reference(row) {
            const source = await runtime.loadOriginal(row.attemptId);
            if (source.referenceVerified && source.resumable && source.nativeMathCapture) {
                const item = source.nativeMathCapture.item;
                return {attemptId:row.attemptId,binding:source.attempt.binding,kind:'practice',title:item.itemKey.slice('practice:'.length),
                    sourceLabel:item.practice.sourceLabel,prompt:item.practice.prompt,reference:source.attempt.submitted?item.practice.answer:undefined};
            }
            if (source.referenceVerified && source.resumable && source.nativeCapture) {
                const item = source.nativeCapture.item, task = item.learningSupport.task;
                return { attemptId: row.attemptId, binding: source.attempt.binding, kind: 'practice',
                    title: item.itemKey.slice('practice:'.length), sourceLabel: task.sources.map(part => part.label).join(' · '),
                    prompt: item.practice.prompt, reference: source.attempt.submitted ? item.learningSupport.criteria.map(point => point.text).join('\n') : undefined };
            }
            if (!source.referenceVerified || !source.item || !source.resumable)
                throw Error(source.notice);
            const item = source.item;
            const value: PendingAnswerSource = { attemptId: row.attemptId, binding: row.binding, kind: item.kind, title: item.title, sourceLabel: item.kind === 'practice' ? item.practice.sourceLabel : '词汇资料', prompt: item.kind === 'practice' ? item.practice.prompt : item.word.word, reference: item.kind === 'practice' ? String(item.practice.answer ?? item.practice.explanation ?? '') : item.word.meaning };
            return value;
        }, async onResume(row) {
            const source = await runtime.loadOriginal(row.attemptId);
            if (!source.resumable)
                throw Error(source.notice);
            if (props.cloud) {
                if (!source.snapshot)
                    throw Error('原快照尚未恢复，原答案已保留。');
                await cacheOriginalPendingBundle({ binding: source.attempt.binding, snapshot: source.snapshot, current, parseItem: parseStudyItem, validateBundle: validateStudyBundle, cache: bundle => cacheLocalStudySnapshot(props.workspaceId, bundle) });
            }
            const deviceId = props.cloud ? await loadWorkspaceRecord<string>(props.workspaceId, 'account-study-device', '') : '';
            if (props.cloud && !deviceId)
                throw Error('账号设备标识尚未可靠读取，原答案已保留。');
            if (current())
                setActive({ key, original: source, deviceId });
        },
        // The source/owner key controls all captured recovery ports.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [runtime, key]);
    if (!props.ready)
        return null;
    const close = () => { setActive(null); setVersion(value => value + 1); };
    return <aside className="nonword-pending-workspace" aria-label="原作答核对与续学"><PendingAnswerQueue ownerId={props.ownerId} libraryId={props.libraryId} version={version} port={port} renderMath={text => <MathText text={text}/>} accountCapability={props.cloud ? 'available' : 'local-only'}/>
        <PendingMathStepQueue key={key} port={steps} version={version} renderMath={text=><MathText text={text}/>}/>
        {active?.key === key && <PendingAttemptReview original={active.original} deviceId={active.deviceId} onClose={close} services={{ workspaceId: props.workspaceId, ownerId: props.ownerId, libraryId: props.libraryId, cloud: props.cloud, current, records: () => records.current, readAttempt: runtime.readLatest, questionAi: props.questionAi, persist: props.persist, sendCloud: props.sendCloud, sendCompanion: props.sendCompanion, changed: props.changed, nativeFrame: props.nativeFrame, nativeCourse: props.nativeCourse, nativeMath: props.nativeMath }}/>}
    </aside>;
}
