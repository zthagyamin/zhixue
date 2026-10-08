'use client';
import {useEffect,useRef,useState} from 'react';
import {loadTrialMaterials,saveTrialMaterial,removeTrialMaterial,matchTrialMaterials,type SavedTrialMaterial} from './saved-note-trials';
import {TRIAL_MATERIALS_CHANGED} from './trial-material-events';
import type {TrialQuestion} from './note-trial-model';
export function SavedTrialMaterials({owner,library,questions,onOpen,showList=true,query='',onMatchCount}:{owner:string;library:string;questions:TrialQuestion[];onOpen:(questions:TrialQuestion[])=>void;showList?:boolean;query?:string;onMatchCount?:(count:number)=>void}){
 const [items,setItems]=useState<SavedTrialMaterial[]>([]),[subject,setSubject]=useState(''),[title,setTitle]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0),[loaded,setLoaded]=useState(false);
 const lifetime=useRef({active:true,busy:false});
 useEffect(()=>{const life=lifetime.current;life.active=true;let cancelled=false,epoch=0;
  const reload=()=>{const token=++epoch;void loadTrialMaterials(owner,library).then(value=>{if(!cancelled&&token===epoch){setItems(value);setLoaded(true);}}).catch(error=>{if(!cancelled&&token===epoch){setLoaded(false);setMessage(error instanceof Error?error.message:'待学材料暂时无法读取。');}});};
  reload();window.addEventListener(TRIAL_MATERIALS_CHANGED,reload);window.addEventListener('focus',reload);
  return()=>{cancelled=true;life.active=false;window.removeEventListener(TRIAL_MATERIALS_CHANGED,reload);window.removeEventListener('focus',reload);};
 },[owner,library,retry]);
 const matches=matchTrialMaterials(items,query);
 useEffect(()=>{if(loaded)onMatchCount?.(matches.length);},[loaded,matches.length,onMatchCount]);
 async function run(action:()=>Promise<void>){const life=lifetime.current;if(life.busy)return;life.busy=true;setBusy(true);try{await action();}catch(error){if(life.active)setMessage(error instanceof Error?error.message:'保存未完成，当前材料仍保留。');}finally{life.busy=false;if(life.active)setBusy(false);}}
 return <section className="saved-trial-materials" aria-label={showList?'本机待学材料':'保存试学材料'} id={showList?'saved-trial-materials':undefined} data-ai-private>
  {!!questions.length&&<details><summary>保存到本机待学材料</summary><p>保存本轮题目与原文参考，方便下次重新练习。仅保存在这台设备的当前浏览器，不同步到账号或 Obsidian，不计入正式成绩和复习计划。</p>
   <label>学科名称<input maxLength={80} placeholder="例如：微观经济学" value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy}/></label>
   <label>材料名称<input maxLength={180} placeholder={questions[0]?.filename||'本次笔记'} value={title} onChange={e=>setTitle(e.target.value)} disabled={busy}/></label>
   <button type="button" disabled={busy||!subject.trim()} onClick={()=>void run(async()=>{await saveTrialMaterial(owner,library,subject,title.trim()||questions[0].filename,questions);if(lifetime.current.active){window.dispatchEvent(new Event(TRIAL_MATERIALS_CHANGED));setMessage('已保存。可在学科列表下方的“本机待学材料”中找到，也可按学科或材料名称搜索。');}})}>{busy?'正在保存…':'确认保存材料'}</button>
  </details>}
  {message&&<p role="status">{message} <button type="button" disabled={busy} onClick={()=>{setMessage('');setRetry(value=>value+1);}}>重新读取材料</button></p>}
  {showList&&<><h3>本机待学材料{loaded?` · ${items.length} 份`:''}</h3><p>仅此浏览器 · 可按上方学科、材料名称或文件名搜索；不计入正式计划。重新练习从第一题开始。</p>
   {!loaded&&!message&&<p role="status">正在读取本机材料…</p>}
   {loaded&&!matches.length&&<p>{query.trim()?'没有匹配的本机材料。':'还没有保存的材料。用自己的笔记试学，完成后即可保存到这里。'}</p>}
   {Array.from(new Set(matches.map(item=>item.subject))).map(name=><section key={name}><h4>{name}</h4><ul>{matches.filter(item=>item.subject===name).map(item=><li key={item.id}><button type="button" disabled={busy} onClick={()=>onOpen(item.questions)}>{item.title} · {item.questions.length} 题 · 重新练习</button><button type="button" disabled={busy} aria-label={`移除待学材料 ${item.title}`} onClick={()=>{if(window.confirm('仅移除这份本机待学材料，原笔记和正式学习记录不受影响。继续吗？'))void run(async()=>{await removeTrialMaterial(owner,library,item.id);if(lifetime.current.active){window.dispatchEvent(new Event(TRIAL_MATERIALS_CHANGED));setMessage('已移除待学材料。');}});}}>移除</button></li>)}</ul></section>)}
  </>}
 </section>;
}
