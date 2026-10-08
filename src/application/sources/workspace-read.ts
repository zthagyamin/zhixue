export class WorkspaceReadError extends Error{
  readonly phase:'storage-error'|'identity-error';
  constructor(phase:'storage-error'|'identity-error'){super(phase);this.phase=phase;}
}
export async function readWorkspaceSnapshot<Identity,Stored>(ports:{
  identity:(signal:AbortSignal)=>Promise<Identity>;owner:(identity:Identity)=>string;storage:(owner:string)=>Promise<Stored>;
  identified:(identity:Identity)=>void;
},signal:AbortSignal){
  let identified=false;
  try{
    const identity=await ports.identity(signal);signal.throwIfAborted();identified=true;ports.identified(identity);
    const owner=ports.owner(identity),stored=await ports.storage(owner);signal.throwIfAborted();return{identity,owner,stored};
  }catch(error){if(signal.aborted)throw error;throw new WorkspaceReadError(identified?'storage-error':'identity-error');}
}
