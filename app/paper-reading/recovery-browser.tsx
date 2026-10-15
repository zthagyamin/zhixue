'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PaperServices} from '../plugins/plugin-paper';
import type {PaperReadingWorkspaceV1,PaperReadingDiscoverySummary} from '../../src/domain/paper-reading';
import {createPaperReadingRemote} from '../../src/infrastructure/paper-reading';
import {PaperSourceText} from '../../src/features/paper-reading/source-text';
import {MathText} from '../math-text';

function BoundPaperReadingRecoveryBrowser({services,onResume}:{services:PaperServices;onResume:(workspace:PaperReadingWorkspaceV1)=>Promise<boolean>}){
    const scope=JSON.stringify([services.owner,services.library]),latest=useRef({scope,services,onResume});
    useLayoutEffect(()=>{latest.current={scope,services,onResume};},[scope,services,onResume]);
    const [rows,setRows]=useState<PaperReadingDiscoverySummary[]>([]),[cursor,setCursor]=useState<string|null>(null);
    const [loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const [selected,setSelected]=useState<PaperReadingWorkspaceV1|null>(null),[missing,setMissing]=useState(false);
    const alive=useRef(true),flight=useRef<AbortController|null>(null);
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;flight.current?.abort();};},[]);
    const current=(expected:string)=>alive.current&&latest.current.scope===expected&&latest.current.services.isCurrent?.()!==false;
    async function list(next:string|null=null){
        if(flight.current)return;const expected=scope,c=new AbortController();flight.current=c;setBusy(true);setError('');
        try{const remote=createPaperReadingRemote({scope:{ownerId:services.owner,libraryId:services.library},isCurrent:()=>current(expected)});
            const page=await remote.list!({cursor:next},c.signal);if(!current(expected))return;
            setRows(previous=>next?[...previous,...page.items.filter(item=>!previous.some(p=>p.unitId===item.unitId))]:page.items);
            setCursor(page.nextCursor);setLoaded(true);
        }catch{if(current(expected))setError('账号阅读记录暂未完整读取，原答保留。请稍后重试。');}
        finally{flight.current=null;if(current(expected))setBusy(false);}
    }
    async function open(id:string,resume=false){
        if(flight.current)return;const expected=scope,c=new AbortController();flight.current=c;setBusy(true);setError('');
        try{const remote=createPaperReadingRemote({scope:{ownerId:services.owner,libraryId:services.library},isCurrent:()=>current(expected)});
            const workspace=await remote.read(id,c.signal);if(!current(expected))return;if(!workspace)throw Error('missing');
            setSelected(workspace);setMissing(false);
            if(resume){const matched=await latest.current.onResume(workspace);if(current(expected))setMissing(!matched);}
        }catch{if(current(expected))setError('该记录未能恢复，已保存原答保留。');}
        finally{flight.current=null;if(current(expected))setBusy(false);}
    }
    if(!services.owner.startsWith('account:')||!services.library.startsWith('account:'))return null;
    return <details key={scope}><summary>恢复账号阅读记录</summary>
        <button type="button" disabled={busy} onClick={()=>void list()}>读取账号记录</button>
        {busy&&<p role="status">正在读取…</p>}{error&&<p role="alert">{error}</p>}
        {loaded&&rows.length===0&&<p>当前资料库没有已保存的阅读记录。</p>}
        <ul>{rows.map(row=><li key={row.unitId}><strong>{row.title}</strong> · {row.sectionId} · {row.task?.question??'问题尚未准备'}
            {row.pendingEvaluation&&<span> · 有待核对答案</span>}
            <button type="button" disabled={busy} onClick={()=>void open(row.unitId)}>查看保存内容</button>
            <button type="button" disabled={busy} onClick={()=>void open(row.unitId,true)}>匹配原文并继续</button>
        </li>)}</ul>
        {cursor&&<button type="button" disabled={busy} onClick={()=>void list(cursor)}>读取更多记录</button>}
        {selected&&<section aria-label="已保存阅读内容"><h3>{selected.unit.title}</h3>
            <p>来源版本：{selected.unit.source.sourceVersion}</p>
            {missing&&<p role="status">本机缺少匹配版本的原文。答案保留，可重新提供同版本材料后再继续。</p>}
            <PaperSourceText text={selected.task?.question??'问题尚未准备'} renderMath={value=><MathText text={value}/>}/>
            {selected.attempts.filter(attempt=>attempt.submission).map(attempt=><article key={attempt.attemptId}>
                <h4>{attempt.purpose==='first'?'首轮回答':'后续尝试'}</h4><PaperSourceText text={attempt.submission!.answer} renderMath={value=><MathText text={value}/>}/>
                <p>{attempt.evaluation.status==='pending'?'待核对':'已保存核对反馈'}</p>
                {attempt.evaluation.status==='resolved'&&<PaperSourceText text={attempt.evaluation.explanation} renderMath={value=><MathText text={value}/>}/>}
            </article>)}<button type="button" disabled={busy} onClick={()=>void open(selected.unit.unitId,true)}>匹配原文并继续</button>
        </section>}
    </details>;
}

export function PaperReadingRecoveryBrowser(props:{services:PaperServices;onResume:(workspace:PaperReadingWorkspaceV1)=>Promise<boolean>}){
    return <BoundPaperReadingRecoveryBrowser key={JSON.stringify([props.services.owner,props.services.library])} {...props}/>;
}