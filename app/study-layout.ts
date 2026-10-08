export type StudyLayout='auto'|'desktop'|'tablet'|'mobile';
const KEY='zhixue:appearance:layout:v1';
const widths={desktop:1440,tablet:900,mobile:390};
const valid=(value:unknown):value is StudyLayout=>['auto','desktop','tablet','mobile'].includes(String(value));
export function createLayoutPreference(storage:()=>Pick<Storage,'getItem'|'setItem'>){
  let current:StudyLayout|undefined;const listeners=new Set<()=>void>();
  return {getSnapshot:():StudyLayout=>{if(current===undefined){try{const value=storage().getItem(KEY);current=valid(value)?value:'auto';}catch{current='auto';}}return current;},
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    set:(value:StudyLayout)=>{if(!valid(value))return;current=value;try{storage().setItem(KEY,value);}catch{/* The current page can still switch. */}for(const listener of listeners)listener();}};
}
export const studyLayoutPreference=createLayoutPreference(()=>window.localStorage);
export const serverStudyLayout=():StudyLayout=>'auto';
const pixels=(number:string,unit:string)=>Number(number)*(unit.toLowerCase()==='px'?1:16);
const compare=(a:number,op:string,b:number)=>op==='>'?a>b:op==='>='?a>=b:op==='<'?a<b:op==='<='?a<=b:a===b;
/** Change only width conditions. Motion, contrast, pointer and height remain real. */
export function layoutMediaQuery(query:string,layout:StudyLayout):string{
  if(layout==='auto')return query;const width=widths[layout];
  const truth=(value:boolean)=>value?'(min-width: 0px)':'(width: 0px)';
  return query.replace(/\(\s*(?:(min|max)-)?width\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)/gi,(_all,bound,n,u)=>truth(compare(width,bound==='min'?'>=':bound==='max'?'<=':'=',pixels(n,u))))
    .replace(/\(\s*width\s*(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)/gi,(_all,op,n,u)=>truth(compare(width,op,pixels(n,u))))
    .replace(/\(\s*(\d+(?:\.\d+)?)(px|rem|em)\s*(>=|<=|>|<|=)\s*width\s*\)/gi,(_all,n,u,op)=>truth(compare(pixels(n,u),op,width)))
    .replace(/\(\s*(\d+(?:\.\d+)?)(px|rem|em)\s*(>=|<=|>|<)\s*width\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)/gi,(_all,a,au,ao,bo,b,bu)=>truth(compare(pixels(a,au),ao,width)&&compare(width,bo,pixels(b,bu))));
}
/** Reversible CSSOM overrides also cover lazy-loaded component/Tailwind styles. */
export function applyStudyLayout(document:Document,layout:StudyLayout){
  const originals=new Map<MediaList,string>();let frame=0;const win=document.defaultView!;
  document.documentElement.dataset.studyLayout=layout;
  function media(list:MediaList){const original=originals.get(list)??list.mediaText;if(!/\bwidth\b/i.test(original))return;if(!originals.has(list))originals.set(list,original);const next=layoutMediaQuery(original,layout);if(list.mediaText!==next)list.mediaText=next;}
  function rules(list:CSSRuleList){for(const rule of Array.from(list)){if('media'in rule)media((rule as CSSMediaRule).media);if('cssRules'in rule)rules((rule as CSSGroupingRule).cssRules);}}
  function scan(){frame=0;for(const sheet of Array.from(document.styleSheets)){try{media(sheet.media);rules(sheet.cssRules);}catch{/* Cross-origin font styles do not belong to the app. */}}}
  const schedule=()=>{if(!frame)frame=win.requestAnimationFrame(scan);};
  scan();const observer=new MutationObserver(schedule);observer.observe(document.head,{childList:true,subtree:true});document.addEventListener('load',schedule,true);
  return()=>{observer.disconnect();document.removeEventListener('load',schedule,true);if(frame)win.cancelAnimationFrame(frame);for(const [list,original] of originals){try{list.mediaText=original;}catch{/* A component may have removed its sheet. */}}delete document.documentElement.dataset.studyLayout;};
}
