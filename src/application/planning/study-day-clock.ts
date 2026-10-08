// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay,studyDayBounds} from '../../domain/planning/index.ts';

export function watchStudyDay(ports:{
  now:()=>Date;publish:(day:string)=>void;
  schedule:(callback:()=>void,delay:number)=>unknown;clear:(handle:unknown)=>void;
  onVisible:(callback:()=>void)=>()=>void;
}):()=>void{
  let active=true,handle:unknown;
  const tick=()=>{
    if(!active)return;
    if(handle!==undefined)ports.clear(handle);
    const now=ports.now(),day=studyDay(now.toISOString());ports.publish(day);
    handle=ports.schedule(tick,Math.max(1,Math.min(60000,studyDayBounds(day).end-now.valueOf())));
  };
  const unsubscribe=ports.onVisible(tick);tick();
  return()=>{active=false;unsubscribe();if(handle!==undefined)ports.clear(handle);};
}
