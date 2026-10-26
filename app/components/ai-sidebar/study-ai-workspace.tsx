'use client';
import {createContext,useCallback,useContext,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {StudyAIContext as Context,StudyAIService,StudyAIScope,StudyAISettings} from '../../ai/study-ai-types';
import type {AssistanceObserver} from '../../assistance-observer';
import {normalizeStudyAIContext} from '../../ai/study-ai-context';
import {studyAISelectedText} from '../../ai/study-ai-selection';
import {createStudyAIConnectionTester,type StudyAIConnectionState as Connection} from '../../ai/study-ai-connection';
import {studyAIErrorMessage} from '../../ai/study-ai-errors';
import './study-ai.css';

type Mode='docked'|'floating'|'collapsed';
type Workspace={assistance:AssistanceObserver|undefined;setAssistance:(observer:AssistanceObserver|undefined)=>void;mode:Mode;setMode:React.Dispatch<React.SetStateAction<Mode>>;scope:StudyAIScope;service:StudyAIService;context:Context;setContext:(context:Context)=>void;clearContext:(id:string)=>void;settings:StudyAISettings|null;setSettings:(settings:StudyAISettings)=>void;error:string;reload:()=>Promise<void>;connection:Connection|null;testConnection:(settings?:StudyAISettings)=>Promise<boolean>};
const WorkspaceContext=createContext<Workspace|null>(null);
const EMPTY:Context={id:'study',title:'当前学习'};
type CopyContext={context:Context;setContext:(context:Context)=>void;clearContext:(id:string)=>void};
const OfflineContext=createContext<CopyContext|null>(null);
/** Keeps visible exercise reporting available without constructing a service or reading settings. */
export function StudyAIOfflineContext({pageContext:page,children}:{pageContext:Context;children:ReactNode}){
 const [reported,setReported]=useState<{pageId:string;context:Context}|null>(null);
 const setContext=useCallback((context:Context)=>setReported({pageId:page.id,context:normalizeStudyAIContext(context)}),[page.id]);
 const clearContext=useCallback((id:string)=>setReported(current=>current?.context.id===id?null:current),[]);
 const context=normalizeStudyAIContext({...page,...(reported?.pageId===page.id?reported.context:{})});
 return <OfflineContext.Provider value={{context,setContext,clearContext}}>{children}</OfflineContext.Provider>;
}
type Props={scope:StudyAIScope;service:StudyAIService;children:ReactNode;context?:Context;pageContext?:Context};
function ScopedWorkspace({scope,service,children,context:provided,pageContext:page=EMPTY}:Props){
 const [assistance,setAssistance]=useState<AssistanceObserver|undefined>();
 const [mode,setMode]=useState<Mode>('collapsed');
 const [reported,setReported]=useState<{pageId:string;context:Context}|null>(null);
 const [selection,setSelection]=useState<{pageId:string;text:string}|null>(null);
 const [storedSettings,publishSettings]=useState<{service:StudyAIService;value:StudyAISettings}|null>(null);
 const [storedError,publishError]=useState<{service:StudyAIService;value:string}|null>(null);
 const settings=storedSettings?.service===service?storedSettings.value:null,error=storedError?.service===service?storedError.value:'';
 const lifetime=useRef({service,active:true}),readGeneration=useRef(0);
 useLayoutEffect(()=>{const binding={service,active:true},generation=readGeneration;lifetime.current=binding;generation.current++;return()=>{binding.active=false;generation.current++;};},[service]);
 const acceptSettings=useCallback((next:StudyAISettings)=>{
  if(!lifetime.current.active||lifetime.current.service!==service)return;
  publishSettings(previous=>previous?.service===service&&previous.value.revision>next.revision?previous:{service,value:next});
 },[service]);
 const setSettings=useCallback((next:StudyAISettings)=>{
  if(!lifetime.current.active||lifetime.current.service!==service)return;
  readGeneration.current++;acceptSettings(next);publishError({service,value:''});
 },[service,acceptSettings]);
 const [connection,setConnection]=useState<Connection|null>(null);
 const tester=useMemo(()=>createStudyAIConnectionTester(service,setConnection),[service]);
 const setContext=useCallback((context:Context)=>setReported({pageId:page.id,context}),[page.id]);
 const clearContext=useCallback((id:string)=>setReported(value=>value?.context.id===id?null:value),[]);
 useEffect(()=>{let active=true;const changed=()=>{if(!active)return;const text=studyAISelectedText(document.getSelection(),document.querySelector('main[data-study-ai-content]'),page.pageKind);setSelection(previous=>previous?.pageId===page.id&&previous.text===text?previous:{pageId:page.id,text});};queueMicrotask(changed);document.addEventListener('selectionchange',changed);return()=>{active=false;document.removeEventListener('selectionchange',changed);};},[page.id,page.pageKind,reported?.context.id]);
 const context=useMemo(()=>normalizeStudyAIContext(provided??{...page,...(reported?.pageId===page.id?reported.context:{}),...(page.pageText?{pageText:page.pageText}:{}),...(selection?.pageId===page.id&&selection.text?{selection:selection.text}:{})}),[provided,page,reported,selection]);
 const readSettings=useCallback(async(signal?:AbortSignal)=>{
  const generation=++readGeneration.current;
  const current=()=>!signal?.aborted&&lifetime.current.active&&lifetime.current.service===service&&generation===readGeneration.current;
  try{const next=await service.settings(signal);if(current()){acceptSettings(next);publishError({service,value:''});}}
  catch(error){if(current())publishError({service,value:studyAIErrorMessage(error)});}
 },[service,acceptSettings]);
 const reload=useCallback(()=>readSettings(),[readSettings]);
 useEffect(()=>{const c=new AbortController(),generation=readGeneration.current;tester.reset();void Promise.resolve().then(()=>{if(!c.signal.aborted&&generation===readGeneration.current)return readSettings(c.signal);});return()=>{c.abort();tester.dispose();};},[readSettings,tester]);
 const testConnection=useCallback(async(value=settings)=>value?tester.run(value):false,[settings,tester]);
 const value=useMemo(()=>({assistance,setAssistance,mode,setMode,scope,service,context,setContext,clearContext,settings,setSettings,error,reload,connection:connection?.revision===settings?.revision?connection:null,testConnection}),[assistance,mode,scope,service,context,setContext,clearContext,settings,setSettings,error,reload,connection,testConnection]);
 return <WorkspaceContext.Provider value={value}><div className="study-ai-workspace" data-mode={mode}>{children}</div></WorkspaceContext.Provider>;
}
export function StudyAIWorkspace(props:Props){return <ScopedWorkspace key={JSON.stringify([props.scope.mode,props.scope.ownerId,props.scope.libraryId])} {...props}/>;}
export function useStudyAIWorkspace(){const value=useContext(WorkspaceContext);if(!value)throw new Error('StudyAIWorkspace is required');return value;}
export function useOptionalStudyAIWorkspace(){return useContext(WorkspaceContext);}
const noop=()=>{};
export function useStudyAIContext(){const value=useContext(WorkspaceContext),offline=useContext(OfflineContext);return useMemo(()=>({setAssistance:value?.setAssistance??noop,context:value?.context??offline?.context??EMPTY,setContext:value?.setContext??offline?.setContext??noop,clearContext:value?.clearContext??offline?.clearContext??noop}),[value?.context,value?.setContext,value?.setAssistance,value?.clearContext,offline]);}
