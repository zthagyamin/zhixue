export type {SequencedStudyEventV3,CloudReviewProjection,CloudDiagnostics,SyncV3Store} from '../src/application/sync';
export type {GetUser,CreateV3Store,LegacySyncHandlers} from '../src/infrastructure/sync-server';
import type {GetUser,CreateV3Store,SyncHttpDependencies} from '../src/infrastructure/sync-server';
// @ts-expect-error TS5097: standalone Node contracts.
import {createSyncRouteHandlers as createHandlers,handleStudyEventsV3Post as handlePost} from '../src/infrastructure/sync-server/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
export {handleStudyEventsV3Get,handleBoundStudyEventsV3Get} from '../src/infrastructure/sync-server/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {processStudyEventBatch} from './review-event-service.ts';
export const createSyncRouteHandlers=(deps:Omit<SyncHttpDependencies,'processBatch'>)=>createHandlers({...deps,processBatch:processStudyEventBatch});
export const handleStudyEventsV3Post=(body:Record<string,unknown>,getUser:GetUser,createStore:CreateV3Store)=>handlePost(body,getUser,createStore,processStudyEventBatch);
