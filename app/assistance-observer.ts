import type {AssistanceAction,AssistanceObservation} from './assistance-summary';
// @ts-expect-error TS5097: standalone Node contract tests.
import {ASSISTANCE_ACTIONS} from './assistance-summary.ts';

/** Only held in the page's draft generation, never serialized. */
export type AssistanceObserverState={covered:boolean;submitted:boolean;invalid:boolean;seen:Set<string>;
  pre:Map<AssistanceAction,number>;post:Map<AssistanceAction,number>;sealed:AssistanceObservation|null;preListeners:Set<(action:AssistanceAction)=>void>};
export type AssistanceObserver={cover:()=>boolean;submit:()=>boolean;shown:(action:AssistanceAction,displayId:string)=>boolean;snapshot:()=>AssistanceObservation|null;onPreAssistance?:(listener:(action:AssistanceAction)=>void)=>()=>void};
export function emptyAssistanceObserverState():AssistanceObserverState{return{covered:false,submitted:false,invalid:false,seen:new Set(),pre:new Map(),post:new Map(),sealed:null,preListeners:new Set()};}

/** The storage owner supplies generation validity and the existing save lock.
 * Early submit marks a phase; it must not lock normal answer input. */
export function createAssistanceObserver(access:()=>{state:AssistanceObserverState;writable:boolean}|null):AssistanceObserver{
  const mutable=()=>{const entry=access();return entry?.writable&&!entry.state.sealed?entry.state:null;};
  return{
    onPreAssistance(listener){const state=access()?.state;state?.preListeners.add(listener);return()=>state?.preListeners.delete(listener);},
    cover(){const state=mutable();if(!state)return false;state.covered=true;return true;},
    submit(){const state=mutable();if(!state||!state.covered)return false;state.submitted=true;return true;},
    shown(action,displayId){
      const state=mutable();if(!state||!state.covered)return false;
      if(!ASSISTANCE_ACTIONS.includes(action)||typeof displayId!=='string'||!/^[a-zA-Z0-9:_.-]{1,120}$/.test(displayId)){state.invalid=true;return false;}
      if(action==='answer-feedback'&&!state.submitted)return false;
      const identity=action+'\u0000'+displayId;if(state.seen.has(identity))return false;
      if(state.seen.size>=10000){state.invalid=true;return false;}
      const counts=state.submitted?state.post:state.pre;counts.set(action,(counts.get(action)??0)+1);state.seen.add(identity);
      if(!state.submitted)for(const listener of state.preListeners)try{listener(action);}catch{state.invalid=true;}return true;
    },
    snapshot(){
      const state=access()?.state;if(!state?.covered||state.invalid)return null;
      if(!state.sealed){state.submitted=true;const rows=(counts:Map<AssistanceAction,number>)=>ASSISTANCE_ACTIONS.filter(action=>counts.has(action)).map(action=>({action,count:counts.get(action)!}));
        state.sealed={observationScope:'current-page-attempt',preSubmitAssistance:rows(state.pre),postSubmitFeedback:rows(state.post)};
      }
      return structuredClone(state.sealed);
    },
  };
}
