'use client';
import {registerStudyNavigationGuard} from '../study-navigation-guard';
import {StudyGuidance} from '../study-guidance';
import {useCallback,useEffect,useRef,useState} from 'react';
import {parseQuizSupport,gradeQuizSelection,mergeStemHighlight,QUIZ_TRAPS,type QuizSupport,type StemHighlight} from '../quiz-support';
import {useLearningDraftState} from '../learning-draft';
import {useAssistance,useAssistanceDisplay} from '../assistance-display';
import {useReportStudyAIItem} from '../ai/use-report-study-ai-item';
import {useStudyShortcuts} from '../use-study-shortcuts';
import {accountAiFailureMessage} from '../account-study-runtime';
import {MathText} from '../math-text';
import {TutorFollowUp} from './tutor-follow-up';
import type {PluginRenderProps} from './registry';
import {quizMistakes,sourceWorksheet} from '../../src/domain/remediation';
import {SourceReviewLauncher} from '../../src/features/remediation';

type Data={topic?:string;prompt:string;code?:string;explanation?:string;learningSupport:QuizSupport};
export function StructuredQuiz(props:PluginRenderProps<Data>){
 let support:QuizSupport;try{support=parseQuizSupport(props.data.learningSupport);}catch{return <p role="status">题目选项配置不可用，请更新来源材料后再练习。</p>;}
 return <StructuredQuizUI key={JSON.stringify([props.data.prompt,support])} {...props} support={support}/>;
}
function StructuredQuizUI({data,support,onGrade,context}:PluginRenderProps<Data>&{support:QuizSupport}){
 const root=useRef<HTMLDivElement>(null),stem=useRef<HTMLParagraphElement>(null);useStudyShortcuts(root);
 const assistance=useAssistance(context?.draft);
 const [selectedIds,setSelected]=useLearningDraftState<string[]>(context?.draft,'quizSelectedIds',[]);
 const [excluded,setExcluded]=useLearningDraftState<string[]>(context?.draft,'quizExcludedIds',[]);
 const [highlights,setHighlights]=useLearningDraftState<StemHighlight[]>(context?.draft,'quizStemHighlights',[]);
 const [submitted,setSubmitted]=useLearningDraftState(context?.draft,'quizSubmitted',false);
 const [feedbackId,setFeedbackId]=useLearningDraftState<string|null>(context?.draft,'quizFeedbackId',null);
 const [hint,setHint]=useLearningDraftState(context?.draft,'quizHint','');
 const [hintId,setHintId]=useLearningDraftState<string|null>(context?.draft,'quizHintId',null);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[graded,setGraded]=useState(false);
 const submittedRef=useRef(submitted),gradedRef=useRef(false),mounted=useRef(true),selectionRevision=useRef(0);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const correct=gradeQuizSelection(support,selectedIds);
 const mistakes=quizMistakes(support,selectedIds);
 const reference={...data,options:support.options.map(o=>o.text),answer:support.options.filter(o=>support.correctOptionIds.includes(o.optionId)).map(o=>o.text).join('\n')};
 useReportStudyAIItem(context,{question:[data.prompt,...support.options.map(o=>`${o.optionId}: ${o.text}`)].join('\n'),code:data.code,learnerAnswer:selectedIds.map(id=>`${id}: ${support.options.find(o=>o.optionId===id)?.text??''}`).join('\n'),errors:submitted&&!correct?['本次选项集合不完整或含错项']:[]});
 useAssistanceDisplay(assistance,'ai-hint',hintId,!submitted&&Boolean(hint.trim()));
 useAssistanceDisplay(assistance,'answer-feedback',feedbackId,submitted);
 const invalidateHint=()=>{selectionRevision.current++;setHint('');setHintId(null);setError('');};
 const toggle=(id:string)=>{if(submittedRef.current)return;invalidateHint();setExcluded(values=>values.filter(v=>v!==id));setSelected(values=>values.includes(id)?values.filter(v=>v!==id):support.selection==='single'?[id]:[...values,id]);};
 const exclude=(id:string)=>{if(submittedRef.current)return;invalidateHint();setSelected(values=>values.filter(v=>v!==id));setExcluded(values=>values.includes(id)?values.filter(v=>v!==id):[...values,id]);};
 const submit=()=>{if(submittedRef.current||!selectedIds.length)return;submittedRef.current=true;assistance?.submit();setFeedbackId(crypto.randomUUID());setSubmitted(true);};
 const finish=()=>{if(!submitted||gradedRef.current)return;gradedRef.current=true;setGraded(true);onGrade(correct?'good':'again');};
 const highlightSelection=useCallback(()=>{
   const element=stem.current,selection=window.getSelection();if(!element||!selection||selection.isCollapsed||selection.rangeCount!==1)return;
   const range=selection.getRangeAt(0);if(!element.contains(range.startContainer)||!element.contains(range.endContainer))return;
   const prefix=range.cloneRange();prefix.selectNodeContents(element);prefix.setEnd(range.startContainer,range.startOffset);
   const start=prefix.toString().length,end=start+range.toString().length;
   setHighlights(current=>mergeStemHighlight(current,{start,end},data.prompt.length));selection.removeAllRanges();
 },[data.prompt.length,setHighlights]);
 useEffect(()=>{const element=stem.current;if(!element)return;element.addEventListener('mouseup',highlightSelection);element.addEventListener('touchend',highlightSelection);return()=>{element.removeEventListener('mouseup',highlightSelection);element.removeEventListener('touchend',highlightSelection);};},[highlightSelection]);
 const requestHint=async()=>{if(loading||submittedRef.current)return;const revision=selectionRevision.current;setLoading(true);setError('');try{if(!context?.requestAiHint)throw Error('当前未连接 AI 提示。');const value=await context.requestAiHint(reference,selectedIds.join(', '));if(!mounted.current||submittedRef.current||revision!==selectionRevision.current)return;if(!value.trim())throw Error('AI 未返回提示，请重试。');setHint(value);setHintId(crypto.randomUUID());}catch(reason){if(mounted.current&&!submittedRef.current&&revision===selectionRevision.current)setError(accountAiFailureMessage(reason));}finally{if(mounted.current)setLoading(false);}};
 const fragments:React.ReactNode[]=[];let cursor=0;
 highlights.forEach((range,index)=>{fragments.push(data.prompt.slice(cursor,range.start));fragments.push(<button type="button" className="quiz-highlight" key={index} onClick={()=>setHighlights(values=>values.filter((_,i)=>i!==index))}><mark>{data.prompt.slice(range.start,range.end)}</mark></button>);cursor=range.end;});fragments.push(data.prompt.slice(cursor));
 return <div ref={root} data-study-shortcuts data-study-activity="quiz" className="study-activity study-quiz w-full max-w-3xl mx-auto"><StudyGuidance topic="quiz" context={context} engaged={submitted}/><div className="study-card">
   <div className="study-activity-eyebrow">{data.topic} · {support.selection==='multiple'?'多选题':'单选题'}</div>
   <p ref={stem} className="study-question quiz-stem">{fragments}</p>
   <div className="quiz-stem-tools"><button type="button" onClick={highlightSelection}>高亮选区</button>{highlights.length>0&&<button type="button" onClick={()=>setHighlights([])}>清除高亮</button>}</div>
   {data.code&&<pre className="quiz-source-code"><code>{data.code}</code></pre>}
   <div className="quiz-id-options" aria-label={support.selection==='multiple'?'选择所有正确选项':'选择一个选项'}>{support.options.map((option,index)=>{const chosen=selectedIds.includes(option.optionId),crossed=excluded.includes(option.optionId),right=support.correctOptionIds.includes(option.optionId);return <div className="quiz-id-option" key={option.optionId} data-result={submitted?(right?'correct':chosen?'wrong':'neutral'):undefined} data-excluded={crossed?'true':undefined}>
     <button type="button" className="study-choice quiz-option-select" aria-pressed={chosen} disabled={submitted} data-study-key={index<9?String(index+1):undefined} onClick={()=>toggle(option.optionId)}><span className="quiz-choice-symbol" aria-hidden="true">{submitted?(right?'✓':chosen?'×':''):chosen?'●':'○'}</span><span><small>{option.optionId}</small> {option.text}</span></button>
     {!submitted&&<button type="button" className="quiz-exclude" aria-pressed={crossed} aria-label={`${crossed?'取消排除':'排除'} ${option.optionId}`} onClick={()=>exclude(option.optionId)}>{crossed?'恢复':'排除'}</button>}
   </div>;})}</div>
   {!submitted?<>{support.selection==='multiple'&&<p className="quiz-selection-note">多选题 · 需选齐全部正确项</p>}<button type="button" className="study-primary-action" disabled={!selectedIds.length} onClick={submit}>提交答案</button>{context?.requestAiHint&&<button type="button" className="study-secondary-action" disabled={loading} onClick={()=>void requestHint()}>{loading?'正在获取提示…':'请求 AI 提示'}</button>}{hint&&<p className="study-feedback">{hint}</p>}{error&&<p role="status">{error}</p>}</>:<section className="quiz-result" aria-label="作答反馈"><h3>{correct?'回答正确':'这次需要复习'}</h3><p>正确选项：{support.correctOptionIds.join('、')}</p>{!correct&&<p role="status">错选：{mistakes.wrong.join('、')||'无'}；漏选：{mistakes.missing.join('、')||'无'}。</p>}{support.options.filter(o=>selectedIds.includes(o.optionId)&&!support.correctOptionIds.includes(o.optionId)&&(o.trapType||o.trapExplanation)).map(o=><div className="quiz-trap" key={o.optionId}><strong>{o.optionId} · {o.trapType?QUIZ_TRAPS[o.trapType]:'选项解析'}</strong>{o.trapExplanation&&<p>{o.trapExplanation}</p>}<small>材料提供的选项解析</small></div>)}{data.explanation&&<MathText text={data.explanation}/>}<TutorFollowUp askTutor={context?.askTutor} item={reference} compact draft={context?.draft}/>{!correct&&<SourceReviewLauncher registerGuard={registerStudyNavigationGuard} worksheet={sourceWorksheet({kind:'distinction',binding:JSON.stringify([data.prompt,support]),target:`错选 ${mistakes.wrong.join('、')||'无'}；漏选 ${mistakes.missing.join('、')||'无'}`,reference:[...support.options.filter(o=>mistakes.wrong.includes(o.optionId)&&o.trapExplanation).map(o=>o.trapExplanation),data.explanation,reference.answer].filter(Boolean).join('\n\n')})} createDraft={context?.draft?.createTemporary} label="对照材料解释错选与漏选（可跳过）"/>}<button type="button" className="study-primary-action" disabled={graded} onClick={finish}>{graded?'已提交':correct?'继续':'记为需复习并继续'}</button></section>}
 </div></div>;
}
