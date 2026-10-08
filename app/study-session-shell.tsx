"use client";
import {StudyPluginOptionsProvider,StudyPluginOptionsSlot} from './study-plugin-options';

import {useSyncExternalStore,useId,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {useManagedDialog} from './use-managed-dialog';
import type {StudyTaskLead} from './study-view-model';

export function StudyIcon({name}:{name:'back'|'close'|'options'|'source'|'list'|'down'}) {
  const paths={back:'m14 5-7 7 7 7',close:'m6 6 12 12M18 6 6 18',options:'M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M10 14v6',source:'M5 4h9l5 5v11H5zM14 4v6h5M8 14h8M8 17h6',list:'M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1',down:'m6 9 6 6 6-6'};
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}

const subscribePortal=()=>()=>{};
const clientPortal=()=>true;
const serverPortal=()=>false;

/** Native modal keeps focus inside the panel; the practice subtree is never moved into it. */
export function StudyPanel({open,onClose,title,children,variant='side',dismissible=true,className=''}:{open:boolean;onClose:()=>void;title:string;children:ReactNode;variant?:'side'|'center';dismissible?:boolean;className?:string}) {
  const id=useId(),dialog=useRef<HTMLDialogElement>(null);
  const mounted=useSyncExternalStore(subscribePortal,clientPortal,serverPortal);
  const managed=useManagedDialog(dialog,open&&mounted,onClose,dismissible);
  const content=<dialog ref={dialog} className={`study-panel ${className}`.trim()} tabIndex={-1} data-variant={variant==='center'?'center':undefined} aria-labelledby={id}
    onKeyDown={event=>{
      if(event.key!=='Tab'||event.defaultPrevented||event.ctrlKey||event.metaKey)return;
      const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]'))
        .filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
      const first=controls[0],last=controls.at(-1),active=event.currentTarget.ownerDocument.activeElement;
      if(!first){event.preventDefault();event.currentTarget.focus();}
      else if(event.shiftKey&&(active===first||active===event.currentTarget)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&(active===last||active===event.currentTarget)){event.preventDefault();first.focus();}
    }}
    onCancel={event=>{event.preventDefault();managed.close();}} onClose={managed.onNativeClose}>
    <div className="study-panel-heading"><h2 id={id}>{title}</h2><button type="button" className="study-icon-button" aria-label={`关闭${title}`} disabled={!dismissible} onClick={managed.close}><StudyIcon name="close"/></button></div>
    <div className="study-panel-body">{children}</div>
  </dialog>;
  return mounted?createPortal(<div className="study-app study-modal-host" style={{display:'contents'}}>{content}</div>,document.body):content;
}

export interface StudySubjectItem {
  id: string;
  name: string;
  pluginType?: string;
}

/** 动态学科菜单：接收任意运行时学科，不设固定学科白名单，空 catalog 显示诚实空状态 */
export function StudySubjectMenu({
  subjects,
  activeId,
  onChoose,
}: {
  subjects: ReadonlyArray<StudySubjectItem>;
  activeId: string;
  onChoose: (id: string) => void;
}) {
  if (!subjects || subjects.length === 0) {
    return (
      <div className="study-subject-menu empty">
        <p className="study-empty-note">暂无可学习的学科</p>
      </div>
    );
  }

  return (
    <nav className="study-subject-menu" aria-label="切换学科">
      <ul className="study-subject-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {subjects.map((subject) => {
          const isActive = subject.id === activeId;
          return (
            <li key={subject.id} style={{ marginBottom: "0.5rem" }}>
              <button
                type="button"
                className={`study-subject-item ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onChoose(subject.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "0.75rem 1rem",
                  borderRadius: "0.5rem",
                  border: isActive ? "1px solid var(--c-accent)" : "1px solid var(--c-border)",
                  background: isActive ? "var(--c-accent-soft)" : "var(--c-card-bg)",
                  color: "var(--c-text-primary)",
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  minHeight: "44px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span className="study-subject-name">{subject.name}</span>
                {subject.pluginType && (
                  <span className="study-subject-kind" style={{ fontSize: "12px", fontWeight: 400 }}>
                    {subject.pluginType}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

type Panel='options'|'source'|'queue'|'subjects';
const titles:Record<Panel,string>={options:'学习选项',source:'学习来源',queue:'本组清单',subjects:'切换学科'};
export function StudyNextStep({lead,onStart,disabled=false}:{lead:StudyTaskLead|null;onStart:(taskId:string)=>void;disabled?:boolean}) {
  if(!lead)return null;
  return <div className="study-next-step"><div><p className="study-meta">{lead.kind==='continue'?'接着上次的任务':'按今天的安排'}</p><strong>{lead.title}</strong></div><button type="button" disabled={disabled} onClick={()=>onStart(lead.taskId)}>{lead.kind==='continue'?'继续学习':'开始下一项'}</button></div>;
}
export function StudyRecoveryState({onExit,children}:{onExit:()=>void;children:ReactNode}) {
  return <section className="study-recovery-state"><button type="button" className="study-back" onClick={onExit}><StudyIcon name="back"/>返回今日</button><div role="status">{children}</div></section>;
}
export function StudyEmptyPlanIcon(){
  return <svg className="c-empty-plan-clipboard" viewBox="0 0 64 72" fill="none" aria-hidden="true"><rect x="12" y="10" width="42" height="57" rx="6" stroke="currentColor" strokeWidth="5"/><path d="M23 10a9 9 0 0 1 18 0v4H23z" fill="currentColor"/><circle cx="32" cy="7" r="2" fill="white"/><path d="M23 30h20M23 41h20M23 52h13" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/></svg>;
}
export function StudyTaskGlyph({category,python=false}:{category:string;python?:boolean}){
  if(category==='new-word')return null;
  if(python)return <span className="c-task-glyph c-task-glyph-python" aria-hidden="true"/>;
  return <span className="c-task-glyph" data-category={category} aria-hidden="true"><svg viewBox="0 0 32 38" fill="none"><path d="M5 1h15l9 9v25a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z" fill="currentColor"/><path d="M20 1v9h9" fill="#ffffff" opacity=".55"/><path d="M9 17h14M9 22h14M9 27h10" stroke="white" strokeWidth="1.6" strokeLinecap="round"/></svg></span>;
}
export function StudyPlanMetrics({tasks,completedTaskIds,ready,itemProgressByTask={},reviewTarget}:{reviewTarget?:number;tasks:ReadonlyArray<{taskId:string;category:string;quantity:number}>;completedTaskIds:string[];ready:boolean;itemProgressByTask?:Record<string,{completed:number;total:number}>}) {
  const groups=[{category:'new-word',label:'新词'},{category:'review',label:reviewTarget===undefined?'必做复习':'全部到期复习'}];
  return <div className="c-plan-metrics">
    {groups.map(group=>{
      const rows=tasks.filter(task=>task.category===group.category),words=group.category==='new-word';
      const total=words?rows.reduce((sum,task)=>sum+task.quantity,0):rows.length;
      const known=ready&&(!words||rows.every(task=>itemProgressByTask[task.taskId]||completedTaskIds.includes(task.taskId)));
      const done=!known?null:words?rows.reduce((sum,task)=>sum+(itemProgressByTask[task.taskId]?.completed??task.quantity),0):rows.filter(task=>completedTaskIds.includes(task.taskId)).length;
      return <section className="c-metric-card" key={group.category}>
        <div className="c-metric-line"><h4>{group.label}</h4><p className="c-metric-value"><b>{done===null?'—':done}</b><small>/ {total} {words?'词':'项'}</small></p></div>
        <progress aria-label={`${group.label}任务完成`} value={done??undefined} max={total||1}/>
        <p className="c-metric-caption">{done===null?'完成情况待核对':!rows.length?'此计划暂未安排':!words&&reviewTarget!==undefined?`默认目标 ${reviewTarget} 条，可在下方追加`:`还需${words?'学习':'复习'} ${Math.max(0,total-done)} ${words?'词':'项任务'}`}</p>
      </section>;
    })}
  </div>;
}
export function StudyTodayLayout({plan,modules,context,notice,contextAlert=false}:{plan:ReactNode;modules:ReactNode;context:ReactNode;notice?:ReactNode;contextAlert?:boolean}) {
  return <div className="study-today-grid">
    <div className="study-today-plan">{plan}</div>
    <section className="study-library" id="study-subjects"><header><h2>按学科学习</h2><span>继续今日任务，或进入学科选择自由练习</span></header>{modules}</section>
    <details className="study-context" open={contextAlert||undefined}><summary>资料与同步详情{contextAlert?' · 有待检查项':''}</summary><div>{context}</div></details>
    {notice}
  </div>;
}
export function StudySessionShell({title,scope,progress,mode,onExit,options,source,queue,subjects,children,notice,assistant}:{
  title:string;scope:string;progress:string;mode:string;onExit:()=>void;options:ReactNode;source:ReactNode;queue:ReactNode;subjects:ReactNode;children:ReactNode;notice?:string;assistant?:ReactNode;
}) {
  const [panel,setPanel]=useState<Panel|null>(null);
  const [queueOpen,setQueueOpen]=useState(false);
  const queueId=useId();
  const queueTrigger=useRef<HTMLButtonElement>(null);
  const queueClose=useRef<HTMLButtonElement>(null);
  const closeQueue=()=>{setQueueOpen(false);queueTrigger.current?.focus({preventScroll:true});};
  const toggleQueue=()=>{
    if(window.matchMedia('(max-width: 760px)').matches){setPanel('queue');return;}
    if(queueOpen){closeQueue();return;}
    setQueueOpen(true);
    requestAnimationFrame(()=>queueClose.current?.focus({preventScroll:true}));
  };
  return <StudyPluginOptionsProvider><section className="study-session-shell study-primary-session" aria-label={`${title}专注学习`}>
    <header className="study-session-topbar">
      <button type="button" className="study-back" onClick={onExit} aria-label="返回今日"><StudyIcon name="back"/><span>今日</span></button>
      <div className="study-session-context"><button type="button" onClick={()=>setPanel('subjects')} aria-haspopup="dialog">{title}<StudyIcon name="down"/></button><p>{scope}</p></div>
      <button type="button" className="study-options-trigger" aria-label="学习选项" aria-haspopup="dialog" aria-expanded={panel==='options'} onClick={()=>setPanel('options')}><StudyIcon name="options"/><span>学习选项</span></button>
    </header>
    <div className="study-session-meta">
      <div className="study-session-status"><span>{mode}</span><span>{progress}</span>{assistant}</div>
      <div className="study-session-footer" role="group" aria-label="学习辅助工具">
        <button type="button" onClick={()=>setPanel('source')} aria-haspopup="dialog" aria-label="查看来源"><StudyIcon name="source"/><span>查看来源</span></button>
        <button ref={queueTrigger} type="button" onClick={toggleQueue} aria-controls={queueId} aria-expanded={queueOpen||panel==='queue'} aria-label={queueOpen?'收起本组清单':'展开本组清单'}><StudyIcon name="list"/><span>本组清单</span></button>
      </div>
    </div>
    <div className="study-session-main" data-queue-open={queueOpen||undefined}>
      <div className="study-session-content">{children}</div>
      <aside id={queueId} className="study-session-queue" aria-label="本组清单" hidden={!queueOpen}>
        <div className="study-session-queue-heading"><h2>本组清单</h2><button ref={queueClose} type="button" className="study-icon-button" aria-label="收起本组清单" onClick={closeQueue}><StudyIcon name="close"/></button></div>
        <div role="presentation" onClick={event=>{if((event.target as HTMLElement).closest('.word-stage-list button'))closeQueue();}}>{queue}</div>
      </aside>
    </div>
    {notice&&<p className="study-source-update-note" role="status">{notice}</p>}
    <StudyPanel open={panel!==null} onClose={()=>setPanel(null)} title={titles[panel??'options']}>
      <div hidden={panel!=='options'}><StudyPluginOptionsSlot/>{options}</div>
      <div hidden={panel!=='source'}>{source}</div>
      <div hidden={panel!=='queue'} onClick={event=>{if((event.target as HTMLElement).closest('button'))setPanel(null);}} role="presentation">{queue}</div>
      <div hidden={panel!=='subjects'} onClick={event=>{if((event.target as HTMLElement).closest('button'))setPanel(null);}} role="presentation">{subjects}</div>
    </StudyPanel>
  </section></StudyPluginOptionsProvider>;
}
