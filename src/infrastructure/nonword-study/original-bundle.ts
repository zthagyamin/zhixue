import type { StudyBundle, StudyItemVersion, StudySnapshot } from '../../domain/sync';
import type { AttemptBinding } from '../../domain/learning-attempt';
type Options = {
    binding: AttemptBinding;
    snapshot: StudySnapshot;
    fetcher?: typeof fetch;
    current: () => boolean;
    parseItem: (raw: unknown) => Promise<StudyItemVersion>;
    validateBundle: (raw: unknown) => Promise<StudyBundle>;
    cache: (bundle: StudyBundle) => Promise<unknown>;
};
/** Read the complete authenticated original snapshot, without adopting a new head. */
export async function cacheOriginalPendingBundle(options: Options): Promise<StudyBundle> {
    const { binding, snapshot } = options;
    if (snapshot.libraryId !== binding.libraryId || snapshot.snapshotId !== binding.snapshotId
        || !snapshot.items.some(member => member.itemKey === binding.itemKey && member.contentHash === binding.contentHash))
        throw Error('pending-original-bundle-binding');
    const items: StudyItemVersion[] = [];
    let position = 0;
    do {
        if (!options.current())
            throw Error('pending-original-owner-changed');
        const query = new URLSearchParams({ action: 'items', libraryId: binding.libraryId,
            snapshotId: binding.snapshotId, expectedUserId: binding.ownerId, position: String(position), limit: '20' });
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
        let page: Record<string, unknown>;
        try {
            const response = await (options.fetcher ?? fetch)(`/api/account-study?${query}`, {
                credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            });
            page = await response.json() as Record<string, unknown>;
            if (!response.ok)
                throw Error(String(page.error ?? 'pending-original-unavailable'));
        }
        finally {
            clearTimeout(timer);
        }
        if (!options.current())
            throw Error('pending-original-owner-changed');
        if (!Array.isArray(page.items) || page.items.length > 20)
            throw Error('pending-original-items-invalid');
        for (const raw of page.items)
            items.push(await options.parseItem(raw));
        const next = position + page.items.length;
        if (next > snapshot.items.length)
            throw Error('pending-original-items-overflow');
        if (page.nextPosition === null) {
            if (next !== snapshot.items.length)
                throw Error('pending-original-items-incomplete');
            break;
        }
        if (page.nextPosition !== next || next <= position || next >= snapshot.items.length)
            throw Error('pending-original-items-cursor');
        position = next;
    } while (position < snapshot.items.length);
    const bundle = await options.validateBundle({ snapshot, items });
    if (!options.current())
        throw Error('pending-original-owner-changed');
    await options.cache(bundle);
    if (!options.current())
        throw Error('pending-original-owner-changed');
    return bundle;
}
