import type {NativeCourseTransport} from '../../application/course-study';
import type {NativeCourseCapture, NativeCourseIdentity, NativeGradeRequest, NativeClaimRequest} from '../../domain/course-study';
import {parseNativeCourseCapture, parseNativeCourseIdentity, parseNativeGradeRequest, parseNativeGradeReceipt,
    // @ts-expect-error TS5097: standalone Node contracts.
    parseNativeClaimRequest, validateNativeClaimReceipt} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';

type Response = {ok: boolean; status: number; json(): Promise<unknown>};
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Options = {baseUrl: string; sessionToken: string; capabilities?: readonly string[]; fetcher?: Fetcher};
/** Paired transport only. The host validates each diagnosis against its submitted answer. */
export function createNativeCourseClient(options: Options): NativeCourseTransport {
    const supported = () => Boolean(options.capabilities?.includes('native-course-v1'));
    const fetcher = options.fetcher ?? fetch;
    async function post(path: string, body: unknown, signal?: AbortSignal, timeout = 15000): Promise<unknown> {
        if (!supported()) throw Error('native-course-unsupported');
        const endpoint = new URL(options.baseUrl);
        if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
            || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
            || !/^\d{4,5}$/u.test(endpoint.port) || Number(endpoint.port) < 1024 || Number(endpoint.port) > 65535)
            throw Error('native-course-endpoint-invalid');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stop = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
            stop = () => {controller.abort(); reject(Error('native-course-cancelled'));};
            signal?.addEventListener('abort', stop, {once: true});
            timer = setTimeout(() => {controller.abort(); reject(Error('native-course-receipt-unavailable'));}, timeout);
            if (signal?.aborted) stop();
        });
        try {
            return await Promise.race([cancelled, Promise.resolve().then(async () => {
                if (controller.signal.aborted) throw Error('native-course-cancelled');
                const response = await fetcher(`${endpoint.origin}${path}`, {
                    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Study-Loop-Session': options.sessionToken},
                    body: JSON.stringify(body), signal: controller.signal,
                });
                const result = await response.json();
                if (controller.signal.aborted) throw Error('native-course-cancelled');
                if (!response.ok) {
                    const code = (result as {error?: unknown})?.error;
                    throw Error(typeof code === 'string' && /^native-course-[a-z-]+$/u.test(code) ? code : 'native-course-receipt-unavailable');
                }
                return result;
            })]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
        }
    }
    async function source(action: 'capture' | 'read', identity: NativeCourseIdentity, captureId?: string, signal?: AbortSignal): Promise<NativeCourseCapture> {
        identity = parseNativeCourseIdentity(identity);
        const raw = await post(`/v1/course/source/${action}`, {schemaVersion: 1, identity, ...(captureId ? {captureId} : {})}, signal);
        const row = raw as {schemaVersion?: unknown; durable?: unknown; capture?: unknown};
        if (!row || row.schemaVersion !== 1 || row.durable !== true
            || Object.keys(row).some(key => !['schemaVersion', 'durable', 'capture'].includes(key))) throw Error('native-course-source-receipt-invalid');
        const capture = await parseNativeCourseCapture(row.capture);
        if (canonicalAttemptJson(capture.identity) !== canonicalAttemptJson(identity) || captureId && capture.captureId !== captureId)
            throw Error('native-course-source-receipt-binding');
        return capture;
    }
    return {supported, capture: (identity, signal) => source('capture', identity, undefined, signal),
        read: (identity, captureId, signal) => source('read', identity, captureId, signal),
        async grade(raw: NativeGradeRequest, signal?: AbortSignal) {
            const request = parseNativeGradeRequest(raw);
            const result = await parseNativeGradeReceipt(await post('/v1/course/grade', request, signal, 60000));
            if (result.requestId !== request.requestId || result.attemptId !== request.attemptId)
                throw Error('native-course-result-binding');
            return result;
        },
        async claim(raw: NativeClaimRequest, signal?: AbortSignal) {
            const request = parseNativeClaimRequest(raw);
            return validateNativeClaimReceipt(await post('/v1/course/claim', request, signal), request);
        },
    };
}
