import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { fields, id, validated } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue as json } from './result.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyObject, studyCount, studyHash } from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parsePlanAiRequest, parseQuestionAiRequest, parseChatRequest, providerEndpoint, assertStudyAIModel } from '../../domain/ai/index.ts';
import type { StudyAIModelSelection } from '../../domain/ai';
// @ts-expect-error TS5097: standalone Node contracts.
import { startAccountChat } from './chat-execution.ts';
export async function executeAiAction(body: Record<string, unknown>, auth: Authenticated, context: AccountContext, signal: AbortSignal): Promise<AccountReply | null> {
    const { deps, requireRole, scope } = context;
    const p = auth.principal, action = body.action;
    if (action === 'configure-plan-ai') {
        requireRole(p, 'browser');
        fields(body, ['action', 'settings'], ['libraryId']);
        const settings = body.settings;
        if (!(deps.planAiAvailable?.() ?? false) && settings && typeof settings === 'object' && !Array.isArray(settings) && ((settings as {
            enabled?: unknown;
        }).enabled === true || Object.hasOwn(settings, 'providerKey')))
            throw new ApiFailure(503, 'cloud-ai-unavailable');
        return json(await (await deps.getAiStore()).configure(await scope(p, body.libraryId), settings));
    }
    if (action === 'recommend-plan-ai') {
        requireRole(p, 'browser');
        fields(body, ['action', 'requestId', 'day', 'request'], ['libraryId']);
        const owner = await scope(p, body.libraryId), request = await validated(async () => parsePlanAiRequest(body.request));
        const day = id(body.day, 'plan-day');
        if (request.planHash.length !== 64)
            throw new ApiFailure(400, 'invalid-plan-hash');
        const state = await (await deps.getPlanStore()).getState(owner, day);
        if (!state.currentPlan || state.currentPlan.cloudPlanHash !== request.planHash)
            throw new ApiFailure(409, 'unknown-current-plan');
        const catalog = await (await deps.getPlanStore()).getCatalogByHash(owner, state.currentPlan.catalogHash);
        if (!catalog)
            throw new ApiFailure(409, 'unknown-planning-source');
        const units = new Map(catalog.subjects.flatMap(subject => subject.units.map(unit => [unit.unitId, { unit, subject }] as const))), done = new Set(catalog.subjects.flatMap(s => s.units.filter(u => u.taskComplete || u.formalComplete).map(u => u.unitId)));
        for (const candidate of request.candidates) {
            const found = units.get(candidate.unitId);
            if (!found || found.subject.goals.length || found.unit.subjectId !== candidate.subjectId || candidate.label !== (found.unit.planningLabel ?? found.unit.title) || candidate.priority !== found.subject.priority || found.unit.formalComplete || found.unit.taskComplete || found.unit.prerequisites.some(id => !done.has(id)))
                throw new ApiFailure(400, 'invalid-ai-candidate');
        }
        const optional = new Set(state.currentPlan.tasks.filter(task => !task.required).map(task => task.taskId));
        if (request.currentOptionalTaskIds.some(id => !optional.has(id)))
            throw new ApiFailure(400, 'invalid-ai-order');
        const selected = await (await deps.getAiStore()).getSettings(owner), inputHash = await studyHash(selected.model ? { request, provider: selected.provider, model: selected.model, baseUrl: selected.baseUrl } : request), requestId = selected.model ? `ai:${await studyHash([id(body.requestId, 'request'), selected.provider, selected.model, selected.baseUrl])}` : id(body.requestId, 'request'), serviceDay = new Date(deps.now().getTime() + 8 * 3600000).toISOString().slice(0, 10), aiStore = await deps.getAiStore(), aiSettings = selected, reservedTokens = new TextEncoder().encode(JSON.stringify(request)).byteLength + aiSettings.maxOutputTokens, reservation = await aiStore.begin(owner, { requestId, day: serviceDay, inputHash, reservedTokens, expectedRevision: selected.revision, trace: { operationKind: 'plan', ...deps.getPlanAiTrace(), ...(selected.model ? { modelId: selected.model, provider: selected.provider } : {}) } });
        if (reservation.status === 'completed')
            return json({ status: 'duplicate', result: reservation.result });
        if (reservation.status === 'pending')
            throw new ApiFailure(409, 'ai-request-pending');
        if (reservation.status === 'failed') {
            const code = reservation.errorCode ?? 'cloud-ai-provider-error';
            throw new ApiFailure(code === 'ai-request-indeterminate' ? 409 : 502, code);
        }
        try {
            const result = await (await deps.getPlanAi(owner, aiSettings.revision)).recommend(request, { maxOutputTokens: reservation.settings.maxOutputTokens });
            await (await deps.getAiStore()).complete(owner, requestId, inputHash, result, result.usageTokens ?? reservedTokens);
            return json({ status: 'accepted', result });
        }
        catch (error) {
            const code = error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : 'cloud-ai-provider-error';
            await (await deps.getAiStore()).fail(owner, requestId, inputHash, code);
            throw new ApiFailure(502, code);
        }
    }
    if (action === 'ai-models') {
        requireRole(p, 'browser');
        fields(body, ['action', 'selection'], ['libraryId']);
        const owner = await scope(p, body.libraryId), value = studyObject(body.selection, ['provider', 'baseUrl', 'expectedRevision'], ['providerKey']);
        if (!['chatgpt', 'deepseek'].includes(String(value.provider)) || typeof value.baseUrl !== 'string' || value.baseUrl.length > 500 || value.providerKey !== undefined && (typeof value.providerKey !== 'string' || value.providerKey.trim().length < 8 || value.providerKey.length > 512))
            throw new ApiFailure(400, 'invalid-ai-model-selection');
        studyCount(value.expectedRevision, 'ai-revision');
        providerEndpoint(value as StudyAIModelSelection);
        const settings = await (await deps.getAiStore()).getSettings(owner);
        if (settings.revision !== value.expectedRevision)
            throw new ApiFailure(409, 'ai-settings-stale');
        if (!deps.getAiModels || !(deps.planAiAvailable?.() ?? false))
            throw new ApiFailure(503, 'cloud-ai-unavailable');
        return json({ models: await deps.getAiModels(owner, value as StudyAIModelSelection, signal) });
    }
    if (action === 'ai-chat') {
        requireRole(p, 'browser');
        fields(body, ['action', 'request'], ['libraryId']);
        const owner = await scope(p, body.libraryId), chatRequest = parseChatRequest(body.request), store = await deps.getAiStore(), settings = await store.getSettings(owner);
        if (chatRequest.provider !== settings.provider || chatRequest.model !== settings.model || chatRequest.settingsRevision !== settings.revision)
            throw new ApiFailure(409, 'ai-settings-stale');
        if (!deps.getChatAi || !(deps.planAiAvailable?.() ?? false))
            throw new ApiFailure(503, 'cloud-ai-unavailable');
        assertStudyAIModel(settings.provider, settings.model, settings.baseUrl);
        const inputHash = await studyHash({ ...chatRequest, baseUrl: settings.baseUrl }), reservedTokens = new TextEncoder().encode(JSON.stringify(chatRequest)).byteLength + settings.maxOutputTokens, day = new Date(deps.now().getTime() + 8 * 3600000).toISOString().slice(0, 10), reservation = await store.begin(owner, { requestId: chatRequest.requestId, day, inputHash, reservedTokens, expectedRevision: settings.revision, trace: { operationKind: 'chat', modelId: settings.model, provider: settings.provider, promptVersion: 'chat-v1', ruleVersion: 'chat-no-evidence-v1' } });
        if (reservation.status === 'completed')
            return json({ status: 'duplicate', result: reservation.result });
        if (reservation.status === 'pending')
            throw new ApiFailure(409, 'ai-request-pending');
        if (reservation.status === 'failed')
            throw new ApiFailure(502, reservation.errorCode ?? 'cloud-ai-provider-error');
        return startAccountChat({ owner, request: chatRequest, settings, inputHash, reservedTokens, store, load: () => deps.getChatAi!(owner, settings.revision), signal });
    }
    if (action === 'question-ai') {
        requireRole(p, 'browser');
        fields(body, ['action', 'requestId', 'request'], ['libraryId']);
        const owner = await scope(p, body.libraryId), clientRequestId = id(body.requestId, 'request'), request = await validated(() => Promise.resolve(parseQuestionAiRequest(body.request))), expectedAttempt = `attempt:${await studyHash([request.kind, request.snapshotId, request.itemKey, request.contentHash, request.input])}`;
        if (request.attemptId !== expectedAttempt)
            throw new ApiFailure(400, 'question-ai-attempt-binding');
        const item = await (await deps.getStudyStore()).getSnapshotItem(owner, request.snapshotId, request.itemKey);
        if (!item || item.contentHash !== request.contentHash)
            throw new ApiFailure(409, 'question-ai-content-changed');
        const selected = await (await deps.getAiStore()).getSettings(owner), inputHash = await studyHash(selected.model ? { request, provider: selected.provider, model: selected.model, baseUrl: selected.baseUrl } : request), requestId = selected.model ? `ai:${await studyHash([clientRequestId, selected.provider, selected.model, selected.baseUrl])}` : clientRequestId, day = new Date(deps.now().getTime() + 8 * 3600000).toISOString().slice(0, 10), aiStore = await deps.getAiStore(), aiSettings = selected, reservedTokens = new TextEncoder().encode(JSON.stringify([request, item])).byteLength + aiSettings.maxOutputTokens, reservation = await aiStore.begin(owner, { requestId, day, inputHash, reservedTokens, expectedRevision: selected.revision, trace: { operationKind: 'question', ...deps.getQuestionAiTrace(), ...(selected.model ? { modelId: selected.model, provider: selected.provider } : {}) } });
        if (reservation.status === 'completed')
            return json({ status: 'duplicate', result: reservation.result });
        if (reservation.status === 'pending')
            throw new ApiFailure(409, 'ai-request-pending');
        if (reservation.status === 'failed') {
            const code = reservation.errorCode ?? 'cloud-ai-provider-error';
            throw new ApiFailure(code === 'ai-request-indeterminate' ? 409 : 502, code);
        }
        try {
            const result = await (await deps.getQuestionAi(owner, aiSettings.revision)).run(request, item, { maxOutputTokens: reservation.settings.maxOutputTokens });
            await (await deps.getAiStore()).complete(owner, requestId, inputHash, result, result.usageTokens ?? reservedTokens);
            return json({ status: 'accepted', result });
        }
        catch (error) {
            const code = error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : 'cloud-ai-provider-error';
            await (await deps.getAiStore()).fail(owner, requestId, inputHash, code);
            throw new ApiFailure(502, code);
        }
    }
    return null;
}
