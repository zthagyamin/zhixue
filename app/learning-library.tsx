'use client';
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {DISCIPLINES,isDiscipline,PLUGIN_CAPABILITIES,FUTURE_LEARNING_CAPABILITIES,type CatalogSubject,type SubjectOrganization,type DisciplineId} from './learning-catalog';
import {readSubjectOrganization,visibleLibraryGroups} from './learning-library-model';
import {groupIsCollapsed,libraryDisclosureKey,parseCollapsedGroups,type CollapsedGroups} from './library-disclosure';
import {loadWorkspaceRecord,updateWorkspaceRecord} from './local-study-db';
import {NoteTrial} from './note-trial';
import {SavedTrialMaterials} from './saved-trial-materials';
import {openTrialMaterial} from './trial-material-events';
import type {PluginType} from './plugin-routing';
import './learning-library.css';
import './ux-remedies.css';
type Subject=CatalogSubject & {items?:unknown[]};
type Props={showTrial?:boolean;statusFor?:(id:string)=>string;subjects:Subject[];owner:string;library:string;onChoose:(id:string)=>void;paper:ReactNode;onSources:()=>void};
export function LearningLibrary(props:Props){return <LearningLibrarySession key={JSON.stringify([props.owner,props.library])} {...props}/>;}
function LearningLibrarySession({subjects,owner,library,onChoose,paper,onSources,statusFor,showTrial=true}:Props){
 const [saved,setSaved]=useState<SubjectOrganization|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [query,setQuery]=useState(''),[retry,setRetry]=useState(0),[pending,setPending]=useState(false);
 const [localMatches,setLocalMatches]=useState<number|null>(null);
 const [collapsed,setCollapsed]=useState<CollapsedGroups>({}),[disclosureNotice,setDisclosureNotice]=useState('');
 const active=useRef(false),saving=useRef(false),disclosureTouched=useRef(false),collapsedCurrent=useRef<CollapsedGroups>({}),kind=`subject-organization:${library}` as const,id=useId(),disclosureKey=libraryDisclosureKey(owner,library);
 useEffect(()=>{
  active.current=true;let cancelled=false;
  void loadWorkspaceRecord<unknown>(owner,kind,{}).then(raw=>{
   if(cancelled)return;const result=readSubjectOrganization(raw);setSaved(result.value);setError('');
   setNotice(result.recovered?'部分分类设置无法识别，暂用默认分类；原学习内容与记录保留。':'');
  }).catch(()=>{if(!cancelled)setError('分类设置尚未读取；仍可搜索和学习，请重试读取分类。');});
  return()=>{cancelled=true;active.current=false;};
 },[owner,kind,retry]);
 useEffect(()=>{let cancelled=false;void Promise.resolve().then(()=>{if(cancelled||disclosureTouched.current)return;try{const value=parseCollapsedGroups(localStorage.getItem(disclosureKey));collapsedCurrent.current=value;setCollapsed(value);}catch{/* Folding still works within this page. */}});return()=>{cancelled=true;};},[disclosureKey]);
 function showGroup(groupId:string,value:boolean){
  disclosureTouched.current=true;let latest=collapsedCurrent.current;
  try{latest={...latest,...parseCollapsedGroups(localStorage.getItem(disclosureKey))};}catch{/* Use this page's state. */}
  const next={...latest,[groupId]:value};collapsedCurrent.current=next;setCollapsed(next);
  try{localStorage.setItem(disclosureKey,JSON.stringify(next));setDisclosureNotice('');}catch{setDisclosureNotice('折叠状态仅在当前页面保留，学习内容与进度不受影响。');}
 }
 async function move(subjectId:string,value:DisciplineId){
  if(saved===null||saving.current||!active.current)return;
  saving.current=true;setPending(true);setError('');setNotice('');
  try{
   let committed:SubjectOrganization={};
   await updateWorkspaceRecord<unknown>(owner,kind,{},current=>{committed={...readSubjectOrganization(current).value,[subjectId]:value};return committed;});
   if(active.current){setSaved(committed);showGroup(value,false);setNotice('分类已保存；原内容和学习进度不变。');}
  }catch{if(active.current)setError('分类未保存，请重试；原内容和进度未移动。');}
  finally{saving.current=false;if(active.current)setPending(false);}
 }
 const groups=visibleLibraryGroups(subjects,saved??{},query),searching=Boolean(query.trim());
 return <div className="learning-library">
  <section className="learning-research-entry"><div><h3>论文与研究</h3><p>为任何学科读取论文，整理机制、证据与生词。论文保留自己的学科归属。</p></div>{paper}</section>
  <div className="learning-library-toolbar"><label>查找学科、课程或本机材料<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="输入学科、材料名称或文件名"/></label><button type="button" onClick={onSources}>添加学习资料</button></div>
  {showTrial&&<NoteTrial owner={owner} library={library} onConnect={onSources}/>}
  {error&&<div role="alert"><p>{error}</p>{saved===null&&<button type="button" className="study-secondary-action" onClick={()=>{setError('');setRetry(value=>value+1);}}>重新读取分类</button>}</div>}
  {pending?<p role="status">正在保存分类…</p>:notice&&<p role="status">{notice}</p>}
  {disclosureNotice&&<p role="status" className="study-meta">{disclosureNotice}</p>}
  {subjects.length>=12&&groups.length>1&&<nav className="library-group-index" aria-label="快速定位学科组">{groups.map(group=><button type="button" key={group.id} onClick={()=>{if(!searching)showGroup(group.id,false);requestAnimationFrame(()=>{const target=document.getElementById(`${id}-${group.id}-toggle`);target?.focus({preventScroll:true});target?.scrollIntoView({block:'start',behavior:'auto'});});}}>{group.label} · {group.subjects.length}</button>)}</nav>}
  <div className="learning-discipline-list">{groups.map((group,index)=>{const closed=groupIsCollapsed(collapsed,group.id,index,subjects.length,searching);return <section className="learning-discipline" key={group.id}>
   <header><div><h3><button id={`${id}-${group.id}-toggle`} type="button" className="library-group-toggle" aria-expanded={!closed} aria-controls={`${id}-${group.id}-cards`} aria-disabled={searching} title={searching?'搜索期间自动展开匹配组；清空搜索后恢复原折叠状态':closed?'展开此学科组':'收起此学科组'} onClick={()=>{if(!searching)showGroup(group.id,!closed);}}>{group.label}<span aria-hidden="true"> {closed?'＋':'−'}</span></button></h3><p>{group.description}</p></div><span>{searching?`显示 ${group.subjects.length} / ${group.total}`:group.subjects.length} 个学科 / 课程</span></header>
   <div id={`${id}-${group.id}-cards`} hidden={closed}>{group.subjects.map(subject=>{const capability=PLUGIN_CAPABILITIES[subject.pluginType as PluginType];return <article key={subject.id}>
    <button type="button" className="learning-subject-open" onClick={()=>onChoose(subject.id)}><strong>{subject.name}</strong><span>{statusFor?.(subject.id)??`${subject.items?.length??0} 项内容`} · {capability?.task??'开始学习'}</span><b aria-hidden="true">→</b></button>
    <details><summary aria-label={`调整 ${subject.name} 分类`}>调整分类</summary><label>所属学科组<select aria-label={`${subject.name} 的所属学科组`} value={group.id} disabled={saved===null||pending} onChange={e=>{if(isDiscipline(e.target.value))void move(subject.id,e.target.value);}}>{Object.entries(DISCIPLINES).map(([key,value])=><option key={key} value={key}>{value.label}</option>)}</select></label></details>
   </article>;})}</div>
  </section>;})}</div>
  <SavedTrialMaterials owner={owner} library={library} questions={[]} query={query} onMatchCount={setLocalMatches} onOpen={next=>openTrialMaterial(owner,library,next)}/>
  {searching&&!groups.length&&localMatches===0&&<p role="status">没有匹配的学科或本机材料。可以调整关键词，或添加学习资料。</p>}
  {!searching&&!subjects.length&&localMatches===0&&<p role="status">还没有正式题库；可先试学并保存本机材料。</p>}
  <details className="learning-capability-guide"><summary>按学习目标选择练习方式</summary><p>练习方式可跨学科共用。进入具体内容后，优先使用适合它的方式，也可在学习选项中调整。</p><dl>{Object.entries(PLUGIN_CAPABILITIES).map(([key,capability])=><div key={key}><dt>{capability.task}</dt><dd>{capability.description}</dd></div>)}</dl><details><summary>未来能力分类（规划，尚未提供）</summary>{FUTURE_LEARNING_CAPABILITIES.map(group=><p key={group.discipline}><strong>{group.discipline}：</strong>{group.tasks}</p>)}</details></details>
 </div>;
}
