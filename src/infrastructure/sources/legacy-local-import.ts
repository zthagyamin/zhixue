type LegacyOwner = {schemaVersion: 1; owner: string};

/** Ownership and destination share one transaction; old source bytes are retained. */
export async function importLegacyLocalRecord<T>(options: {
  open: () => Promise<IDBDatabase>;
  storeName: string;
  workspaceId: string;
  destinationId: string;
  kind: string;
  legacyKey: string;
  raw: string;
  value: T;
  fallback: T;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
}): Promise<T> {
  const ownerId = ['legacy-local-import', 1, options.legacyKey];
  const markerKey = `zhixue-migration-owner:${options.legacyKey}`;
  const database = await options.open();
  try {
    const result = await new Promise<{value: T; imported: boolean}>((resolve, reject) => {
      const tx = database.transaction(options.storeName, 'readwrite');
      const store = tx.objectStore(options.storeName);
      let result = {value: options.fallback, imported: false};
      const destination = store.get(options.destinationId);
      destination.onsuccess = () => {
        if (destination.result?.value != null) {
          result.value = destination.result.value;
          return;
        }
        const owner = store.get(ownerId);
        owner.onsuccess = () => {
          try {
            const claim = owner.result as LegacyOwner | undefined;
            // Unknown or malformed versions cannot be treated as unowned.
            if (claim && (claim.schemaVersion !== 1 || claim.owner !== options.workspaceId)) return;
            const marker = options.storage.getItem(markerKey);
            if (marker && marker !== options.workspaceId) return;
            if (options.storage.getItem(options.legacyKey) !== options.raw) return;
            store.put({id: ownerId, schemaVersion: 1, owner: options.workspaceId} satisfies LegacyOwner & {id: (string | number)[]});
            store.put({id: options.destinationId, workspaceId: options.workspaceId, kind: options.kind,
              value: options.value, updatedAt: new Date().toISOString()});
            result = {value: options.value, imported: true};
          } catch (cause) {
            reject(cause);
            tx.abort();
          }
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? Error('legacy-import-not-saved'));
    });
    if (result.imported) {
      try {options.storage.setItem(markerKey, options.workspaceId);} catch { /* Durable ownership remains authoritative. */ }
    }
    return result.value;
  } finally {database.close();}
}
