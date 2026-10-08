import type {SubjectRound} from '../src/domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
export {restoredSubjectRound,taskRoundIdentity,firstPendingRoundIndex,nativeTaskCompletedKeys} from '../src/domain/planning/index.ts';
export function createSubjectRoundSessions(){
 let visible:Record<string,SubjectRound>={},revision=0;const scopes=new Map<string,string>(),cache=new Map<string,SubjectRound>(),listeners=new Set<()=>void>();
 const emit=()=>{revision++;for(const listener of [...listeners])listener();};
 return {
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  getSnapshot:()=>revision,getRounds:()=>visible,get:(scope:string)=>cache.get(scope),
  getVisible:(subjectId:string)=>({scope:scopes.get(subjectId),round:visible[subjectId]}),
  set(next:Record<string,SubjectRound>|((current:Record<string,SubjectRound>)=>Record<string,SubjectRound>)){
   const value=typeof next==='function'?next(visible):next;if(value===visible)return;
   if(!Object.keys(value).length){cache.clear();scopes.clear();}
   for(const [id,round]of Object.entries(value)){const scope=scopes.get(id);if(scope)cache.set(scope,round);}
   visible=value;emit();
  },
  activate(subjectId:string,scope:string,seed:SubjectRound){const round=cache.get(scope)??seed;cache.set(scope,round);scopes.set(subjectId,scope);visible={...visible,[subjectId]:round};emit();return round;},
 };
}
