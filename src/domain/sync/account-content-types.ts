import type {LearningSupport} from '../content';
type ItemBase = {
  schemaVersion:1|2;learningSupport?:LearningSupport;itemKey:string;eventKind:'word'|'python'|'due';subjectId:string;
  title:string;sourceHash:string;
};

export type StudyWordBody = ItemBase & {
  kind:'word';completionRule:'three-stage'|'graded-practice';language:string;
  recommendedPlugin:'three-stage'|'recall'|'flashcard'|'spelling';
  word:{word:string;phonetic:string;meaning:string;context:string;example:string;source:string;level:string;distractors:string[]};
};

export type StudyPracticeBody = ItemBase & {
  kind:'practice';completionRule:'graded-practice';
  practice:{itemId:string;abilityId:string;domain:string;questionType:'quiz'|'recall'|'calculation'|'code'|'flashcard';
    prompt:string;sourceLabel:string;options?:string[];answer?:number|string;explanation?:string;reviewPoint?:string;
    initialCode?:string;testCode?:string;solutionCode?:string};
};

export type StudyItemBody = StudyWordBody | StudyPracticeBody;

export type StudyItemVersion = StudyItemBody & {contentHash:string};

export type StudySnapshotBody = {
  schemaVersion:1;libraryId:string;snapshotId:string;revision:number;generatedAt:string;sourceHash:string;
  eventCursor:number;taskCursor:number;items:{itemKey:string;contentHash:string}[];
};

export type StudySnapshot = StudySnapshotBody & {snapshotHash:string};

export type StudyBundle = {snapshot:StudySnapshot;items:StudyItemVersion[]};
