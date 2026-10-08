import type {DailyTask,LearningUnit,PlanningCatalog,PlanningSubject,TaskPlanV2,CurrentSourceReview,TimedReviewDemand,TaskEventV1} from './task-plan-types';
import type {StudyEventV3} from '../evidence';
export type CloudAction={kind:'practice';itemKeys:string[]}|{kind:'open-material';materialId:string}|{kind:'manual'};

export type CloudUnit=Omit<LearningUnit,'action'|'stateRef'>&{action:CloudAction;stateHandle?:string};

export type CloudSubject=Omit<PlanningSubject,'units'>&{units:CloudUnit[]};

export type CloudCatalogBody={schemaVersion:1;libraryId:string;snapshotId:string;sourceHash:string;subjects:CloudSubject[];
  practiceSources:NonNullable<PlanningCatalog['practiceSources']>;diagnostics:{code:string;subjectId?:string}[];contentRefs:Record<string,string>};

export type CloudPlanningCatalogV1=CloudCatalogBody&{catalogHash:string};

export type LocalPlanningMaterial={materialId:string;subjectId:string;unitId:string;contentRef:string;sourceHash:string;stateRef?:string;abilityId?:string};

export type LocalPlanningMaterials=Record<string,LocalPlanningMaterial>;

export type PlanningFactsBody={schemaVersion:1;libraryId:string;snapshotId:string;catalogHash:string;observedAt:string;nativePlanRevision:number;
  sourceReviews:CurrentSourceReview[];captureReviews:TimedReviewDemand[];legacyEvents:StudyEventV3[];legacyTaskEvents:TaskEventV1[];
  contentCandidates:{candidateId:string;kind:'added'|'modified'|'removed'|'renamed';label:string;oldLabel?:string;contentHash:string}[];historyComplete:boolean};

export type CloudPlanningFactsV1=PlanningFactsBody&{factsHash:string};

export type CloudTask=Omit<DailyTask,'action'>&{action:CloudAction};

export type CloudPlanBody={schemaVersion:1;day:string;catalogHash:string;factsHash:string;eventThrough:number;taskThrough:number;nativeBaseRevision:number;enginePlanHash:string;inputHash:string;sourceHash:string;draftVersion:number;
  tasks:CloudTask[];vocabulary:TaskPlanV2['vocabulary'];manual:TaskPlanV2['manual'];baseRevision:number;longTermAllocation?:TaskPlanV2['longTermAllocation'];optionalMinutes?:number};

export type CloudTaskPlanV1=CloudPlanBody&{cloudPlanHash:string};
