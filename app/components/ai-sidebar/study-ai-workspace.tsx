'use client';
import {createContext,useCallback,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
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
 const [settings,setSettings]=useState<StudyAISettings|null>(null),[error,setError]=useState('');
 const [connection,setConnection]=useState<Connection|null>(null);
 const tester=useMemo(()=>createStudyAIConnectionTester(service,setConnection),[service]);
 const setContext=useCallback((context:Context)=>setReported({pageId:page.id,context}),[page.id]);
 const clearContext=useCallback((id:string)=>setReported(value=>value?.context.id===id?null:value),[]);
 useEffect(()=>{let active=true;const changed=()=>{if(!active)return;const text=studyAISelectedText(document.getSelection(),document.querySelector('main[data-study-ai-content]'),page.pageKind);setSelection(previous=>previous?.pageId===page.id&&previous.text===text?previous:{pageId:page.id,text});};queueMicrotask(changed);document.addEventListener('selectionchange',changed);return()=>{active=false;document.removeEventListener('selectionchange',changed);};},[page.id,page.pageKind,reported?.context.id]);
 const context=useMemo(()=>normalizeStudyAIContext(provided??{...page,...(reported?.pageId===page.id?reported.context:{}),...(page.pageText?{pageText:page.pageText}:{}),...(selection?.pageId===page.id&&selection.text?{selection:selection.text}:{})}),[provided,page,reported,selection]);
 const reload=useCallback(async()=>{try{setSettings(await service.settings());setError('');}catch(error){setError(studyAIErrorMessage(error));}},[service]);
 useEffect(()=>{const c=new AbortController();tester.reset();void service.settings(c.signal).then(next=>{if(!c.signal.aborted){setSettings(next);setError('');}}).catch(error=>{if(!c.signal.aborted)setError(studyAIErrorMessage(error));});return()=>{c.abort();tester.dispose();};},[service,tester]);
 const testConnection=useCallback(async(value=settings)=>value?tester.run(value):false,[settings,tester]);
 const value=useMemo(()=>({assistance,setAssistance,mode,setMode,scope,service,context,setContext,clearContext,settings,setSettings,error,reload,connection:connection?.revision===settings?.revision?connection:null,testConnection}),[assistance,mode,scope,service,context,setContext,clearContext,settings,error,reload,connection,testConnection]);
 return <WorkspaceContext.Provider value={value}><div className="study-ai-workspace" data-mode={mode}>{children}</div></WorkspaceContext.Provider>;
}
export function StudyAIWorkspace(props:Props){return <ScopedWorkspace key={JSON.stringify([props.scope.mode,props.scope.ownerId,props.scope.libraryId])} {...props}/>;}
export function useStudyAIWorkspace(){const value=useContext(WorkspaceContext);if(!value)throw new Error('StudyAIWorkspace is required');return value;}
export function useOptionalStudyAIWorkspace(){return useContext(WorkspaceContext);}
const noop=()=>{};
export function useStudyAIContext(){const value=useContext(WorkspaceContext),offline=useContext(OfflineContext);return useMemo(()=>({setAssistance:value?.setAssistance??noop,context:value?.context??offline?.context??EMPTY,setContext:value?.setContext??offline?.setContext??noop,clearContext:value?.clearContext??offline?.clearContext??noop}),[value?.context,value?.setContext,value?.setAssistance,value?.clearContext,offline]);}
