// @ts-expect-error TS5097: standalone Node regression tests.
import {paperOriginalScope, paperOriginalMetadata} from '../../domain/paper-reading/index.ts';
import type {PaperOriginalScope} from '../../domain/paper-reading/index';
import type {PaperOriginalCacheStore, PaperOriginalRecord} from '../../application/paper-reading/index';

/** The host supplies a scoped KV store whose update is one durable transaction. */
export interface PaperOriginalKeyValuePort {
  read(key: string): Promise<unknown | null>;
  update(key: string, change: (current: unknown | null) => unknown): Promise<void>;
}

const CACHE_WORKSPACE = 'paper-original-cache:v1';
const WORKSPACE_STORE = 'workspace-records';

function cacheRecordId(key: string): string {
  if (!key.startsWith('paper-original:v1:')) throw new Error('paper-original-invalid-key');
  return `${CACHE_WORKSPACE}:${key}`;
}

function unwrapWorkspaceRecord(value: unknown, key: string): unknown | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object') throw new Error('paper-original-corrupt-envelope');
  const row = value as Record<string, unknown>;
  if (row.id !== cacheRecordId(key) || row.workspaceId !== CACHE_WORKSPACE || row.kind !== key) {
    throw new Error('paper-original-corrupt-envelope-scope');
  }
  if (row.value === null || row.value === undefined) throw new Error('paper-original-corrupt-payload');
  return row.value;
}

/** Reuse the host DB connection, without generic fallback masking corrupt rows. */
export function createPaperOriginalIndexedDbPort(open: () => Promise<IDBDatabase>): PaperOriginalKeyValuePort {
  async function database() {
    if (typeof indexedDB === 'undefined') throw new Error('本机原文件缓存不可用。');
    return open();
  }
  return {
    async read(key) {
      const id = cacheRecordId(key);
      const db = await database();
      try {
        return await new Promise<unknown | null>((resolve, reject) => {
          const tx = db.transaction(WORKSPACE_STORE, 'readonly');
          const request = tx.objectStore(WORKSPACE_STORE).get(id);
          tx.oncomplete = () => {
            try {resolve(unwrapWorkspaceRecord(request.result, key));}
            catch (error) {reject(error);}
          };
          tx.onerror = () => reject(tx.error ?? new Error('无法读取本机原文件缓存。'));
          tx.onabort = () => reject(tx.error ?? new Error('本机原文件读取已取消。'));
        });
      } finally {db.close();}
    },
    async update(key, change) {
      const id = cacheRecordId(key);
      const db = await database();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(WORKSPACE_STORE, 'readwrite');
          const store = tx.objectStore(WORKSPACE_STORE);
          const request = store.get(id);
          request.onsuccess = () => {
            try {
              const value = change(unwrapWorkspaceRecord(request.result, key));
              store.put({id, workspaceId: CACHE_WORKSPACE, kind: key, value, updatedAt: new Date().toISOString()});
            } catch (error) {tx.abort(); reject(error);}
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('无法保存本地学习空间。'));
          tx.onabort = () => reject(tx.error ?? new Error('本机原文件保存已取消。'));
        });
      } finally {db.close();}
    },
  };
}

export function paperOriginalRecordKey(inputScope: PaperOriginalScope): `paper-original:v1:${string}` {
  const scope = paperOriginalScope(inputScope);
  return `paper-original:v1:${JSON.stringify([scope.ownerId, scope.libraryId, scope.sourceVersion])}`;
}

function parseRecord(value: unknown, scope: PaperOriginalScope): PaperOriginalRecord {
  const metadata = paperOriginalMetadata(value, scope);
  const bytes = (value as {bytes?: unknown}).bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== metadata.byteLength) {
    throw new Error('paper-original-corrupt-size');
  }
  return {...metadata, bytes: new Uint8Array(bytes)};
}

export function createPaperOriginalCacheStore(port: PaperOriginalKeyValuePort): PaperOriginalCacheStore {
  return {
    async read(inputScope) {
      const scope = paperOriginalScope(inputScope);
      const stored = await port.read(paperOriginalRecordKey(scope));
      return stored === null ? null : parseRecord(stored, scope);
    },
    async save(inputRecord) {
      const scope = paperOriginalScope(inputRecord.scope);
      const incoming = parseRecord(inputRecord, scope);
      await port.update(paperOriginalRecordKey(scope), current => {
        if (current === null) return incoming;
        const existing = parseRecord(current, scope);
        if (existing.bytes.length !== incoming.bytes.length ||
            existing.bytes.some((byte, i) => byte !== incoming.bytes[i])) {
          throw new Error('paper-original-immutable-version-conflict');
        }
        // An idempotent retry preserves the first filename and full identity.
        return current;
      });
    },
  };
}

export async function sha256PaperOriginal(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
