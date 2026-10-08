export type CloudFSRSData = {
  due: string; // ISO string
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  last_review?: string; // ISO string
};

export type CloudProgress = {
  itemStages: Record<string, number>;
  fsrsData?: Record<string, CloudFSRSData>;
  wordStages?: Record<string, number>;
  pythonDone?: string[];
  dueStable?: string[];
  answered: number;
  correct: number;
};

