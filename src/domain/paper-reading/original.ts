export const PAPER_ORIGINAL_MAX_BYTES = 20_000_000;

export type PaperOriginalScope = {
  ownerId: string;
  libraryId: string;
  sourceVersion: string;
};

export type PaperOriginalMetadata = {
  schemaVersion: 1;
  scope: PaperOriginalScope;
  filename: string;
  byteLength: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('paper-original-corrupt-metadata');
  }
  return value as Record<string, unknown>;
}

/** Copy identity before asynchronous work, keeping owner and library literal. */
export function paperOriginalScope(value: unknown): PaperOriginalScope {
  const scope = object(value);
  if (typeof scope.ownerId !== 'string' || !scope.ownerId.trim() ||
      typeof scope.libraryId !== 'string' || !scope.libraryId.trim()) {
    throw new Error('paper-original-invalid-scope');
  }
  if (typeof scope.sourceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(scope.sourceVersion)) {
    throw new Error('paper-original-invalid-source-version');
  }
  return {ownerId: scope.ownerId, libraryId: scope.libraryId, sourceVersion: scope.sourceVersion};
}

export function samePaperOriginalScope(a: PaperOriginalScope, b: PaperOriginalScope): boolean {
  return a.ownerId === b.ownerId && a.libraryId === b.libraryId && a.sourceVersion === b.sourceVersion;
}

export function paperOriginalMetadata(value: unknown, expectedScope: PaperOriginalScope): PaperOriginalMetadata {
  const metadata = object(value);
  if (metadata.schemaVersion !== 1) throw new Error('paper-original-unsupported-version');
  const scope = paperOriginalScope(metadata.scope);
  if (!samePaperOriginalScope(scope, paperOriginalScope(expectedScope))) {
    throw new Error('paper-original-scope-mismatch');
  }
  if (typeof metadata.filename !== 'string' || !metadata.filename.trim()) {
    throw new Error('paper-original-invalid-filename');
  }
  if (typeof metadata.byteLength !== 'number' || !Number.isInteger(metadata.byteLength) ||
      metadata.byteLength < 1 || metadata.byteLength > PAPER_ORIGINAL_MAX_BYTES) {
    throw new Error('paper-original-invalid-size');
  }
  return {schemaVersion: 1, scope, filename: metadata.filename, byteLength: metadata.byteLength};
}
