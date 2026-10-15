export type PaperNoteReceiptLocation = {kind: 'obsidian'; path: string} | {kind: 'notion'; url: string};

/** A receipt location is display metadata, never proof of an authenticated write. */
export function paperNoteReceiptLocation(raw: unknown): PaperNoteReceiptLocation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as {status?: unknown; kind?: unknown; path?: unknown; url?: unknown};
  if (value.status !== 'written' || (value.path !== undefined && value.url !== undefined)) return null;
  if (value.kind === 'obsidian') {
    if (typeof value.path !== 'string' || !value.path.endsWith('.md') || value.path.startsWith('/')
      || value.path.split('/').includes('..') || value.url !== undefined) return null;
    return {kind: 'obsidian', path: value.path};
  }
  if (value.kind === 'notion' && typeof value.url === 'string' && value.path === undefined) {
    const prefix = 'https://www.notion.so/';
    const id = value.url.slice(prefix.length);
    // Length also excludes the final-newline exception of JavaScript's $ anchor.
    if (value.url.startsWith(prefix) && id.length === 32 && /^[a-f0-9]{32}$/.test(id))
      return {kind: 'notion', url: value.url};
  }
  return null;
}
