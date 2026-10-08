export type StudySwipe='left'|'right'|'up';
export type SwipePoint={x:number;y:number;time:number};
export function classifyStudySwipe(start:SwipePoint,end:SwipePoint,allowVertical=false):StudySwipe|null{
 const dx=end.x-start.x,dy=end.y-start.y,duration=end.time-start.time;
 if(![dx,dy,duration].every(Number.isFinite)||duration<0||duration>1800)return null;
 if(Math.abs(dx)>=64&&Math.abs(dx)>Math.abs(dy)*1.5)return dx>0?'right':'left';
 if(allowVertical&&dy<=-64&&Math.abs(dy)>Math.abs(dx)*1.5)return 'up';
 return null;
}
export function studySwipeAction(direction:StudySwipe|null,state:{revealed:boolean;ready:boolean;busy:boolean;current:boolean}):'reveal'|'again'|'good'|null{
 if(!direction||!state.ready||state.busy||!state.current)return null;
 if(direction==='up')return state.revealed?null:'reveal';
 if(!state.revealed)return null;
 return direction==='right'?'good':'again';
}
