import type {CloudProgress as Progress} from '../evidence';
import type {CloudLearningEvent,CloudSyncMetadata} from './cloud-contracts';
export type {Progress};
export const emptyProgress:Progress={itemStages:{},answered:0,correct:0,fsrsData:{}};
export const emptyCloudSyncMetadata:CloudSyncMetadata={decision:'pending',cursor:0};
export function hasProgressData(progress: Progress) {
  return progress.answered > 0 || progress.correct > 0 || Object.keys(progress.itemStages || {}).length > 0;
}

export function cloudWordKey(value: string) {
  const word = value.includes("::") ? value.slice(value.lastIndexOf("::") + 2) : value.replace(/^word:/, "");
  return `word:${word.trim().toLocaleLowerCase("en-US")}`;
}

export function normalizeProgress(progress: Progress): Progress {
  const itemStages: Record<string, number> = {};
  for (const [key, stage] of Object.entries(progress.wordStages || {})) {
    const normalizedKey = key.startsWith("word:") ? key : cloudWordKey(key);
    itemStages[normalizedKey] = Math.max(itemStages[normalizedKey] || 0, stage);
  }
  for (const [key, stage] of Object.entries(progress.itemStages || {})) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    itemStages[normalizedKey] = Math.max(itemStages[normalizedKey] || 0, stage);
  }
  return {
    itemStages,
    fsrsData: progress.fsrsData || {},
    answered: progress.answered || 0,
    correct: progress.correct || 0,
  };
}

export function applyCloudEvents(progress: Progress, events: CloudLearningEvent[]) {
  const next: Progress = {
    itemStages: { ...progress.itemStages },
    fsrsData: { ...progress.fsrsData },
    answered: progress.answered,
    correct: progress.correct,
  };
  for (const event of events) {
    next.answered += event.answeredDelta ?? 0;
    next.correct += event.correctDelta ?? 0;
    if (event.numericValue !== undefined) {
      next.itemStages[event.itemKey] = event.numericValue;
    }
  }
  return next;
}
