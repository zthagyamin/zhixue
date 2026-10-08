// Page-local navigation, not mastery: saved non-word attempts finish one pass.
// Vocabulary retains its retry rules. No scheduler or event schema changes.

/** Classify the original content; a display override cannot turn a word into a question. */
export function completesSubjectItemAfterAttempt(
  item: {eventKind?:string;word?:unknown;pluginType?:string;type?:string;questionType?:string},
  subject?: {pluginType?:string},
): boolean {
  const originalMode=item.pluginType??item.type??item.questionType;
  return item.eventKind!=='word' && !(typeof item.word==='string' && item.word.trim())
    && !['three-stage','spelling'].includes(originalMode??'')
    && !['three-stage','spelling'].includes(subject?.pluginType??'');
}

export type SubjectRound = {
  correctKeys: string[];
  wrongKeys: string[];
  resets: number;
  /** Page-local traversal. Neither field is a correct answer or a persisted grade. */
  reviewedKeys?: string[];
  skippedKeys?: string[];
  /** Durable answers awaiting assessment: traversal only, no correct or formal-complete evidence. */
  awaitingReviewKeys?:string[];
};

export type SubjectRoundAdvance = {
  round: SubjectRound;
  nextIndex: number;
  complete: boolean;
};

export function emptySubjectRound(): SubjectRound {
  return { correctKeys: [], wrongKeys: [], resets: 0 };
}

// 再学一轮用：把该学科全部条目的阶段从进度记录中清掉（其他学科进度保
// 持不变），演示模式由此直接重置；真实模式仍走事件链路，此函数只负责
// 键集合计算。
export function clearItemStages(
  itemStages: Record<string, number>,
  keys: readonly string[],
): Record<string, number> {
  const drop = new Set(keys.filter((key) => key));
  const next: Record<string, number> = {};
  for (const [key, stage] of Object.entries(itemStages)) {
    if (!drop.has(key)) next[key] = stage;
  }
  return next;
}

// 只重练答错的项：把本轮其余项预标记为已答对，现有跳题与完成判定自然
// 只会出被选中的键。
export function focusRound(allKeys: readonly string[], practiceKeys: readonly string[]): SubjectRound {
  const focus = new Set(practiceKeys.filter((key) => key));
  return {
    correctKeys: allKeys.filter((key) => !focus.has(key)),
    wrongKeys: [],
    resets: 0,
  };
}

// 学科本轮是否完成：词汇读持久化阶段（跨刷新稳定），其他模块读会话内
// 本轮答对集合。study-dashboard 的结束界面、模块卡标记与全局完成态共用。
export function isSubjectRoundComplete<TItem>({
  pluginType,
  items,
  itemStages,
  keyOf,
  round,
}: {
  pluginType: string;
  items: readonly TItem[];
  itemStages: Record<string, number>;
  keyOf: (item: TItem, index: number) => string;
  round: SubjectRound;
}): boolean {
  if (items.length === 0) return false;
  if (pluginType === "three-stage") {
    return items.every((item, index) => (itemStages[keyOf(item, index)] || 0) >= 3);
  }
  return items.every((item, index) => round.correctKeys.includes(keyOf(item, index)));
}

export function advanceSubjectRound({
  round,
  itemKeys,
  currentIndex,
  correct,
  completeItem = correct,
  completeAfterAttempt = false,
}: {
  round: SubjectRound;
  itemKeys: readonly string[];
  currentIndex: number;
  correct: boolean;
  /** A correct vocabulary stage is not necessarily a completed word. */
  completeItem?: boolean;
  /** A response has been saved and continued; never count a wrong answer as correct. */
  completeAfterAttempt?: boolean;
}): SubjectRoundAdvance {
  const currentKey = itemKeys[currentIndex] ?? "";
  const correctSet = new Set(round.correctKeys);
  if (correct && completeItem) {
    correctSet.add(currentKey);
  } else {
    correctSet.delete(currentKey);
  }

  const nextRound: SubjectRound = {
    ...round,
    correctKeys: itemKeys.filter((key, index) => correctSet.has(key) && itemKeys.indexOf(key) === index),
    wrongKeys: round.wrongKeys.includes(currentKey) || correct
      ? round.wrongKeys
      : [...round.wrongKeys, currentKey].filter((key) => key),
    resets: round.resets + (correct ? 0 : 1),
    ...(completeAfterAttempt ? {
      reviewedKeys: [...new Set([...(round.reviewedKeys ?? []), currentKey])].filter(key=>itemKeys.includes(key)),
      skippedKeys: (round.skippedKeys ?? []).filter(key=>key!==currentKey && itemKeys.includes(key)),
    } : {}),
  };

  const settled = new Set(settledSubjectKeys(nextRound));
  const complete = itemKeys.length > 0 && itemKeys.every((key) => settled.has(key));
  let nextIndex = currentIndex;
  if (!complete) {
    for (let step = 1; step <= itemKeys.length; step += 1) {
      const candidate = (currentIndex + step) % itemKeys.length;
      if (!settled.has(itemKeys[candidate] ?? "")) {
        nextIndex = candidate;
        break;
      }
    }
  }

  return { round: nextRound, nextIndex, complete };
}

/** Visited is intentionally distinct from correct; skipped is not an attempt. */
export function practicedSubjectKeys(round:SubjectRound):string[]{
  return [...new Set([...round.correctKeys,...(round.reviewedKeys??[])])];
}
export function settledSubjectKeys(round:SubjectRound):string[]{
  return [...new Set([...practicedSubjectKeys(round),...(round.skippedKeys??[]),...(round.awaitingReviewKeys??[])])];
}
export function awaitSubjectReview(round:SubjectRound,itemKeys:readonly string[],currentIndex:number):SubjectRoundAdvance{
  const key=itemKeys[currentIndex];
  const next={...round,awaitingReviewKeys:[...new Set([...(round.awaitingReviewKeys??[]),key])].filter(value=>itemKeys.includes(value)),skippedKeys:(round.skippedKeys??[]).filter(value=>value!==key)};
  const settled=new Set(settledSubjectKeys(next));
  const remaining=itemKeys.findIndex((value,index)=>index!==currentIndex&&!settled.has(value));
  return {round:next,nextIndex:remaining<0?currentIndex:remaining,complete:itemKeys.every(value=>settled.has(value))};
}
export function pendingSubjectKeys(round:SubjectRound,itemKeys:readonly string[]):string[]{
  const settled=new Set(settledSubjectKeys(round));return itemKeys.filter(key=>!settled.has(key));
}
export function skipSubjectRound(round:SubjectRound,itemKeys:readonly string[],currentIndex:number):SubjectRoundAdvance{
  const key=itemKeys[currentIndex];if(!key)return {round,nextIndex:currentIndex,complete:false};
  const practiced=new Set(practicedSubjectKeys(round));
  const nextRound={...round,skippedKeys:[...new Set([...(round.skippedKeys??[]),key])].filter(value=>itemKeys.includes(value)&&!practiced.has(value))};
  const settled=new Set(settledSubjectKeys(nextRound));let nextIndex=currentIndex;
  for(let step=1;step<=itemKeys.length;step++){const candidate=(currentIndex+step)%itemKeys.length;if(!settled.has(itemKeys[candidate])){nextIndex=candidate;break;}}
  return {round:nextRound,nextIndex,complete:itemKeys.every(item=>settled.has(item))};
}

/** Traversal only: never use this as an official task/mastery completion predicate. */
export function isSubjectPassComplete(round:SubjectRound,itemKeys:readonly string[]):boolean{
  const settled=new Set(settledSubjectKeys(round));return itemKeys.length>0&&itemKeys.every(key=>settled.has(key));
}

/** Resume an already saved answer; no new round, grade or source identity is created. */
export function reopenAwaitingSubjectRound(round:SubjectRound,itemKeys:readonly string[]):SubjectRoundAdvance {
  const awaiting=(round.awaitingReviewKeys??[]).filter(key=>itemKeys.includes(key));
  const nextIndex=itemKeys.findIndex(key=>awaiting.includes(key));
  return {round:{...round,awaitingReviewKeys:(round.awaitingReviewKeys??[]).filter(key=>!awaiting.includes(key))},nextIndex:Math.max(0,nextIndex),complete:awaiting.length===0&&isSubjectPassComplete(round,itemKeys)};
}
