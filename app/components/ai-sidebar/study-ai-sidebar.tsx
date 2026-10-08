'use client';
import {useEffect,useRef,useState} from 'react';
import {StudyAIRequestGate,readStudyAIHistory,writeStudyAIHistory,studyAIHistoryKey} from '../../ai/study-ai-service';
import {buildStudyAIRequest} from '../../ai/study-ai-context';
import {legacyStudyAIConversations,legacyStudyAIContextId} from '../../ai/study-ai-conversations';
import {studyAIErrorMessage,suggestedStudyAIModel} from '../../ai/study-ai-errors';
import type {StudyAIMessage,StudyAIProvider} from '../../ai/study-ai-types';
import {useStudyAIWorkspace,useOptionalStudyAIWorkspace} from './study-ai-workspace';
import {StudyAIChatStream} from './study-ai-chat-stream';
import {observeStudyAIReplies,studyAIRepliesForContext} from '../../ai/study-ai-assistance';
import {StudyAISettings} from './study-ai-settings';
import {StudyAIIcon} from './study-ai-icon';
import {StudyAICopyPrompt} from './study-ai-copy-prompt';

export function StudyAITrigger({onUnavailable}:{onUnavailable?:()=>void}){
 const workspace=useOptionalStudyAIWorkspace();if(!workspace&&!onUnavailable)return null;
 const ready=Boolean(workspace?.settings?.enabled&&workspace.settings.configured);
 return <button type="button" className="study-ai-nav-trigger" aria-label={ready?'打开 AI 学习助手':'配置 AI 学习助手'} aria-expanded={Boolean(workspace&&workspace.mode!=='collapsed')} onClick={()=>!ready&&onUnavailable?onUnavailable():workspace?.setMode(workspace.mode==='collapsed'?'docked':'collapsed')}><StudyAIIcon name="spark" size={18}/><span>{ready?'问 AI':'配置 AI'}</span></button>;
}
function ChatSession({visible,onSettings,drafts,onDraft}:{visible:boolean;onSettings:()=>void;drafts:Record<string,string>;onDraft:(key:string,value:string)=>void}){
 const {context,scope,settings,service,setSettings,assistance}=useStudyAIWorkspace();
 const [conversation,setConversation]=useState('current'),[conversations,setConversations]=useState(['current']);
 const [legacy,setLegacy]=useState<ReturnType<typeof legacyStudyAIConversations>>([]),[indexReady,setIndexReady]=useState(false);
 const [messages,setMessages]=useState<StudyAIMessage[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loadedKey,setLoadedKey]=useState(''),[historyError,setHistoryError]=useState(false),[includePage,setIncludePage]=useState(true);
 const gate=useRef(new StudyAIRequestGate()),provider=settings?.provider??'deepseek';
 const key=legacy.find(item=>item.id===conversation)?.key??studyAIHistoryKey(scope,provider,`workspace:${conversation}`),indexKey=studyAIHistoryKey(scope,provider,'workspace-index');
 const input=drafts[key]??'',setInput=(value:string)=>onDraft(key,value);
 useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(!active)return;try{
   const archived=legacyStudyAIConversations(localStorage,scope,provider);setLegacy(archived);
   const saved=JSON.parse(localStorage.getItem(indexKey)??'null'),ids=Array.isArray(saved?.ids)?saved.ids.filter((id:unknown)=>typeof id==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(id)).slice(-50):['current'];
   const next=ids.length?ids:['current'];setConversations(next);if(next.includes(saved?.current)||archived.some(item=>item.id===saved?.current))setConversation(saved.current);
  }catch{setHistoryError(true);}setIndexReady(true);});return()=>{active=false;};},[indexKey,scope,provider]);
 useEffect(()=>{if(!indexReady)return;try{localStorage.setItem(indexKey,JSON.stringify({ids:conversations,current:conversation}));}catch{/* History remains in this mounted session. */}},[indexReady,indexKey,conversations,conversation]);
 useEffect(()=>{if(!indexReady)return;let active=true;const currentGate=gate.current;void Promise.resolve().then(()=>{if(!active)return;try{setMessages(readStudyAIHistory(localStorage,key));}catch{setHistoryError(true);}setLoadedKey(key);});return()=>{active=false;currentGate.invalidate();};},[key,indexReady]);
 useEffect(()=>{if(loadedKey!==key)return;try{writeStudyAIHistory(localStorage,key,messages);}catch{/* Do not erase the visible transcript on a storage failure. */}},[key,messages,loadedKey]);
 useEffect(()=>{const shown=()=>observeStudyAIReplies(assistance,studyAIRepliesForContext(messages,context.id,legacyStudyAIContextId(key),loadedKey===key),visible&&document.visibilityState!=='hidden');shown();document.addEventListener('visibilitychange',shown);return()=>document.removeEventListener('visibilitychange',shown);},[assistance,messages,context.id,visible,key,loadedKey]);
 const stop=()=>{gate.current.invalidate();setBusy(false);};
 const newConversation=()=>{stop();setInput('');setError('');const id=crypto.randomUUID();setConversations(ids=>[...ids,id].slice(-50));setConversation(id);};
 const ready=loadedKey===key&&settings?.enabled&&settings.configured&&Boolean(settings.model)&&settings.serverAvailable!==false&&!suggestedStudyAIModel(provider,settings.model,settings.baseUrl);
 async function send(text=input,retry=false){
  if(!text.trim()||!settings||busy||!ready)return;
  const task=gate.current.begin(),user:StudyAIMessage={id:crypto.randomUUID(),role:'user',content:text.trim(),contextId:context.id,contextTitle:includePage?context.title:'自由提问（未引用页面）'},answer:StudyAIMessage={id:crypto.randomUUID(),role:'assistant',content:'',provider,contextId:context.id,contextTitle:includePage?context.title:'自由提问（未引用页面）'};
  const base=retry&&messages.at(-1)?.role==='user'&&messages.at(-1)?.content===text?messages.slice(0,-1):messages,prior=[...base,user];
  const request=buildStudyAIRequest(settings,includePage?context:{id:'free-chat',title:'自由提问'},prior,`chat:${crypto.randomUUID()}`);
  if(scope.mode==='account'&&!settings.unlimitedDailyUsage&&new TextEncoder().encode(JSON.stringify(request)).length+settings.maxOutputTokens>settings.dailyTokenLimit){setError('本次引用内容超过当前每日用量上限。可关闭页面引用，或在 AI 设置中调整用量限制。');return;}
  setMessages([...prior,answer]);setInput('');setBusy(true);setError('');
  try{for await(const event of service.chat(request,task.signal)){if(!task.current())return;setMessages(current=>current.map(message=>message.id!==answer.id?message:event.type==='delta'?{...message,content:message.content+event.text}:{...message,model:event.model,provider:event.provider??provider}));}}
  catch(error){if(task.current()){setMessages(current=>current.filter(message=>message.id!==answer.id||message.content.trim()));setError(studyAIErrorMessage(error));}}
  finally{if(task.current())setBusy(false);}
 }
 async function switchProvider(next:StudyAIProvider){if(!settings)return;stop();setError('');try{const selected=settings.providers[next];setSettings(await service.configure({provider:next,model:selected.model,baseUrl:selected.baseUrl,enabled:settings.enabled&&selected.configured&&Boolean(selected.model),expectedRevision:settings.revision,confirmCosts:settings.enabled,dailyRequestLimit:settings.dailyRequestLimit,dailyTokenLimit:settings.dailyTokenLimit,concurrentLimit:settings.concurrentLimit,maxOutputTokens:settings.maxOutputTokens}));}catch(error){setError(studyAIErrorMessage(error));}}
 const suggestions=context.code?[['提示思路','给我一个提示，先不要直接写答案。'],['检查代码','根据当前代码与上次运行信息，指出下一步该检查哪里。'],['出一道变式','请给我一道检验相同知识点的变式。']]:context.pageKind==='today'?[['梳理今天','请结合当前学习安排，帮我梳理今天的学习顺序。'],['从哪里开始','我应该先从哪门学科开始？请说明依据。'],['解释安排','解释当前页面的学习安排，区分确定信息和建议。']]:[['给个提示','结合当前页面，给我一个提示，先不揭示答案。'],['解释内容','解释当前页面的核心概念和关键联系。'],['检验理解','请围绕当前学习内容，问我一个检查理解的问题。']];
 return <>
  <div className="study-ai-toolbar"><label><span>模型提供商</span><select aria-label="切换 AI 提供商" value={provider} disabled={!settings||busy} onChange={event=>void switchProvider(event.target.value as StudyAIProvider)}><option value="deepseek">DeepSeek</option><option value="chatgpt">ChatGPT · OpenAI</option></select></label><label className="study-ai-conversation-select"><span>对话记录</span><select aria-label="选择对话" value={conversation} onChange={event=>{stop();setError('');setConversation(event.target.value);}}>{conversations.map((id,index)=><option key={id} value={id}>{index===0?'当前对话':`对话 ${index+1}`}</option>)}{legacy.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><button type="button" title="新建对话" aria-label="新建对话" onClick={newConversation}><StudyAIIcon name="plus"/></button></div>
  <div className="study-ai-page-context"><div><StudyAIIcon name="page"/><span><strong>{context.title}</strong><small>{includePage?'自动关联当前页面':'本次不引用页面内容'}{context.truncated?' · 内容已精简':''}</small></span><label className="study-ai-context-toggle"><input type="checkbox" checked={includePage} onChange={event=>setIncludePage(event.target.checked)} aria-label="引用当前页面"/><span>引用</span></label></div>{includePage&&<details><summary>查看将引用的内容</summary><pre>{[context.pageText,context.question,context.learnerAnswer&&`我的尝试：${context.learnerAnswer}`,context.code,context.errors?.join('\n'),context.selection&&`选中文字：${context.selection}`].filter(Boolean).join('\n\n')||'当前页暂无可引用的学习内容。'}</pre></details>}</div>
  {!ready&&<div className="study-ai-setup-callout"><strong>{settings?.configured?'还差一步即可提问':'先连接你的模型'}</strong><p>{settings?.configured?'请确认已选择有效模型、启用并保存；可运行连接测试定位问题。':'填写 API 密钥、选择模型并测试连接。'}</p><button type="button" onClick={onSettings}>配置与测试 <StudyAIIcon name="chevron" size={14}/></button></div>}
  {!ready&&<StudyAICopyPrompt context={context} includePage={includePage}/>}
  <StudyAIChatStream messages={messages} busy={busy}/>
  {error&&<div className="study-ai-error" role="alert"><p>{error}</p><div><button type="button" onClick={onSettings}>检查配置 / 测试连接</button><button type="button" disabled={busy||!ready} onClick={()=>{const last=messages.findLast(message=>message.role==='user');if(last)void send(last.content,true);}}>重试</button></div></div>}
  <div className="study-ai-chips">{suggestions.map(([label,prompt])=><button key={label} type="button" disabled={!ready||busy} onClick={()=>void send(prompt)}>{label}</button>)}</div>
  <form className="study-ai-composer" onSubmit={event=>{event.preventDefault();void send();}}><label className="study-ai-sr" htmlFor="study-ai-input">向 AI 学习助手提问</label><textarea id="study-ai-input" value={input} maxLength={12000} onChange={event=>setInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&ready&&input.trim()){event.preventDefault();void send();}}} placeholder={includePage?'针对这页，问点什么…':'写下你的问题…'} rows={3}/><div><span>{busy?'正在回答…':settings?.model||'尚未选择模型'}<small>{historyError?'本机历史暂不可用':'Enter 发送 · Shift + Enter 换行'}</small></span>{busy?<button type="button" className="study-ai-send" onClick={stop} aria-label="停止回答">■</button>:<button type="submit" className="study-ai-send" disabled={!ready||!input.trim()} aria-label="发送问题"><StudyAIIcon name="send"/></button>}</div></form>
 </>;
}
export function StudyAISidebar({manageShortcut=true,onClose}:{manageShortcut?:boolean;onClose?:()=>void}={}){
 const {scope,settings,connection,error,reload,mode,setMode}=useStudyAIWorkspace();
 const [drafts,setDrafts]=useState<Record<string,string>>({});
 const [showSettings,setShowSettings]=useState(false),[position,setPosition]=useState({x:40,y:80});const drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
 useEffect(()=>{if(!manageShortcut)return;const listener=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key==='\\'&&!document.querySelector('dialog[open]')){event.preventDefault();setMode(value=>value==='collapsed'?'docked':'collapsed');}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[manageShortcut,setMode]);
 const floating=()=>{setPosition({x:Math.max(0,window.innerWidth-460),y:60});setMode('floating');};
 const status=connection?.state==='connected'?'连接已通过':connection?.state==='testing'?'正在测试':connection?.state==='error'?'连接需检查':settings?.enabled&&settings.configured?'配置已保存 · 待测试':'等待连接';
 return <>
  <aside hidden={mode==='collapsed'} tabIndex={-1} className="study-ai-panel" data-mode={mode} style={mode==='floating'?{left:position.x,top:position.y}:undefined} aria-label="AI 学习助手">
   <header className="study-ai-header"><button className="study-ai-avatar" type="button" title={mode==='floating'?'拖动面板':'AI 学习助手'} aria-label="拖动悬浮 AI 面板" disabled={mode!=='floating'} onPointerDown={event=>{if(mode!=='floating')return;event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,y:event.clientY,left:position.x,top:position.y};}} onPointerMove={event=>{const start=drag.current;if(start)setPosition({x:Math.max(0,Math.min(window.innerWidth-Math.min(420,window.innerWidth),start.left+event.clientX-start.x)),y:Math.max(0,Math.min(window.innerHeight-120,start.top+event.clientY-start.y))});}} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}><StudyAIIcon name="spark" size={23}/></button><div className="study-ai-heading"><h2>AI 学习助手</h2><p data-state={connection?.state??'idle'}><i/>{status}</p></div><button type="button" title="模型设置与连接测试" aria-label="模型设置与连接测试" aria-expanded={showSettings} onClick={()=>setShowSettings(value=>!value)}><StudyAIIcon name="settings"/></button><button type="button" title={mode==='floating'?'停靠':'悬浮'} aria-label={mode==='floating'?'停靠 AI 面板':'悬浮 AI 面板'} onClick={()=>mode==='floating'?setMode('docked'):floating()}><StudyAIIcon name={mode==='floating'?'dock':'float'}/></button><button type="button" title="收起 AI 助手" aria-label="收起 AI 学习助手" onClick={()=>onClose?onClose():setMode('collapsed')}><StudyAIIcon name="close"/></button></header>
   {showSettings&&<div className="study-ai-settings-scroll"><button type="button" className="study-ai-back" onClick={()=>setShowSettings(false)}>← 返回提问</button><StudyAISettings/></div>}
   {error&&!showSettings&&<div className="study-ai-error" role="alert"><p>{error}</p><button type="button" onClick={()=>void reload()}>重新读取配置</button></div>}
   <div className="study-ai-chat-body" hidden={showSettings||Boolean(error)}><ChatSession drafts={drafts} onDraft={(key,value)=>setDrafts(current=>({...current,[key]:value}))} visible={mode!=='collapsed'&&!showSettings&&!error} onSettings={()=>setShowSettings(true)} key={JSON.stringify([scope.ownerId,scope.libraryId,settings?.provider,settings?.model,settings?.revision])}/></div>
   <p className="study-ai-keyboard-hint">Esc 收起 · Ctrl + \ 切换 · Tab 在面板内移动</p>
  </aside>
 </>;
}
