import type {ReactNode} from 'react';

type IconKind='words'|'conversation'|'paper'|'code'|'quiz'|'calculation'|'cards'|'spelling'|'library';
const shapes:Record<IconKind,ReactNode>={
 words:<><path d="M12 5.5C9 3.7 5.5 3.5 3 4.6v14c2.7-1.1 6-1 9 1 3-2 6.3-2.1 9-1v-14c-2.5-1.1-6-0.9-9 0.9Zm0 0v14"/><path d="M6 8h3M6 11h3m6-3h3m-3 3h3"/></>,
 conversation:<><path d="M6 4h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H9l-5 3v-4a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3Z"/><path d="M9.5 9a2.6 2.6 0 0 1 5 .9c0 1.6-2.5 1.7-2.5 3.1M12 16h.01"/></>,
 paper:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 12h8m-8 4h6"/></>,
 code:<><path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/></>,
 quiz:<><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m6.5 8 1.3 1.3L10 6.5M13 8h4M7 13h2m4 0h4M7 17h2m4 0h4"/></>,
 calculation:<><rect x="5" y="2.5" width="14" height="19" rx="3"/><path d="M8 7h8M8 12h2m-1-1v2m5-1h2M8 17h2m4-1h2m-2 2h2"/></>,
 cards:<><path d="M7 4V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-1"/><rect x="3" y="6" width="14" height="16" rx="2"/><path d="M6 11h8m-8 4h5"/></>,
 spelling:<><path d="M4 20h16M5 15 9 4h2l4 11M7 11h6M18 6v9m-2-7h4"/></>,
 library:<><rect x="3" y="4" width="5" height="17" rx="1"/><path d="M5 8h1m5-4v17m4-17 6 16-4 1-6-16 4-1Z"/></>,
};
export function StudyModuleIcon({pluginType,domain}:{pluginType:string;domain?:string}){
 const kind:IconKind=domain==='paper'&&pluginType==='recall'?'paper':pluginType==='three-stage'?'words':pluginType==='recall'?'conversation':pluginType==='code'?'code':pluginType==='quiz'?'quiz':pluginType==='calculation'?'calculation':pluginType==='flashcard'?'cards':pluginType==='spelling'?'spelling':'library';
 const tone=kind==='code'||kind==='calculation'?'warm':kind==='words'||kind==='paper'||kind==='spelling'?'blue':'navy';
 return <span className="module-icon study-module-icon" data-icon={kind} data-tone={tone} aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false">{shapes[kind]}</svg></span>;
}
