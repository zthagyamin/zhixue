'use client';
import { useRef } from 'react';
import type { StudyPlugin, PluginContext, PluginGradeOptions, FSRSRating } from '../plugins/registry';
import { MathText } from '../math-text';
import { recallReference } from '../recall-flow-model';
import { createSubmissionJournal } from '../study-submission-journal';
import { getLocalStudyEvent } from '../local-study-events';
import { createAssistanceObserver, emptyAssistanceObserverState, type AssistanceObserver } from '../assistance-observer';
import { isNonWordOriginal } from '../../src/domain/content';
import { NonWordStudyHost, type HostDriver } from '../../src/features/nonword-study';
import { createNonWordRuntime, recoveryFields, rawAnswer, restoredFields, evaluationPhase, type NonWordMode } from '../../src/infrastructure/nonword-study';
import '../../src/features/nonword-study/study.css';
import { continueNonWordRound } from '../../src/application/nonword-study';
import {CourseInteraction} from '../../src/features/course-study';
import {portableCourseTask,attachPortableCourseDriver,nativeCourseTask,attachNativeCourseDriver} from '../../src/infrastructure/course-study';
import '../../src/features/course-study/course-study.css';
import {attachPracticeDriver} from '../../src/infrastructure/practice-evidence';
import {nativeMathTask,attachNativeMathDriver,attachAccountMathDriver} from '../../src/infrastructure/math-study';
import {parseStudyItem,parseStudySnapshot} from '../account-study-content';
type Props = {
    recovered?: import('../../src/domain/learning-attempt').LearningAttempt;
    lookupFormal?: (eventId: string) => Promise<import('../../src/application/learning-attempt').VerifiedFormalAttemptEvent | null>;
    round?: () => Promise<import('../../src/application/nonword-study').NonWordRoundPort | null>;
    plugin: StudyPlugin<Record<string, unknown>>;
    data: Record<string, unknown>;
    context: PluginContext;
    onGrade: (rating: FSRSRating, options?: PluginGradeOptions) => void | Promise<unknown>;
};
/** Legacy composition seam. Business lifetime lives in application; this wires existing verified readers. */
export function NonWordPluginHost(props: Props) {
    const source = props.context.contentSource;
    if (!props.context.nonWordScope || !props.context.draft || !source || !isNonWordOriginal(source.mode, source.data))
        return <props.plugin.renderUI data={props.data} context={props.context} onGrade={props.onGrade}/>;
    return <BoundNonWordHost {...props}/>;
}
function BoundNonWordHost({ plugin: Plugin, data, context, onGrade, round, recovered, lookupFormal }: Props) {
    const scope = context.nonWordScope!, mode = Plugin.id.replace('@zhixue/plugin-', '') as NonWordMode;
    const temporaryObserver = useRef<AssistanceObserver | undefined>(undefined);
    const verified = async (eventId: string) => {
        const journal = await createSubmissionJournal().get(scope.workspaceId, eventId);
        const core = await getLocalStudyEvent(scope.workspaceId, eventId);
        if (!journal?.coreStored || !core || core.event.eventType !== 'practice-attempt')
            return lookupFormal?.(eventId) ?? null;
        const route = journal.payload.route;
        const accountRecord = route.kind === 'account' && route.record.provenanceMode !== 'task' ? route.record : null;
        const sourceHash = accountRecord?.contentHash ?? (route.kind === 'local' ? route.binding?.contentHash : undefined);
        if (sourceHash !== scope.contentHash)
            return null;
        return { eventId: core.eventId, coreHash: core.event.coreHash, itemKey: core.event.item.key, contentHash: sourceHash,
            reviewedAt: core.event.scheduling?.reviewedAt ?? core.event.occurredAt, rating: core.event.attempt.rating,
            ...(accountRecord ? { snapshotId: accountRecord.snapshotId } : {}),
            ...(accountRecord?.provenanceMode === 'verified-round' ? { authoritativeRecord: { attemptId: accountRecord.attemptId, roundId: accountRecord.roundId } } : {}) };
    };
    const createDriver = async (purpose: 'first' | 'guided' | 'remediation', intent: 'review' | 'learn', parentAttemptId?: string, instanceId?: string,taskId?:string): Promise<HostDriver> => {
        const group = await round?.(), cursor = await group?.read();
        const member = cursor?.members.find(member => member.itemKey === scope.itemKey);
        const prepared=await portableCourseTask(scope,purpose,parentAttemptId,taskId);
        const nativePrepared=prepared?null:await nativeCourseTask(scope,purpose,parentAttemptId,taskId,context.nativeCourse);
        const nativeMathPrepared=mode==='calculation'&&!scope.cloud?await nativeMathTask(scope,purpose,parentAttemptId,context.nativeMath):null;
        const runtime = await createNonWordRuntime({ ...scope, ...(cursor ? { roundId: cursor.roundId, snapshotId: member?.snapshotId ?? scope.snapshotId } : {}) }, prepared?.task.mode??nativePrepared?.task.mode??mode, { verifyFormalEvent: verified, ...(cursor?{continuationMode:'group',navigationGroup:{anchorAttemptId:cursor.anchorAttemptId,sourceHash:cursor.sourceHash,runId:cursor.runId,roundId:cursor.roundId}}:{}), ...(recovered ? { binding: recovered.binding, ...(purpose === 'first' ? { existing: recovered } : {}) } : {}), purpose: scope.temporary ? 'remediation' : purpose, intent, parentAttemptId, instanceId });
        if (purpose !== 'first' || scope.temporary) {
            const state = emptyAssistanceObserverState();
            temporaryObserver.current = createAssistanceObserver(() => ({ state, writable: true }));
        }
        const driver:HostDriver = { runtime, ...(group ? { group, continueGroup: async (result: FSRSRating | 'pending' | 'skipped') => { await continueNonWordRound(group, scope.itemKey, result, cursor?.runId,runtime.continuationBoundary); } } : {}), restore: () => restoredFields(runtime.session.snapshot()!, mode), fields: values => recoveryFields(mode, values), answer: values => rawAnswer(mode, values), phase: () => evaluationPhase(runtime.session.snapshot()),
            verifiedCore: async () => {
                const formal = runtime.session.snapshot()?.formal;
                if (!formal)
                    return null;
                return (await verified(formal.eventId))?.coreHash ?? null;
            } };
        if(mode==='code'&&!prepared&&!nativePrepared)return attachPracticeDriver(driver,runtime,
            !scope.cloud&&context.requestAiHint?{requestHint:({answer,report})=>context.requestAiHint!(structuredClone(data),
                JSON.stringify({code:answer,failure:report.firstFailure??report.exception,sourceVersion:report.identity?.sourceVersion,
                    instruction:'只给定位当前问题的一条小提示，不提供完整题解。'}))}:{});
        if(mode==='calculation'&&scope.cloud&&scope.courseReference){
            const source=scope.courseReference,item=source.item;
            if(item.itemKey!==scope.itemKey||item.contentHash!==scope.contentHash||item.kind!=='practice'||item.practice.questionType!=='calculation'
                ||source.snapshot.libraryId!==scope.libraryId||source.snapshot.snapshotId!==scope.snapshotId
                ||!source.snapshot.items.some(member=>member.itemKey===item.itemKey&&member.contentHash===item.contentHash))throw Error('math-original-source-unavailable');
            return attachAccountMathDriver(driver,runtime,{item:await parseStudyItem(item),snapshot:await parseStudySnapshot(source.snapshot)});
        }
        if(nativeMathPrepared)return attachNativeMathDriver(driver,runtime,nativeMathPrepared,context.nativeMath);
        return prepared?attachPortableCourseDriver(driver,runtime,prepared):nativePrepared?attachNativeCourseDriver(driver,runtime,nativePrepared,context.nativeCourse):driver;
    };
    return <NonWordStudyHost temporary={scope.temporary} key={JSON.stringify([scope, mode])} bindingKey={JSON.stringify([scope, mode])} mode={mode} draft={context.draft!} question={typeof data.prompt === 'string' ? data.prompt : typeof data.front === 'string' ? data.front : undefined} reference={recallReference(data) ?? (typeof data.explanation === 'string' ? data.explanation : '')} recallConfigured={(data.learningSupport as {
            type?: string;
        } | undefined)?.type === 'recall'} createDriver={createDriver} restoreRound={context.nonWordNavigation?.restoreRound} onGrade={onGrade} continuePending={() => context.nonWordNavigation?.continuePending()} resumeFormal={rating => context.nonWordNavigation?.resumeFormal(rating)} renderMath={text => <MathText text={text}/>} renderPlugin={(draft, lifecycle, grade) => lifecycle.course?<CourseInteraction lifecycle={lifecycle} draft={draft} onGrade={grade} renderMath={text=><MathText text={text}/>}/>:<Plugin.renderUI data={data} onGrade={grade} context={{ ...context, nonWordLearning: lifecycle,
                ...(lifecycle.purpose === 'first' ? {} : { recallScope: undefined, recallPersistenceRequired: false }),
                ...(mode==='calculation'&&scope.nativeMathIdentity&&!lifecycle.practice?.calculation?{gradeCalculation:undefined}:{}),
                draft: { ...context.draft!, ...draft, assistance: lifecycle.purpose === 'first' ? context.draft?.assistance : temporaryObserver.current } }}/>}/>;
}
export { createNonWordContinuation, restorePendingAnswers, restoreNonWordRound } from '../../src/features/nonword-study';
export { scopeForNonWord, nonWordRoundMembers, makeExtra } from './nonword-scopes';
export { useNonWordRoundCache, cursorSeed, restoreSavedPending, restartSavedRound } from './nonword-round-cache';
export { subjectLearningServices } from './nonword-services';
