/** Coordinates visibility only. Owners retain draft data and decide when to unmount. */
export type ModalEntry={id:object;blocked:boolean;show:()=>void;hide:()=>void};
export function createModalCoordinator(){
 const entries:ModalEntry[]=[];let active:ModalEntry|undefined;
 function reconcile(){const next=entries.findLast(entry=>entry.blocked)??entries.at(-1);if(next===active)return;const previous=active;active=next;previous?.hide();next?.show();}
 return {current:()=>active,register(entry:ModalEntry){
  if(entries.some(value=>value.id===entry.id))throw new Error('Dialog already registered');
  entries.push(entry);reconcile();let removed=false;
  return {setBlocked(value:boolean){if(removed)return;entry.blocked=value;reconcile();},dispose(){if(removed)return;removed=true;const index=entries.indexOf(entry);if(index>=0)entries.splice(index,1);reconcile();}};
 }};
}