'use client';
import {registerStudyNavigationGuard} from '../study-navigation-guard';
import {StudyGuidance} from '../study-guidance';
import {useReportStudyAIItem} from '../ai/use-report-study-ai-item';
import { useState, useRef, useEffect } from "react";
import {CodeEditor} from '../components/code-editor';
import {useLearningDraftState} from '../learning-draft';
import {useAssistance,useAssistanceDisplay} from '../assistance-display';
import { StudyPlugin, PluginRenderProps } from "./registry";
import { usePyodide } from "../hooks/use-pyodide";
import {CodeRewriteLauncher} from '../../src/features/remediation';
import {codeRunFailure,formatCodeFailureFeedback} from '../../src/domain/remediation';
import type {NonWordOutcome} from '../../src/application/nonword-study';
import {MathText} from '../math-text';
import type {CodeLearningSupportV1} from '../../src/domain/content';
import {normalizeCodeRunReport,type CodeRunReportV1,type CodeRunIdentity} from '../../src/domain/code-execution';
import {CodeCaseFeedback} from '../../src/features/code-study';
import {LearningText} from '../../src/features/nonword-study';

export type CodeChallengeData = {
  topic: string;
  prompt: string;
  initialCode: string;
  testCode: string;
  solutionCode: string;
  explanation: string;
  learningSupport?:CodeLearningSupportV1;
};

export const CodePlugin: StudyPlugin<CodeChallengeData> = {
  id: "@zhixue/plugin-code",
  name: "实战编程题 (LeetCode Mode)",
  description: "提供一个类似于力扣的编程沙箱环境，用户必须编写通过所有断言测试的代码才能通关。",
  renderUI: function CodeUI({ data, onGrade, context }: PluginRenderProps<CodeChallengeData>) {
    const lifecycle=context?.nonWordLearning;
    const assistance=useAssistance(context?.draft);
    const [code, setCode] = useLearningDraftState(context?.draft,'code',data.initialCode || "");
    const [codeState, setCodeState] = useLearningDraftState<"coding" | "passed" | "gave_up">(context?.draft,'codeState',"coding");
    const [testOutput, setTestOutput] = useLearningDraftState<string>(context?.draft,'testOutput',"");
    const [testOutputId,setTestOutputId]=useLearningDraftState<string|null>(context?.draft,'testOutputId',null);
    const [isTesting, setIsTesting] = useState(false);
    const [failedOnce, setFailedOnce] = useLearningDraftState(context?.draft,'failedOnce',false);
    const [firstOutput,setFirstOutput]=useLearningDraftState(context?.draft,'firstTestOutput','');
    const [firstCode,setFirstCode]=useLearningDraftState(context?.draft,'firstTestCode','');
    const [firstRunKind,setFirstRunKind]=useLearningDraftState<'not-run'|'pending'|'incorrect'|'correct'|'forgotten'>(context?.draft,'firstRunKind',lifecycle?.submitted?'pending':'not-run');
    const [firstNeedsReview,setFirstNeedsReview]=useLearningDraftState(context?.draft,'firstNeedsReview',false);
    const [flowError,setFlowError]=useState('');
    const [executionReport,setExecutionReport]=useState<CodeRunReportV1|null>(null);
    const nonWordRunLock=useRef(false);
    const nonWordContinued=useRef(false);
    const [rewriting,setRewriting]=useState(false);
    const { isReady, error:runtimeError, runPython, retry:retryRuntime,cancel } = usePyodide();
    const [stdin,setStdin]=useLearningDraftState(context?.draft,'stdin','');
    const [panel,setPanel]=useState<'tests'|'input'|'result'>('tests');
    const [resultKind,setResultKind]=useLearningDraftState(context?.draft,'resultKind','');
    const [elapsed,setElapsed]=useLearningDraftState<number|null>(context?.draft,'elapsed',null);
    const runEpoch=useRef(0);useEffect(()=>()=>{runEpoch.current++;},[]);
    useEffect(()=>{let active=true;void lifecycle?.practice?.codeFeedback().then(saved=>{
      if(!active||!saved.latest)return;
      setExecutionReport(saved.latest);if(saved.output!==undefined)setTestOutput(saved.output);
      setPanel('result');setResultKind(saved.latest.status==='passed'?'passed':saved.latest.outcome==='student-error'?'failed':saved.latest.outcome);
      setCodeState(saved.latest.status==='passed'?'passed':'coding');
      if(saved.firstState){setFirstRunKind(saved.firstState.status);setFirstNeedsReview(saved.firstState.status==='pending');setFirstOutput(saved.firstState.explanation);}
    }).catch(()=>{});return()=>{active=false;};},[lifecycle?.practice,setTestOutput,setCodeState,setFirstRunKind,setFirstNeedsReview,setResultKind]);
    useReportStudyAIItem(context,{question:data.prompt,code,errors:[...(runtimeError?[String(runtimeError)]:[]),...(testOutput?[`上次运行输出（当前代码可能已编辑）：${testOutput}`]:[])]});
    useAssistanceDisplay(assistance,'reference-answer','code-reference',codeState==='gave_up'&&Boolean((data.solutionCode||data.explanation||'').trim()));
    useAssistanceDisplay(assistance,'answer-feedback',testOutputId,Boolean(testOutput)&&!isTesting);

    const handleRunTests = async (mode:'tests'|'trial'='tests') => {
      if (!isReady||isTesting||codeState==='passed'||(mode==='tests'&&!data.testCode?.trim())) return;
      if(mode==='tests')assistance?.submit();
      const epoch=++runEpoch.current,started=performance.now();
      setIsTesting(true);
      setPanel('result');setResultKind('running');setElapsed(null);
      setTestOutput(mode==='tests'?'正在运行题目测试…':'正在试运行，不计入通关…');
      
      try {
        const { output,result,assertionsPassed } = await runPython(code, true,mode==='trial'?stdin:'',mode==='tests'?data.testCode:undefined);
        if(epoch!==runEpoch.current)return;
        if(mode==='tests'&&(!Number.isSafeInteger(assertionsPassed)||!assertionsPassed||assertionsPassed<1))throw Object.assign(new Error('题目测试没有执行有效断言，不能自动判定通过。'),{name:'RuntimeError',testDefinitionError:true});
        
        setTestOutput((mode==='tests'?`通过题目提供的 ${assertionsPassed} 项公开断言；这些结果只覆盖本次测试。\n`:'')+(output || (result!==undefined&&result!==null?String(result):mode==='tests'?'题目提供的测试已通过。':'试运行结束，无输出。')));
        setTestOutputId(crypto.randomUUID());
        setResultKind(mode==='tests'?'passed':'trial');
        if(mode==='tests'&&!firstOutput){setFirstCode(code);setFirstOutput(`通过 ${assertionsPassed} 项公开断言。\n${output||''}`);}
        if(mode==='tests')setCodeState("passed");
      } catch (error: unknown) {
        if(epoch!==runEpoch.current)return;
        const diagnosis=codeRunFailure(error);
        if(mode==='tests'&&diagnosis.kind==='student-error')setFailedOnce(true);
        setResultKind(diagnosis.kind==='student-error'?'failed':diagnosis.kind);
        setTestOutputId(crypto.randomUUID());
        const errStr = error instanceof Error ? error.message : String(error);
        if(mode==='tests'&&!firstOutput){setFirstCode(code);setFirstOutput(errStr);}
        if(diagnosis.kind==='cancelled'||diagnosis.kind==='timeout'){
          setTestOutput(errStr);
        }else if (errStr.includes("AssertionError") || errStr.includes("assert")) {
          setTestOutput("❌ 测试失败:\n" + errStr);
        } else {
          setTestOutput("❌ 运行报错:\n" + errStr);
        }
      } finally {
        if(epoch===runEpoch.current){setElapsed(Math.round(performance.now()-started));setIsTesting(false);}
      }
    };

    const handleGiveUp = () => {
      if(isTesting)return;
      setFailedOnce(true);
      setCodeState("gave_up");
    };

    const handleNext = () => {
      if(isTesting||codeState==='coding')return;
      if (failedOnce || codeState === "gave_up") {
        onGrade("again");
      } else {
        onGrade("good");
      }
    };

    const handleNonWordRunTests = async (mode:'tests'|'trial'='tests') => {
      if(mode==='trial'){await handleRunTests(mode);return;}
      if(!lifecycle?.ready||!isReady||isTesting||nonWordRunLock.current||context?.draft?.isPending?.()||(!data.testCode?.trim()&&!data.learningSupport))return;
      if(lifecycle.purpose==='first'&&['incorrect','forgotten'].includes(firstRunKind)&&!context?.draft?.hasSavedFeedback?.()){
        setFlowError('首轮结果尚未取得保存回执。请先重试保存，再补练。');return;
      }
      nonWordRunLock.current=true;
      const epoch=++runEpoch.current,started=performance.now(),submittedCode=code;
      const firstSnapshot=firstRunKind==='not-run'?submittedCode:firstCode;
      const resolvesFirst=['not-run','pending'].includes(firstRunKind)&&submittedCode===firstSnapshot;
      setIsTesting(true);setFlowError('');setPanel('result');setResultKind('running');setElapsed(null);
      try{
        if(firstRunKind==='not-run'){
          assistance?.submit();await lifecycle.submit(submittedCode);
          if(epoch!==runEpoch.current)return;
          setFirstCode(submittedCode);setFirstRunKind('pending');setFirstNeedsReview(true);
        }
        let outcome:NonWordOutcome,details:string,kind:string,executionIdentity:CodeRunIdentity|undefined;
        try{
          executionIdentity=await lifecycle.prepareExecution?.(submittedCode);
          const result=await runPython(submittedCode,true,'',data.learningSupport?undefined:data.testCode,
            {...(executionIdentity?{identity:executionIdentity}:{}),...(data.learningSupport?{tests:data.learningSupport}:{})});
          if(epoch!==runEpoch.current)return;
          if(executionIdentity&&(!result.report?.identity||Object.keys(executionIdentity).some(key=>result.report!.identity![key as keyof CodeRunIdentity]!==executionIdentity![key as keyof CodeRunIdentity])))throw Object.assign(new Error('当前运行环境未提供匹配的核对证据，原代码保留待核对。'),{name:'RuntimeError'});
          if(result.report){await lifecycle.recordExecutionReport?.(result.report,result.output);setExecutionReport(result.report);}
          if(!Number.isSafeInteger(result.assertionsPassed)||!result.assertionsPassed||result.assertionsPassed<1)
            throw Object.assign(new Error('题目测试没有执行有效断言，不能自动判定通过。'),{name:'RuntimeError',testDefinitionError:true});
          details=`通过题目提供的 ${result.assertionsPassed} 项公开断言；这些结果只覆盖本次测试。\n${result.output||''}`;
          kind='passed';outcome={status:'correct',source:'deterministic',rating:'good',explanation:`本次通过 ${result.assertionsPassed} 项公开断言，只覆盖这些测试。`};
        }catch(error){
          if(epoch!==runEpoch.current)return;
          const report=normalizeCodeRunReport((error as {report?:unknown})?.report);
          const compatible=!executionIdentity||Boolean(report?.identity&&Object.keys(executionIdentity).every(key=>report.identity![key as keyof CodeRunIdentity]===executionIdentity![key as keyof CodeRunIdentity]));
          const diagnosis=compatible?codeRunFailure(error):{kind:'unknown',message:'执行证据未匹配当前保存的代码，原答案保留待核对。',details:'运行证据已过期或身份不匹配，原代码保留待核对。'};
          if(report&&compatible){await lifecycle.recordExecutionReport?.(report,diagnosis.details);setExecutionReport(report);}
          kind=diagnosis.kind==='student-error'?'failed':diagnosis.kind;details=diagnosis.details;
          const concrete=formatCodeFailureFeedback(compatible?error:{message:diagnosis.message},{testCode:data.testCode});
          outcome={status:diagnosis.kind==='student-error'?'incorrect':'undetermined',source:'deterministic',explanation:`${diagnosis.message}\n${concrete.summary}`,
            ...(diagnosis.kind==='student-error'?{rating:'again' as const}:{})};
        }
        if(resolvesFirst){
          if(outcome.status==='undetermined')await lifecycle.waitForReview(outcome.explanation);
          else await lifecycle.assess(outcome);
          if(epoch!==runEpoch.current)return;
          setFirstRunKind(outcome.status==='undetermined'?'pending':outcome.status==='correct'?'correct':'incorrect');
          setFirstNeedsReview(outcome.status==='undetermined');setFirstOutput(outcome.explanation);
          if(outcome.status==='incorrect')setFailedOnce(true);
        }else{
          if(!lifecycle.recordRemediation)throw Error('当前入口未提供补练保存，首轮结果已保留。');
          await lifecycle.recordRemediation(submittedCode,outcome);
          if(epoch!==runEpoch.current)return;
        }
        setTestOutput(details);setTestOutputId(crypto.randomUUID());setResultKind(kind);
        setCodeState(outcome.status==='correct'?'passed':'coding');
        if(resolvesFirst&&outcome.status==='incorrect'&&lifecycle.purpose==='first')await onGrade('again',{deferAdvance:true});
      }catch(reason){if(epoch===runEpoch.current){setResultKind('save-error');setFlowError(reason instanceof Error?reason.message:'答案尚未可靠保存。');}}
      finally{if(epoch===runEpoch.current){setElapsed(Math.round(performance.now()-started));setIsTesting(false);}nonWordRunLock.current=false;}
    };

    const handleNonWordGiveUp = async () => {
      if(!lifecycle?.ready||isTesting||nonWordRunLock.current||context?.draft?.isPending?.())return;
      nonWordRunLock.current=true;setFlowError('');const epoch=++runEpoch.current;
      try{
        if(firstRunKind==='not-run'){
          assistance?.submit();await lifecycle.submit(code);
          if(epoch!==runEpoch.current)return;
          await lifecycle.assess({status:'incorrect',source:'self-assess',rating:'again',explanation:'尚未独立完成，主动查看参考解答。'});
          if(epoch!==runEpoch.current)return;
          setFirstCode(code);setFirstRunKind('forgotten');setFirstNeedsReview(false);setFailedOnce(true);
          if(lifecycle.purpose==='first')await onGrade('again',{deferAdvance:true});
        }
        if(epoch===runEpoch.current)setCodeState('gave_up');
      }catch(reason){if(epoch===runEpoch.current)setFlowError(reason instanceof Error?reason.message:'答案尚未可靠保存。');}
      finally{nonWordRunLock.current=false;}
    };

    const handleNonWordNext = async () => {
      if(!lifecycle?.ready||isTesting||nonWordRunLock.current||context?.draft?.isPending?.()||nonWordContinued.current)return;
      nonWordRunLock.current=true;setFlowError('');
      try{
        if(lifecycle.purpose==='remediation'){await lifecycle.finishRemediation?.();nonWordContinued.current=true;return;}
        if(firstNeedsReview||firstRunKind==='pending'){await lifecycle.continuePending();nonWordContinued.current=true;return;}
        if(context?.draft?.hasSavedFeedback?.()){nonWordContinued.current=context.draft.continueAfterFeedback?.()===true;return;}
        if(firstRunKind==='correct'){await onGrade('good');nonWordContinued.current=true;}
        else if(firstRunKind==='incorrect'||firstRunKind==='forgotten')await onGrade('again',{deferAdvance:true});
      }catch(reason){setFlowError(reason instanceof Error?reason.message:'继续前的保存尚未完成。');}
      finally{nonWordRunLock.current=false;}
    };

    const handleStartRemediation = async () => {
      if(!lifecycle?.ready||isTesting||nonWordRunLock.current||context?.draft?.isPending?.())return;
      nonWordRunLock.current=true;setFlowError('');
      try{
        if(!firstNeedsReview&&!context?.draft?.hasSavedFeedback?.())throw Error('请先保存首轮结果，再开始补练。');
        if(!lifecycle.startRemediation)throw Error('当前入口暂未提供内联补练，原答案已保留。');
        await lifecycle.startRemediation();
      }catch(reason){setFlowError(reason instanceof Error?reason.message:'补练尚未开始。');}
      finally{nonWordRunLock.current=false;}
    };

    const diagnostic=lifecycle&&['failed','unknown','test-error','environment-error'].includes(resultKind)&&testOutput
      ?formatCodeFailureFeedback({message:testOutput,...(executionReport?{report:executionReport}:{})},{testCode:data.testCode}):null;
    const currentFault=diagnostic&&(diagnostic.exception||diagnostic.location)?diagnostic.summary:null;
    const showFirstFault=lifecycle&&firstOutput&&['incorrect','pending'].includes(firstRunKind)
      &&!(panel==='result'&&currentFault&&firstOutput.includes(currentFault));
    const sourceItem=context?.nonWordScope?.courseReference?.item;
    const sourceLabel=sourceItem?.kind==='practice'?sourceItem.practice.sourceLabel:undefined;
    return (
      <div data-study-activity="code" className="study-activity study-code w-full max-w-5xl mx-auto">
        {/* Left Column: Problem & Test Cases & Environment */}
        <div className="study-code-sidebar flex flex-col gap-4">
          <div className="study-card study-code-prompt p-5 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">题目</h3>
              {data.topic && (
                <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                  {data.topic}
                </span>
              )}
            </div>
            {lifecycle?<LearningText className="text-zinc-800 dark:text-zinc-100 font-medium text-base mb-4" text={data.prompt||''} renderMath={text=><MathText text={text}/>}/>:
              <p className="text-zinc-800 dark:text-zinc-100 font-medium text-base mb-4 leading-relaxed whitespace-pre-wrap break-words">{data.prompt||''}</p>}
            <StudyGuidance topic="code" context={context} engaged={isTesting||codeState!=='coding'}/>
            {lifecycle&&sourceLabel&&sourceLabel!==data.topic&&<p className="study-meta">{sourceLabel}</p>}
          </div>

          {runtimeError && (
            <div className="study-feedback p-5 border border-red-200 dark:border-red-900/60 rounded-xl bg-red-50/50 dark:bg-red-950/20">
              <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-bold mb-1">
                <span>{resultKind==='cancelled'||resultKind==='timeout'?'⏹':'❌'}</span><span>{resultKind==='cancelled'||resultKind==='timeout'?'运行环境已停止':'环境准备失败'}</span>
              </div>
              <p role="status" className="text-xs text-zinc-600 dark:text-zinc-400 mb-3">
                {resultKind==='cancelled'||resultKind==='timeout'?'重新加载后可以继续运行，代码与输入仍保留。':'请检查网络或稍后重试。当前输入仍在，尚未判定作答。'}
              </p>
              <button type="button" className="study-secondary-action w-full" onClick={retryRuntime}>
                重试加载环境
              </button>
              <details className="mt-2 text-xs">
                <summary className="text-zinc-500 cursor-pointer">查看加载详情</summary>
                <p className="mt-1 font-mono text-[11px] text-zinc-500 break-all">{runtimeError}</p>
              </details>
            </div>
          )}
        </div>

        {/* Right Column: Code Editor & Action Buttons & Output */}
        <div className="study-code-main flex flex-col gap-4">
          <div className="study-code-editor w-full flex flex-col overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-[#161b22]">
            {/* Title bar */}
            <div className="flex items-center justify-between px-4 py-3 bg-[#1A1D24] border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-zinc-200">代码编辑器</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono font-medium text-zinc-400 px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/50">Python 3</span>
              </div>
            </div>

            <CodeEditor value={code} onChange={setCode} readOnly={isTesting||(lifecycle?firstRunKind==='correct':codeState!=='coding')}/>
          </div>
          {/* Action Buttons Row */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={()=>lifecycle?handleNonWordRunTests():handleRunTests()}
              disabled={!isReady || isTesting || (lifecycle?!lifecycle.ready||firstRunKind==='correct':codeState==='passed') || (!data.testCode?.trim()&&!data.learningSupport)}
              className="study-primary-action flex-1 min-h-[48px] px-6 py-2.5 hover:brightness-105 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-sm"
            >
              <span>▶</span>
              <span>{runtimeError ? '需重新加载环境' : isTesting ? "正在运行…" : !isReady ? "正在准备环境…" : "运行测试"}</span>
            </button>
            {codeState === "coding" && (
              <button 
                type="button"
                disabled={isTesting||Boolean(lifecycle&&!lifecycle.ready)} onClick={lifecycle?handleNonWordGiveUp:handleGiveUp}
                className="min-h-[48px] px-5 py-2.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/60 rounded-xl font-bold text-sm flex items-center justify-center gap-1.5 transition-all shadow-sm"
              >
                <span>📖</span>
                <span>查看题解</span>
              </button>
            )}
          </div>

          <section className="study-card study-code-output p-4 border border-zinc-200 dark:border-zinc-800 rounded-xl bg-white dark:bg-zinc-900" aria-label="测试与运行">
            <div className="flex gap-2 flex-wrap mb-4" role="group" aria-label="切换测试内容">
              {([['tests','题目测试'],['input','自定义输入'],['result','运行结果']] as const).map(([id,label])=><button key={id} type="button" aria-pressed={panel===id} onClick={()=>setPanel(id)} className={`px-3 py-2 rounded border text-sm ${panel===id?'border-[var(--orange)] font-bold':'border-zinc-300 dark:border-zinc-700'}`}>{label}</button>)}
            </div>
            {panel==='tests'&&<>{data.learningSupport?<div className="space-y-3">{data.learningSupport.cases.map(test=><div key={test.id} className="text-sm"><p className="font-mono break-words">函数：{test.functionName} · 输入：{JSON.stringify(test.args)}{test.kwargs&&Object.keys(test.kwargs).length?` · 命名参数：${JSON.stringify(test.kwargs)}`:''}</p><p className="font-mono break-words">预期：{JSON.stringify(test.expected)}</p></div>)}</div>:<pre className="text-xs whitespace-pre-wrap break-words p-3 bg-zinc-50 dark:bg-zinc-950 rounded">{data.testCode?.trim()||'尚未提供有效测试，只能试运行。'}</pre>}</>}
            {panel==='input'&&<><label htmlFor="code-stdin" className="text-sm">标准输入（每行一项，最多 10000 字）</label><textarea id="code-stdin" value={stdin} maxLength={10000} onChange={event=>setStdin(event.target.value)} readOnly={isTesting} rows={4} className="w-full border border-zinc-300 dark:border-zinc-700 rounded p-3 font-mono text-sm bg-transparent mt-2"/><p className="text-xs text-zinc-500 mt-2">只运行你的代码；这里的输入不改变题目测试，也不生成通关记录。</p></>}
            {panel==='result'&&<div role="status"><p className="text-sm font-bold mb-2">{{running:'正在运行',passed:'题目测试通过',trial:'试运行完成（未判通关）',cancelled:'已停止',timeout:'运行超时',failed:'程序或断言未通过',unknown:'执行结果未知 · 未能判定','test-error':'题目测试异常 · 未能判定','environment-error':'执行环境异常 · 未能判定','save-error':'保存尚未完成'}[resultKind]||'尚未运行'}{elapsed!==null?` · ${elapsed} ms`:''}</p>{currentFault?<p className="whitespace-pre-wrap break-words">{currentFault}</p>:lifecycle&&resultKind==='failed'?<p>程序或公开断言未通过，首轮结果保持不变。</p>:null}{lifecycle?<details><summary>查看运行详情</summary><pre className="text-sm whitespace-pre-wrap break-words max-h-72 overflow-auto">{testOutput||'运行后在这里查看结果。'}</pre></details>:<pre className="text-sm whitespace-pre-wrap break-words max-h-72 overflow-auto">{testOutput||'运行后在这里查看结果。'}</pre>}</div>}
            <div className="flex gap-3 flex-wrap mt-4">
              <button type="button" disabled={!isReady||isTesting||codeState==='passed'} onClick={()=>lifecycle?handleNonWordRunTests('trial'):handleRunTests('trial')} className="study-secondary-action disabled:opacity-50">试运行当前代码</button>
              {isTesting&&<button type="button" onClick={cancel} className="study-secondary-action">停止运行</button>}
            </div>
          </section>
          {lifecycle&&<CodeCaseFeedback key={JSON.stringify(executionReport)} report={executionReport} practice={lifecycle.practice}
            requestHint={executionReport&&lifecycle.practice?.requestCodeHint?()=>lifecycle.practice!.requestCodeHint!(executionReport):undefined}/>}
          {/* Outcome & Explanation */}
          {flowError&&<p role="alert">{flowError}</p>}
          {showFirstFault&&<details><summary>{firstRunKind==='pending'?'首轮待核对':'首轮未通过'}</summary><LearningText text={firstOutput} renderMath={text=><MathText text={text}/>}/></details>}
          {(codeState === "passed" || codeState === "gave_up" || lifecycle&&firstRunKind!=='not-run'&&!isTesting) && (
            <div className="p-6 bg-white dark:bg-[#13151A] rounded-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col gap-4">
              {codeState === "gave_up" && !rewriting && (
                <div className="p-4 rounded-xl bg-zinc-50 dark:bg-[#0D0E12] border border-zinc-200 dark:border-zinc-800">
                  <span className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2 block">参考解答 (Solution)</span>
                  <pre className="text-sm font-mono text-zinc-800 dark:text-zinc-300 overflow-x-auto">
                    <code>{data.solutionCode || "暂无参考解答"}</code>
                  </pre>
                </div>
              )}
              {!lifecycle&&codeState==='gave_up'&&<CodeRewriteLauncher registerGuard={registerStudyNavigationGuard} binding={JSON.stringify([data.prompt,data.initialCode,data.testCode])} initialCode={data.initialCode} originalCode={firstOutput?firstCode:code} originalOutput={firstOutput||testOutput} firstResultKnown={Boolean(firstOutput)} testCode={data.testCode||''} createDraft={context?.draft?.createTemporary} onOpenChange={setRewriting} runner={{ready:isReady,error:runtimeError,run:(next,input,tests)=>runPython(next,true,input,tests),retry:retryRuntime,cancel}} renderEditor={props=><CodeEditor {...props}/>}/>}
              {lifecycle?.purpose==='first'&&firstRunKind!=='correct'&&<button type="button" className="study-secondary-action" disabled={isTesting||!lifecycle.ready} onClick={handleStartRemediation}>收起解释，再写一次</button>}
              {lifecycle&&firstNeedsReview&&<p role="status">首轮代码仍待核对；修改后的公开测试结果属于补练，不改变原作答。</p>}
              {lifecycle?.purpose==='remediation'&&<p role="status">这是辅助补练，原题和首轮结果保持不变。</p>}
              {data.explanation && !rewriting && (lifecycle?<details><summary>查看解析</summary><LearningText text={data.explanation} renderMath={text=><MathText text={text}/>}/></details>:
                <div>
                  <h3 className="text-base font-bold text-zinc-900 dark:text-white mb-2 flex items-center gap-2">
                    <span>🧠</span> 知识点解析
                  </h3>
                  <p className="text-zinc-600 dark:text-zinc-400 text-sm leading-relaxed">
                    {data.explanation}
                  </p>
                </div>
              )}
              {lifecycle?.purpose==='guided'?<p role="status">引导测试反馈已保留；请收起讲解后进入独立尝试。</p>:<button
                onClick={lifecycle?handleNonWordNext:handleNext}
                className="study-primary-action w-full min-h-[46px] rounded-xl font-bold"
              >
                {lifecycle?.purpose==='remediation'?'结束补练，继续':lifecycle&&firstNeedsReview?'保留待核对结果，继续':'继续'}
              </button>}
            </div>
          )}
        </div>
      </div>
    );
  }
};
