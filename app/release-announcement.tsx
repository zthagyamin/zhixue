'use client';
import {useEffect,useRef,useState} from 'react';
import announcements from './release-announcements.json';
import {announcementReceiptPrefix,createAnnouncementReceipt} from './release-announcements-model';
import {useStudyArrival} from './onboarding';
import {StudyPanel} from './study-session-shell';

export function ReleaseAnnouncement({scope,ready=false,blocked=false}:{scope?:string;ready?:boolean;blocked?:boolean}={}){
  const current=announcements[0];
  const [receipt]=useState(()=>createAnnouncementReceipt(()=>window.localStorage));
  const [visible,setVisible]=useState(false);
  const attempted=useRef(false),arrival=useStudyArrival();
  useEffect(()=>{
    // Wait for identity/loading, but do not surprise a learner when a busy session later ends.
    if(attempted.current||!ready||!arrival.visit||arrival.scope!==scope)return;
    if(blocked||arrival.tutorialOpen||arrival.visit.announcementVersion!==current.version){attempted.current=true;return;}
    const frame=window.requestAnimationFrame(()=>{
      attempted.current=true;
      if(document.querySelector('dialog[open]')||document.visibilityState==='hidden')return;
      const active=document.activeElement;
      if(active instanceof HTMLElement&&active.matches('input,textarea,select,[contenteditable="true"]'))return;
      if(!receipt.hasRead(current.version))setVisible(true);
    });
    return()=>window.cancelAnimationFrame(frame);
  },[ready,blocked,scope,arrival,current.version,receipt]);
  useEffect(()=>{
    // Storage changes only close an acknowledged dialog; clearing data never opens a new modal.
    const onStorage=(event:StorageEvent)=>{if((event.key===null||event.key===announcementReceiptPrefix+current.version)&&receipt.hasRead(current.version))setVisible(false);};
    const show=()=>setVisible(true);
    window.addEventListener('storage',onStorage);
    window.addEventListener('zhixue:show-release-announcement',show);
    return()=>{window.removeEventListener('storage',onStorage);window.removeEventListener('zhixue:show-release-announcement',show);};
  },[current.version,receipt]);
  function acknowledge(){receipt.acknowledge(current.version);setVisible(false);}
  return <StudyPanel open={visible} onClose={acknowledge} title="知学更新" variant="center" className="release-dialog">
    <div className="release-dialog-intro"><div className="release-dialog-meta"><span>v{current.version}</span><time dateTime={current.date}>{current.date.replaceAll('-','.')}</time></div><h2>{current.title}</h2><p>这次为你的学习带来这些变化。</p></div>
    <ol className="release-dialog-changes">{current.changes.map((change,index)=><li key={change}><span aria-hidden="true">{String(index+1).padStart(2,'0')}</span><p>{change}</p></li>)}</ol>
    <footer className="release-dialog-actions"><a href={`/updates#v${current.version}`} target="_blank" rel="noreferrer">历史公告 <span aria-hidden="true">↗</span></a><button type="button" onClick={acknowledge}>我知道了 <span aria-hidden="true">→</span></button></footer>
  </StudyPanel>;
}
export function ShowReleaseAnnouncementButton(){return <button className="release-reopen" type="button" onClick={()=>window.dispatchEvent(new Event('zhixue:show-release-announcement'))}>查看本次公告</button>;}
