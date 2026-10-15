// @ts-expect-error TS5097: standalone Node regression tests.
import {openStudyDb} from '../local-study-db.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {createPaperOriginalCacheService} from '../../src/application/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {createPaperOriginalCacheStore, createPaperOriginalIndexedDbPort, sha256PaperOriginal} from '../../src/infrastructure/paper-reading/index.ts';
export type {PaperOriginalScope, PaperOriginalCache} from '../../src/application/paper-reading/index';

export function createPaperOriginalCache() {
  const store = createPaperOriginalCacheStore(createPaperOriginalIndexedDbPort(openStudyDb));
  return createPaperOriginalCacheService({store, fingerprint: sha256PaperOriginal});
}
