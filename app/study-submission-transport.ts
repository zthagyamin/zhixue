import type {SubmissionJournal} from './study-submission-journal';
import type {DeliveryConnection} from '../src/infrastructure/sync';
export type {AuxiliaryDelivery} from '../src/domain/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
import {createSubmissionDelivery} from '../src/application/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {createDeliveryHttp} from '../src/infrastructure/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {persistOriginalSubmission} from './study-submission.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {getLocalStudyRecord,applyLocalStudyReceipt} from './local-account-study.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {getLocalStudyEvent,updateStudyEventDelivery,isStudyStorageFailure} from './local-study-events.ts';
type Options={workspaceId:string;journal:SubmissionJournal;isCurrent:()=>boolean;fetcher?:typeof fetch;companion?:DeliveryConnection|null};
/** Legacy storage assembly; orchestration is shared through the public application use case. */
export function createSubmissionTransport(options:Options){return createSubmissionDelivery({...options,http:createDeliveryHttp(options),storage:{persistOriginalSubmission,getLocalStudyRecord,applyLocalStudyReceipt,getLocalStudyEvent,updateStudyEventDelivery,isStudyStorageFailure}});}
