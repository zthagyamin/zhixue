// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingClockKey, paperReadingClockScope} from './contracts.ts';
import type {PaperReadingClockScope, PaperReadingClockState, PaperReadingClockStorePort} from './contracts';

export type PaperReadingGroup = {groupId: string; elapsedMs: number; paused: boolean; completed: boolean};
export type PaperReadingGroupsCheckpoint = {
    schemaVersion: 1;
    scope: PaperReadingClockScope;
    revision: number;
    operationId: string;
    /** Immutable historical offset from V1; V1 is never written by group learning. */
    legacyElapsedMs: number;
    groups: PaperReadingGroup[];
};
export interface PaperReadingGroupsStorePort {
    readGroups(scope: PaperReadingClockScope): Promise<PaperReadingGroupsCheckpoint | null>;
    saveGroups(scope: PaperReadingClockScope, value: PaperReadingGroupsCheckpoint, expectedRevision: number): Promise<PaperReadingGroupsCheckpoint>;
}
export type PaperReadingGroupClockStorePort = Pick<PaperReadingClockStorePort, 'read'> & PaperReadingGroupsStorePort;
export type PaperReadingGroupClockState = PaperReadingClockState & {
    groupId: string | null;
    groupCompleted: boolean;
    completedGroupCount: number;
    materialElapsedMs: number;
};
export function paperReadingGroupsKey(scope: PaperReadingClockScope): string {
    return paperReadingClockKey(scope).replace('paper-reading-clock:v1:', 'paper-reading-groups:v1:');
}
export function readPaperReadingGroupsCheckpoint(value: unknown, scope: PaperReadingClockScope): PaperReadingGroupsCheckpoint {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('corrupt-reading-groups');
    const record = value as PaperReadingGroupsCheckpoint;
    const keys = ['schemaVersion', 'scope', 'revision', 'operationId', 'legacyElapsedMs', 'groups'];
    if (Object.keys(record).some(key => !keys.includes(key)) || record.schemaVersion !== 1
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || typeof record.operationId !== 'string' || !record.operationId.trim()
        || !Number.isSafeInteger(record.legacyElapsedMs) || record.legacyElapsedMs < 0
        || !Array.isArray(record.groups) || record.groups.length === 0
        || paperReadingClockKey(record.scope) !== paperReadingClockKey(scope)) throw Error('corrupt-reading-groups');
    const ids = new Set<string>();
    const groups = record.groups.map((group, index) => {
        if (!group || Object.keys(group).some(key => !['groupId', 'elapsedMs', 'paused', 'completed'].includes(key))
            || typeof group.groupId !== 'string' || !group.groupId.trim() || ids.has(group.groupId)
            || !Number.isSafeInteger(group.elapsedMs) || group.elapsedMs < 0
            || typeof group.paused !== 'boolean' || typeof group.completed !== 'boolean'
            || group.completed && !group.paused || index < record.groups.length - 1 && !group.completed) throw Error('corrupt-reading-groups');
        ids.add(group.groupId);
        return {groupId: group.groupId, elapsedMs: group.elapsedMs, paused: group.paused, completed: group.completed};
    });
    return {schemaVersion: 1, scope: paperReadingClockScope(record.scope), revision: record.revision,
        operationId: record.operationId, legacyElapsedMs: record.legacyElapsedMs, groups};
}
/** Append-only group boundaries, immutable completed groups and monotonic effective time. */
export function validatePaperReadingGroupsUpdate(current: PaperReadingGroupsCheckpoint | null, next: PaperReadingGroupsCheckpoint, expected: number) {
    if ((current?.revision ?? 0) !== expected || next.revision !== expected + 1) throw Error('reading-groups-conflict');
    if (!current) {
        if (next.groups.length !== 1 || next.groups[0].elapsedMs !== 0 || next.groups[0].completed) throw Error('reading-groups-initial-conflict');
        return;
    }
    if (current.legacyElapsedMs !== next.legacyElapsedMs || next.groups.length < current.groups.length
        || next.groups.length > current.groups.length + 1) throw Error('reading-groups-history-conflict');
    for (let i = 0; i < current.groups.length; i++) {
        const before = current.groups[i], after = next.groups[i];
        if (before.completed && JSON.stringify(before) !== JSON.stringify(after)
            || before.groupId !== after.groupId || after.elapsedMs < before.elapsedMs) throw Error('reading-groups-history-conflict');
    }
    if (next.groups.length > current.groups.length) {
        const previous = next.groups[next.groups.length - 2], added = next.groups[next.groups.length - 1];
        if (!previous.completed || added.elapsedMs !== 0 || added.paused || added.completed) throw Error('reading-groups-boundary-conflict');
    }
}
