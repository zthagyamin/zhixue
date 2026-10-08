import type {AttemptBinding} from '../learning-attempt';
import type {CourseRecallSupport, QuizSupportV2} from '../content';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject, studyId, studyDigest, studySize, studyHash, studyText} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolveCourseTask, courseTaskHash} from './task.ts';

export type NativeCourseIdentity = {
    schemaVersion: 1; libraryId: string; itemKey: string; contentHash: string; localBindingHash: string;
};
/** Native captures intentionally lack portable publication/snapshot metadata. */
export type NativeCourseItem = {
    schemaVersion: 2; kind: 'practice'; eventKind: 'due'; itemKey: string; contentHash: string;
    learningSupport: CourseRecallSupport | QuizSupportV2;
    practice: {questionType: 'recall' | 'quiz'; prompt: string; domain: string};
};
export type NativeCourseCapture = {
    schemaVersion: 1; captureId: string; identity: NativeCourseIdentity; item: NativeCourseItem; taskHash: string;
};
export function parseNativeCourseIdentity(raw: unknown): NativeCourseIdentity {
    const row = studyObject(raw, ['schemaVersion', 'libraryId', 'itemKey', 'contentHash', 'localBindingHash']);
    if (row.schemaVersion !== 1 || typeof row.libraryId !== 'string' || !/^local-vault:[a-f0-9]{64}$/u.test(row.libraryId))
        throw Error('invalid-native-course-identity');
    studyId(row.itemKey);
    if (!row.itemKey.startsWith('practice:')) throw Error('invalid-native-course-identity');
    studyDigest(row.contentHash); studyDigest(row.localBindingHash);
    return structuredClone(row) as NativeCourseIdentity;
}
/** Capture integrity is not authentication. Admission is through the paired source port. */
export async function parseNativeCourseCapture(raw: unknown): Promise<NativeCourseCapture> {
    studySize(raw, 2 * 1024 * 1024);
    const row = studyObject(raw, ['schemaVersion', 'captureId', 'identity', 'item', 'taskHash']);
    if (row.schemaVersion !== 1) throw Error('unsupported-native-course-capture');
    studyDigest(row.captureId); studyDigest(row.taskHash);
    const identity = parseNativeCourseIdentity(row.identity);
    const item = studyObject(row.item, ['schemaVersion', 'kind', 'eventKind', 'itemKey', 'contentHash', 'learningSupport', 'practice']);
    const practice = studyObject(item.practice, ['questionType', 'prompt', 'domain']);
    studyText(practice.domain, 'native-course-domain', 128);
    if (item.itemKey !== identity.itemKey || item.contentHash !== identity.contentHash) throw Error('native-course-source-binding');
    if (item.schemaVersion !== 2 || item.kind !== 'practice' || item.eventKind !== 'due') throw Error('invalid-native-course-item');
    const task = resolveCourseTask(item as NativeCourseItem);
    if (await courseTaskHash(task) !== row.taskHash) throw Error('native-course-task-hash-conflict');
    const body = {schemaVersion: 1, identity, item, taskHash: row.taskHash};
    if (await studyHash(body) !== row.captureId) throw Error('native-course-capture-integrity');
    return structuredClone({...body, captureId: row.captureId}) as NativeCourseCapture;
}
export function assertNativeCaptureBinding(capture: NativeCourseCapture, binding: AttemptBinding): void {
    const identity = capture.identity;
    if (binding.snapshotId !== 'local' || binding.libraryId !== identity.libraryId
        || binding.itemKey !== identity.itemKey || binding.contentHash !== identity.contentHash)
        throw Error('native-course-attempt-source-binding');
}
