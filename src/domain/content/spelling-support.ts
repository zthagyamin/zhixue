export type SpellingSupport = {
    schemaVersion: 1;
    type: 'spelling';
    word: string;
    criteria?: never;
    hints?: never;
    segments: {
        letters: string;
        phoneme: string;
        isTricky?: boolean;
    }[];
};
function closed(raw: unknown, keys: string[]): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key)))
    throw Error('invalid-spelling-support'); return raw as Record<string, unknown>; }
export function parseSpellingSupport(raw: unknown): SpellingSupport {
    const value = closed(raw, ['schemaVersion', 'type', 'word', 'segments']);
    if (value.schemaVersion !== 1 || value.type !== 'spelling')
        throw Error('unsupported-spelling-support');
    if (typeof value.word !== 'string' || !value.word.length || value.word.length > 100 || !/^[a-zA-Z' -]+$/.test(value.word) || value.word.trim() !== value.word)
        throw Error('invalid-spelling-word');
    if (!Array.isArray(value.segments) || !value.segments.length || value.segments.length > 100)
        throw Error('invalid-spelling-segments');
    for (const rawSegment of value.segments) {
        const segment = closed(rawSegment, ['letters', 'phoneme', 'isTricky']);
        if (typeof segment.letters !== 'string' || !segment.letters.length || typeof segment.phoneme !== 'string' || !segment.phoneme.trim() || segment.phoneme.length > 80 || /[\p{Cc}]/u.test(segment.phoneme) || segment.isTricky !== undefined && typeof segment.isTricky !== 'boolean')
            throw Error('invalid-spelling-segment');
    }
    if (value.segments.map(segment => segment.letters).join('') !== value.word)
        throw Error('spelling-mapping-mismatch');
    return structuredClone(value) as SpellingSupport;
}
