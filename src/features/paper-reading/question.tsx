'use client';
import type {ReactNode} from 'react';
import type {PaperReadingSessionState} from '../../application/paper-reading';
export function paperReadingMessage(code:string,savedAnswer=false){
    if(/quota|save-unavailable|保存|conflict/.test(code))return /cloud|同步/.test(code)?'本机答案已保留，账号有不同版本，暂未覆盖。':'保存失败，输入仍保留在本页。请重试保存。';
    if(/receipt-unknown|request-pending/.test(code))return '核对结果尚待确认。答案已保留，可稍后恢复核对。';
    if(/unsupported/.test(code))return '当前服务尚未提供论文问答。已保存内容保留。';
    if(/source-budget|input-budget/.test(code))return '本次范围超出问答预算，请缩小阅读范围；原文与答案保留。';
    if(/unavailable|offline|unconfirmed|network/.test(code))return savedAnswer?'AI 或账号暂不可用，答案已保留，待核对。':'AI 或账号暂不可用，可稍后重新准备问题。';
    if(/cancel/.test(code))return '请求已取消，已保存内容保留。';
    return '本次操作未完成，输入与已保存内容保留。';
}
type Props={state:PaperReadingSessionState;formalReview?:ReactNode;onBegin:()=>void;onAnswer:(text:string)=>void;onSubmit:()=>void;onReveal:()=>void;onRetry:()=>void;
    onEvaluate:()=>void;onSync:()=>void;onContinue?:()=>void;renderText:(text:string)=>ReactNode};
export function PaperReadingQuestion(props:Props){
    const {state}=props,workspace=state.workspace,task=workspace?.task;
    const attempt=workspace?.attempts.find(a=>a.attemptId===workspace.activeAttemptId),submitted=Boolean(attempt?.submission);
    const result=attempt?.evaluation.status==='resolved'?attempt.evaluation:null;
    const locked=state.saving||state.busy||Boolean(state.error);
    return <section className="paper-reading-question" aria-label="论文理解练习">
        <h2 className="paper-reading-question-title">理解与作答</h2>
        {state.error&&<p role="alert">{paperReadingMessage(state.error)}</p>}
        {state.notice&&<p role="status">{paperReadingMessage(state.notice,submitted)}</p>}
        {!state.ready?<p role="status">正在恢复问答…</p>:!task||task.status!=='ready'?<>
            {task?.status==='needs-improvement'&&<p role="status">问题待完善，请先核对当前原文或缩小范围。</p>}
            {!workspace&&<button type="button" disabled={state.saving} onClick={props.onSync}>重试读取问答</button>}
            <button className="paper-reading-primary" type="button" disabled={locked||!workspace} onClick={props.onBegin}>{state.busy?'正在准备问题…':task?'重新准备问题':'开始学习'}</button>
        </>:<>
            <header><span>{attempt?.purpose==='remediation'?'补练':'阅读理解'}</span>{props.renderText(task.question)}</header>
            <form onSubmit={event=>{event.preventDefault();props.onSubmit();}}>
                <label htmlFor={workspace!.unit.unitId+'-answer'}>你的回答</label>
                <textarea id={workspace!.unit.unitId+'-answer'} maxLength={20000} required value={state.input} readOnly={submitted||state.busy}
                    onChange={event=>props.onAnswer(event.target.value)}/>
                {!submitted&&<button className="paper-reading-primary" type="submit" disabled={locked||!state.input.trim()}>提交核对</button>}
            </form>
            <p className="paper-answer-save-state" role="status">{state.error?'保存未完成':state.saving?'正在保存…':state.cloud==='acked'?'已同步账号':state.cloud==='device-only'?'已保存本机':'已保存本机，账号同步未确认'}</p>
            {submitted&&<section className="paper-reading-feedback" aria-label="回答反馈">
                <h3>核对反馈</h3>
                <strong>{result?result.outcome==='correct'?'本次回答符合参考要点':result.outcome==='partial'?'部分正确':'本次回答有遗漏或错误':'待核对'}</strong>
                {result&&<>{result.issues.length>0&&<ul>{result.issues.map((issue,i)=><li key={i}>{props.renderText(issue)}</li>)}</ul>}{props.renderText(result.explanation)}
                    {result.matched.length>0&&<details><summary>匹配的要点</summary>{result.matched.map((point,i)=><div key={i}>{props.renderText(point)}</div>)}</details>}</>}
                {!result&&<button type="button" disabled={locked} onClick={props.onEvaluate}>{state.busy?'正在核对…':'恢复核对'}</button>}
            </section>}
            {workspace!.referenceSeen?<section className="paper-reading-reference" aria-label="参考要点">
                <h3>参考要点</h3>
                {task.reference.map((point,i)=><div key={i}>{props.renderText(point.point)}</div>)}
                {submitted&&<button type="button" disabled={locked} onClick={props.onRetry}>收起答案再试</button>}
            </section>:<button type="button" disabled={locked} onClick={props.onReveal}>查看关键要点</button>}
            {submitted&&<div className="paper-reading-actions">
                {!workspace!.referenceSeen&&<button type="button" disabled={locked} onClick={props.onRetry}>现在再练一下</button>}
                {props.onContinue&&<button className="paper-reading-primary" type="button" disabled={state.saving||Boolean(state.error)} onClick={props.onContinue}>继续</button>}
            </div>}
            {attempt?.purpose!=='first'&&workspace!.attempts[0]?.submission&&<details><summary>查看首轮回答</summary>{props.renderText(workspace!.attempts[0].submission!.answer)}</details>}
            {state.cloud==='pending'&&<button type="button" disabled={locked} onClick={props.onSync}>恢复账号同步</button>}
            {props.formalReview&&<div className="paper-reading-formal-review" inert={locked||undefined}>{props.formalReview}</div>}
        </>}
    </section>;
}
