import type {NativeCourseCapture, NativeCourseIdentity, NativeGradeRequest, NativeGradeReceipt,
    NativeClaimRequest, NativeClaimReceipt} from '../../domain/course-study';

/** The composition root supplies an already paired Companion connection. */
export interface NativeCourseTransport {
    supported(): boolean;
    capture(identity: NativeCourseIdentity, signal?: AbortSignal): Promise<NativeCourseCapture>;
    read(identity: NativeCourseIdentity, captureId: string, signal?: AbortSignal): Promise<NativeCourseCapture>;
    grade(request: NativeGradeRequest, signal?: AbortSignal): Promise<NativeGradeReceipt>;
    claim(request: NativeClaimRequest, signal?: AbortSignal): Promise<NativeClaimReceipt>;
}
