import {useState,useEffect,useRef} from 'react';
import type {CodeRunReportV1} from '../../domain/code-execution';
import type {PracticeLearningPort} from '../../application/practice-evidence';
type Props={report:CodeRunReportV1|null;practice?:PracticeLearningPort;
    requestHint?:()=>Promise<string>};
/** A short observed failure and an explicit optional hint, without grading or storage access. */
export function CodeCaseFeedback({report,practice,requestHint}:Props){
    const failure=report?.firstFailure;
    const [hint,setHint]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const active=useRef(true),locked=useRef(false);
    useEffect(()=>{active.current=true;
        void practice?.codeFeedback().then(saved=>{const restored=saved.hint;if(active.current&&restored&&restored.runId===report?.runId
            &&restored.caseId===report?.firstFailure?.caseId)setHint(restored.text);}).catch(()=>{});
        return()=>{active.current=false;};},[practice,report]);
    if(!report||report.status==='passed')return null;
    const compact=(value:unknown)=>{const text=JSON.stringify(value);return text.length>240?text.slice(0,240)+'…':text;};
    const showHint=async()=>{
        if(locked.current)return;locked.current=true;setBusy(true);setError('');
        try{
            const value=failure?.hint??await requestHint?.();
            if(!active.current)return;
            if(!value?.trim())throw Error('暂时没有可用提示。');
            if(failure?.hint&&practice)await practice.recordCodeHint({runId:report!.runId,caseId:failure.caseId,text:value,source:'preset'});
            if(active.current)setHint(value);
        }catch(reason){if(active.current)setError(reason instanceof Error?reason.message:'提示暂不可用。');}
        finally{if(active.current){locked.current=false;setBusy(false);}}
    };
    return <div className="study-code-case" data-code-case={failure?.caseId}>
        {failure&&<dl className="grid gap-2 text-sm">
            <div><dt className="font-semibold">输入</dt><dd className="font-mono break-words">{compact(failure.args)}{Object.keys(failure.kwargs).length?` ${compact(failure.kwargs)}`:''}</dd></div>
            <div><dt className="font-semibold">预期</dt><dd className="font-mono break-words">{compact(failure.expected)}</dd></div>
            <div><dt className="font-semibold">实际</dt><dd className="font-mono break-words">{compact(failure.actual)}</dd></div>
        </dl>}
        {failure&&JSON.stringify(failure).length>720&&<details><summary>查看完整检查项</summary><pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify({input:failure.args,kwargs:failure.kwargs,expected:failure.expected,actual:failure.actual},null,2)}</pre></details>}
        {(failure?.hint||requestHint)&&<button type="button" className="study-secondary-action mt-3" disabled={busy} onClick={showHint}>{busy?'获取提示…':'小提示'}</button>}
        {hint&&<p className="mt-2" role="status">{hint}</p>}
        {error&&<p className="mt-2" role="status">{error}</p>}
    </div>;
}
