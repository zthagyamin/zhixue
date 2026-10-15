// @ts-expect-error TS5097: standalone Node regression tests.
import {paperOriginalScope, paperOriginalMetadata} from '../../domain/paper-reading/index.ts';
import type {PaperOriginalScope, PaperOriginalMetadata} from '../../domain/paper-reading/index';

export type PaperOriginalFile = {filename: string; bytes: Uint8Array};
export type PaperOriginalRecord = PaperOriginalMetadata & {bytes: Uint8Array};

export interface PaperOriginalCache {
  save(scope: PaperOriginalScope, file: PaperOriginalFile): Promise<void>;
  read(scope: PaperOriginalScope): Promise<PaperOriginalFile | null>;
}

export interface PaperOriginalCacheStore {
  read(scope: PaperOriginalScope): Promise<PaperOriginalRecord | null>;
  /** Atomically preserve the first record; conflicting bytes must reject. */
  save(record: PaperOriginalRecord): Promise<void>;
}

export type PaperOriginalFingerprint = (bytes: Uint8Array) => Promise<string>;

export function createPaperOriginalCacheService(ports: {
  store: PaperOriginalCacheStore;
  fingerprint: PaperOriginalFingerprint;
}): PaperOriginalCache {
  return {
    async save(inputScope, file) {
      const scope = paperOriginalScope(inputScope);
      if (!(file.bytes instanceof Uint8Array)) throw new Error('paper-original-invalid-bytes');
      const metadata = paperOriginalMetadata({schemaVersion: 1, scope, filename: file.filename, byteLength: file.bytes.byteLength}, scope);
      // Callers (including PDF extraction) may mutate or detach their own buffer.
      const bytes = new Uint8Array(file.bytes);
      if (await ports.fingerprint(bytes) !== scope.sourceVersion) {
        throw new Error('paper-original-fingerprint-mismatch');
      }
      await ports.store.save({...metadata, bytes});
    },
    async read(inputScope) {
      const scope = paperOriginalScope(inputScope);
      const record = await ports.store.read(scope);
      if (record === null) return null;
      const metadata = paperOriginalMetadata(record, scope);
      if (!(record.bytes instanceof Uint8Array) || record.bytes.byteLength !== metadata.byteLength) {
        throw new Error('paper-original-corrupt-size');
      }
      const bytes = new Uint8Array(record.bytes);
      if (await ports.fingerprint(bytes) !== scope.sourceVersion) {
        throw new Error('paper-original-corrupt-fingerprint');
      }
      return {filename: metadata.filename, bytes};
    },
  };
}
