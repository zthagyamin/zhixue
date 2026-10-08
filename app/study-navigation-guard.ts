/** Page-lifetime guards; no persistence, network or imported user data. */
type Guard={message:()=>string|null;onLeave:()=>void;version?:()=>unknown};
const guards=new Set<Guard>();
export function registerStudyNavigationGuard(guard:Guard){guards.add(guard);return()=>{guards.delete(guard);};}
/** Async actions can obtain consent now and commit only when navigation really occurs. */
export function prepareStudyNavigation(confirm?:(message:string)=>boolean):(()=>boolean)|null{
 const active=[...guards].filter(guard=>guard.message()!==null),versions=active.map(guard=>guard.version?.());
 const ask=confirm??(message=>typeof window!=='undefined'&&window.confirm(message));
 if(active.length&&!ask([...new Set(active.map(guard=>guard.message()))].join('\n')))return null;
 return()=>{
  const latest=[...guards].filter(guard=>guard.message()!==null);
  if(latest.length!==active.length||latest.some((guard,index)=>guard!==active[index]||guard.version?.()!==versions[index]))return confirmStudyNavigation(confirm);
  for(const guard of latest)guard.onLeave();return true;
 };
}
export function confirmStudyNavigation(confirm?:(message:string)=>boolean):boolean{return prepareStudyNavigation(confirm)?.()??false;}
