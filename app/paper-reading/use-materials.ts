'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {DEMO_PAPER_ALEXNET,type PaperStudyData} from '../paper-study';
import {loadPaperMaterials,openPaperDraft,savePaperMaterial,type PaperMaterial,type PaperDraftSession} from '../paper-draft-store';
import type {PaperServices} from '../plugins/plugin-paper';
import {createPaperOriginalCache} from './original-cache';

export function usePaperReadingMaterials(services:PaperServices,initialPaper?:PaperStudyData){
    const [paper,setPaper]=useState(initialPaper??DEMO_PAPER_ALEXNET),[materials,setMaterials]=useState<PaperMaterial[]>([]);
    const [loaded,setLoaded]=useState<{scope:string;paper:PaperStudyData;session:PaperDraftSession}|null>(null),[error,setError]=useState('');
    const [originalNotice,setOriginalNotice]=useState('');
    const scope=JSON.stringify([services.owner,services.library]),currentScope=useRef(scope);
    const selection=useRef(0);
    useLayoutEffect(()=>{currentScope.current=scope;selection.current++;},[scope]);
    useEffect(()=>{
        let active=true;const selectedAtStart=selection.current;
        void loadPaperMaterials(services.owner,services.library).then(items=>{
            if(!active||currentScope.current!==scope)return;
            setMaterials(current=>[...current,...items.filter(item=>!current.some(prior=>prior.fingerprint===item.fingerprint))]);
            if(selection.current===selectedAtStart&&!initialPaper&&items[0])setPaper(items[0].paper);
        }).catch(reason=>{if(active&&currentScope.current===scope)setError(String(reason));});
        return()=>{active=false;};
    },[services.owner,services.library,scope,initialPaper]);
    useEffect(()=>{
        let active=true;
        void openPaperDraft(services.owner,services.library,paper).then(session=>{
            if(active&&currentScope.current===scope)setLoaded({scope,paper,session});
        }).catch(reason=>{if(active)setError(String(reason));});
        return()=>{active=false;};
    },[services.owner,services.library,scope,paper]);
    async function choose(next:PaperStudyData){
        const bound=scope,operation=++selection.current;
        try{
            if(loaded?.scope===scope&&loaded.paper===paper)await loaded.session.flush();
            if(currentScope.current!==bound||services.isCurrent?.()===false)throw Error('论文资料库已切换，原草稿保留。');
            if(operation===selection.current){setPaper(next);setError('');setOriginalNotice('');}
        }catch(reason){
            if(currentScope.current===bound&&operation===selection.current)setError(reason instanceof Error?reason.message:'切换失败，原文与草稿保留。');
            throw reason;
        }
    }
    async function add(next:PaperStudyData,file?:File){
        const bound=scope,operation=++selection.current;
        if(loaded?.scope===scope&&loaded.paper===paper)await loaded.session.flush();
        if(currentScope.current!==bound||services.isCurrent?.()===false)throw Error('论文资料库已切换，原草稿保留。');
        if(operation!==selection.current)return;
        const material=await savePaperMaterial(services.owner,services.library,next);
        if(currentScope.current!==bound||services.isCurrent?.()===false)return;
        setMaterials(items=>[material,...items.filter(item=>item.fingerprint!==material.fingerprint)]);
        if(operation===selection.current)setOriginalNotice('');
        if(file&&next.origin?.kind==='upload'&&file.name.toLowerCase().endsWith('.pdf')){
            try{await createPaperOriginalCache().save({ownerId:services.owner,libraryId:services.library,sourceVersion:next.origin.version},
                {filename:file.name,bytes:new Uint8Array(await file.arrayBuffer())});}
            catch{if(currentScope.current===bound&&operation===selection.current)setOriginalNotice('正文已保存，原 PDF 副本未能保存。刷新后核对原页需重新提供同版本文件。');}
        }
        if(currentScope.current===bound&&operation===selection.current&&services.isCurrent?.()!==false){setPaper(material.paper);setError('');}
    }
    return {paper,materials,session:loaded?.scope===scope&&loaded.paper===paper?loaded.session:null,error,originalNotice,add,choose};
}
