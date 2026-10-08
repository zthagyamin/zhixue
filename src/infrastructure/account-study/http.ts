// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createAccountStudyApplication } from '../../application/account-study/index.ts';
import type { AccountStudyDependencies, Authenticated, AccountReply } from '../../application/account-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyAIErrorCode } from '../../domain/ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { json, query, readJson, failure } from './http-values.ts';
export type AccountHttpDependencies = AccountStudyDependencies & {
    enabled: boolean | (() => boolean);
    getBrowserUser: (request: Request) => Promise<{
        userId: string;
    } | null>;
};
export function encodeAccountReply(reply: AccountReply): Response {
    if (reply.kind === 'value')
        return json(reply.value, reply.status);
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
            const emit = (event: unknown) => { if (!closed)
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
            try {
                for await (const event of reply.events)
                    emit(event);
            }
            catch (error) {
                emit({ type: 'error', error: studyAIErrorCode(error) });
            }
            finally {
                if (!closed) {
                    closed = true;
                    controller.close();
                }
            }
        }, cancel() { closed = true; reply.cancel(); } });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function createAccountStudyHttpHandlers(deps: AccountHttpDependencies) {
    const application = createAccountStudyApplication(deps);
    async function authenticate(request: Request): Promise<Authenticated> {
        const user = await deps.getBrowserUser(request), authorization = request.headers.get('Authorization');
        if (authorization !== null) {
            const matched = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(authorization);
            if (!matched)
                throw new ApiFailure(401, 'authentication-required');
            const principal = await (await deps.getAccessStore()).authenticate(matched[1]);
            if (!principal)
                throw new ApiFailure(401, 'authentication-required');
            if (user && user.userId !== principal.userId)
                throw new ApiFailure(403, 'account-mismatch');
            return { principal, secret: matched[1] };
        }
        if (!user)
            throw new ApiFailure(401, 'authentication-required');
        return { principal: { kind: 'browser', userId: user.userId } };
    }
    function handler(run: (request: Request, auth: Authenticated) => Promise<AccountReply>) {
        return async (request: Request) => {
            try {
                if (!(typeof deps.enabled === 'function' ? deps.enabled() : deps.enabled))
                    return json({ error: 'account-study-disabled' }, 503);
                return encodeAccountReply(await run(request, await authenticate(request)));
            }
            catch (error) {
                return failure(error);
            }
        };
    }
    return { GET: handler((request, auth) => application.get(query(request), auth)), POST: handler(async (request, auth) => {
            if (auth.principal.kind === 'browser' && request.headers.get('Origin') !== new URL(request.url).origin)
                throw new ApiFailure(403, 'origin-mismatch');
            return application.post(await readJson(request), auth, request.signal);
        }) };
}
