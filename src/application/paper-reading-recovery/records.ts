// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePaperReadingWorkspace, paperReadingUnit, preparedPaperTaskRecipe} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {readPaperReadingClockCheckpoint, readPaperReadingGroupsCheckpoint} from '../paper-reading-clock/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {recoveryObject, recoveryJson, recoveryScope, recoveryDigest, recoverySize, PAPER_READING_RECOVERY_MAX_RECORDS} from './contracts.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateRecoveryPaperDraft} from './legacy.ts';
import type {PaperReadingSource, PaperReadingTaskV1} from '../../domain/paper-reading';
import type {PaperReadingRecoveryCodec, PaperReadingRecoveryKind, PaperReadingRecoveryMaterial, PaperReadingRecoveryRow, PaperReadingRecoveryScope} from './contracts';

const same = (a: unknown, b: unknown) => canonicalAttemptJson(a) === canonicalAttemptJson(b);
function parts(key: string, prefix: string, count: number): unknown[] {
    if (!key.startsWith(prefix)) throw Error('reading-recovery-record-key');
    let result: unknown; try {result = JSON.parse(key.slice(prefix.length));} catch {throw Error('reading-recovery-record-key');}
    if (!Array.isArray(result) || result.length !== count || prefix + JSON.stringify(result) !== key) throw Error('reading-recovery-record-key');
    return result;
}
/** Synchronous identity allowlist shared with the transaction adapter. */
export function identifyRecoveryRow(inputScope: PaperReadingRecoveryScope, raw: PaperReadingRecoveryRow): {type: PaperReadingRecoveryKind; identity: unknown[]} {
    const scope = recoveryScope(inputScope), row = recoveryObject(raw, ['id', 'workspaceId', 'kind', 'value'], ['updatedAt']);
    for (const key of ['id', 'workspaceId', 'kind']) if (typeof row[key] !== 'string') throw Error('reading-recovery-record-key');
    const value = row as PaperReadingRecoveryRow;
    if (value.workspaceId === scope.ownerId && value.kind === `paper-document:${scope.libraryId}` && value.id === `${scope.ownerId}:${value.kind}`) return {type: 'materials', identity: []};
    if (value.workspaceId === scope.ownerId && value.kind.startsWith('paper-draft:')) {
        const identity = parts(value.kind, 'paper-draft:', 2);
        if (identity[0] !== scope.libraryId || value.id !== `${scope.ownerId}:${value.kind}`) throw Error('reading-recovery-scope');
        recoveryDigest(identity[1]); return {type: 'draft', identity};
    }
    if (value.workspaceId === 'paper-reading-workspaces:v1') {
        const identity = parts(value.kind, 'paper-reading:v1:', 3);
        if (identity[0] !== scope.ownerId || identity[1] !== scope.libraryId || value.id !== value.workspaceId + ':' + value.kind) throw Error('reading-recovery-scope');
        return {type: 'workspace', identity};
    }
    if (value.workspaceId === 'paper-reading-prepared:v1') {
        const identity = parts(value.id, value.workspaceId + ':', 8);
        if (identity[0] !== scope.ownerId || identity[1] !== scope.libraryId || value.kind !== JSON.stringify(identity)) throw Error('reading-recovery-scope');
        return {type: 'prepared', identity};
    }
    for (const type of ['clock', 'groups'] as const) {
        const prefix = type === 'clock' ? 'paper-reading-clock:v1' : 'paper-reading-groups:v1';
        if (value.workspaceId === scope.ownerId && value.kind === prefix) {
            const identity = parts(value.id, prefix + ':', 3);
            if (identity[0] !== scope.ownerId || identity[1] !== scope.libraryId) throw Error('reading-recovery-scope');
            recoveryDigest(identity[2]); return {type, identity};
        }
    }
    throw Error('reading-recovery-record-not-allowed');
}
function noCredentials(raw: unknown, kind: PaperReadingRecoveryKind, path: string[] = []): void {
    if (!raw || typeof raw !== 'object') return;
    if (Array.isArray(raw)) {raw.forEach((value,index)=>noCredentials(value,kind,[...path,String(index)])); return;}
    const dictionary = (kind === 'materials' && /^\d+\.paper\.sections\.\d+\.paragraphs\.\d+\.lexicon$/.test(path.join('.')))
        || (kind === 'draft' && /^paper\.sections\.\d+\.paragraphs\.\d+\.lexicon$/.test(path.join('.')))
        || (kind === 'draft' && path.join('.') === 'draft.summaries');
    for (const [key, value] of Object.entries(raw)) {
        // Only validated paper lexicons and paragraph-indexed summaries own content keys.
        // Its values still pass this guard and the exact existing material codec.
        if (!dictionary && /^(?:password|passphrase|api[_-]?key|model[_-]?key|provider[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|private[_-]?key|credentials?)$/i.test(key)) throw Error('reading-recovery-credentials-not-allowed');
        noCredentials(value,kind,[...path,key]);
    }
}
function taskFields(task: PaperReadingTaskV1 | null): void {
    if (!task) return;
    for (const reference of task.reference) recoveryObject(reference, ['point', 'paragraphId', 'quote']);
}
function evaluationFields(raw: unknown): void {
    const status = (raw as {status?: unknown})?.status;
    recoveryObject(raw, status === 'pending' ? ['status', 'reason'] : ['status', 'outcome', 'matched', 'issues', 'explanation']);
}
export async function validateRecoveryRows(scope: PaperReadingRecoveryScope, input: PaperReadingRecoveryRow[], codec: PaperReadingRecoveryCodec, hash: (text: string) => Promise<string>) {
    if (!Array.isArray(input) || input.length > PAPER_READING_RECOVERY_MAX_RECORDS) throw Error('reading-recovery-limit');
    recoverySize(input);
    const rows = input.map(raw => {
        const info = identifyRecoveryRow(scope, raw); noCredentials(raw.value,info.type);
        return {row: recoveryJson({id: raw.id, workspaceId: raw.workspaceId, kind: raw.kind, value: raw.value}), ...info};
    });
    if (new Set(rows.map(value => value.row.id)).size !== rows.length) throw Error('reading-recovery-duplicate-record');
    const materials = new Map<string, PaperReadingRecoveryMaterial>();
    const parseMaterial = async (raw: unknown, expected: unknown) => {
        recoveryDigest(expected); const paper = recoveryJson(codec.parseMaterial(raw));
        if (!same(paper, raw) || await codec.fingerprint(paper) !== expected) throw Error('reading-recovery-material-hash');
        return paper;
    };
    for (const entry of rows.filter(value => value.type === 'materials')) {
        if (!Array.isArray(entry.row.value) || entry.row.value.length > 30) throw Error('reading-recovery-materials-limit');
        for (const raw of entry.row.value) {
            const material = recoveryObject(raw, ['fingerprint', 'paper']), fingerprint = material.fingerprint;
            recoveryDigest(fingerprint);
            if (materials.has(fingerprint)) throw Error('reading-recovery-material-duplicate');
            materials.set(fingerprint, await parseMaterial(material.paper, fingerprint));
        }
    }
    // Legacy drafts embed their full original even when the material picker has no entry.
    // Validate that original before using it as a dependency; never rewrite either record.
    for(const entry of rows.filter(value=>value.type==='draft')){
        const stored=recoveryObject(entry.row.value,['paper','draft']),fingerprint=entry.identity[1] as string;
        const paper=await parseMaterial(stored.paper,fingerprint);validateRecoveryPaperDraft(stored.draft,paper);
        const existing=materials.get(fingerprint);
        if(existing&&!same(existing,paper))throw Error('reading-recovery-draft-material');
        if(!existing)materials.set(fingerprint,paper);
    }
    const requiredMaterial = (fingerprint: string) => {
        const paper = materials.get(fingerprint);
        if (!paper) throw Error('reading-recovery-required-material-missing'); return paper;
    };
    const source = (value: PaperReadingSource) => {
        if (value.ownerId !== scope.ownerId || value.libraryId !== scope.libraryId) throw Error('reading-recovery-scope');
        const paper = requiredMaterial(value.materialFingerprint);
        if (value.sourceVersion !== (paper.origin?.version ?? value.materialFingerprint)) throw Error('reading-recovery-source-version');
        const section = paper.sections.find(item => item.id === value.sectionId), first = section?.paragraphs.findIndex(item => item.id === value.paragraphs[0]?.id) ?? -1;
        if (!section || first < 0 || value.paragraphs.some((paragraph, index) => {
            const original = section.paragraphs[first + index];
            return !original || paragraph.id !== original.id || paragraph.rawEn !== original.rawEn || paragraph.pageNumber !== original.pageNumber;
        })) throw Error('reading-recovery-source-content');
    };
    for (const entry of rows) {
        const {row, type, identity} = entry;
        if (type === 'draft') {
            const stored = recoveryObject(row.value, ['paper', 'draft']), fingerprint = identity[1] as string;
            const paper = await parseMaterial(stored.paper, fingerprint);
            if (!same(paper, requiredMaterial(fingerprint))) throw Error('reading-recovery-draft-material');
            validateRecoveryPaperDraft(stored.draft, paper);
        } else if (type === 'workspace') {
            const workspace = parsePaperReadingWorkspace(row.value);
            if (workspace.unit.unitId !== identity[2]) throw Error('reading-recovery-workspace-binding');
            source(workspace.unit.source); taskFields(workspace.task);
            for (const attempt of workspace.attempts) {taskFields(attempt.task); evaluationFields(attempt.evaluation);}
            for (const operation of workspace.operations) if (operation.kind === 'feedback') evaluationFields(operation.evaluation);
        } else if (type === 'prepared') {
            const prepared = recoveryObject(row.value, ['schemaVersion', 'baseUnit', 'activeRecipeHash', 'recipes']);
            if (prepared.schemaVersion !== 1 || !Array.isArray(prepared.recipes) || !prepared.recipes.length) throw Error('reading-recovery-prepared');
            const unit = paperReadingUnit(prepared.baseUnit); source(unit.source);
            const expected = [scope.ownerId, scope.libraryId, unit.unitId, unit.source.materialFingerprint, unit.source.sourceVersion,
                unit.source.sectionId, unit.source.paragraphs.map(paragraph => paragraph.id), unit.goal];
            if (!same(identity, expected)) throw Error('reading-recovery-prepared-binding');
            const recipes = new Set<string>();
            for (const raw of prepared.recipes) {
                const recipe = recoveryObject(raw, ['recipeHash', 'packet']); recoveryDigest(recipe.recipeHash);
                if (recipes.has(recipe.recipeHash) || await hash(preparedPaperTaskRecipe(unit, recipe.packet)) !== recipe.recipeHash) throw Error('reading-recovery-prepared-hash');
                recipes.add(recipe.recipeHash);
            }
            if (!recipes.has(prepared.activeRecipeHash as string)) throw Error('reading-recovery-prepared-active');
        } else if (type === 'clock' || type === 'groups') {
            const clockScope = {...scope, materialFingerprint: identity[2] as string}; requiredMaterial(clockScope.materialFingerprint);
            if (type === 'clock') readPaperReadingClockCheckpoint(row.value, clockScope);
            else readPaperReadingGroupsCheckpoint(row.value, clockScope);
        }
    }
    return {rows: rows.map(entry => entry.row), types: rows.map(entry => entry.type), materials};
}
