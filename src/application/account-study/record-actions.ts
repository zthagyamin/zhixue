import type { Authenticated } from './ports';
import type { AccountContext } from './context';
import type { AccountReply } from './result';
// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { fields, id, count, validated } from './request-values.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { accountValue as json } from './result.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseStudyRecord, studyObject, studyCount } from '../../domain/sync/index.ts';
export async function executeRecordAction(body: Record<string, unknown>, auth: Authenticated, context: AccountContext): Promise<AccountReply> {
    const { deps, requireRole, scope } = context;
    const p = auth.principal, action = body.action, parseStudySnapshot = deps.parseSnapshot, parseStudyItem = deps.parseItem;
    if (typeof action !== 'string' || !['begin-snapshot', 'stage-items', 'complete-snapshot', 'append-records'].includes(action))
        throw new ApiFailure(400, 'unsupported-action');
    if (action !== 'append-records')
        requireRole(p, 'device');
    else if (p.kind === 'device')
        requireRole(p, 'device');
    if (action === 'begin-snapshot') {
        fields(body, ['action', 'snapshot'], ['libraryId']);
        const owner = await scope(p, body.libraryId), snapshot = await validated(() => parseStudySnapshot(body.snapshot));
        await (await deps.getStudyStore()).beginSnapshot(owner, snapshot);
        return json({ accepted: true });
    }
    if (action === 'stage-items') {
        fields(body, ['action', 'snapshotId', 'entries'], ['libraryId']);
        const rawEntries = body.entries;
        if (!Array.isArray(rawEntries) || rawEntries.length < 1 || rawEntries.length > 20)
            throw new ApiFailure(400, 'invalid-upload-page');
        const entries = await validated(() => Promise.all(rawEntries.map(async (raw) => {
            const entry = studyObject(raw, ['position', 'item']);
            studyCount(entry.position, 'position');
            return { position: entry.position, item: await parseStudyItem(entry.item) };
        })));
        await (await deps.getStudyStore()).stageSnapshotItems(await scope(p, body.libraryId), id(body.snapshotId, 'snapshot'), entries);
        return json({ accepted: true });
    }
    if (action === 'complete-snapshot') {
        fields(body, ['action', 'snapshotId', 'expectedRevision'], ['libraryId']);
        return json(await (await deps.getStudyStore()).completeSnapshot(await scope(p, body.libraryId), id(body.snapshotId, 'snapshot'), count(body.expectedRevision, 'expected-revision')));
    }
    fields(body, ['action', 'records'], ['libraryId']);
    if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 5)
        throw new ApiFailure(400, 'invalid-record-batch');
    const owner = await scope(p, body.libraryId), records = await validated(() => Promise.all((body.records as unknown[]).map(parseStudyRecord)));
    if (records.some(record => record.libraryId !== owner.libraryId))
        throw new ApiFailure(403, 'library-mismatch');
    const store = await deps.getStudyStore(), results = [];
    for (const record of records) {
        try {
            if (record.provenanceMode === 'task')
                await (await deps.getPlanStore()).validateTaskRecord(owner, record);
            const result = await store.appendRecord(owner, record);
            results.push({ eventId: record.event.eventId, ...result, ...(result.durable ? { receipt: { schemaVersion: 1, libraryId: owner.libraryId, eventId: record.event.eventId,
                        envelopeHash: record.envelopeHash, target: 'cloud', status: 'acked', revision: result.sequence } } : {}) });
        }
        catch (error) {
            const code = error instanceof Error ? error.message : '';
            if (!['unknown-study-snapshot', 'study-record-membership', 'study-record-item-binding', 'invalid-word-stage-transition',
                'invalid-practice-stage-transition', 'invalid-study-practice-mode', 'inconsistent-study-rating', 'invalid-study-start-stage', 'invalid-study-scheduling', 'invalid-study-scheduling-time', 'invalid-legacy-content',
                'course-task-word', 'course-task-unreviewed', 'course-task-prompt-mismatch', 'course-task-missing-conditions', 'unfocused-recall-question',
                'course-evidence-required', 'course-evaluation-mismatch', 'course-formal-binding', 'course-evidence-unsupported',
                'duplicate-study-attempt', 'study-parent-cycle', 'study-round-fork', 'terminal-study-round', 'study-record-parent-binding', 'study-record-parent-time',
                'study-record-parent-stage', 'study-record-round-binding', 'study-parent-conflict', 'task-plan-not-approved', 'task-plan-binding', 'task-completion-binding', 'task-evidence-required', 'task-evidence-not-yet-verified'].includes(code))
                throw error;
            results.push({ eventId: record.event.eventId, status: 'blocked', durable: false, error: code, retryable: code === 'unknown-study-snapshot' });
        }
    }
    return json({ results });
}
