// @ts-expect-error TS5097: standalone Node contracts.
import {openStudyDb} from '../local-study-db.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingLocalStore,createPaperReadingIndexedDbPort} from '../../src/infrastructure/paper-reading/index.ts';
export function createPaperReadingStore(){return createPaperReadingLocalStore(createPaperReadingIndexedDbPort(openStudyDb));}
