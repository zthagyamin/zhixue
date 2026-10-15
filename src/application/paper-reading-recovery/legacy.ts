// @ts-expect-error TS5097: standalone Node contracts.
import {recoveryObject} from './contracts.ts';
import type {PaperReadingRecoveryMaterial} from './contracts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperNoteReceiptLocation} from '../../domain/paper-reading/index.ts';
function text(value: unknown, max = 20000): asserts value is string {
    if (typeof value !== 'string' || value.length > max) throw Error('reading-recovery-draft-text');
}
function integer(value: unknown) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error('reading-recovery-draft-number');
}
function strings(value: unknown, allowed?: string[]) {
    const record = recoveryObject(value, [], Object.keys(value as object ?? {}));
    for (const [key, entry] of Object.entries(record)) {
        text(key, 400); text(entry);
        if (allowed && !allowed.includes(key)) throw Error('reading-recovery-draft-slot');
    }
}
function origin(raw: unknown) {
    const value = recoveryObject(raw, ['kind', 'version'], ['path', 'sourceId', 'sourceRevision', 'pageId', 'url', 'filename']);
    if (!['vault', 'notion', 'upload'].includes(value.kind as string)) throw Error('reading-recovery-draft-origin');
    for (const [key, entry] of Object.entries(value)) {
        if (key === 'sourceRevision') integer(entry); else text(entry, 1000);
    }
}
function words(raw: unknown, paper: PaperReadingRecoveryMaterial) {
    if (!Array.isArray(raw) || raw.length > 10000) throw Error('reading-recovery-draft-words');
    const ids = new Set<string>(), paragraphs = paper.sections.flatMap(section => section.paragraphs);
    for (const item of raw) {
        const word = recoveryObject(item, ['id', 'term', 'meaning', 'context', 'sourceNote', 'paperTitle', 'section', 'page', 'paragraphId', 'start', 'end'], ['locator']);
        for (const [key, value] of Object.entries(word)) {
            if (['page', 'start', 'end'].includes(key)) integer(value); else text(value);
        }
        const source = paragraphs.find(paragraph => paragraph.id === word.paragraphId);
        if (!source || ids.has(word.id as string) || (word.end as number) <= (word.start as number)
            || source.rawEn.slice(word.start as number, word.end as number) !== word.term) throw Error('reading-recovery-draft-word-source');
        ids.add(word.id as string);
    }
}
function request(raw: unknown, paper: PaperReadingRecoveryMaterial) {
    const value = recoveryObject(raw, ['requestId', 'localLibraryId', 'expectedRevision', 'entries'], ['accountLibraryId']);
    for (const key of ['requestId', 'localLibraryId', 'expectedRevision', 'accountLibraryId']) if (value[key] !== undefined) text(value[key], 1000);
    words(value.entries, paper);
}
function receipt(raw: unknown) {
    const value = recoveryObject(raw, ['requestId', 'localLibraryId', 'results', 'gatewayRecognized'], ['backupRelative']);
    if (typeof value.gatewayRecognized !== 'boolean' || !Array.isArray(value.results)) throw Error('reading-recovery-draft-receipt');
    for (const key of ['requestId', 'localLibraryId', 'backupRelative']) if (value[key] !== undefined) text(value[key], 1000);
    for (const rawResult of value.results) {
        const result = recoveryObject(rawResult, ['id', 'status'], ['message']);
        if (!['added', 'existing', 'conflict'].includes(result.status as string)) throw Error('reading-recovery-draft-receipt');
        for (const entry of Object.values(result)) text(entry);
    }
}
function noteRequest(raw: unknown) {
    const value = recoveryObject(raw, ['requestId', 'localLibraryId', 'destination', 'title', 'markdown'], ['accountLibraryId', 'source']);
    for (const key of ['requestId', 'localLibraryId', 'title', 'markdown', 'accountLibraryId']) if (value[key] !== undefined) text(value[key], 500000);
    const target = recoveryObject(value.destination, ['kind'], ['directory', 'label', 'sourceId', 'sourceRevision', 'url']);
    if (target.kind === 'obsidian') {
        recoveryObject(target, ['kind', 'directory'], ['label']); text(target.directory, 1000);
    } else if (target.kind === 'notion') {
        recoveryObject(target, ['kind', 'sourceId', 'sourceRevision'], ['label', 'url']); integer(target.sourceRevision); text(target.sourceId, 1000);
    } else throw Error('reading-recovery-draft-destination');
    for (const key of ['label', 'url']) if (target[key] !== undefined) text(target[key], 1000);
    if (value.source !== undefined) origin(value.source);
}
/** Strict allowlist for the unchanged old PaperDraft; no unknown credentials are copied. */
export function validateRecoveryPaperDraft(raw: unknown, paper: PaperReadingRecoveryMaterial): void {
    const value = recoveryObject(raw, ['revision', 'selected', 'slots', 'summaries', 'position', 'selfcheck'],
        ['slotTemplate', 'templateSlots', 'ingestedVocabulary', 'sourceNoteOverride', 'pending', 'receipt', 'pendingNote', 'noteReceipt']);
    integer(value.revision); integer(value.position);
    if ((value.position as number) >= paper.sections.reduce((sum, section) => sum + section.paragraphs.length, 0)) throw Error('reading-recovery-draft-position');
    words(value.selected, paper); if (value.ingestedVocabulary !== undefined) words(value.ingestedVocabulary, paper);
    strings(value.slots, ['motivation', 'baselineFailure', 'coreMechanism', 'keyEvidence', 'limitations']); strings(value.summaries,paper.sections.flatMap(section=>section.paragraphs.map(paragraph=>paragraph.id))); strings(value.selfcheck);
    if (value.sourceNoteOverride !== undefined) text(value.sourceNoteOverride, 1000);
    if (value.slotTemplate !== undefined && !['empirical', 'theory', 'free'].includes(value.slotTemplate as string)) throw Error('reading-recovery-draft-template');
    if (value.templateSlots !== undefined) {
        const templates = recoveryObject(value.templateSlots, [], ['empirical', 'theory', 'free']);
        for (const [key, entries] of Object.entries(templates)) strings(entries, key === 'empirical'
            ? ['motivation', 'baselineFailure', 'coreMechanism', 'keyEvidence', 'limitations']
            : key === 'theory' ? ['thesis', 'prior', 'argument', 'conclusion'] : ['problem', 'approach', 'limits']);
    }
    if (value.pending !== undefined) request(value.pending, paper);
    if (value.receipt !== undefined) receipt(value.receipt);
    if (value.pendingNote !== undefined) noteRequest(value.pendingNote);
    if (value.noteReceipt !== undefined) {
        const note = recoveryObject(value.noteReceipt, ['requestId', 'localLibraryId', 'status', 'kind'], ['path', 'url', 'day']);
        if (note.status !== 'written' || !['obsidian', 'notion'].includes(note.kind as string)) throw Error('reading-recovery-draft-note-receipt');
        for (const entry of Object.values(note)) text(entry, 1000);
        if (!paperNoteReceiptLocation(note)) throw Error('reading-recovery-draft-note-receipt-location');
    }
}
