export const PLUGIN_TYPES = ["three-stage", "quiz", "recall", "calculation", "code", "flashcard", "spelling", "paper"] as const;
export type PracticeMode = (typeof PLUGIN_TYPES)[number];
