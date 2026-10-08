'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PendingMathStep, PendingMathStepPage, PendingMathStepPort } from '../../application/math-study';
export type {PendingMathStepPort} from '../../application/math-study';
export function PendingMathStepReview({ row, port, onClose, renderMath = text => text }: {
    row: PendingMathStep; port: PendingMathStepPort; onClose: () => void; renderMath?: (text: string) => ReactNode;
}) {
    const [diagnostic, setDiagnostic] = useState(row.diagnostic), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    const controller = useRef<AbortController | null>(null), lock = useRef(false);
    useEffect(() => () => { controller.current?.abort(); }, [row]);
    const evaluate = async () => {
        if (lock.current || !row.canEvaluate) return;
        lock.current = true; setBusy(true); setMessage('');
        const request = new AbortController(); controller.current = request;
        try {
            const result = await port.evaluate(row, request.signal);
            if (request.signal.aborted) return;
            if (result) setDiagnostic(result);
            else setMessage('这一步已由另一设备核对；返回列表查看最新状态。');
        } catch (reason) {
            if (!request.signal.aborted) setMessage(reason instanceof Error ? reason.message : '步骤仍待核对，原文保留。');
        } finally { lock.current = false; if (!request.signal.aborted) setBusy(false); }
    };
    const resolved = diagnostic && diagnostic.status !== 'undetermined';
    return <section className="study-session-shell" aria-label="核对保存的步骤"><header><h2>{row.title} · 待核对步骤</h2><button type="button" onClick={() => { controller.current?.abort(); onClose(); }}>返回待核对列表</button></header>
        {row.sourceLabel && <p>{row.sourceLabel}</p>}{row.prompt && <p>{renderMath(row.prompt)}</p>}
        {row.stepPrompt && <p>{renderMath(row.stepPrompt)}</p>}
        <p>原步骤</p><pre style={{whiteSpace:'pre-wrap'}}>{renderMath(row.stepText)}</pre>
        <p>原最终答案：{renderMath(row.original.attempt.submitted?.answer ?? '')}。{row.original.attempt.formal?.status==='linked'?'最终成绩保留。':'步骤核对不会生成最终成绩。'}</p>
        <p role="status">{message || diagnostic?.explanation || row.notice}</p>
        <button type="button" disabled={!row.canEvaluate || busy || Boolean(resolved)} onClick={() => void evaluate()}>{busy ? '正在核对…' : resolved ? '步骤已核对' : '核对这一步'}</button>
    </section>;
}
export function PendingMathStepQueue({ port, version, renderMath = text => text }: {
    port: PendingMathStepPort; version: number; renderMath?: (text: string) => ReactNode;
}) {
    const [revision, setRevision] = useState(0);
    type View = {port:PendingMathStepPort;version:number;revision:number;page:PendingMathStepPage|null;active:PendingMathStep|null;error:string};
    const initial = ():View => ({port,version,revision,page:null,active:null,error:''});
    const [state,setState] = useState<View>(initial);
    const view = state.port===port&&state.version===version&&state.revision===revision?state:initial();
    const identity = useRef({port,version,revision,live:true});
    useLayoutEffect(()=>{identity.current={port,version,revision,live:true};return()=>{identity.current.live=false;};},[port,version,revision]);
    const current=()=>identity.current.live&&identity.current.port===port&&identity.current.version===version&&identity.current.revision===revision;
    useEffect(() => {
        let live = true;
        void port.list().then(page => { if (live) setState({port,version,revision,page,active:null,error:''}); })
            .catch(reason => { if (live) setState({port,version,revision,page:null,active:null,error:reason instanceof Error ? reason.message : '步骤列表尚未恢复。'}); });
        return () => { live = false; };
    }, [port, version, revision]);
    const open = async (row: PendingMathStep) => {
        try { const latest = await port.load(row.evidence.attemptId); if (current()) { if (latest) setState({...view,active:latest}); else setRevision(value => value + 1); } }
        catch (reason) { if (current()) setState({...view,error:reason instanceof Error ? reason.message : '原步骤暂不可用。'}); }
    };
    const {page,active,error}=view;
    if(page?.complete&&!page.rows.length&&!page.notice&&!error&&!active)return null;
    return <section className="nonword-pending-steps" aria-label="待核对步骤"><h2>待核对步骤</h2>
        <p role="status">{error || page?.notice || (page ? page.rows.length ? '已保存的步骤可单独核对，最终成绩保留。' : '当前没有待核对步骤。' : '正在读取已保存步骤…')}</p>
        {page?.rows.map(row => <article key={row.evidence.attemptId}><h3>{row.title}</h3><p>{renderMath(row.stepText)}</p><p>{row.notice}</p><button type="button" onClick={() => void open(row)}>查看保存的步骤</button></article>)}
        {(error || page && !page.complete) && <button type="button" onClick={() => setRevision(value => value + 1)}>重新读取</button>}
        {active && <PendingMathStepReview key={active.evidence.attemptId} row={active} port={port} renderMath={renderMath} onClose={() => { setState({...view,active:null}); setRevision(value => value + 1); }}/>}
    </section>;
}
