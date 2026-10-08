/** Safe, bounded inline presentation of a supplied example. No generated sentences or answers.
 * Supported markup: paired emphasis/strong, code spans and delimited TeX. Everything else
 * stays literal text. This is intentionally not a general-purpose Markdown/HTML parser.
 */
export type ContextMark = 'strong' | 'em';
export type ContextRun = {text: string; marks: ContextMark[]; kind: 'text' | 'code' | 'math'};
export type ContextRange = {start: number; end: number};
export type WordContext = {
  runs: ContextRun[];
  plain: string;
  matches: ContextRange[];
  canCloze: boolean;
  reason: 'ready' | 'missing' | 'no-match' | 'short' | 'protected' | 'complex' | 'bibliographic';
};
const LIMIT = 20_000;
const wordPart = /[\p{L}\p{N}_]/u;
const escapedAt = (s: string, at: number) => {
  let n = 0; while (at > 0 && s[--at] === '\\') n++;
  return n % 2 === 1;
};

function closing(s: string, delimiter: string, start: number): number {
  let end = s.indexOf(delimiter, start);
  while (end !== -1 && escapedAt(s, end)) end = s.indexOf(delimiter, end + delimiter.length);
  return end;
}

/** Protected spans are copied byte-for-byte, not stripped or searched for emphasis. */
function atom(s: string, at: number): {end: number; kind: 'code' | 'math'; text: string} | null {
  if (s[at] === '`') {
    const marker = /^`+/.exec(s.slice(at))![0];
    let end = s.indexOf(marker, at + marker.length);
    while (end !== -1 && (s[end - 1] === '`' || s[end + marker.length] === '`')) end = s.indexOf(marker, end + marker.length);
    if (end !== -1) return {end: end + marker.length, kind: 'code', text: s.slice(at + marker.length, end)};
  }
  for (const [open, close] of [['\\(', '\\)'], ['\\[', '\\]'], ['$$', '$$'], ['$', '$']]) {
    if (!s.startsWith(open, at) || escapedAt(s, at)) continue;
    // A lone currency sign is ordinary source text, not an empty math expression.
    const end = closing(s, close, at + open.length);
    if (end > at + open.length) return {end: end + close.length, kind: 'math', text: s.slice(at, end + close.length)};
  }
  return null;
}

export function parseContextInline(source: string): ContextRun[] {
  if (source.length > LIMIT) return [{text: source, marks: [], kind: 'text'}];
  const out: ContextRun[] = [];
  function emit(text: string, marks: ContextMark[], kind: ContextRun['kind'] = 'text') {
    if (!text) return;
    const last = out.at(-1);
    if (kind === 'text' && last?.kind === kind && last.marks.join() === marks.join()) last.text += text;
    else out.push({text, marks: [...marks], kind});
  }
  function parse(s: string, marks: ContextMark[], depth: number) {
    if (depth > 8) { emit(s, marks); return; }
    for (let i = 0; i < s.length;) {
      const protectedSpan = atom(s, i);
      if (protectedSpan) { emit(protectedSpan.text, marks, protectedSpan.kind); i = protectedSpan.end; continue; }
      if (s[i] === '\\' && /[\\`*_{}[\]()#+.!<>~$|-]/.test(s[i + 1] ?? '')) { emit(s[i + 1], marks); i += 2; continue; }
      const delimiter = ['***', '___', '**', '__', '*', '_'].find(d => s.startsWith(d, i));
      // Conservative boundary: x*y*z / snake_case and operators remain literal.
      if (delimiter && !/\s/.test(s[i + delimiter.length] ?? ' ') && (i === 0 || !wordPart.test(s[i - 1]))) {
        let end = i + delimiter.length;
        while (end < s.length) {
          const nestedAtom = atom(s, end);
          if (nestedAtom) { end = nestedAtom.end; continue; }
          if (s.startsWith(delimiter, end) && !escapedAt(s, end) && !/\s/.test(s[end - 1]) && end > i + delimiter.length &&
            !(delimiter[0] === '_' && wordPart.test(s[end + delimiter.length] ?? ''))) break;
          end++;
        }
        if (end < s.length) {
          const add: ContextMark[] = delimiter.length === 3 ? ['strong', 'em'] : delimiter.length === 2 ? ['strong'] : ['em'];
          parse(s.slice(i + delimiter.length, end), [...new Set([...marks, ...add])], depth + 1);
          i = end + delimiter.length; continue;
        }
      }
      emit(s[i], marks); i++;
    }
  }
  parse(source, [], 0);
  return out;
}

export function makeWordContext(example: string, word: string): WordContext {
  if (!example.trim()) return {runs: [], plain: '', matches: [], canCloze: false, reason: 'missing'};
  // OCR/imported PDF snippets can join author affiliations and emails to the abstract.
  // They are provenance, not a usable vocabulary example; do not render or submit them.
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const affiliations = /\b(?:University of|Google Brain|Google Research|Department of|Institute of)\b/i;
  const abstractHeading = /(?:^|\s)Abstract\s+(?=(?:The|We|This|Our|In|A|An)\b)/;
  if (email.test(example) || (affiliations.test(example) && abstractHeading.test(example))) {
    return {runs: [], plain: '', matches: [], canCloze: false, reason: 'bibliographic'};
  }
  const runs = parseContextInline(example), plain = runs.map(run => run.text).join('');
  const empty = (reason: WordContext['reason']): WordContext => ({runs, plain, matches: [], canCloze: false, reason});
  if (!word.trim() || word.length > 300) return empty('no-match');
  if (example.length > LIMIT) return empty('complex');
  const literal = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])`, 'giu');
  const matches = [...plain.matchAll(regex)].map(match => ({start: match.index!, end: match.index! + match[0].length}));
  if (!matches.length) return empty('no-match');
  let offset = 0;
  const protectedTarget = runs.some(run => {
    const start = offset; offset += run.text.length;
    return run.kind !== 'text' && matches.some(match => match.start < offset && match.end > start);
  });
  if (protectedTarget) return {...empty('protected'), matches};
  // Do not mask Markdown link destinations, HTML or unsupported complex markup.
  if (/[<>]|!?\[[^\]]*\]\(|!?\[\[/.test(example)) return {...empty('complex'), matches};
  let contextOnly = plain;
  for (const match of [...matches].reverse()) contextOnly = contextOnly.slice(0, match.start) + ' ' + contextOnly.slice(match.end);
  // A conservative display gate, NOT a proof of grammatical completeness or a unique answer.
  const words = contextOnly.match(/[\p{L}][\p{L}\p{M}'’-]*/gu) ?? [];
  const canCloze = words.length >= 5 && contextOnly.trim().length >= 24;
  return {runs, plain, matches, canCloze, reason: canCloze ? 'ready' : 'short'};
}

export function contextPrompt(model: WordContext, concealed: boolean): string {
  if (!concealed || !model.canCloze) return model.plain;
  let prompt = model.plain;
  for (const match of [...model.matches].reverse()) prompt = prompt.slice(0, match.start) + '______' + prompt.slice(match.end);
  return prompt;
}

/** Rendering pieces never carry a concealed answer (including title/aria/data attributes). */
export type ContextPiece = ContextRun & {answer?: boolean; gap?: boolean};
export function contextPieces(model: WordContext, concealed: boolean): ContextPiece[] {
  const ranges = model.canCloze ? model.matches : [];
  const out: ContextPiece[] = [];
  let offset = 0;
  for (const run of model.runs) {
    const start = offset, end = start + run.text.length; offset = end;
    let cursor = start;
    for (const range of ranges) {
      if (range.end <= start || range.start >= end) continue;
      const left = Math.max(range.start, start), right = Math.min(range.end, end);
      if (cursor < left) out.push({...run, text: run.text.slice(cursor - start, left - start)});
      if (concealed) {
        if (range.start >= start) out.push({text: '', kind: 'text', marks: [], gap: true});
      } else out.push({...run, text: run.text.slice(left - start, right - start), answer: true});
      cursor = right;
    }
    if (cursor < end) out.push({...run, text: run.text.slice(cursor - start)});
  }
  return out;
}

export function contextFallback(reason: WordContext['reason']): string {
  return reason === 'missing' ? '当前材料没有例句，使用词义核对。' : reason === 'short' ? '原文片段较短，保留原文进行语境核对。' :
    reason === 'no-match' ? '未在例句中找到完整目标词，保留原文。' : reason === 'protected' ? '目标词位于代码或公式中，保留原文。' :
    reason === 'complex' ? '当前格式不适合安全挖空，保留原文。' : reason === 'bibliographic' ? '这条语境混入论文署名或邮箱，已暂不展示；请按词义核对。' : '';
}
