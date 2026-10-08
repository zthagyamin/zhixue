'use client';
import {registerStudyNavigationGuard} from './study-navigation-guard';
import {TrialMaterialBackupControls} from './trial-material-backup-controls';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {extractTrialQuestions,validateTrialFiles,type TrialQuestion,TRIAL_BYTE_LIMIT} from './note-trial-model';
import {SavedTrialMaterials} from './saved-trial-materials';
import {TRIAL_MATERIAL_OPEN,type TrialMaterialOpen} from './trial-material-events';
import {markTrialForRetry,trialRetryQueue} from './trial-review';
import './ux-remedies.css';
/** Answers stay in this session; only the separate, explicit material action persists source questions. */
export function NoteTrial({onConnect,featured=false,owner,library}:{onConnect:()=>void;featured?:boolean;owner?:string;library?:string}){
 const [questions,setQuestions]=useState<TrialQuestion[]>([]),[index,setIndex]=useState(0),[answer,setAnswer]=useState(''),[revealed,setRevealed]=useState(false),[done,setDone]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[pasted,setPasted]=useState('');
 const consumed=useRef<string|null>(null),run=useRef(0),alive=useRef(true),pending=useRef(false),card=useRef<HTMLElement>(null),focusNext=useRef(false);
 const container=useRef<HTMLDetailsElement>(null);
 const [queue,setQueue]=useState<number[]>([]),[marked,setMarked]=useState<string[]>([]),[retrying,setRetrying]=useState(false);
 useEffect(()=>{alive.current=true;const aliveRef=alive,runRef=run;return()=>{aliveRef.current=false;runRef.current++;};},[]);
 useEffect(()=>{if(focusNext.current){focusNext.current=false;card.current?.focus({preventScroll:true});}},[index,done,questions]);
 const dirty=Boolean(pasted.trim()||answer.trim()||questions.length&&!done||busy);
 const live=useRef({dirty}),leaving=useRef(false),guardRevision=useRef(0);
 useLayoutEffect(()=>{guardRevision.current++;live.current={dirty};leaving.current=false;},[dirty,pasted,answer,questions]);
 useEffect(()=>registerStudyNavigationGuard({message:()=>alive.current&&!leaving.current&&(live.current.dirty||pending.current)?'试学仍有未保存的输入或正在读取材料，离开后不会保留。仍要离开吗？':null,version:()=>guardRevision.current,onLeave:()=>{leaving.current=true;run.current++;pending.current=false;setBusy(false);}}),[]);
 useEffect(()=>{if(!dirty)return;const guard=(event:BeforeUnloadEvent)=>{if(leaving.current)return;event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
 const start=useCallback((next:TrialQuestion[])=>{if(!next.length){setError('没有找到足够的问答或正文。请粘贴一个 20–8000 字符的完整段落，或使用“Q: 问题 / A: 答案”。');return;}run.current++;pending.current=false;setBusy(false);leaving.current=false;consumed.current=null;focusNext.current=true;setQuestions(next);setQueue(next.map((_,i)=>i));setMarked([]);setRetrying(false);setIndex(0);setDone(false);setRevealed(false);setAnswer('');setPasted('');setError('');if(container.current)container.current.open=true;},[]);
 useEffect(()=>{const open=(event:Event)=>{const detail=(event as CustomEvent<TrialMaterialOpen>).detail;if(!detail||detail.owner!==owner||detail.library!==library||!Array.isArray(detail.questions))return;if((pending.current||pasted.trim()||answer.trim()||!done&&questions.length>0)&&!window.confirm('打开待学材料会替换当前临时试学和未提交输入，继续吗？'))return;start(detail.questions);requestAnimationFrame(()=>container.current?.scrollIntoView({block:'start'}));};window.addEventListener(TRIAL_MATERIAL_OPEN,open);return()=>window.removeEventListener(TRIAL_MATERIAL_OPEN,open);},[owner,library,pasted,answer,done,questions.length,start]);
 useEffect(()=>{const reveal=()=>{if(window.location.hash==='#note-trial'&&container.current){container.current.open=true;container.current.scrollIntoView({block:'start'});}};reveal();window.addEventListener('hashchange',reveal);return()=>window.removeEventListener('hashchange',reveal);},[]);
 async function load(files:File[]){
  if(pending.current)return;const invalid=validateTrialFiles(files);if(invalid){setError(invalid);return;}
  guardRevision.current++;leaving.current=false;
  pending.current=true;setBusy(true);setError('');const token=++run.current;
  try{const sources=await Promise.all(files.map(async file=>({name:file.name,text:new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())})));const next=extractTrialQuestions(sources);if(alive.current&&token===run.current)start(next);}
  catch{if(alive.current&&token===run.current)setError('无法读取材料，请确认它是 UTF-8 文本，再选择一个章节重试。');}
  finally{if(alive.current&&token===run.current){pending.current=false;setBusy(false);}}
 }
 const question=questions[queue[index]],retryQueue=trialRetryQueue(questions,marked);
 function assess(needsRetry:boolean){if(!question||consumed.current===question.id)return;consumed.current=question.id;setMarked(current=>markTrialForRetry(current,question.id,needsRetry));focusNext.current=true;setAnswer('');setRevealed(false);if(index+1>=queue.length)setDone(true);else setIndex(value=>value+1);}
 return <details ref={container} className={`note-trial${featured?' note-trial-featured':''}`} open={featured||undefined} id="note-trial" data-ai-private>
  <summary>{featured?'用自己的笔记，开始第一轮练习':'用一份自己的笔记试学 · 无需安装'}</summary>
  <p className="study-meta">选 1–2 个 Markdown / TXT 文件，或粘贴正文。仅在当前页面提取最多 3 道回忆题；不上传、不调用 AI、不写学习记录。临时输入在离开或刷新后不保留；完成后可自行选择保存题目到本机待学材料。</p>
  {!question&&!done&&<>
   <div className="note-trial-drop" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();void load(Array.from(event.dataTransfer.files));}}>
    <label>选择笔记（也可拖到此处）<input type="file" accept=".md,.markdown,.txt" multiple disabled={busy} onChange={event=>{void load(Array.from(event.target.files??[]));event.target.value='';}}/></label>
    <span className="study-meta">每个文件最多 256 KB；正文与答案按原文保留，不自动编写新事实。</span>
   </div>
   <details><summary>改为粘贴一段文字</summary><label>笔记正文<textarea maxLength={TRIAL_BYTE_LIMIT} value={pasted} onChange={event=>setPasted(event.target.value)} rows={5}/></label><button type="button" disabled={busy||!pasted.trim()} onClick={()=>{try{start(extractTrialQuestions([{name:'粘贴的笔记',text:pasted}]));}catch(e){setError(e instanceof Error?e.message:'材料无法解析。');}}}>从这段文字开始</button></details>
  </>}
  {busy&&<p role="status">正在本页读取材料…</p>}{error&&<p role="alert">{error}</p>}
  {question&&!done&&<section ref={card} tabIndex={-1} aria-label="个人笔记试学">
   <p className="study-meta">{retrying?'困难题再练 · ':''}第 {index+1} / {queue.length} 题 · {question.kind==='qa'?'原文问答':'段落回忆（对照自评）'}</p><h3>{question.prompt}</h3>
   <label>先写下你的理解<textarea rows={4} maxLength={8000} value={answer} onChange={event=>setAnswer(event.target.value)}/></label>
   <p className="study-meta">出处：{question.filename}{question.section?` · ${question.section}`:''}（文件名不代表已连接笔记库）</p>
   {!revealed?<button type="button" onClick={()=>setRevealed(true)}>查看原文并自评</button>:<><blockquote className="note-trial-excerpt">{question.answer}</blockquote><p>对照原文核对遗漏；本次不自动判断正确率或掌握度。再练标记仅在本页保留。</p><div className="trial-review-actions"><button type="button" onClick={()=>assess(true)}>仍不熟悉，标记再练</button><button type="button" onClick={()=>assess(false)}>已能回忆，{index+1===queue.length?'完成本轮':'继续下一题'}</button></div></>}
  </section>}
  {done&&<section ref={card} tabIndex={-1} aria-label="笔记试学完成" aria-live="polite"><h3>已完成 {queue.length} 道{retrying?'困难题再练':'笔记试学'}</h3><p>{retryQueue.length?`还有 ${retryQueue.length} 道题标记为需要再练。`:'本轮没有标记待练题；这不代表长期掌握。'}</p>{!!retryQueue.length&&<button type="button" onClick={()=>{consumed.current=null;focusNext.current=true;setQueue(retryQueue);setIndex(0);setRetrying(true);setDone(false);setAnswer('');setRevealed(false);}}>只练标记的 {retryQueue.length} 道题</button>}<p>这轮没有更改原笔记或正式复习安排。需要持续读取授权资料、按确认的操作写回笔记时，再连接本地资料助手。</p><button type="button" onClick={onConnect}>了解资料连接</button></section>}
  {!!questions.length&&<button type="button" onClick={()=>{if(!done&&!window.confirm('结束会清除本页试学和未提交输入，原文件不受影响。继续吗？'))return;run.current++;setQuestions([]);setAnswer('');setDone(false);setError('');}}>清除本次材料</button>}
  {owner&&library&&<SavedTrialMaterials key={JSON.stringify([owner,library])} owner={owner} library={library} questions={done?questions:[]} showList={false} onOpen={start}/>}
  {owner&&library&&<TrialMaterialBackupControls key={JSON.stringify(["backup",owner,library])} owner={owner} library={library}/>}
 </details>;
}
