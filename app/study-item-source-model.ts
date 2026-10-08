// @ts-expect-error TS5097: standalone Node regression tests.
import {safeObsidianReference} from './obsidian-link.ts';
export type ItemSourceFields = { sourceNote?: string; source?: string; sourceLabel?: string; sourcePath?: string };
export type ItemSourceLocation = {
  kind: 'unlocated' | 'label' | 'document' | 'section';
  label: string;
  notePath: string | null;
  section: string | null;
  description: string | null;
};

function cleanLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Metadata for this item only. A collection path must never stand in for a question's source. */
export function resolveItemSource(item: ItemSourceFields): ItemSourceLocation {
  const raw = cleanLabel(item.sourceNote) ?? cleanLabel(item.sourcePath);
  const description = cleanLabel(item.sourceLabel) ?? cleanLabel(item.source);
  const local = raw && safeObsidianReference(raw);
  const match = local ? /^(.+\.md)(?:#(.+))?$/i.exec(raw) : null;
  if (match) {
    const section = match[2]?.trim() || null;
    return { kind: section ? 'section' : 'document', label: match[1], notePath: match[1], section, description };
  }
  if (description) return { kind: 'label', label: description, notePath: null, section: null, description: null };
  return { kind: 'unlocated', label: '尚未定位', notePath: null, section: null, description: null };
}

export function itemSourceNotice(location: ItemSourceLocation, localAccess: boolean): string {
  if (location.kind === 'unlocated') return '本题尚未提供可靠出处；当前资料库信息不代表这道题的来源。';
  if (location.kind === 'label') return '已有来源说明，尚未定位到具体笔记或小节。';
  const precision = location.kind === 'section' ? '已提供本题的小节定位。' : '已定位到所属笔记，尚未定位到具体小节。';
  return precision + (localAccess ? '' : '可复制路径，或设置本机 Obsidian 库名直接打开；此链接不会同步文件。');
}
