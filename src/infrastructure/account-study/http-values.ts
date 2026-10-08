// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { STUDY_AI_ERRORS } from '../../domain/ai/index.ts';
export function json(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Vary': 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff' } });
}
export function query(request: Request): Record<string, string> {
    if (request.url.length > 4096)
        throw new ApiFailure(400, 'query-too-long');
    const result: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
        if (!['action', 'expectedUserId', 'libraryId', 'snapshotId', 'catalogHash', 'day', 'position', 'after', 'through', 'limit'].includes(key) || Object.hasOwn(result, key))
            throw new ApiFailure(400, 'invalid-query');
        result[key] = value;
    }
    return result;
}
export async function readJson(request: Request): Promise<Record<string, unknown>> {
    const max = 2200000, declared = request.headers.get('Content-Length');
    if (declared !== null && Number(declared) > max)
        throw new ApiFailure(413, 'request-too-large');
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
        throw new ApiFailure(415, 'json-required');
    if (!request.body)
        throw new ApiFailure(400, 'body-required');
    const reader = request.body.getReader(), buffer = new Uint8Array(max);
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (size + value.byteLength > max) {
                await reader.cancel();
                throw new ApiFailure(413, 'request-too-large');
            }
            buffer.set(value, size);
            size += value.byteLength;
        }
        try {
            const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                throw new Error('object-required');
            return raw as Record<string, unknown>;
        }
        catch {
            throw new ApiFailure(400, 'invalid-json');
        }
    }
    finally {
        reader.releaseLock();
    }
}
export function failure(error: unknown): Response {
    if (error instanceof ApiFailure)
        return json({ error: error.code }, error.status);
    const code = error instanceof Error ? error.message : '';
    if (code === 'study-scope-mismatch')
        return json({ error: code }, 403);
    if (code.startsWith('invalid-long-term-'))
        return json({ error: 'invalid-long-term-plan' }, 400);
    if (code === 'long-term-plan-too-large')
        return json({ error: code }, 413);
    if (['long-term-operation-conflict', 'long-term-observation-moved-backward', 'long-term-frozen-history-changed'].includes(code))
        return json({ error: code }, 409);
    if (code === 'study-writer-required')
        return json({ error: code }, 403);
    if (code === 'unknown-study-snapshot' || code === 'unknown-study-record' || code === 'unknown-assistance-summary')
        return json({ error: code }, 404);
    if (code === 'assistance-receipt-binding' || code === 'assistance-account-binding')
        return json({ error: code }, 409);
    if (code === 'study-receipt-binding')
        return json({ error: code }, 409);
    if (code === 'plan-operation-conflict' || code === 'plan-operation-in-flight' || code === 'plan-operation-cancelled' || code === 'unknown-current-plan' || code === 'unknown-plan-restore' || code === 'unknown-plan-cancel' || code === 'plan-cancel-target-changed' || code === 'plan-predecessor-pending' || code === 'plan-execution-revision' || code === 'plan-execution-binding' || code === 'plan-execution-claim-required' || code === 'content-decision-conflict' || code === 'content-decision-final' || code === 'question-ai-content-changed')
        return json({ error: code }, 409);
    if (code === 'account-ai-key-required' || code === 'ai-cost-confirmation-required')
        return json({ error: code }, 400);
    if (code === 'account-ai-daily-limit' || code === 'account-ai-token-limit' || code === 'account-ai-concurrency-limit' || code === 'study-grant-limit')
        return json({ error: code }, 429);
    if (code === 'ai-settings-stale' || code === 'account-ai-disabled' || code === 'ai-request-pending' || code === 'ai-request-conflict' || code === 'ai-request-indeterminate')
        return json({ error: code }, 409);
    if (/^study-[a-z-]+(?:conflict|mismatch|approval-required)$/.test(code))
        return json({ error: code }, 409);
    if (/^(invalid-|unsupported-|missing-|too-long-|unknown-study-field)/.test(code) && /^[a-z-]+$/.test(code))
        return json({ error: code }, 400);
    if (Object.hasOwn(STUDY_AI_ERRORS, code))
        return json({ error: code }, code === 'ai-model-name' || code === 'ai-model-list-key-required' ? 400 : 502);
    return json({ error: 'study-service-unavailable' }, 503);
}
