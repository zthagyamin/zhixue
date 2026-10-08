"use client";

import type {MouseEvent} from 'react';

type NavigationProps={
  activeId:string;
  homeHref?:string;
  subjects:ReadonlyArray<{id:string;name:string}>;
  hidden?:boolean;
  settingsCount?:number;
  onNavigate:(id:string)=>void;
  onSettings:()=>void;
  onLibrary?:()=>void;
  accountSection?:import('react').ReactNode;
  aiSection?:import('react').ReactNode;
  paperEntry?:import('react').ReactNode;
};

export function StudyWorkspaceNavigation({activeId,homeHref="/",subjects,hidden,settingsCount=0,onNavigate,onSettings,onLibrary,accountSection,aiSection,paperEntry}:NavigationProps){
  function chooseSubject(event:MouseEvent<HTMLButtonElement>,id:string){
    event.currentTarget.closest('details')?.removeAttribute('open');
    onNavigate(id);
  }
  return <header data-ai-private className="study-workspace-nav" hidden={hidden}>
    <a href={homeHref} className="c-workspace-brand" aria-label="返回首页" title="返回网站首页">知学</a>
    <nav className="c-workspace-tabs" aria-label="主导航">
      <a href={homeHref} className="c-workspace-tab">首页</a>
      <button type="button" className="c-workspace-tab" aria-label="今日" aria-current={activeId==='today'?'page':undefined} onClick={()=>onNavigate('today')}>今日</button>
      <details className="c-subject-disclosure">
        <summary className="c-workspace-tab" aria-label="学科">学科 <span aria-hidden="true">⌄</span></summary>
        <div className="c-subject-popover" aria-label="今日学习模块">{paperEntry&&<div className="c-paper-nav-entry">{paperEntry}<hr/></div>}{onLibrary&&<><button type="button" onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');onLibrary();}}>浏览学科库 →</button><hr/></>}
          {subjects.length?subjects.map(subject=><button type="button" key={subject.id} aria-label={subject.name} aria-current={activeId===subject.id?'page':undefined} onClick={event=>chooseSubject(event,subject.id)}>{subject.name}<span aria-hidden="true">›</span></button>):<p>暂无可学习的学科</p>}
        </div>
      </details>
      <button type="button" className="c-workspace-tab" aria-label="学习进度" aria-current={activeId==='progress'?'page':undefined} onClick={()=>onNavigate('progress')}>进度</button>
    </nav>
    <div className="c-workspace-right-controls flex items-center gap-3">
      {aiSection}
      {accountSection}
      <button type="button" className="c-workspace-settings" aria-label="数据与设置" aria-current={activeId==='sources'?'page':undefined} onClick={onSettings}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 3-.6 2.2-2 .9-2-.6-2 3.4 1.5 1.6-.2 2.2L2 14l2 3.5 2.2-.4 1.8 1.3.5 2.6h4l.8-2.3 2-.9 2 .6 2-3.4-1.5-1.6.2-2.2L21 10l-2-3.5-2.2.4L15 5.6 14.5 3z"/><circle cx="11.5" cy="12" r="3"/></svg>
        <span>设置</span>{settingsCount>0&&<b className="c-nav-count">{settingsCount}</b>}
      </button>
    </div>
  </header>;
}
