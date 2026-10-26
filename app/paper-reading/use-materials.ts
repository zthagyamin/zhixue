'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {DEMO_PAPER_ALEXNET,type PaperStudyData} from '../paper-study';
import {loadPaperMaterials,openPaperDraft,paperFingerprint,savePaperMaterial,type PaperMaterial,type PaperDraftSession} from '../paper-draft-store';
import type {PaperServices} from '../plugins/plugin-paper';
import {createPaperOriginalCache} from './original-cache';
import {loadPaperReadingBookmarks,paperReadingBookmarkFor,savePaperReadingBookmark,type PaperReadingBookmark,type PaperReadingBookmarks} from './bookmark';
import {createPaperReadingStore} from './store';
import {matchPaperReadingResume} from '../../src/application/paper-reading-resume';
import type {PaperReadingWorkspaceV1} from '../../src/domain/paper-reading';

type Resume={workspace:PaperReadingWorkspaceV1;position:number;count:number};
type Loaded={scope:string;paper:PaperStudyData;session:PaperDraftSession;bookmark:PaperReadingBookmark;resume?:Resume};
export function usePaperReadingMaterials(services:PaperServices,initialPaper?:PaperStudyData){
    const [catalog,setCatalog]=useState<{scope:string;items:PaperMaterial[]}|null>(null),[loaded,setLoaded]=useState<Loaded|null>(null),[error,setError]=useState('');
    const [originalNotice,setOriginalNotice]=useState('');
    const scope=JSON.stringify([services.owner,services.library]),currentScope=useRef(scope),currentServices=useRef(services);
    const selection=useRef(0),bookmarkIntent=useRef(0),changing=useRef(false),alive=useRef(true),latest=useRef<Loaded|null>(null);
    useLayoutEffect(()=>{currentScope.current=scope;currentServices.current=services;},[scope,services]);
    useLayoutEffect(()=>{selection.current++;},[scope,initialPaper]);
    useLayoutEffect(()=>{latest.current=null;changing.current=false;},[scope]);
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    const bound={ownerId:services.owner,libraryId:services.library};
    const current=(operation:number)=>alive.current&&currentScope.current===scope&&selection.current===operation&&currentServices.current.isCurrent?.()!==false;
    const check=(operation:number)=>{if(!current(operation))throw Error('论文资料库或选择已切换，原草稿保留。');};
    async function prepare(paper:PaperStudyData,bookmarks:PaperReadingBookmarks|null,operation:number):Promise<Loaded>{
        const fingerprint=await paperFingerprint(paper),session=await openPaperDraft(services.owner,services.library,paper);await session.flush();check(operation);
        const saved=paperReadingBookmarkFor(bookmarks,paper,fingerprint);
        const bookmark=saved??{materialFingerprint:fingerprint,sourceVersion:paper.origin?.version??fingerprint,position:session.snapshot().draft.position,count:1};
        let resume:Resume|undefined;
        if(saved?.activeUnitId){
            const workspace=await createPaperReadingStore().read(bound,saved.activeUnitId);check(operation);
            const match=workspace&&matchPaperReadingResume(workspace,{materialFingerprint:fingerprint,sourceVersion:bookmark.sourceVersion,sections:paper.sections});
            if(match&&match.position===bookmark.position&&match.count===bookmark.count)resume={workspace:workspace!,...match};
        }
        return {scope,paper,session,bookmark,...(resume?{resume}:{})};
    }
    function accept(next:Loaded){latest.current=next;setLoaded(next);setError('');}
    useEffect(()=>{
        const operation=selection.current;
        void Promise.all([loadPaperMaterials(services.owner,services.library),loadPaperReadingBookmarks(bound)]).then(async([items,bookmarks])=>{
            if(!alive.current||currentScope.current!==scope)return;
            setCatalog(previous=>{const current=previous?.scope===scope?previous.items:[];
                return {scope,items:[...current,...items.filter(item=>!current.some(prior=>prior.fingerprint===item.fingerprint))]};});
            if(!current(operation))return;
            const recent=items.find(item=>item.fingerprint===bookmarks?.lastMaterialFingerprint&&paperReadingBookmarkFor(bookmarks,item.paper,item.fingerprint));
            const paper=initialPaper??recent?.paper??items[0]?.paper??DEMO_PAPER_ALEXNET;
            const next=await prepare(paper,bookmarks,operation);if(current(operation))accept(next);
        }).catch(reason=>{if(current(operation))setError(reason instanceof Error?reason.message:String(reason));});
        // Intent counters, rather than delayed reads, own subsequent user choices.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    },[services.owner,services.library,scope,initialPaper]);
    async function choose(next:PaperStudyData){
        const operation=++selection.current;changing.current=true;
        try{
            await latest.current?.session.flush();check(operation);
            const prepared=await prepare(next,await loadPaperReadingBookmarks(bound),operation);
            await savePaperReadingBookmark(bound,prepared.bookmark,()=>current(operation));check(operation);
            accept(prepared);setOriginalNotice('');
        }catch(reason){
            if(current(operation))setError(reason instanceof Error?reason.message:'切换失败，原文与草稿保留。');
            throw reason;
        }finally{if(selection.current===operation)changing.current=false;}
    }
    async function remember(value:{position:number;count:number;activeUnitId?:string}){
        const previous=loaded;if(changing.current||!previous||latest.current?.session!==previous.session)throw Error('论文已切换，原草稿保留。');
        const operation=selection.current,write=++bookmarkIntent.current;await previous.session.flush();check(operation);
        const same=previous.bookmark.position===value.position&&previous.bookmark.count===value.count;
        const bookmark={materialFingerprint:previous.bookmark.materialFingerprint,sourceVersion:previous.bookmark.sourceVersion,...value,
            ...(value.activeUnitId===undefined&&same&&previous.bookmark.activeUnitId?{activeUnitId:previous.bookmark.activeUnitId}:{})};
        await savePaperReadingBookmark(bound,bookmark,()=>current(operation)&&!changing.current&&write===bookmarkIntent.current&&latest.current?.session===previous.session);check(operation);
        const next={...latest.current!,bookmark};latest.current=next;setLoaded(next);
    }
    async function add(next:PaperStudyData,file?:File){
        const operation=++selection.current;changing.current=true;
        try{
            await latest.current?.session.flush();check(operation);
            const material=await savePaperMaterial(services.owner,services.library,next);check(operation);
            setCatalog(previous=>({scope,items:[material,...(previous?.scope===scope?previous.items:[]).filter(item=>item.fingerprint!==material.fingerprint)]}));setOriginalNotice('');
            if(file&&next.origin?.kind==='upload'&&file.name.toLowerCase().endsWith('.pdf')){
                try{await createPaperOriginalCache().save({ownerId:services.owner,libraryId:services.library,sourceVersion:next.origin.version},
                    {filename:file.name,bytes:new Uint8Array(await file.arrayBuffer())});}
                catch{if(current(operation))setOriginalNotice('正文已保存，原 PDF 副本未能保存。刷新后核对原页需重新提供同版本文件。');}
            }
            if(!current(operation))return;
            const prepared=await prepare(material.paper,await loadPaperReadingBookmarks(bound),operation);
            await savePaperReadingBookmark(bound,prepared.bookmark,()=>current(operation));check(operation);accept(prepared);
        }finally{if(selection.current===operation)changing.current=false;}
    }
    const selected=loaded?.scope===scope?loaded:null;
    return {paper:selected?.paper??initialPaper??DEMO_PAPER_ALEXNET,materials:catalog?.scope===scope?catalog.items:[],session:selected?.session??null,
        bookmark:selected?.bookmark,resume:selected?.resume,remember,error,originalNotice,add,choose};
}
