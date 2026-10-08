import { Rating, createEmptyCard, fsrs as createScheduler, generatorParameters, type Card, type Grade } from "ts-fsrs";
import type { CloudFSRSData } from "./cloud-sync-types";

// FSRS rating enum mapping
// 1: Again (忘记)
// 2: Hard (困难)
// 3: Good (良好)
// 4: Easy (极易)
export type PluginRating = "again" | "hard" | "good" | "easy";

export const FSRS_RATING_MAP: Record<PluginRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const;

const parameters = generatorParameters({});
const scheduler = createScheduler(parameters);

/**
 * Converts CloudFSRSData (plain object) to ts-fsrs Card object
 */
export function fromCloudFSRSData(data: CloudFSRSData): Card {
  return {
    due: new Date(data.due),
    stability: data.stability,
    difficulty: data.difficulty,
    elapsed_days: data.elapsed_days,
    scheduled_days: data.scheduled_days,
    learning_steps: data.learning_steps,
    reps: data.reps,
    lapses: data.lapses,
    state: data.state,
    last_review: data.last_review === undefined ? undefined : new Date(data.last_review),
  };
}

export const toFSRSCard = fromCloudFSRSData;

/**
 * Converts ts-fsrs Card object to CloudFSRSData (plain object for JSON/Cloudflare)
 */
export function toCloudFSRSData(card: Card): CloudFSRSData {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as CloudFSRSData["state"],
    last_review: card.last_review?.toISOString(),
  };
}

export function scheduleReviewAt(
  current: CloudFSRSData | undefined,
  rating: PluginRating,
  reviewedAt: string,
): CloudFSRSData {
  const now = new Date(reviewedAt);
  if (!Number.isFinite(now.valueOf())) throw new Error("invalid-reviewed-at");
  const card = current === undefined ? createEmptyCard(now) : fromCloudFSRSData(current);
  const result = scheduler.repeat(card, now)[FSRS_RATING_MAP[rating]];
  return toCloudFSRSData(result.card);
}

/** @internal Temporary compatibility boundary for legacy interactive callers. */
export function scheduleNextReview(current: CloudFSRSData | undefined, rating: PluginRating): CloudFSRSData {
  return scheduleReviewAt(current, rating, new Date().toISOString());
}
