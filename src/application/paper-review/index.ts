// @ts-expect-error TS5097: standalone Node regression tests.
export {createPaperReviewService} from './service.ts';
export type {PaperReviewPorts,PaperReviewPrepared,PaperReviewState} from './ports';
export type {PaperReviewService} from './service';
