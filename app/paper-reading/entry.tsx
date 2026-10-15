'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import type {PaperStudyData} from '../paper-study';
import {paperFingerprint,savePaperMaterial} from '../paper-draft-store';
import {matchPaperReadingResume} from '../../src/application/paper-reading-resume';
import type {PaperReadingWorkspaceV1} from '../../src/domain/paper-reading';
import {PaperReadingRecoveryBrowser} from './recovery-browser';
import type {PaperDraftSession} from '../paper-draft-store';
import type {PaperServices} from '../plugins/plugin-paper';
import {PaperSourcesPanel} from '../paper-sources-panel';
import {verifiedPaperScope} from '../paper-library-client';
import {MathText} from '../math-text';
import {PaperSourceText} from '../../src/features/paper-reading/source-text';
import {PaperOriginalPage,PaperReadingPage,paperReadingMessage,type OriginalPageDocument} from '../../src/features/paper-reading';
import {createPaperReadingUnit} from '../../src/domain/paper-reading';
import {createPaperOriginalCache} from './original-cache';
import {usePaperReadingMaterials} from './use-materials';
import {confirmStudyNavigation,registerStudyNavigationGuard} from '../study-navigation-guard';
import '../../src/features/paper-reading/reading.css';
import {PaperQuestionEntry} from './question';
import type {PaperReadingSession} from '../../src/application/paper-reading';
import {ReadingBackupControls} from './backup-controls';
import {usePaperClock} from './use-clock';

type Props={services:PaperServices;initialPaper?:PaperStudyData;returnHref?:string;renderTools?:(paper:PaperStudyData)=>ReactNode};
export function PaperReadingEntry({services,initialPaper,renderTools,returnHref}:Props){
    const model=usePaperReadingMaterials(services,initialPaper);
    const questionSession=useRef<PaperReadingSession|null>(null),sourceIntent=useRef(0);
    const [switchError,setSwitchError]=useState('');
    const [resume,setResume]=useState<{scope:string;workspace:PaperReadingWorkspaceV1;position:number;count:number}|null>(null);
    const boundScope=JSON.stringify([services.owner,services.library]);
    async function resumeSaved(workspace:PaperReadingWorkspaceV1){
        const intent=++sourceIntent.current;await questionSession.current?.flush();
        if(workspace.unit.source.ownerId!==services.owner||workspace.unit.source.libraryId!==services.library)return false;
        const papers=[model.paper,...model.materials.map(material=>material.paper)];
        for(const paper of papers){
            const fingerprint=await paperFingerprint(paper);
            const match=matchPaperReadingResume(workspace,{materialFingerprint:fingerprint,sourceVersion:paper.origin?.version??fingerprint,sections:paper.sections});
            if(!match)continue;
            if(intent!==sourceIntent.current||services.isCurrent?.()===false)return false;
            await model.choose(paper);
            if(intent!==sourceIntent.current||services.isCurrent?.()===false)return false;
            setResume({scope:boundScope,workspace,...match});return true;
        }
        return false;
    }
    const registerQuestion=useCallback((next:PaperReadingSession|null)=>{questionSession.current=next;},[]);
    useEffect(()=>()=>{sourceIntent.current++;},[]);
    async function switchMaterial(next:PaperStudyData,file?:File,importing=false){
        const intent=++sourceIntent.current;setSwitchError('');setResume(null);
        try{
            await questionSession.current?.flush();
            if(intent!==sourceIntent.current||services.isCurrent?.()===false)throw Error('材料选择已变更，请在当前论文继续。');
            if(importing)await model.add(next,file);else await model.choose(next);
        }catch(reason){if(intent===sourceIntent.current)setSwitchError(reason instanceof Error?reason.message:'答案尚未保存，请重试保存。');throw reason;}
    }
    const sources=<><PaperReadingRecoveryBrowser services={services} onResume={resumeSaved}/><PaperSourcesPanel key={JSON.stringify([services.owner,services.library])} services={services} onImport={(paper,file)=>switchMaterial(paper,file,true)}/>
        {model.materials.length>0&&<label>已保存材料<select value={model.materials.find(m=>m.paper===model.paper)?.fingerprint??''}
            onChange={event=>{const found=model.materials.find(m=>m.fingerprint===event.target.value);if(found)void switchMaterial(found.paper).catch(()=>{});}}>
            <option value="">选择论文</option>{model.materials.map(material=><option key={material.fingerprint} value={material.fingerprint}>{material.paper.title}</option>)}
        </select></label>}{model.originalNotice&&<p role="status">{model.originalNotice}</p>}</>;
    const failure=model.error||switchError;
    return <>{failure&&<p role="alert">{/^[a-z0-9-]+$/.test(failure)?paperReadingMessage(failure):failure}</p>}{model.session?
        <ReadingDocument key={JSON.stringify([model.session.kind,resume?.scope===boundScope?resume.workspace.unit.unitId:null])} paper={model.paper} session={model.session} services={services} sources={sources}
            tools={renderTools?.(model.paper)} returnHref={returnHref} registerQuestion={registerQuestion} resume={resume?.scope===boundScope?resume:undefined}/>:<p role="status">正在读取论文与原草稿…</p>}</>;
}

function ReadingDocument({paper,session,services,sources,tools,returnHref,registerQuestion,resume}:{paper:PaperStudyData;session:PaperDraftSession;services:PaperServices;sources:ReactNode;tools?:ReactNode;returnHref?:string;registerQuestion?:(session:PaperReadingSession|null)=>void;resume?:{workspace:PaperReadingWorkspaceV1;position:number;count:number}}){
    const clock=usePaperClock(paper,services);
    const state=useSyncExternalStore(session.subscribe,session.snapshot,session.snapshot);
    const [position,setPosition]=useState(resume?.position??state.draft.position),[count,setCount]=useState(resume?.count??1),[error,setError]=useState('');
    const [questionSaving,setQuestionSaving]=useState(false);
    const [questionError,setQuestionError]=useState('');
    const question=useRef<PaperReadingSession|null>(null);
    const onSession=useCallback((next:PaperReadingSession|null)=>{question.current=next;registerQuestion?.(next);},[registerQuestion]);
    const [original,setOriginal]=useState<{unit:string;page:number}|null>(null);
    const [originalRevision,setOriginalRevision]=useState(0),[restoring,setRestoring]=useState(false),[restoreError,setRestoreError]=useState('');
    const active=useRef(true),originalTrigger=useRef<HTMLButtonElement|null>(null);
    const acknowledgedPosition=useRef(state.draft.position);
    const currentServices=useRef(services);
    useLayoutEffect(()=>{currentServices.current=services;},[services]);
    const restoration=useRef(false);
    useEffect(()=>{active.current=true;return()=>{active.current=false;};},[session]);
    useEffect(()=>{
        if(state.ready&&!state.saving&&!state.error&&acknowledgedPosition.current!==state.draft.position){
            acknowledgedPosition.current=state.draft.position;
            setPosition(state.draft.position);setCount(1);
        }
    },[state.ready,state.saving,state.error,state.draft.position]);
    const total=paper.sections.reduce((sum,section)=>sum+section.paragraphs.length,0);
    const base=createPaperReadingUnit(paper,Math.min(position,total-1),1);
    const unit=createPaperReadingUnit(paper,base.position,Math.min(count,base.availableParagraphs));
    const origin=paper.origin,scope=JSON.stringify([services.owner,services.library,origin?.version]);
    const unitKey=JSON.stringify([scope,position,count]);
    const page=original?.unit===unitKey?original.page:null;
    const currentScope=useRef(scope);
    useLayoutEffect(()=>{currentScope.current=scope;},[scope]);
    useEffect(()=>{
        const unregister=registerStudyNavigationGuard({message:()=>session.snapshot().saving||session.snapshot().error?'论文草稿尚未可靠保存，离开后可能无法恢复当前输入。':null,
            onLeave:()=>{active.current=false;},version:()=>session.snapshot().draft});
        const beforeUnload=(event:BeforeUnloadEvent)=>{if(session.snapshot().saving||session.snapshot().error){event.preventDefault();event.returnValue='';}};
        window.addEventListener('beforeunload',beforeUnload);
        return()=>{unregister();window.removeEventListener('beforeunload',beforeUnload);};
    },[session]);
    async function move(next:number){
        if(!state.ready||state.saving||state.error||questionSaving||questionError)return;
        setError('');
        try{await question.current?.flush();if(next>=total){await clock.flush().catch(()=>{});window.location.assign(returnHref??'/study');return;}
            await session.update(draft=>({...draft,position:next}));await session.flush();
            if(active.current&&services.isCurrent?.()!==false){setPosition(next);setCount(1);}}
        catch(reason){if(active.current&&!question.current?.snapshot().error)setError(reason instanceof Error?reason.message:'位置尚未保存，原文与草稿保留。');}
    }
    const loadOriginal=useMemo(()=>async(signal:AbortSignal):Promise<OriginalPageDocument>=>{
        const expected=scope,boundServices={owner:services.owner,library:services.library,libraryClient:services.libraryClient,localLibraryId:services.localLibraryId,accountLibraryId:services.accountLibraryId};
        const current=()=>!signal.aborted&&currentScope.current===expected&&active.current&&currentServices.current.isCurrent?.()!==false;
        if(!origin||page===null)throw Error('原页暂不可用，原文与草稿保留。');
        if(!current())throw Error('原页请求已取消。');
        if(origin.kind==='upload'){
            const stored=await createPaperOriginalCache().read({ownerId:boundServices.owner,libraryId:boundServices.library,sourceVersion:origin.version});
            if(!current())throw Error('原页请求已取消。');
            if(!stored)throw Error('原 PDF 本机副本不可用，请重新提供同版本 PDF；原草稿保留。');
            return {bytes:stored.bytes,sourceVersion:origin.version,pageToRender:page};
        }
        const client=boundServices.libraryClient;
        if(!client?.originalPage)throw Error('当前服务未提供原页，请连接对应资料库的新版 Companion。');
        const catalog=await client.catalog('',signal);
        if(!current())throw Error('原页请求已取消。');
        const library=verifiedPaperScope(catalog,boundServices);
        const asset=await client.originalPage({...library,source:origin,page},signal);
        if(!current())throw Error('原页请求已取消。');
        return {bytes:Uint8Array.from(atob(asset.data),character=>character.charCodeAt(0)),sourceVersion:asset.sourceVersion,pageToRender:1};
    },[scope,origin,page,services.owner,services.library,services.libraryClient,services.localLibraryId,services.accountLibraryId]);
    async function restoreOriginal(file:File){
        if(restoration.current||!origin||origin.kind!=='upload')return;
        const expected=scope,boundServices=currentServices.current;
        const current=()=>active.current&&currentScope.current===expected&&currentServices.current.isCurrent?.()!==false;
        restoration.current=true;setRestoring(true);setRestoreError('');
        try{
            if(file.size>20000000||!file.name.toLowerCase().endsWith('.pdf'))throw Error('请选择不超过 20 MB 的同版本 PDF。');
            const bytes=new Uint8Array(await file.arrayBuffer());
            if(!current())return;
            await createPaperOriginalCache().save({ownerId:boundServices.owner,libraryId:boundServices.library,sourceVersion:origin.version},{filename:file.name,bytes});
            if(current())setOriginalRevision(value=>value+1);
        }catch(reason){
            if(current())setRestoreError(reason instanceof Error&&reason.message==='paper-original-fingerprint-mismatch'
                ?'文件版本不匹配，请选择导入时的原 PDF。原文与草稿保留。'
                :'原文件未能保存，请检查文件和本机存储后重试。原文与草稿保留。');
        }
        finally{restoration.current=false;if(active.current)setRestoring(false);}
    }
    const sourceAvailable=Boolean(origin&&unit.physicalPages.length&&(origin.kind==='upload'||origin.kind==='vault'&&services.libraryClient?.originalPage));
    const close=()=>{setOriginal(null);setRestoreError('');requestAnimationFrame(()=>originalTrigger.current?.focus());};
    return <PaperReadingPage title={paper.title} returnHref={returnHref} identity={[paper.authors?.join(', '),paper.year,paper.venue].filter(Boolean).join(' · ')}
        unit={unit} saving={!state.ready||state.saving||questionSaving} navigationBlocked={Boolean(questionError)} toolsBlocked={questionSaving||Boolean(questionError)} error={state.error||error} sources={sources} tools={<>{clock.details}<ReadingBackupControls services={services} beforeChange={async()=>{await question.current?.flush();await session.flush();await clock.persist();}} beforeExport={async()=>{await savePaperMaterial(services.owner,services.library,paper);}}/>{tools}</>} clock={clock.controls} onLeave={()=>confirmStudyNavigation()}
        onPosition={next=>void move(next)} onCount={value=>{void (async()=>{try{await question.current?.flush();setCount(value);}catch(reason){setError(reason instanceof Error?reason.message:'答案尚未保存。');}})();}} sourceAvailable={sourceAvailable}
        onOriginal={()=>{originalTrigger.current=document.activeElement instanceof HTMLButtonElement?document.activeElement:null;setRestoreError('');setOriginal({unit:unitKey,page:unit.physicalPages[0]});}}
        renderText={text=><PaperSourceText text={text} renderMath={value=><MathText text={value}/>}/>}
        task={<PaperQuestionEntry key={unitKey} paper={paper} unit={unit} services={services} restoredUnit={resume?.workspace.unit} onSaving={setQuestionSaving} onError={setQuestionError} onSession={onSession} onContinue={()=>void move(unit.position+unit.paragraphs.length)}/>}
        original={page!==null?<><nav aria-label="原页选择">{unit.physicalPages.map(number=><button key={number} type="button" onClick={()=>setOriginal({unit:unitKey,page:number})}>第 {number} 页</button>)}</nav>
            {origin?.kind==='upload'&&<label>重新提供同版本 PDF<input type="file" accept=".pdf,application/pdf" disabled={restoring}
                onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void restoreOriginal(file);}}/></label>}
            {restoring&&<p role="status">正在保存原文件…</p>}{restoreError&&<p role="alert">{restoreError}</p>}
            <PaperOriginalPage key={JSON.stringify([scope,page,originalRevision])} physicalPage={page} sourceVersion={origin!.version} load={loadOriginal} onClose={close}/></>:undefined}/>
}
