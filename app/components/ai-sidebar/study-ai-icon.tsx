export type StudyAIIconName='spark'|'send'|'close'|'settings'|'float'|'dock'|'page'|'check'|'plus'|'chevron';
const paths:Record<StudyAIIconName,React.ReactNode>={
 spark:<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m20 2 .7 2.3L23 5l-2.3.7L20 8l-.7-2.3L17 5l2.3-.7L20 2Z"/></>,
 send:<><path d="m5 12 7-8 7 8M12 4v16"/></>,close:<path d="m6 6 12 12M18 6 6 18"/>,
 settings:<><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
 float:<><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8h4v4m0-4-6 6"/></>,
 dock:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14 4v16m-4-11 3 3-3 3"/></>,
 page:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8m-8 4h5"/></>,
 check:<path d="m5 12 4 4L19 6"/>,plus:<path d="M12 5v14M5 12h14"/>,chevron:<path d="m8 5 7 7-7 7"/>,
};
export function StudyAIIcon({name,size=20}:{name:StudyAIIconName;size?:number}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;}
