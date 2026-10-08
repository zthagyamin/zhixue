export type FlashcardMask = {
    id: string;
    x: string;
    y: string;
    width: string;
    height: string;
    answer: string;
};
type Base = {
    schemaVersion: 1;
    type: 'flashcard';
    parentId?: string;
    criteria?: never;
    hints?: never;
};
export type FlashcardSupport = Base & ({
    mode: 'bidirectional';
    direction?: 'forward' | 'reverse';
} | {
    mode: 'occlusion';
    sourceKey: string;
    sourceVersion: string;
    assetId: string;
    assetVersion: string;
    masks: FlashcardMask[];
    activeMaskId?: string;
});
function object(raw: unknown, keys: string[]) { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k)))
    throw Error('invalid-flashcard-support'); return raw as Record<string, unknown>; }
function id(raw: unknown, max = 160) { if (typeof raw !== 'string' || !raw.length || raw.length > max || !/^[a-zA-Z0-9:_.-]+$/.test(raw))
    throw Error('invalid-flashcard-id'); return raw; }
function coordinate(raw: unknown) { if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/.test(raw) || Number(raw) > 100)
    throw Error('invalid-flashcard-mask'); return Math.round(Number(raw) * 100); }
export function parseFlashcardSupport(raw: unknown): FlashcardSupport {
    const base = raw as Record<string, unknown>, v = object(raw, base?.mode === 'bidirectional' ? ['schemaVersion', 'type', 'mode', 'parentId', 'direction'] : ['schemaVersion', 'type', 'mode', 'parentId', 'sourceKey', 'sourceVersion', 'assetId', 'assetVersion', 'masks', 'activeMaskId']);
    if (v.schemaVersion !== 1 || v.type !== 'flashcard')
        throw Error('invalid-flashcard-support');
    // Parent IDs follow the existing content identity contract, including Unicode.
    // eslint-disable-next-line no-control-regex
    if (v.parentId !== undefined && (typeof v.parentId !== 'string' || !v.parentId || v.parentId.length > 200 || v.parentId !== v.parentId.trim() || /[\\/\x00-\x1f\x7f]/.test(v.parentId)))
        throw Error('invalid-flashcard-parent');
    if (v.mode === 'bidirectional') {
        if (v.direction !== undefined && (typeof v.direction !== 'string' || !['forward', 'reverse'].includes(v.direction)) || Boolean(v.parentId) !== Boolean(v.direction))
            throw Error('invalid-flashcard-direction');
    }
    else if (v.mode === 'occlusion') {
        for (const k of ['sourceKey', 'sourceVersion', 'assetVersion'])
            if (typeof v[k] !== 'string' || !/^[a-f0-9]{64}$/.test(v[k] as string))
                throw Error('invalid-flashcard-asset');
        id(v.assetId, 80);
        if (!Array.isArray(v.masks) || !v.masks.length || v.masks.length > 24)
            throw Error('invalid-flashcard-masks');
        const ids = new Set<string>();
        for (const rawMask of v.masks) {
            const m = object(rawMask, ['id', 'x', 'y', 'width', 'height', 'answer']), key = id(m.id, 64);
            if (ids.has(key))
                throw Error('duplicate-flashcard-mask');
            ids.add(key);
            const x = coordinate(m.x), y = coordinate(m.y), w = coordinate(m.width), h = coordinate(m.height);
            if (w <= 0 || h <= 0 || x + w > 10000 || y + h > 10000 || typeof m.answer !== 'string' || !m.answer.trim() || m.answer.length > 2000)
                throw Error('invalid-flashcard-mask');
        }
        if (Boolean(v.parentId) !== Boolean(v.activeMaskId) || v.activeMaskId !== undefined && (typeof v.activeMaskId !== 'string' || !ids.has(v.activeMaskId)))
            throw Error('invalid-flashcard-active-mask');
    }
    else
        throw Error('invalid-flashcard-mode');
    return structuredClone(v) as FlashcardSupport;
}
export async function flashcardChildId(parent: string, variant: string) { const bytes = new TextEncoder().encode(JSON.stringify(['flashcard-child-v1', parent, variant])); const hash = await crypto.subtle.digest('SHA-256', bytes); return 'flashcard:' + Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, '0')).join(''); }
