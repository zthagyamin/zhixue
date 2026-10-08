import type { FSRSRating, AssistanceObservation } from '../../domain/assessment';
import type { AttemptIdentity, AttemptOutcome, StudyAttemptRequest, StudyAttemptSubmission, StudyAttemptInput, StudyAttemptResult, StudyAttemptDependencies, StudyAttemptRecordPort } from '../../application/study-attempt';
import type { LocalStudyEventRecord } from '../../domain/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
import { attemptFailureMessage } from './status.ts';
export type SubjectGradeCommand<Frame = unknown> = {
    input: StudyAttemptInput;
    frame: Frame;
    observation: AssistanceObservation | null;
};
export type SubjectGradeOptions = {
    continuationReceipt?: boolean;
    deferAdvance?: boolean;
    identity?: AttemptIdentity;
};
export type SubjectGradeInput<Draft = unknown> = {
    mode: string;
    completedStage: number;
    isDemoMode: boolean;
    draft: Draft;
};
export type SubjectGradePorts<Draft, Command extends SubjectGradeCommand, Payload> = {
    drafts: {
        submit: (draft: Draft, options: StudyAttemptSubmission) => Promise<AttemptOutcome>;
    };
    modeEpoch: () => number;
    ownerCurrent: (modeEpoch: number) => boolean;
    /** Automatic navigation also checks the current navigation epoch. */
    canPresent: (explicitContinue: boolean) => boolean;
    prepare: (request: StudyAttemptRequest, rating: FSRSRating) => Command;
    /** Reads the current round, not the immutable command's old round. */
    advance: (command: Command) => void | boolean;
    publishDemo: (command: Command) => void;
    record: StudyAttemptRecordPort;
    persist: (record: LocalStudyEventRecord, frame: Command['frame'], observation: AssistanceObservation | null) => Promise<Payload>;
    publishEvent: (record: LocalStudyEventRecord) => void;
    publishProgress: (command: Command, result: StudyAttemptResult) => void | Promise<void>;
    sendCloud: (payload: Payload) => Promise<unknown>;
    sendCompanion: (payload: Payload) => Promise<unknown>;
    updateDelivery: StudyAttemptDependencies['updateDelivery'];
    setMessage: (message: string) => void;
    invalidateView: () => void;
};
/** Formal host orchestration; ports retain the existing word and projection rules. */
export function createSubjectGradeHandler<Draft, Command extends SubjectGradeCommand, Payload>(input: SubjectGradeInput<Draft>, ports: SubjectGradePorts<Draft, Command, Payload>): (rating: FSRSRating, options?: SubjectGradeOptions) => void | Promise<unknown> {
    return (rating, options) => {
        const deferAdvance = ['calculation', 'recall', 'code', 'quiz', 'flashcard'].includes(input.mode) && options?.deferAdvance === true;
        const modeEpoch = ports.modeEpoch(), ownerCurrent = () => ports.ownerCurrent(modeEpoch);
        if (input.mode === 'paper')
            return;
        if (input.mode === 'three-stage' && input.completedStage >= 3) {
            ports.setMessage('这个词本轮已完成，请从本组清单选未完成的词。');
            return;
        }
        if (!ownerCurrent())
            return;
        const submission: StudyAttemptSubmission = {
            identity: options?.identity,
            intent: JSON.stringify([rating, deferAdvance]), current: ownerCurrent, deferred: deferAdvance,
            execute(request, control) {
                const command = request.capture('subject-command', () => ports.prepare(request, rating));
                const advance = (explicitContinue = false) => {
                    if (ownerCurrent() && ports.canPresent(explicitContinue))
                        return ports.advance(command)!==false;
                    return false;
                };
                const continued = () => { const accepted=advance(true); return options?.continuationReceipt?accepted:undefined; };
                if (input.isDemoMode) {
                    control.durable({ continue: continued, publish() {
                            ports.publishDemo(command);
                            if (!deferAdvance)
                                advance();
                        } });
                    return;
                }
                let payload: Payload | undefined;
                return ports.record(command.input, {
                    persistEvent: async (record) => {
                        payload = await ports.persist(record, command.frame, command.observation);
                        control.durable({ continue: continued, publish() {
                                // Advance before the saved event can repaint the old vocabulary stage.
                                if (!deferAdvance)
                                    advance();
                                ports.publishEvent(record);
                            } });
                    },
                    persistProgress: async (result) => {
                        if (control.committed() && ownerCurrent())
                            await ports.publishProgress(command, result);
                    },
                    sendCloud: () => ownerCurrent() && payload !== undefined ? ports.sendCloud(payload) : Promise.reject(new Error('study-workspace-changed')),
                    sendCompanion: () => ownerCurrent() && payload !== undefined ? ports.sendCompanion(payload) : Promise.reject(new Error('study-workspace-changed')),
                    updateDelivery: ports.updateDelivery,
                });
            },
            onError(error, saved) {
                ports.setMessage(input.isDemoMode ? '演示进度未能显示，正式学习记录未改变。' : attemptFailureMessage(error, saved));
                if (!saved && ports.canPresent(false))
                    ports.invalidateView();
            },
        };
        return ports.drafts.submit(input.draft, submission);
    };
}
