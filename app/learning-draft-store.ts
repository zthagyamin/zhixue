/** Page-lifetime buffers only. Never serialize this store or include it in learning evidence. */
import type {AssistanceObserver,AssistanceObserverState} from './assistance-observer';
// @ts-expect-error TS5097: standalone Node contract tests.
import {createAssistanceObserver,emptyAssistanceObserverState} from './assistance-observer.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createTemporaryDraft,type TemporaryDraft} from '../src/application/temporary-practice/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createStudyAttemptSession,createStudyEvaluation,type StudyAttemptSession,type StudyAttemptSubmission,type AttemptOutcome} from '../src/application/study-attempt/index.ts';
export type LearningDraftTicket={readonly item:string;readonly generation:number;readonly epoch:number};
export type LearningDraftAdapter={
  /** Independent page-only child; cannot acquire the parent's formal submit callback. */
  createTemporary?:(initial:Record<string,string>)=>TemporaryDraft|null;
  read:<T>(field:string,initial:T)=>T;
  write:(field:string,value:unknown)=>boolean;
  begin:()=>LearningDraftTicket|null;
  /** Live shared submission lock for non-form input such as gestures and hotkeys. */
  isPending?:()=>boolean;
  /** Saved feedback can be read again on this page; continuing never re-saves a grade. */
  subscribe?:(listener:()=>void)=>()=>void;
  getSnapshot?:()=>number;
  hasSavedFeedback?:()=>boolean;
  /** Failure is about this item, not an unrelated earlier submission. */
  hasSaveFailure?:()=>boolean;
  continueAfterFeedback?:()=>boolean;
  /** Behavioral counters only; raw display IDs remain in this page generation. */
  assistance?:AssistanceObserver;
  /** Host recovery receipts refer to this exact input revision and page generation. */
  inputRevision?:()=>number;
  markInputRecovered?:(revision:number)=>boolean;
};
type Entry={sourceItem:string;generation:number;frozen:boolean;saved?:boolean;resume?:()=>void|boolean;initials:Map<string,unknown>;values:Map<string,unknown>;assistance:Map<string,AssistanceObserverState>;label:string;inputRevision?:number;recoveredRevision?:number;submission?:StudyAttemptSession<LearningDraftTicket>};

// Only learner input counts as dirty. Merely revealing a card or receiving AI output does not.
const inputFields=new Set(['answer','value','code','stdin','sandbox.code','sandbox.stdin','tutor.question','selectedOption','lapseInput','quizSelectedIds','quizExcludedIds','quizStemHighlights']);
function inputValue(field:string,value:unknown):string|undefined{
  if(field==='nonwordQuizState'&&value&&typeof value==='object')return JSON.stringify((value as {selection?:unknown}).selection??[]);
  if(field==='state'&&value&&typeof value==='object'){
    const state=value as {input?:unknown;wrong?:unknown};
    return typeof state.input==='string'?state.input+(typeof state.wrong==='string'?state.wrong:''):undefined;
  }
  if(!inputFields.has(field))return undefined;
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.length?JSON.stringify(value):'';
  return '';
}
export function createLearningDraftStore(scopeKey='page',runtime:{newId?:()=>string;now?:()=>string}={}){
  const entries=new Map<string,Entry>(),itemEpochs=new Map<string,number>(),listeners=new Set<()=>void>(),failures=new Map<string,string>();
  const temporary=new Map<TemporaryDraft,string>(),sourceEpochs=new Map<string,number>();
  let epoch=0,generation=0,revision=0,mutation=0,disposed=false,unavailable=false,pending:LearningDraftTicket|null=null;
  const handles=new WeakMap<LearningDraftAdapter,{entry:()=>Entry|undefined;item:string;variant:string;scopeCurrent:()=>boolean}>();
  const hasUnsavedInput=()=>[...temporary.keys()].some(draft=>draft.hasUnsavedInput())||[...entries.values()].some(entry=>[...entry.values].some(([key,value])=>{
    const field=JSON.parse(key)[1] as string,current=inputValue(field,value);
    if(entry.saved&&field!=='tutor.question')return false;
    return current!==undefined&&current!==(inputValue(field,entry.initials.get(key))??'');
  }));
  const notify=()=>{revision++;mutation++;for(const listener of [...listeners])try{listener();}catch{/* Presentation failures cannot interrupt a durable record. */}};
  const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
  const getSnapshot=()=>revision;
  const evaluation=createStudyEvaluation({blocked:()=>disposed||pending!==null,notify});
  const valid=(ticket:LearningDraftTicket|null)=>Boolean(ticket&&pending===ticket&&!disposed&&ticket.epoch===epoch&&entries.get(ticket.item)?.generation===ticket.generation);
  const releaseEntry=(entry:Entry|undefined,committed=false)=>{if(!entry)return;if(!committed)entry.submission?.invalidate();entry.values.clear();entry.initials.clear();entry.assistance.clear();entry.resume=undefined;};
  const clearEntry=(item:string,committed=false)=>{for(const [draft,parent] of [...temporary])if(parent===item)draft.dispose();releaseEntry(entries.get(item),committed);entries.delete(item);failures.delete(item);itemEpochs.set(item,(itemEpochs.get(item)??0)+1);if(pending?.item===item)pending=null;};
  const clear=()=>{for(const draft of [...temporary.keys()])draft.dispose();for(const entry of entries.values())releaseEntry(entry);entries.clear();itemEpochs.clear();sourceEpochs.clear();failures.clear();pending=null;evaluation.invalidate(false);unavailable=false;epoch++;notify();};
  const store={
    scopeKey,
    adapter(item:string,variant:string,label='上一题',sourceItem=item):LearningDraftAdapter{
      const bornEpoch=epoch,bornItemEpoch=itemEpochs.get(item)??0;let pinned:Entry|undefined;
      const bornSourceEpoch=sourceEpochs.get(sourceItem)??0;
      const scopeCurrent=()=>!disposed&&bornEpoch===epoch&&bornSourceEpoch===(sourceEpochs.get(sourceItem)??0);
      const entry=()=>{
        if(!scopeCurrent()||bornItemEpoch!==(itemEpochs.get(item)??0))return undefined;
        if(pinned)return entries.get(item)===pinned?pinned:undefined;
        pinned=entries.get(item);if(!pinned){pinned={sourceItem,generation:++generation,frozen:false,initials:new Map(),values:new Map(),assistance:new Map(),label:label.slice(0,120)};entries.set(item,pinned);}return pinned;
      };
      const fieldKey=(field:string)=>JSON.stringify([variant,field]);
      const adapter:LearningDraftAdapter={
        createTemporary(initial){
          const parent=entry();if(!parent||pending||evaluation.isBusy())return null;
          const child=createTemporaryDraft({initial,binding:JSON.stringify([scopeKey,item,parent.generation]),
            isCurrent:()=>!disposed&&bornEpoch===epoch&&entries.get(item)===parent&&bornItemEpoch===(itemEpochs.get(item)??0),
            onChange:notify,onDispose:()=>{temporary.delete(child);}});
          temporary.set(child,item);return child;
        },
        isPending:()=>!scopeCurrent()||bornItemEpoch!==(itemEpochs.get(item)??0)||pending!==null||evaluation.isBusy(),
        subscribe,getSnapshot,
        hasSavedFeedback:()=>Boolean(entry()?.saved),
        hasSaveFailure:()=>Boolean(entry()&&failures.has(item)),
        continueAfterFeedback:()=>{
          const current=entry();if(!current?.saved||!current.resume||pending||evaluation.isBusy())return false;
          const resume=current.resume;clearEntry(item,true);notify();return resume()!==false;
        },
        assistance:createAssistanceObserver(()=>{const current=entry();if(!current)return null;let state=current.assistance.get(variant);
          if(!state){state=emptyAssistanceObserverState();current.assistance.set(variant,state);}return{state,writable:!current.frozen};}),
        read<T>(field:string,initial:T):T{
          const current=entry(),key=fieldKey(field);
          if(current&&!current.initials.has(key))current.initials.set(key,initial);
          if(!current?.values.has(key))return initial;
          return structuredClone(current.values.get(key)) as T;
        },
        write(field,value){
          const current=entry();if(!current||(current.frozen&&!(current.saved&&field.startsWith('tutor.'))))return false;
          try{const dirty=hasUnsavedInput();const before=inputValue(field,current.values.get(fieldKey(field)));current.values.set(fieldKey(field),structuredClone(value));if(inputValue(field,value)!==before)current.inputRevision=(current.inputRevision??0)+1;mutation++;if(dirty!==hasUnsavedInput())notify();return true;}
          catch{if(!unavailable){unavailable=true;notify();}return false;}
        },
        begin(){
          const current=entry();if(!current||current.frozen||pending||evaluation.isBusy())return null;
          current.frozen=true;pending=Object.freeze({item,generation:current.generation,epoch});notify();return pending;
        },
        inputRevision:()=>entry()?.inputRevision??0,
        markInputRecovered(revision){const current=entry();if(!current||revision!==(current.inputRevision??0))return false;current.recoveredRevision=revision;notify();return true;},
      };
      handles.set(adapter,{entry,item,variant,scopeCurrent});
      return adapter;
    },
    /** Host-only coordination; plugins receive the narrower draft adapter, never this persistence port. */
    submit(adapter:LearningDraftAdapter,options:StudyAttemptSubmission):Promise<AttemptOutcome>{
      const handle=handles.get(adapter),current=handle?.entry();
      if(!handle||!current)return Promise.resolve({status:'stale'});
      current.submission??=createStudyAttemptSession({binding:{scopeKey,itemBinding:handle.item,mode:handle.variant},
        gate:{begin:adapter.begin,commit:(ticket,resume)=>store.commit(ticket,resume),fail:ticket=>store.fail(ticket)},
        newId:runtime.newId??(()=>crypto.randomUUID()),now:runtime.now??(()=>new Date().toISOString())});
      return current.submission.submit({...options,intent:JSON.stringify([handle.variant,options.intent]),current:()=>handle.scopeCurrent()&&options.current()});
    },
    commit(ticket:LearningDraftTicket|null,resumeAfterFeedback?:()=>void|boolean){
      if(!valid(ticket))return false;
      if(resumeAfterFeedback){const current=entries.get(ticket!.item)!;current.saved=true;current.resume=resumeAfterFeedback;failures.delete(ticket!.item);pending=null;}
      else clearEntry(ticket!.item,true);
      notify();return true;
    },
    fail(ticket:LearningDraftTicket|null){if(!valid(ticket))return false;const current=entries.get(ticket!.item)!;current.frozen=false;failures.set(ticket!.item,current.label);pending=null;notify();return true;},
    clearItem(item:string){
      // Original-content resets retire all grouped drafts, including untouched old adapters.
      sourceEpochs.set(item,(sourceEpochs.get(item)??0)+1);
      const keys=new Set([item,...[...entries].filter(([,entry])=>entry.sourceItem===item).map(([key])=>key)]);
      for(const key of keys)clearEntry(key);notify();
    },
    clear,
    dispose(){disposed=true;clear();listeners.clear();},
    async grade<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
      if(disposed)throw new Error('学习空间已经变化，请重新打开题目。');
      return evaluation.run(operation,signal);
    },
    isPending:()=>pending!==null||evaluation.isBusy(),
    isGrading:()=>evaluation.isBusy(),
    isUnavailable:()=>unavailable,
    hasBuffers:()=>hasUnsavedInput()||[...entries.values()].some(entry=>!entry.saved&&entry.values.size>0),
    hasUnsavedInput,
    hasUnrecoverableInput:()=>[...temporary.keys()].some(draft=>draft.hasUnsavedInput())||[...entries.values()].some(entry=>entry.recoveredRevision!==(entry.inputRevision??0)&&[...entry.values].some(([key,value])=>{const field=JSON.parse(key)[1] as string;if(entry.saved&&field!=='tutor.question')return false;const current=inputValue(field,value);return current!==undefined&&current!==(inputValue(field,entry.initials.get(key))??'');})),
    hasDurableRecovery:()=>hasUnsavedInput()&&[...entries.values()].filter(current=>!current.saved&&current.values.size>0).every(current=>current.recoveredRevision!==undefined&&current.recoveredRevision===(current.inputRevision??0)),
    failureTitles:()=>[...failures.values()],
    getSnapshot,
    getMutationVersion:()=>mutation,
    getItemVersion:(item:string)=>`${epoch}:${itemEpochs.get(item)??0}`,
    subscribe,
  };
  return store;
}
export type LearningDraftStore=ReturnType<typeof createLearningDraftStore>;

/** Ignore transport timestamps, but bind the buffer to the actual displayed content. */
export function learningDraftItemId(subjectId:string,itemKey:string,item:object):string{
  const value=item as Record<string,unknown>;
  const content=['word','meaning','phonetic','context','example','front','back','topic','prompt','options','answer','reviewPoint','explanation','code','initialCode','testCode','solutionCode','sourceNote','stateRef'].map(key=>value[key]);
  if(value.learningSupport!==undefined)content.push(value.learningSupport);
  return JSON.stringify([subjectId,itemKey,value.contentHash??value.fingerprint??null,content]);
}
