'use client';
import {Component,useCallback,useEffect,useRef} from 'react';
import {useOptionalStudyAIWorkspace,useStudyAIWorkspace} from './study-ai-workspace';
import {StudyAIIcon} from './study-ai-icon';
import {createLazyComponent} from '../../plugins/lazy-plugin';

type PanelProps={mode:ReturnType<typeof useStudyAIWorkspace>['mode'];onClose:()=>void;onReady?:()=>void};
export function StudyAIPanelFallback({mode,onClose,retry}:PanelProps&{retry?:()=>void}){
 return <aside hidden={mode==='collapsed'} tabIndex={-1} className="study-ai-panel" data-mode={mode} style={mode==='floating'?{left:40,top:80}:undefined} aria-label="AI 学习助手"><header className="study-ai-header"><div className="study-ai-heading"><h2>AI 学习助手</h2></div><button type="button" aria-label="收起 AI 学习助手" onClick={onClose}><StudyAIIcon name="close"/></button></header><div className="study-feedback" role={retry?'alert':'status'}><p>{retry?'AI 学习助手暂时无法加载，请检查网络后重试。':'正在加载 AI 学习助手…'}</p>{retry&&<button type="button" onClick={retry}>重新加载</button>}</div></aside>;
}
const Panel=createLazyComponent<PanelProps>(async()=>{const {StudyAISidebar}=await import('./study-ai-sidebar');return{default:function LoadedPanel({onReady,onClose}:PanelProps){useEffect(()=>onReady?.(),[onReady]);return <StudyAISidebar manageShortcut={false} onClose={onClose}/>;}};},'AI 学习助手',(props,retry)=><StudyAIPanelFallback {...props} retry={retry}/>);
class PanelLifetime extends Component<PanelProps,{activated:boolean}>{
 state={activated:false};
 static getDerivedStateFromProps(props:PanelProps,state:{activated:boolean}){return props.mode!=='collapsed'&&!state.activated?{activated:true}:null;}
 render(){return this.state.activated?<Panel {...this.props}/>:null;}
}
/** Mount on first use, then retain drafts and running requests while collapsed. */
export function StudyAISidebar(){
 const {mode,setMode}=useStudyAIWorkspace();
 const host=useRef<HTMLDivElement>(null),opener=useRef<HTMLElement|null>(null),wasOpen=useRef(false),restoreOnClose=useRef(false);
 const closePanel=useCallback(()=>{restoreOnClose.current=Boolean(host.current?.contains(document.activeElement));setMode('collapsed');},[setMode]);
 const focusReady=useCallback(()=>{if(document.activeElement===document.body)host.current?.querySelector<HTMLElement>('.study-ai-panel:not([hidden])')?.focus({preventScroll:true});},[]);
 useEffect(()=>{
  const open=mode!=='collapsed';
  if(open&&!wasOpen.current){restoreOnClose.current=false;opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;host.current?.querySelector<HTMLElement>('.study-ai-panel:not([hidden])')?.focus({preventScroll:true});}
  if(!open&&wasOpen.current&&restoreOnClose.current&&opener.current?.isConnected&&!document.querySelector('dialog[open]'))opener.current.focus({preventScroll:true});
  wasOpen.current=open;
 },[mode]);
 useEffect(()=>{const listener=(event:KeyboardEvent)=>{
  if(event.defaultPrevented||event.repeat||event.isComposing||document.querySelector('dialog[open]'))return;
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key==='\\'){event.preventDefault();if(mode==='collapsed')setMode('docked');else closePanel();}
  else if(event.key==='Escape'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&event.target instanceof Node&&host.current?.contains(event.target)&&!(event.target instanceof Element&&event.target.closest('.cm-editor,[data-escape-owned]'))){event.preventDefault();closePanel();}
 };window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[mode,setMode,closePanel]);
 return <div ref={host} role="presentation" className="study-ai-panel-host" onKeyDown={event=>{
  if(event.key!=='Tab'||event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey||event.nativeEvent.isComposing)return;
  const panel=event.currentTarget.querySelector<HTMLElement>('.study-ai-panel:not([hidden])');if(!panel)return;
  const controls=Array.from(panel.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex]')).filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
  const first=controls[0],last=controls.at(-1),active=document.activeElement;
  if(!first){event.preventDefault();panel.focus();}
  else if(event.shiftKey&&(active===first||active===panel)){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(active===last||active===panel)){event.preventDefault();first.focus();}
 }}><PanelLifetime mode={mode} onClose={closePanel} onReady={focusReady}/></div>;
}
export function StudyAITrigger({onUnavailable}:{onUnavailable?:()=>void}){
 const workspace=useOptionalStudyAIWorkspace();if(!workspace&&!onUnavailable)return null;
 const ready=Boolean(workspace?.settings?.enabled&&workspace.settings.configured);
 return <button type="button" className="study-ai-nav-trigger" aria-label={ready?'打开 AI 学习助手':'配置 AI 学习助手'} aria-expanded={Boolean(workspace&&workspace.mode!=='collapsed')} onClick={()=>!ready&&onUnavailable?onUnavailable():workspace?.setMode(workspace.mode==='collapsed'?'docked':'collapsed')}><StudyAIIcon name="spark" size={18}/><span>{ready?'问 AI':'配置 AI'}</span></button>;
}
export const StudyAIChatStream=createLazyComponent<Parameters<typeof import('./study-ai-chat-stream').StudyAIChatStream>[0]>(async()=>({default:(await import('./study-ai-chat-stream')).StudyAIChatStream}),'对话');
export const StudyAIMarkdown=createLazyComponent<{text:string}>(async()=>({default:(await import('./study-ai-chat-stream')).StudyAIMarkdown}),'内容');
