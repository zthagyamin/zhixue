// 词库分组与每日配额（默认 20 词/组、20 词/天）。分组由词库固定顺序切
// 分；当天固定服务同一组（状态记入 workspace），跨天自动推进到第一个未
// 完成组；用户可手动选组或改配额——自由化通道保留，不改变进度身份。

export const DEFAULT_VOCAB_QUOTA = 20;

export type GroupBounds = { start: number; end: number };
export type VocabServe = {dayKey: string; group: number; itemKeys?: string[]};
export type VocabPacingState = {settings: {quota: number; override: number | null}; serve: VocabServe; previousServe?: VocabServe};
export type SubjectPacing = {schemaVersion: 1; subjects: Record<string, VocabPacingState>};

export function migrateSubjectPacing(saved: SubjectPacing | null, legacy: VocabPacingState | null): SubjectPacing {
  if (saved?.schemaVersion === 1 && saved.subjects) return saved;
  return {schemaVersion:1, subjects:legacy ? {'ielts-vocabulary':legacy} : {}};
}

export function pacingForSubject(state: SubjectPacing, subjectId: string, quota = DEFAULT_VOCAB_QUOTA): VocabPacingState {
  return state.subjects[subjectId] ?? {settings:{quota:Number.isInteger(quota) && quota > 0 ? quota : DEFAULT_VOCAB_QUOTA,override:null},serve:{dayKey:'',group:0}};
}

export function snapshotServedGroup(state: VocabPacingState, itemKeys: string[]): VocabPacingState {
  const start = state.serve.group * state.settings.quota;
  return {...state,serve:{...state.serve,itemKeys:itemKeys.slice(start,start + state.settings.quota)}};
}

export function vocabQuotaOptions(current: number): number[] {
  return [...new Set([10,20,30,50,current])].filter(value=>Number.isInteger(value) && value>0).sort((a,b)=>a-b);
}

export function selectPlanGroup(state: VocabPacingState, day: string, practice: {groupIndex?: number; itemKeys: string[]}): VocabPacingState {
  if (practice.groupIndex === undefined || !Number.isInteger(practice.groupIndex) || practice.groupIndex < 0) return state;
  return {
    settings: {...state.settings,override:null},
    serve: {dayKey:day,group:practice.groupIndex,itemKeys:[...practice.itemKeys]},
    previousServe: state.serve.dayKey && state.serve.dayKey !== day ? state.serve : state.previousServe,
  };
}

export function splitGroupBounds(total: number, quota: number): GroupBounds[] {
  const size = quota > 0 ? quota : DEFAULT_VOCAB_QUOTA;
  if (total <= 0) return [];
  const bounds: GroupBounds[] = [];
  for (let start = 0; start < total; start += size) {
    bounds.push({ start, end: Math.min(total, start + size) });
  }
  return bounds.length > 0 ? bounds : [{ start: 0, end: total }];
}

export function firstIncompleteGroup(
  bounds: GroupBounds[],
  isCompleted: (index: number) => boolean,
): number {
  for (let group = 0; group < bounds.length; group += 1) {
    const { start, end } = bounds[group];
    for (let index = start; index < end; index += 1) {
      if (!isCompleted(index)) return group;
    }
  }
  return Math.max(0, bounds.length - 1);
}

export function resolveServedGroup({
  todayKey,
  saved,
  firstIncomplete,
  override,
  groupCount,
}: {
  todayKey: string;
  saved?: { dayKey: string; group: number } | null;
  firstIncomplete: number;
  override?: number | null;
  groupCount: number;
}): number {
  const clamp = (value: number) => Math.min(Math.max(value, 0), Math.max(0, groupCount - 1));
  if (typeof override === "number") return clamp(override);
  if (saved && saved.dayKey === todayKey) return clamp(saved.group);
  return clamp(firstIncomplete);
}
