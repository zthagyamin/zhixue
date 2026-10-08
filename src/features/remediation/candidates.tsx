'use client';
import {useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createTemporaryDraft,type TemporaryDraft} from '../../application/temporary-practice';
import {approveCandidates,candidateDocument,sourceFingerprint,type CandidateRow,type CandidateSource} from '../../domain/practice-candidates';
import {TemporaryDialog,type LeaveGuardPort} from './dialog';
import type {TemporaryFactory} from './source-review';

type Props={source:Omit<CandidateSource,'version'>&{version?:string};seeds:CandidateRow[];scope:string;createDraft?:TemporaryFactory;isCurrent?:()=>boolean;registerGuard?:LeaveGuardPort;download:(name:string,content:string)=>void;label:string;defaultFragmentId?:string};
type Session={source:CandidateSource;seeds:CandidateRow[];draft:TemporaryDraft};
export function CandidateLauncher(props:Props){
    const [session,setSession]=useState<Session|null>(null),[notice,setNotice]=useState(''),[preparing,setPreparing]=useState(false);
    const signature=JSON.stringify([props.scope,props.source,props.seeds]),current=useRef(signature);
    const opening=useRef(false),live=useRef(props.isCurrent);
    useLayoutEffect(()=>{
        current.current=signature;live.current=props.isCurrent;
        // A committed source change must notify subscribers as well as prevent export.
        if(session&&!session.draft.isActive())session.draft.dispose();
    },[signature,props.isCurrent,session]);
    const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    const open=async()=>{
        if(opening.current||!props.seeds.length)return;opening.current=true;setPreparing(true);setNotice('');
        try{
            const source:CandidateSource={...props.source,version:props.source.version||await sourceFingerprint(props.source)};
            if(!alive.current)return;
            if(current.current!==signature||live.current?.()===false){setNotice('来源已变化，请从当前材料重新准备候选。');return;}
            const initial:Record<string,string>={};
            props.seeds.forEach((row,index)=>{
                const fragment=source.fragments.find(value=>value.id===(row.fragmentId||props.defaultFragmentId))??source.fragments[0];
                const fields={...row,fragmentId:fragment?.id??'',quote:row.quote||fragment?.text||'',selected:index===0?'yes':'no'};
                for(const [field,value] of Object.entries(fields))initial[`${index}.${field}`]=value;
            });
            const owned=props.createDraft?props.createDraft(initial):createTemporaryDraft({initial,binding:signature,isCurrent:()=>alive.current&&current.current===signature&&live.current?.()!==false});
            if(!owned){setNotice('当前练习正在保存或已变化，请稍后重试。');return;}
            const draft:TemporaryDraft={...owned,isActive:()=>alive.current&&owned.isActive()&&current.current===signature&&live.current?.()!==false};
            setSession({source,seeds:structuredClone(props.seeds),draft});
        }catch{if(alive.current)setNotice('候选暂时无法准备，原材料没有变化。');}finally{opening.current=false;if(alive.current)setPreparing(false);}
    };
    return <section className="study-remedy-entry">
        <button type="button" className="study-secondary-action" disabled={!props.seeds.length||preparing} onClick={()=>void open()}>{preparing?'正在准备候选…':props.label}</button>
        {!props.seeds.length&&<p className="study-meta">{props.source.kind==='paper'?'请先在主线自检中标记“还说不清”的项目。':'按原段落生成 2–6 项候选；更多段落请先人工整理，不会自动扩增任务。'}</p>}
        {notice&&<p role="status">{notice}</p>}
        {session&&<CandidateEditor {...session} download={props.download} registerGuard={props.registerGuard} onClose={()=>setSession(null)}/>}
    </section>;
}
function CandidateEditor({source,seeds,draft,download,registerGuard,onClose}:Session&{download:Props['download'];registerGuard?:LeaveGuardPort;onClose:()=>void}){
    useSyncExternalStore(draft.subscribe,draft.getSnapshot,()=>0);
    const [reviewed,setReviewed]=useState(false),[workload,setWorkload]=useState(false),[message,setMessage]=useState(''),[exported,setExported]=useState(false),[busy,setBusy]=useState(false);
    const locked=useRef(false);
    const rows=seeds.map((seed,index)=>{
        const get=(key:string)=>draft.read(`${index}.${key}`);
        return{id:seed.id,question:get('question'),reference:get('reference'),keyPoints:get('keyPoints'),category:get('category'),fragmentId:get('fragmentId'),quote:get('quote'),selected:get('selected')==='yes'};
    });
    const selected=rows.filter(row=>row.selected);
    const edit=(index:number,key:string,value:string)=>{if(draft.write(`${index}.${key}`,value)){setReviewed(false);setWorkload(false);setExported(false);setMessage('');}};
    const exportMaterial=async()=>{
        if(locked.current||!draft.isActive())return;locked.current=true;setBusy(true);draft.setBusy(true);setMessage('');
        try{
            const artifact=approveCandidates(source,selected,{reviewed,workload,currentVersion:source.version});
            const identity=await sourceFingerprint(artifact);
            if(!draft.isActive())return;
            download(`知学复测候选-${identity.slice(0,12)}.zhixue-candidates.json`,candidateDocument(artifact));
            draft.acknowledge();setExported(true);setMessage('已准备无损候选文件。请用支持此格式的新版 Companion 在“单个学习文件”中预览、确认导入，再确认计划。旧版不支持时请先更新，不要改名当普通文本导入；目前尚未新增题库、成绩或排程。');
        }catch(error){
            const code=error instanceof Error?error.message:'';
            setMessage(code.includes('quote')?'原文摘录必须真实存在于所选段落或父卡，请重新定位。':code.includes('category')?'请先区分论文主张、实验观察、推测或限制。':code.includes('key-points')?'请补充经过原文核对的关键要点。':code.includes('stale')?'来源版本已变化，请重新准备候选。':'请完整填写所选题目、参考，并确认原文核对和新增负担。');
        }finally{locked.current=false;draft.setBusy(false);setBusy(false);}
    };
    return <TemporaryDialog draft={draft} title={source.kind==='paper'?'待批准论文复测候选':'待批准子卡候选'} registerGuard={registerGuard} onClose={onClose}>
        <p>父项：{source.title}。默认仅选一项；编辑、预览、批准或导出都不会生成掌握记录。</p>
        <details><summary>来源与版本</summary><p>{source.key}</p><p>{source.versionKind==='paper-origin'?'原文件版本':source.versionKind==='item-content'?'原题内容版本':'当前可见材料快照'}：{source.version}</p></details>
        {rows.map((row,index)=>{const fragment=source.fragments.find(value=>value.id===row.fragmentId);return <fieldset key={row.id} className="study-candidate-row" disabled={busy}>
            <legend><label><input type="checkbox" checked={row.selected} onChange={event=>edit(index,'selected',event.target.checked?'yes':'no')}/>候选 {index+1}</label></legend>
            {row.selected&&<>
                <label>题目<textarea aria-label={`候选 ${index+1} 题目`} maxLength={1000} value={row.question} onChange={event=>edit(index,'question',event.target.value)}/></label>
                {source.kind==='paper'&&<label>内容属性<select aria-label={`候选 ${index+1} 内容属性`} value={row.category} onChange={event=>edit(index,'category',event.target.value)}><option value="">先区分材料性质</option><option value="claim">论文主张</option><option value="observation">实验观察</option><option value="inference">推测 / 推断</option><option value="limitation">限制 / 适用边界</option></select></label>}
                <label>原文位置<select aria-label={`候选 ${index+1} 原文位置`} value={row.fragmentId} onChange={event=>{edit(index,'fragmentId',event.target.value);edit(index,'quote','');}}>{source.fragments.map(value=><option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
                <details><summary>查看选中原文</summary><p className="study-temporary-reference">{fragment?.text}</p></details>
                <label>原文摘录<textarea aria-label={`候选 ${index+1} 原文摘录`} value={row.quote} onChange={event=>edit(index,'quote',event.target.value)}/></label>
                <label>参考说明（须核对原文）<textarea aria-label={`候选 ${index+1} 参考说明`} rows={4} maxLength={7000} value={row.reference} onChange={event=>edit(index,'reference',event.target.value)}/></label>
                <label>关键要点{source.kind==='paper'?'（必填）':'（可选）'}<textarea aria-label={`候选 ${index+1} 关键要点`} maxLength={1000} value={row.keyPoints} onChange={event=>edit(index,'keyPoints',event.target.value)}/></label>
            </>}
        </fieldset>;})}
        <label className="study-temporary-check"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>我已核对题目、参考、原文位置与内容属性，不把推测当作已证实结论</label>
        <label className="study-temporary-check"><input type="checkbox" checked={workload} disabled={busy} onChange={event=>setWorkload(event.target.checked)}/>我确认导出 {selected.length} 项候选的潜在复习负担；导入与每日计划仍需分别确认</label>
        <button type="button" className="study-primary-action" disabled={busy||exported||!reviewed||!workload||!selected.length} onClick={()=>void exportMaterial()}>{busy?'正在准备材料…':exported?'本次材料已准备':'批准并导出复测材料'}</button>
        {message&&<p role="status">{message}</p>}
    </TemporaryDialog>;
}
