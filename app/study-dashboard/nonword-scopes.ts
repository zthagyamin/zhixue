import type { NonWordHostScope } from '../../src/application/nonword-study';
import type { PracticeItem } from '../companion-plan-client';
import type { DashboardController } from './use-dashboard-controller';
import { resolveAccountStudyItem } from '../account-study-runtime';
import type { ExtraPracticeSnapshot } from '../extra-practice-session';
import type { PluginType } from '../plugin-routing';
import {nativeScopeReference} from '../../src/infrastructure/course-study';
type Model = Pick<DashboardController, 'isDemoMode' | 'accountLibraryId' | 'data' | 'accountLoaded' | 'workspaceId' | 'sessionUser' | 'practiceItems' | 'currentDay' | 'activeTaskScope'>;
/** Bind the exact published item, independently of its chosen presentation. */
export function inlineNonWordScope(model: Model, item: PracticeItem): NonWordHostScope | undefined {
    if (model.isDemoMode || !item.contentHash || !(model.accountLibraryId || model.data.localLibraryId))
        return;
    const source = model.accountLoaded ? resolveAccountStudyItem(model.accountLoaded, item) : null;
    const scope: NonWordHostScope = { workspaceId: model.workspaceId, ownerId: model.accountLoaded ? model.sessionUser?.userId ?? model.workspaceId : model.workspaceId,
        libraryId: model.accountLibraryId ?? model.data.localLibraryId!, snapshotId: source?.bundle.snapshot.snapshotId ?? 'local',
        itemKey: source?.item.itemKey ?? `practice:${item.itemId}`, contentHash: item.contentHash,
        groupId: JSON.stringify(['inline', model.practiceItems?.map(item => [item.itemId, item.contentHash])]),
        roundId: JSON.stringify([model.currentDay, 'inline', model.activeTaskScope?.taskId ?? null]), cloud: Boolean(model.accountLoaded),
        ...(source?.item.kind==='practice'&&(['code','calculation'].includes(source.item.practice.questionType)
            ||source.item.learningSupport?.schemaVersion===2&&'task' in source.item.learningSupport)?{courseReference:{item:source.item,snapshot:source.bundle.snapshot}}:{}) };
    return {...scope, ...nativeScopeReference(scope, item)};
}
import { practiceGroup } from '../practice-order';
import { stableStudyItemKey } from '../dynamic-ui-model';
export function inlinePracticeGroup(model: Pick<DashboardController, 'normalizedSubjects'>, item: PracticeItem) {
    const key = stableStudyItemKey(item), matches = model.normalizedSubjects.filter(subject => subject.items.some(source => key ? stableStudyItemKey(source) === key : source.itemId === item.itemId && source.fingerprint === item.fingerprint));
    return matches.length === 1 ? { id: matches[0].id, label: matches[0].name } : practiceGroup(item);
}
export function scopeForNonWord(source: {
    workspaceId: string;
    ownerId: string;
    libraryId?: string | null;
    loaded: Parameters<typeof resolveAccountStudyItem>[0] | null;
    enabled: boolean;
}, item: {
    contentHash?: string;
}, itemKey: string, groupId: string, roundId: string, temporary = false): NonWordHostScope | undefined {
    if (!source.enabled || !source.libraryId || !item.contentHash)
        return;
    const original=source.loaded?resolveAccountStudyItem(source.loaded,item):null;
    const scope: NonWordHostScope = { workspaceId: source.workspaceId, ownerId: source.ownerId, libraryId: source.libraryId, snapshotId: original?.bundle.snapshot.snapshotId ?? 'local', itemKey, contentHash: item.contentHash, groupId, roundId, cloud: Boolean(source.loaded), ...(temporary ? { temporary: true } : {}),
        ...(original?.item.kind==='practice'&&(['code','calculation'].includes(original.item.practice.questionType)
            ||original.item.learningSupport?.schemaVersion===2&&'task' in original.item.learningSupport)?{courseReference:{item:original.item,snapshot:original.bundle.snapshot}}:{}) };
    return {...scope, ...nativeScopeReference(scope, item)};
}
export function nonWordRoundMembers<T extends {
    contentHash?: string;
    eventKind?: string;
    word?: unknown;
    pluginType?: string;
}>(source: {
    loaded: Parameters<typeof resolveAccountStudyItem>[0] | null;
}, items: readonly T[], keyOf: (item: T, index: number) => string, modeOf: (item: T, index: number) => string) {
    return items.flatMap((item, index) => {
        const mode = modeOf(item, index);
        if (!item.contentHash || item.eventKind === 'word' || item.word || !['recall', 'quiz', 'code', 'calculation', 'flashcard'].includes(mode))
            return [];
        return [{ itemKey: keyOf(item, index), snapshotId: source.loaded ? resolveAccountStudyItem(source.loaded, item).bundle.snapshot.snapshotId : 'local', contentHash: item.contentHash, kind: 'practice' as const, mode }];
    });
}
/** Freeze extra-practice inputs while leaving scheduling authority outside this composition. */
export function makeExtra(input: {
    scopeKey: string;
    workspaceId: string;
    day: string;
    title: string;
    source: ExtraPracticeSnapshot['source'];
    scope: Parameters<typeof scopeForNonWord>[0];
    selected: {
        item: ExtraPracticeSnapshot['items'][number];
        key: string;
        sourceMode: PluginType;
        mode: PluginType;
    }[];
}): ExtraPracticeSnapshot {
    return { scopeKey: input.scopeKey, guidanceScope: input.workspaceId, sourcePreferenceScope: JSON.stringify([input.workspaceId, input.scope.libraryId ?? 'local']), recoveryDay: input.day, title: input.title, source: { title: input.source.title, scope: input.source.scope }, items: input.selected.map(row => ({ ...row.item })), sourceModes: input.selected.map(row => row.sourceMode), modes: input.selected.map(row => row.mode), recoveryScopes: input.selected.map(row => scopeForNonWord(input.scope, row.item, row.key, input.scopeKey, input.scopeKey, true)) };
}
