import type {CloudProgress,CloudFSRSData} from './cloud-sync-types';
import type {StudyEventV3} from './study-event-v3';
export type NativeProjection={workspaceId:string;sourceScope:string;events:StudyEventV3[];excludedKeys:string[];itemStages:Record<string,number>;fsrsData:Record<string,CloudFSRSData>};
export function applySavedNativeAttempt(current:NativeProjection|null,scope:{workspaceId:string;sourceScope:string},event:StudyEventV3,fsrs:CloudFSRSData|undefined):NativeProjection|null{
  if(!current||current.workspaceId!==scope.workspaceId||current.sourceScope!==scope.sourceScope||event.eventType!=='practice-attempt')return current;
  return{...current,events:[...current.events.filter(value=>value.eventId!==event.eventId),event],itemStages:{...current.itemStages,[event.item.key]:event.attempt.stageAfter},fsrsData:fsrs?{...current.fsrsData,[event.item.key]:fsrs}:current.fsrsData};
}
export function nativeSourceScope(workspaceId:string,data:{source:{path?:string;scope:string};subjects:Array<{id:string;items:object[]}>}):string{
  return JSON.stringify([workspaceId,data.source.path??null,data.source.scope,data.subjects.map(subject=>[subject.id,subject.items.map(raw=>{
    const item=raw as Record<string,unknown>;return[item.abilityId??item.itemId??item.id??item.word??item.topic??null,item.contentHash??item.fingerprint??[item.word,item.meaning,item.prompt,item.answer],item.localBindingHash??null];
  })])]);
}
/** A derived display mask only. Keep the old cache intact for recovery; do not
 * turn an unexplained old value into a claim of zero progress or a score basis. */
export function nativeProgressView(base:CloudProgress,projection:NativeProjection|null,scope:{workspaceId:string;sourceScope:string}):{progress:CloudProgress;ready:boolean;unresolvedKeys:string[]}{
  if(!projection||projection.workspaceId!==scope.workspaceId||projection.sourceScope!==scope.sourceScope)return{progress:base,ready:false,unresolvedKeys:[]};
  const progress=structuredClone(base),unresolvedKeys:string[]=[];progress.itemStages={...progress.itemStages,...projection.itemStages};progress.fsrsData={...progress.fsrsData,...projection.fsrsData};
  for(const key of projection.excludedKeys){
    if(!Object.hasOwn(projection.itemStages,key)){
      if(Object.hasOwn(base.itemStages??{},key)||Object.hasOwn(base.fsrsData??{},key))unresolvedKeys.push(key);delete progress.itemStages[key];
    }
    if(!Object.hasOwn(projection.fsrsData,key))delete progress.fsrsData[key];
  }
  return{progress,ready:true,unresolvedKeys};
}
