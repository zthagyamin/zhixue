import type {LocalEventContext,StudyEventV3} from '../evidence';
export type DeliveryState = "not-required" | "pending" | "acked" | "conflict";

export type DeliveryTarget = "cloud" | "companion";


export type StudyEventDelivery = {
  cloud: DeliveryState;
  companion: DeliveryState;
};


export type LocalStudyEventRecord = {
  workspaceId: string;
  eventId: string;
  event: StudyEventV3;
  localContext?: LocalEventContext;
  cloud: DeliveryState;
  companion: DeliveryState;
  occurredAt: string;
  updatedAt: string;
};


export type StudyEventPutOutcome = "inserted" | "merged" | "conflict";


export type StudyEventDiagnostics = {
  total: number;
  pendingCloud: number;
  pendingCompanion: number;
  conflicts: number;
  latestEventAt?: string;
};
export type CloudBatchResult = {
  accepted?: string[];
  duplicates?: string[];
  conflicts?: Array<{ eventId: string; reason: string }>;
  projections?: Array<{ itemKey: string; dueAt: string; eventSetHash: string }>;
  error?: string;
};


export type CompanionActivityResult = {
  status?: string;
  projectionStatus?: "pending" | "applied";
  companionReceipt?: {
    durable?: boolean;
    projectionStatus?: "pending" | "applied";
    stateProjection?: { status?: string } | null;
  };
};


export type ProjectionMismatch = {
  eventId: string;
  itemKey: string;
  serverDueAt: string;
  localDueAt?: string;
};
export type StudyDeliveryReceipt={schemaVersion:1;libraryId:string;eventId:string;envelopeHash:string;
  target:'cloud'|'companion';status:'acked'|'received'|'blocked'|'applied';revision:number;reason?:string};
export type AuxiliaryDelivery='unknown'|'binding-unknown'|'not-saved'|'parent-pending'|'unsupported'|'account-received'|'received'|'blocked'|'applied';
