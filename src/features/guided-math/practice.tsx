'use client';
import {useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createGuidedMathSession,createMathExposureLedger,mathDraftFields,type GuidedMathSession} from '../../application/guided-math';
import {createTemporaryDraft,type TemporaryDraft} from '../../application/temporary-practice';
import {MATH_TEMPLATES,mathFingerprint,type MathDefinition,type Choice} from '../../domain/guided-math';
import {TemporaryDialog,type LeaveGuardPort,type TemporaryFactory} from '../remediation';

type Source={key:string;contentHash?:string;title:string;snapshot:string};
type OpenSession={draft:TemporaryDraft;session:GuidedMathSession};
type Props={source:Source;scope:string;createDraft?:TemporaryFactory;registerGuard?:LeaveGuardPort;disabled?:boolean};
export function MathPracticeLauncher(props:Props){
    const [opened,setOpened]=useState<OpenSession|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
    const signature=JSON.stringify([props.scope,props.source]),current=useRef(signature),alive=useRef(true),preparing=useRef(false);
    // A source change creates a separate exposure scope, while closing a dialog does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const exposure=useMemo(()=>createMathExposureLedger(),[signature]);
    useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
    useLayoutEffect(()=>{
        current.current=signature;
        if(opened&&!opened.draft.isActive()){opened.session.dispose();opened.draft.dispose();}
    },[signature,opened]);
    const open=async()=>{
        if(props.disabled||preparing.current||opened)return;
        preparing.current=true;setBusy(true);setNotice('');
        try{
            const parentContentHash=props.source.contentHash||await mathFingerprint(props.source.snapshot);
            if(!alive.current||current.current!==signature)return;
            const owned=props.createDraft?props.createDraft({...mathDraftFields}):createTemporaryDraft({initial:{...mathDraftFields},binding:signature});
            if(!owned){setNotice('原作答正在保存或来源已变化，请稍后重试。');return;}
            const draft:TemporaryDraft={...owned,isActive:()=>alive.current&&current.current===signature&&owned.isActive()};
            const session=createGuidedMathSession(draft,{parentItemKey:props.source.key,parentContentHash,hashKind:props.source.contentHash?'content':'visible-snapshot'},undefined,exposure);
            setOpened({draft,session});
        }catch{if(alive.current)setNotice('暂时无法准备练习，仍可从原反馈继续。');}
        finally{preparing.current=false;if(alive.current)setBusy(false);}
    };
    return <section className="study-remedy-entry">
        <button type="button" className="study-secondary-action" disabled={props.disabled||busy} onClick={()=>void open()}>{busy?'正在准备入口…':'换条件练习与数学步骤'}</button>
        <p className="study-meta">选择相关的基础代数模板。仅在本页练习，不新增成绩或每日任务。</p>
        {notice&&<p role="status">{notice}</p>}
        {opened&&<MathPractice {...opened} source={props.source} registerGuard={props.registerGuard} onClose={()=>setOpened(null)}/>}
    </section>;
}
function ChoiceInput({name,value,choices,onChange}:{name:string;value:string;choices:readonly Choice[];onChange:(value:string)=>void}){
    return <label>{name}<select aria-label={name} value={value} onChange={event=>onChange(event.target.value)}><option value="">请选择</option>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label>;
}
function StepInputs({rule,draft,session}:{rule:MathDefinition;draft:TemporaryDraft;session:GuidedMathSession}){
    return <div className="guided-math-steps">
        <p>只核对本题的三个检查项，不自动证明任意解题过程。</p>
        <ChoiceInput name="采用的方法" value={draft.read('method')} choices={rule.methods} onChange={value=>session.edit('method',value)}/>
        <ChoiceInput name="适用条件" value={draft.read('condition')} choices={rule.conditions} onChange={value=>session.edit('condition',value)}/>
        <label>{rule.transformationPrompt}<input aria-label="局部变形" value={draft.read('transformation')} maxLength={512} onChange={event=>session.edit('transformation',event.target.value)}/></label>
        <p className="study-meta">乘法请写 *，乘方请写 ^。不支持的写法会显示无法判定。</p>
    </div>;
}
function MathPractice({draft,session,source,registerGuard,onClose}:OpenSession&{source:Source;registerGuard?:LeaveGuardPort;onClose:()=>void}){
    useSyncExternalStore(session.subscribe,session.getSnapshot,()=>0);
    useSyncExternalStore(draft.subscribe,draft.getSnapshot,()=>0);
    const state=session.snapshot(),variant=state.variant,rule=variant?.definition;
    const labels={correct:'与本题规则一致',wrong:'需要再核对',unknown:'暂时无法判定'};
    const chooseTemplate=(value:string)=>{session.edit('templateId',value);session.edit('approved','');};
    return <TemporaryDialog draft={draft} title="换条件练习" registerGuard={registerGuard} onStop={session.dispose} onClose={onClose}>
        <p className="guided-math-source">关联原题：{source.title}</p>
        {!variant?<fieldset className="guided-math-setup" disabled={state.phase==='preparing'}>
            <ChoiceInput name="练习模板" value={draft.read('templateId')} choices={MATH_TEMPLATES.map(template=>({id:template.id,label:template.title}))} onChange={chooseTemplate}/>
            <p>{MATH_TEMPLATES.find(template=>template.id===draft.read('templateId'))?.purpose}</p>
            <label>题目编号<input aria-label="题目编号" inputMode="numeric" maxLength={10} value={draft.read('seed')} onChange={event=>{session.edit('seed',event.target.value);session.edit('approved','');}}/></label>
            <p className="study-meta">同一模板和编号可重现同一道题。模板与原题是否相关，由你核对。</p>
            <label className="study-temporary-check"><input type="checkbox" checked={draft.read('approved')==='yes'} onChange={event=>session.edit('approved',event.target.checked?'yes':'')}/>我确认练习目标与原题相关，并会核对给定条件</label>
            <button type="button" className="study-primary-action" disabled={draft.read('approved')!=='yes'} onClick={()=>void session.prepare()}>准备这道练习</button>
        </fieldset>:rule&&<>
            <h3 className="guided-math-question">{rule.prompt}</h3>
            <p className="guided-math-domain">已知条件：{rule.domain}</p>
            <ChoiceInput name="结论类型" value={draft.read('answerKind')} choices={variant.templateId==='cancel-domain'?[{id:'allowed',label:'允许直接同除'},{id:'not-allowed',label:'不能直接同除'}]:[{id:'number',label:'有唯一数值结果'},{id:'none',label:'无解 / 条件矛盾'},{id:'all',label:'不能唯一确定（任意实数均符合）'}]} onChange={value=>session.edit('answerKind',value)}/>
            {draft.read('answerKind')==='number'&&<><label>最终结果<input aria-label="变式最终结果" value={draft.read('answer')} maxLength={512} onChange={event=>session.edit('answer',event.target.value)}/></label><p className="study-meta">按精确值核对；分数可写成 7/2，也可输入等价表达式。</p></>}
            <details className="guided-math-disclosure" onToggle={event=>{if(event.currentTarget.open&&!state.stepsVisible)session.showSteps();}}><summary>需要帮助？写出关键步骤</summary>{state.stepsVisible&&<StepInputs rule={rule} draft={draft} session={session}/>}</details>
            <p className="study-meta">{state.assisted?'本页已使用步骤或反馈辅助；不能据此宣称独立掌握。':'当前只核对最终结果；步骤可以跳过。'}</p>
            <button type="button" className="study-primary-action" onClick={session.check}>核对本次练习</button>
            {state.result&&<section className="guided-math-result" aria-label="变式核对结果">
                <p data-math-verdict={state.result.final.verdict}><strong>最终结果：{labels[state.result.final.verdict]}</strong></p>
                <p>{state.result.final.explanation}</p>
                {state.result.steps?<><p><strong>所填步骤：{labels[state.result.steps.verdict]}</strong></p>{(['method','condition','transformation'] as const).map((field,index)=><p key={field}>{['方法','条件','局部变形'][index]}：{labels[state.result!.steps![field].verdict]}。{state.result!.steps![field].explanation}</p>)}</>:<p>未核对解题过程；结果一致不证明每一步都正确。</p>}
                <details onToggle={event=>{if(event.currentTarget.open)session.showReference();}}><summary>对照本题规则与参考</summary><p>{rule.reference}</p></details>
                <button type="button" className="study-secondary-action" onClick={session.acknowledge}>已核对本次结果</button>
            </section>}
            <details className="guided-math-identity"><summary>题目来源与复现信息</summary><p>{variant.parent.hashKind==='content'?'父题内容版本':'父题可见材料快照'}：{variant.parent.parentContentHash}</p><p>模板版本：{variant.templateVersion}；题目编号：{variant.seed}；题族：{variant.familyKey}</p><p>实例：{variant.variantHash}</p></details>
            <button type="button" className="study-secondary-action" onClick={()=>{if(draft.hasUnsavedInput()&&!window.confirm('本页还有未确认输入，重新选择后不会保留。仍要继续吗？'))return;session.restart(true);}}>重新选择模板</button>
        </>}
        {state.phase==='preparing'&&<button type="button" className="study-secondary-action" onClick={session.cancel}>停止准备</button>}
        {state.notice&&<p role="status">{state.notice}</p>}
    </TemporaryDialog>;
}
