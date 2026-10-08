import type { CloudFSRSData } from "../evidence";
import type { FSRSRating as PluginRating } from "../assessment";

export const STUDY_EVENT_SCHEMA_VERSION = 3 as const;
export const SCHEDULER_VERSION = "ts-fsrs-5.4.1-default-v1" as const;

const FORBIDDEN_CLOUD_KEYS = new Set([
  "sourceNote",
  "stateRef",
  "vaultPath",
  "localPath",
  "apiKey",
  "token",
]);
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_IDENTIFIER_CHARACTERS = 200;

export type CanonicalFSRSDataV1 = {
  due: string;
  stability: string;
  difficulty: string;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  lastReview?: string;
};

type StudyEventBaseV3 = {
  schemaVersion: typeof STUDY_EVENT_SCHEMA_VERSION;
  eventId: string;
  coreHash: string;
  occurredAt: string;
  domain: "ielts" | "python" | "differential-review";
  item: {
    kind: "word" | "python" | "due";
    key: string;
    stateHandle?: string;
  };
};

export type StudyAttemptEventV3 = StudyEventBaseV3 & {
  eventType: "practice-attempt";
  attempt: {
    rating: PluginRating;
    correct: boolean;
    stageBefore: number;
    stageAfter: number;
  };
  scheduling?: {
    reviewedAt: string;
    schedulerVersion: typeof SCHEDULER_VERSION;
    clientStateAfter?: CloudFSRSData;
  };
};

export type ReviewBaselineEventV3 = StudyEventBaseV3 & {
  eventType: "review-baseline";
  schedulerVersion: typeof SCHEDULER_VERSION;
  baselineState: CanonicalFSRSDataV1;
};

export type StudyEventV3 = StudyAttemptEventV3 | ReviewBaselineEventV3;

export type LocalEventContext = {
  title: string;
  activityType: string;
  durationMin: number;
  weakPoints: string[];
  sourceNote?: string;
  stateRef?: string;
  abilityId?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0)!;
    const rightPoint = rightPoints[index].codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new Error("non-canonical-json-value");
      values.push(canonicalizeJson(value[index]));
    }
    return `[${values.join(",")}]`;
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalizeJson(child)}`).join(",")}}`;
  }
  throw new Error("non-canonical-json-value");
}

function pickItem(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  return {
    kind: value.kind,
    key: value.key,
    ...(value.stateHandle === undefined ? {} : { stateHandle: value.stateHandle }),
  };
}

export function studyEventHashInput(event: unknown): unknown {
  if (!isPlainRecord(event)) return event;

  const common = {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    domain: event.domain,
    eventType: event.eventType,
    item: pickItem(event.item),
  };

  if (event.eventType === "practice-attempt") {
    const scheduling = isPlainRecord(event.scheduling)
      ? {
          reviewedAt: event.scheduling.reviewedAt,
          schedulerVersion: event.scheduling.schedulerVersion,
        }
      : undefined;
    return {
      ...common,
      attempt: event.attempt,
      ...(scheduling === undefined ? {} : { scheduling }),
    };
  }

  if (event.eventType === "review-baseline") {
    return {
      ...common,
      schedulerVersion: event.schedulerVersion,
      baselineState: event.baselineState,
    };
  }

  return common;
}

export async function computeStudyEventCoreHash(event: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeJson(studyEventHashInput(event)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function withStudyEventCoreHash<T extends StudyEventV3>(event: T): Promise<T> {
  return { ...event, coreHash: await computeStudyEventCoreHash(event) } as T;
}

function fail(message = "invalid-study-event-v3"): never {
  throw new Error(message);
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("unknown-study-event-field");
}

function scanForbiddenCloudKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(scanForbiddenCloudKeys);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CLOUD_KEYS.has(key)) fail("forbidden-cloud-field");
    scanForbiddenCloudKeys(child);
  }
}

function assertCanonicalIsoDate(value: unknown): asserts value is string {
  if (typeof value !== "string") fail();
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) fail();
}

function assertInteger(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail();
}

function assertCount(value: unknown): asserts value is number {
  assertInteger(value);
  if (value < 0) fail();
}

function assertString(value: unknown, maximumCharacters?: number): asserts value is string {
  if (typeof value !== "string") fail();
  if (maximumCharacters !== undefined && Array.from(value).length > maximumCharacters) fail();
}

function assertOneOf<T extends string | number>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (!allowed.includes(value as T)) fail();
}

function parseItem(value: unknown): StudyEventBaseV3["item"] {
  if (!isPlainRecord(value)) fail();
  assertKnownKeys(value, ["kind", "key", "stateHandle"]);
  assertOneOf(value.kind, ["word", "python", "due"] as const);
  assertString(value.key, MAX_IDENTIFIER_CHARACTERS);
  if (value.stateHandle !== undefined) assertString(value.stateHandle);
  return value as StudyEventBaseV3["item"];
}

function parseClientStateAfter(value: unknown): CloudFSRSData {
  if (!isPlainRecord(value)) fail();
  assertKnownKeys(value, [
    "due",
    "stability",
    "difficulty",
    "elapsed_days",
    "scheduled_days",
    "learning_steps",
    "reps",
    "lapses",
    "state",
    "last_review",
  ]);
  assertCanonicalIsoDate(value.due);
  for (const key of ["stability", "difficulty"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) fail();
  }
  for (const key of ["elapsed_days", "scheduled_days", "learning_steps", "reps", "lapses"]) {
    assertCount(value[key]);
  }
  assertOneOf(value.state, [0, 1, 2, 3] as const);
  if (value.last_review !== undefined) assertCanonicalIsoDate(value.last_review);
  return value as CloudFSRSData;
}

function parseScheduling(value: unknown): StudyAttemptEventV3["scheduling"] {
  if (!isPlainRecord(value)) fail();
  assertKnownKeys(value, ["reviewedAt", "schedulerVersion", "clientStateAfter"]);
  assertCanonicalIsoDate(value.reviewedAt);
  assertOneOf(value.schedulerVersion, [SCHEDULER_VERSION]);
  if (value.clientStateAfter !== undefined) parseClientStateAfter(value.clientStateAfter);
  return value as StudyAttemptEventV3["scheduling"];
}

function parseAttempt(value: unknown): StudyAttemptEventV3["attempt"] {
  if (!isPlainRecord(value)) fail();
  assertKnownKeys(value, ["rating", "correct", "stageBefore", "stageAfter"]);
  assertOneOf(value.rating, ["again", "hard", "good", "easy"] as const);
  if (typeof value.correct !== "boolean") fail();
  assertCount(value.stageBefore);
  assertCount(value.stageAfter);
  return value as StudyAttemptEventV3["attempt"];
}

function parseBaselineState(value: unknown): CanonicalFSRSDataV1 {
  if (!isPlainRecord(value)) fail();
  assertKnownKeys(value, [
    "due",
    "stability",
    "difficulty",
    "elapsedDays",
    "scheduledDays",
    "learningSteps",
    "reps",
    "lapses",
    "state",
    "lastReview",
  ]);
  assertCanonicalIsoDate(value.due);
  for (const key of ["stability", "difficulty"]) {
    if (typeof value[key] !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value[key])) fail();
  }
  for (const key of ["elapsedDays", "scheduledDays", "learningSteps", "reps", "lapses"]) {
    assertCount(value[key]);
  }
  assertOneOf(value.state, [0, 1, 2, 3] as const);
  if (value.lastReview !== undefined) assertCanonicalIsoDate(value.lastReview);
  return value as CanonicalFSRSDataV1;
}

function assertEventSize(raw: unknown): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    fail();
  }
  if (json === undefined || new TextEncoder().encode(json).byteLength > MAX_EVENT_BYTES) {
    fail("study-event-too-large");
  }
}

export async function parseCloudStudyEventV3(raw: unknown): Promise<StudyEventV3> {
  assertEventSize(raw);
  scanForbiddenCloudKeys(raw);
  if (!isPlainRecord(raw)) fail();

  assertOneOf(raw.eventType, ["practice-attempt", "review-baseline"] as const);
  const baseKeys = ["schemaVersion", "eventId", "coreHash", "occurredAt", "domain", "eventType", "item"];
  assertKnownKeys(raw, raw.eventType === "practice-attempt"
    ? [...baseKeys, "attempt", "scheduling"]
    : [...baseKeys, "schedulerVersion", "baselineState"]);
  if (raw.schemaVersion !== STUDY_EVENT_SCHEMA_VERSION) fail();
  assertString(raw.eventId, MAX_IDENTIFIER_CHARACTERS);
  assertString(raw.coreHash);
  assertCanonicalIsoDate(raw.occurredAt);
  assertOneOf(raw.domain, ["ielts", "python", "differential-review"] as const);
  const item = parseItem(raw.item);

  let event: StudyEventV3;
  if (raw.eventType === "practice-attempt") {
    event = {
      schemaVersion: STUDY_EVENT_SCHEMA_VERSION,
      eventId: raw.eventId,
      coreHash: raw.coreHash,
      occurredAt: raw.occurredAt,
      domain: raw.domain,
      eventType: "practice-attempt",
      item,
      attempt: parseAttempt(raw.attempt),
      ...(raw.scheduling === undefined ? {} : { scheduling: parseScheduling(raw.scheduling) }),
    };
  } else {
    assertOneOf(raw.schedulerVersion, [SCHEDULER_VERSION]);
    event = {
      schemaVersion: STUDY_EVENT_SCHEMA_VERSION,
      eventId: raw.eventId,
      coreHash: raw.coreHash,
      occurredAt: raw.occurredAt,
      domain: raw.domain,
      eventType: "review-baseline",
      item,
      schedulerVersion: raw.schedulerVersion,
      baselineState: parseBaselineState(raw.baselineState),
    };
  }

  if (raw.coreHash !== await computeStudyEventCoreHash(event)) fail("invalid-study-event-core-hash");
  return event;
}
