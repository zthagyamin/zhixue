import type {StudyEventV3} from '../src/domain/evidence';
import type {ReviewEventStore} from '../src/application/sync';
export type {AppendOutcome,StudyEventConflict,StudyEventBatchResult,ReviewEventStore} from '../src/application/sync';
// @ts-expect-error TS5097: standalone Node contracts.
import {processStudyEventBatch as processBatch} from '../src/application/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {replayReviewEvents} from './review-projection.ts';
export const processStudyEventBatch=(owner:string,events:StudyEventV3[],store:ReviewEventStore)=>processBatch(owner,events,store,replayReviewEvents);
