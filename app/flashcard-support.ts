/** Compatibility entrypoint. New modules use src/domain/content/index. */
// @ts-expect-error TS5097: standalone Node contracts use TypeScript extensions.
export * from '../src/domain/content/flashcard-support.ts';
