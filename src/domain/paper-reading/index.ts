// @ts-expect-error TS5097: standalone Node regression tests.
export {PAPER_ORIGINAL_MAX_BYTES, paperOriginalScope, paperOriginalMetadata, samePaperOriginalScope} from './original.ts';
export type {PaperOriginalScope, PaperOriginalMetadata} from './original';
// @ts-expect-error TS5097: standalone Node regression tests.
export {createPaperReadingUnit} from './unit.ts';
export type {PaperReadingParagraph, PaperReadingDocument, PaperReadingUnit} from './unit';
// @ts-expect-error TS5097: standalone Node regression tests.
export {paperReadingTask,createPaperReadingAttempt,submitPaperReadingAnswer,applyPaperReadingFeedback} from './evidence.ts';
export type {PaperReadingSource,PaperReadingReference,PaperReadingTaskV1,PaperReadingEvaluation,PaperReadingAttemptV1} from './evidence';
// @ts-expect-error TS5097: standalone Node contracts.
export {paperReadingUnit,parsePaperReadingMutation,applyPaperReadingMutation,parsePaperReadingWorkspace} from './workspace.ts';
export type {PaperReadingUnitV1,PaperReadingMutation,PaperReadingWorkspaceV1,PaperReadingMutationResult} from './workspace';
// @ts-expect-error TS5097: standalone Node contracts.
export {paperReadingPreparation,paperReadingModelEvaluation} from './model-output.ts';
// @ts-expect-error TS5097: standalone Node contracts.
export {preparePaperReviewCandidate,readingCandidateArtifact} from './review-candidate.ts';
export type {PaperReviewContext,PaperReviewPreparation,ReadingCandidateArtifact} from './review-candidate';
// @ts-expect-error TS5097: standalone Node contracts.
export {PAPER_READING_DISCOVERY_MAX_PAGE_CHARS,comparePaperReadingDiscoveryIds,paperReadingDiscoveryCursor,paperReadingDiscoveryQuery,parsePaperReadingDiscoverySummary,paperReadingDiscoverySummary,parsePaperReadingDiscoveryPage} from './discovery.ts';
export type {PaperReadingDiscoveryScope,PaperReadingDiscoveryQuery,PaperReadingDiscoverySummary,PaperReadingDiscoveryPage} from './discovery';
// @ts-expect-error TS5097: standalone Node contracts.
export {parsePreparedPaperTaskPacket,preparedPaperTaskRecipe,preparedPaperTask,preparedPaperTaskTemplate} from './prepared.ts';
export type {PreparedPaperTask,PreparedPaperTaskPacketV1} from './prepared';
// @ts-expect-error TS5097: standalone Node contracts.
export {paperNoteReceiptLocation} from './note-receipt.ts';
export type {PaperNoteReceiptLocation} from './note-receipt';
