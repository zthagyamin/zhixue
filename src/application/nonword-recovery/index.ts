/** Explicit UI ports. File decoding and controlled storage remain in the composition adapters. */
export type RestoreControlPreview={previewHash:string;restorable:number;existing:number;conflicts:number;review:number};
export type RestoreControlResult={status:'restored'|'partial'|'stale';restored:number;existing:number;conflicts:number;review:number};
export type RecoveryControlPort={
 preview:(workspaceId:string,raw:unknown,guard:{current:()=>boolean})=>Promise<RestoreControlPreview>;
 restore:(workspaceId:string,raw:unknown,previewHash:string,guard:{current:()=>boolean})=>Promise<RestoreControlResult>;
 archives:(workspaceId:string)=>Promise<{sourceHash:string;source:unknown}[]>;
};
