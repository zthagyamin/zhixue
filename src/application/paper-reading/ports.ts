import type {PaperReadingUnitV1,PaperReadingMutation,PaperReadingWorkspaceV1,PaperReadingTaskV1,PaperReadingEvaluation} from '../../domain/paper-reading';
import type {PaperReadingDiscoveryQuery,PaperReadingDiscoveryPage} from '../../domain/paper-reading';
export type {PaperReadingDiscoveryQuery,PaperReadingDiscoverySummary,PaperReadingDiscoveryPage} from '../../domain/paper-reading';
export type PaperReadingScope={ownerId:string;libraryId:string};
export type PaperReadingReceipt={schemaVersion:1;operationId:string;status:'accepted'|'duplicate'|'conflict';durable:boolean;workspace:PaperReadingWorkspaceV1|null};
export interface PaperReadingStorePort{
    supported():Promise<boolean>;
    /** Optional capability; old repositories remain readable by known unit ID. */
    list?(scope:PaperReadingScope,query?:PaperReadingDiscoveryQuery):Promise<PaperReadingDiscoveryPage>;
    read(scope:PaperReadingScope,unitId:string):Promise<PaperReadingWorkspaceV1|null>;
    mutate(scope:PaperReadingScope,mutation:PaperReadingMutation):Promise<PaperReadingReceipt>;
    /** Private application path, never exposed as a client mutation route. */
    writeService(scope:PaperReadingScope,mutation:PaperReadingMutation):Promise<PaperReadingReceipt>;
    hydrate?(scope:PaperReadingScope,workspace:PaperReadingWorkspaceV1):Promise<PaperReadingWorkspaceV1>;
}
export interface PaperReadingRemotePort{
    list?(query?:PaperReadingDiscoveryQuery,signal?:AbortSignal):Promise<PaperReadingDiscoveryPage>;
    read(unitId:string,signal?:AbortSignal):Promise<PaperReadingWorkspaceV1|null>;
    mutate(mutation:PaperReadingMutation,signal?:AbortSignal):Promise<PaperReadingReceipt>;
    begin(unitId:string,requestId:string,signal:AbortSignal,prepared?:PaperReadingTaskV1):Promise<PaperReadingWorkspaceV1>;
    evaluate(unitId:string,attemptId:string,requestId:string,signal:AbortSignal):Promise<PaperReadingWorkspaceV1>;
}
export interface PaperReadingAiPort{
    prepare(unit:PaperReadingUnitV1,requestId:string,signal:AbortSignal):Promise<PaperReadingTaskV1|null>;
    evaluate(task:PaperReadingTaskV1,answer:string,requestId:string,signal:AbortSignal):Promise<PaperReadingEvaluation>;
}
export type PaperReadingModelTrace={requestId:string;modelId:string;promptVersion:string;ruleVersion:string};
export interface PaperReadingProviderPort{
    run(kind:'prepare'|'evaluate',input:unknown,trace:PaperReadingModelTrace,budget:{maxOutputTokens:number},signal:AbortSignal):Promise<{
        output:unknown;trace:PaperReadingModelTrace;usageTokens?:number;
    }>;
}
