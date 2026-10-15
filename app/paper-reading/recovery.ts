// @ts-expect-error TS5097: standalone Node contracts.
import {openStudyDb} from '../local-study-db.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePaperStudyData} from '../paper-study.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperFingerprint} from '../paper-draft-store.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingRecovery} from '../../src/application/paper-reading-recovery/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingRecoveryIndexedDbPort} from '../../src/infrastructure/paper-reading-recovery/index.ts';
import type {PaperReadingRecoveryScope} from '../../src/application/paper-reading-recovery';

export function createPaperReadingRecoveryService(scope: PaperReadingRecoveryScope, options: {isCurrent?: () => boolean; openDb?: () => Promise<IDBDatabase>} = {}) {
    const hash = async (text: string) => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    };
    return createPaperReadingRecovery({scope, isCurrent: options.isCurrent, hash,
        codec: {parseMaterial: parsePaperStudyData, fingerprint: value => paperFingerprint(parsePaperStudyData(value))},
        port: createPaperReadingRecoveryIndexedDbPort({scope, open: options.openDb ?? openStudyDb, isCurrent: options.isCurrent})});
}
