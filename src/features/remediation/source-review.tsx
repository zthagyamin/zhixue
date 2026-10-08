'use client';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createTemporaryDraft,type TemporaryDraft} from '../../application/temporary-practice';
import {recalculationResult,type SourceWorksheet} from '../../domain/remediation';
import {TemporaryDialog,type LeaveGuardPort} from './dialog';

export type TemporaryFactory = (initial:Record<string,string>)=>TemporaryDraft|null;
type Props={worksheet:SourceWorksheet|null;createDraft?:TemporaryFactory;registerGuard?:LeaveGuardPort;beforeOpen?:(signal:AbortSignal)=>Promise<boolean>;disabled?:boolean;label?:string;expected?:string|number;calculation?:{mode?:string;variables?:string[];tolerance?:string}};
export function SourceReviewLauncher(props:Props) {
    const [draft,setDraft]=useState<TemporaryDraft|null>(null),[preparing,setPreparing]=useState(false),[notice,setNotice]=useState('');
    const pending=useRef<AbortController|null>(null),alive=useRef(true);
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;pending.current?.abort();};},[]);
    const open=async()=>{
        if(preparing||pending.current||props.disabled||!props.worksheet)return;
        const controller=new AbortController();pending.current=controller;setPreparing(true);setNotice('');
        try{
            if(props.beforeOpen&&!await props.beforeOpen(controller.signal)){if(alive.current)setNotice('原结果尚未保存成功，请处理保存提示后再补练。');return;}
            if(!alive.current||controller.signal.aborted)return;
            const initial:Record<string,string>={answer:'',reason:''};
            const next=props.createDraft?props.createDraft(initial):createTemporaryDraft({initial,binding:props.worksheet.binding});
            if(!next){setNotice('当前题目已变化或正在保存，请稍后重试。');return;}
            setDraft(next);
        }finally{if(pending.current===controller)pending.current=null;if(alive.current)setPreparing(false);}
    };
    if(!props.worksheet)return <p className="study-meta">暂无可对应的补练材料，可以核对来源或直接继续。</p>;
    return <div className="study-remedy-entry">
        <button type="button" className="study-secondary-action" disabled={props.disabled||preparing} onClick={()=>void open()}>{preparing?'正在保留原结果…':props.label??'针对这一点，做一次原文核对'}</button>
        {notice&&<p role="status">{notice}</p>}
        {draft&&<SourceReview key={props.worksheet.binding} {...props} worksheet={props.worksheet} draft={draft} onClose={()=>setDraft(null)}/>}
    </div>;
}
function SourceReview({worksheet,draft,onClose,expected,calculation,registerGuard}:Props&{worksheet:SourceWorksheet;draft:TemporaryDraft;onClose:()=>void}) {
    useSyncExternalStore(draft.subscribe,draft.getSnapshot,()=>0);
    const [result,setResult]=useState(''),[reviewed,setReviewed]=useState(false),[complete,setComplete]=useState(false);
    const canCheck=!!draft.read('reason').trim()&&(worksheet.kind!=='recalculate'||!!draft.read('answer').trim());
    return <TemporaryDialog draft={draft} title="一次针对性核对" onClose={onClose} registerGuard={registerGuard}>
        <p>{worksheet.instruction}</p><p><strong>本次聚焦：</strong>{worksheet.target}</p>
        <details><summary>对照原材料</summary><p className="study-temporary-reference">{worksheet.reference}</p></details>
        <label>你的解释 / 关键步骤<textarea aria-label="补练解释" rows={4} maxLength={12000} value={draft.read('reason')} onChange={event=>{if(draft.write('reason',event.target.value)){setComplete(false);setReviewed(false);setResult('');}}}/></label>
        {worksheet.kind==='recalculate'&&<label>最终结果<input aria-label="补练最终结果" value={draft.read('answer')} onChange={event=>{if(draft.write('answer',event.target.value)){setComplete(false);setReviewed(false);setResult('');}}}/></label>}
        <button type="button" className="study-secondary-action" disabled={!canCheck} onClick={()=>setResult(worksheet.kind==='recalculate'&&expected!==undefined?recalculationResult(draft.read('answer'),expected,calculation).message:'请对照原材料核对你的说明。这里没有自动判分，也没有认证反例或概念判断的正确性。')}>核对这次补练</button>
        {result&&<><p role="status">{result}</p><label className="study-temporary-check"><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>我已回到原材料核对，不把本次辅助练习当成独立通过</label><button type="button" className="study-primary-action" disabled={!reviewed} onClick={()=>{draft.acknowledge();setComplete(true);}}>完成这次核对</button></>}
        {complete&&<p role="status">本次核对已结束，原作答和复习安排没有改变。可以返回原反馈继续。</p>}
    </TemporaryDialog>;
}
