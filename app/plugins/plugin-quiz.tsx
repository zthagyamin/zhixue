'use client';
import {registerStudyNavigationGuard} from '../study-navigation-guard';
import {StudyGuidance} from '../study-guidance';
import {useReportStudyAIItem} from '../ai/use-report-study-ai-item';
import {StructuredQuiz} from './structured-quiz';
import type {QuizSupport} from '../quiz-support';
import { useState,useRef } from "react";
import {useStudyShortcuts} from '../use-study-shortcuts';
import {useLearningDraftState} from '../learning-draft';
import {useAssistance,useAssistanceDisplay} from '../assistance-display';
import { StudyPlugin, PluginRenderProps } from "./registry";
import { PythonPlayground } from "../components/python-playground";
import { MathText } from "../math-text";
import { TutorFollowUp } from "./tutor-follow-up";
import {accountAiFailureMessage} from '../account-study-runtime';
import {sourceWorksheet} from '../../src/domain/remediation';
import {SourceReviewLauncher} from '../../src/features/remediation';
import {NonWordQuiz} from '../../src/features/nonword-study';
import '../../src/features/nonword-study/study.css';
import type {NonWordQuizState} from '../../src/domain/content';

export type QuizData = {
  learningSupport?:QuizSupport;
  topic: string;
  prompt: string;
  code?: string;
  options: string[];
  answer: string;
  explanation: string;
};

const LegacyQuizPlugin: StudyPlugin<QuizData> = {
  id: "@zhixue/plugin-quiz",
  name: "单项选择题",
  description: "提供传统的单选答题体验，包含苏格拉底式 AI 启发和交互式沙箱辅助。",
  renderUI: function QuizUI({ data, onGrade, context }: PluginRenderProps<QuizData>) {
    const shortcutRoot=useRef<HTMLDivElement>(null);useStudyShortcuts(shortcutRoot);
    const readingMaterial=data.prompt.length>100||data.prompt.includes('\n');
    const PromptTag=readingMaterial?'p':'h2';
    const assistance=useAssistance(context?.draft);
    const [quizState, setQuizState] = useLearningDraftState<"guessing" | "answered" | "lapse_typing">(context?.draft,'quizState',"guessing");
    const [selectedOption, setSelectedOption] = useLearningDraftState<string | null>(context?.draft,'selectedOption',null);
    const [failedOnce, setFailedOnce] = useLearningDraftState(context?.draft,'failedOnce',false);
    const [hintLoading, setHintLoading] = useState(false);
    const [hintText, setHintText] = useLearningDraftState<string | null>(context?.draft,'hintText',null);
    const [hintDisplayId,setHintDisplayId]=useLearningDraftState<string|null>(context?.draft,'hintDisplayId',null);
    const [feedbackDisplayId,setFeedbackDisplayId]=useLearningDraftState<string|null>(context?.draft,'feedbackDisplayId',null);
    const [hintError,setHintError]=useLearningDraftState(context?.draft,'hintError','');
    const [lapseInput] = useLearningDraftState(context?.draft,'lapseInput',"");
    const [firstWrong,setFirstWrong]=useLearningDraftState(context?.draft,'firstWrongOption','');
    useReportStudyAIItem(context,{question:[data.prompt,...data.options].join('\n'),code:data.code,learnerAnswer:[selectedOption,lapseInput].filter(Boolean).join('\n'),errors:failedOnce?['本题曾答错']:[]});
    useAssistanceDisplay(assistance,'ai-hint',hintDisplayId,quizState==='guessing'&&Boolean(hintText?.trim()));
    useAssistanceDisplay(assistance,'answer-feedback',feedbackDisplayId,selectedOption!==null);

    const handleSelect = (option: string) => {
      if (quizState !== "guessing") return;
      assistance?.submit();
      
      const isCorrect = option === data.answer;
      setSelectedOption(option);
      setFeedbackDisplayId(crypto.randomUUID());

      if (isCorrect) {
        if (failedOnce) {
          setQuizState("lapse_typing");
        } else {
          setQuizState("answered");
        }
      } else {
        if(!firstWrong)setFirstWrong(option);
        setFailedOnce(true);
      }
    };

    const handleLapseSubmit = () => {
       if(!context?.draft?.isPending?.()&&!context?.draft?.hasSavedFeedback?.())onGrade('again');
    };

    const requestHint=async()=>{
      if(hintLoading)return;
      setHintLoading(true);setHintError('');
      try{
        if(!context?.requestAiHint)throw new Error('当前未连接 AI 提示。');
        const hint=await context.requestAiHint(data,selectedOption);
        if(!hint.trim())throw new Error('AI 未返回提示，请重试。');
        setHintText(hint);
        setHintDisplayId(crypto.randomUUID());
      }catch(error){setHintError(accountAiFailureMessage(error));}
      finally{setHintLoading(false);}
    };

    return (
      <div ref={shortcutRoot} data-study-shortcuts data-study-activity="quiz" className="study-activity study-quiz w-full max-w-3xl mx-auto flex flex-col">
        <StudyGuidance topic="quiz" context={context} engaged={quizState!=='guessing'}/>
        {/* Main Quiz Card */}
        <div className="study-card">
          
          <div className="flex justify-between items-center mb-6">
            <span className="study-activity-eyebrow">{data.topic}</span>
          </div>
          
          <PromptTag className={`study-question${readingMaterial?' study-reading-material':''}`}>
            {data.prompt}
          </PromptTag>
          
          {data.code && quizState === "guessing" && (
            <div className="mb-8 rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800">
              <pre className="p-5 bg-zinc-50 dark:bg-[#0D0E12] text-sm overflow-x-auto text-zinc-800 dark:text-zinc-300 font-mono">
                <code>{data.code}</code>
              </pre>
            </div>
          )}

          {data.code && (quizState === "answered" || quizState === "lapse_typing") && (
            <PythonPlayground key={data.code} initialCode={data.code} draft={context?.draft} />
          )}

          <div className="flex flex-col gap-3 sm:gap-4">
            {data.options.map((option, idx) => {
              const isSelected = selectedOption === option;
              const isCorrectAnswer = option === data.answer;
              
              let btnClass = "study-choice relative w-full text-left px-5 sm:px-6 py-4 sm:py-5 rounded-xl border-2 transition-colors duration-200 group flex items-center justify-between ";
              let icon = null;
              
              if (quizState !== "guessing") {
                if (isCorrectAnswer) {
                  btnClass += "border-[var(--success)] bg-[var(--success)]/5 text-[var(--success)] font-medium";
                  icon = <span className="text-[var(--success)] text-xl animate-in zoom-in">✓</span>;
                } else {
                  btnClass += "border-zinc-100 bg-zinc-50/50 text-zinc-400 dark:border-zinc-800/50 dark:bg-[#13151A] dark:text-zinc-600 opacity-50";
                }
              } else {
                if (isSelected) {
                  btnClass += "border-red-400/50 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 text-red-700 dark:text-red-400 opacity-90";
                  icon = <span className="text-red-500 text-xl animate-in zoom-in">×</span>;
                } else {
                  btnClass += "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-[#1A1D24] dark:text-zinc-300 dark:hover:border-zinc-700 cursor-pointer";
                }
              }

              return (
                <button
                  key={idx}
                  data-study-key={idx<9?String(idx+1):undefined} aria-keyshortcuts={idx<9?String(idx+1):undefined}
                  disabled={quizState !== "guessing"}
                  onClick={() => handleSelect(option)}
                  className={btnClass}
                >
                  <span className="pr-8 text-base">{idx<9&&<kbd className="study-key-hint" aria-hidden="true">{idx+1}</kbd>} {option}</span>
                  {icon && <span className="absolute right-5 flex items-center justify-center w-6 h-6">{icon}</span>}
                </button>
              );
            })}
          </div>

          {/* AI Hint Section (only when failedOnce and still guessing) */}
          {failedOnce && quizState === "guessing" && !hintText && (
            <div className="mt-8 flex flex-col items-center animate-in fade-in zoom-in duration-300">
              <button 
                onClick={()=>void requestHint()}
                disabled={hintLoading}
                className="study-secondary-action"
              >
                {hintLoading ? "思考中…" : "请求 AI 提示"}
              </button>
            </div>
          )}
          
          {hintError&&quizState==='guessing'&&<p role="status" className="study-feedback mt-4">{hintError} 你仍可继续作答或稍后重试提示。</p>}
          {hintText && quizState === "guessing" && (
             <div className="study-feedback mt-6">
                <div className="study-activity-eyebrow mb-3">
                   <span>AI 导师提示</span>
                </div>
                <p className="text-zinc-700 dark:text-zinc-300 text-sm leading-relaxed whitespace-pre-wrap">{hintText}</p>
             </div>
          )}

          {(quizState === "answered" || quizState === "lapse_typing") && (
            <div className="mt-8 p-6 rounded-2xl bg-zinc-50 dark:bg-[#1A1D24] border border-zinc-200 dark:border-zinc-800 animate-in fade-in slide-in-from-bottom-4">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-teal-600 dark:text-[var(--success)] font-black text-lg flex items-center gap-2">
                  <span className="text-2xl leading-none">✓</span> 
                  {quizState === "lapse_typing" ? "本次已修正，首次仍需复习" : "回答正确"}
                </span>
              </div>
              <p className="text-zinc-700 dark:text-zinc-300 leading-relaxed text-sm sm:text-base mb-2">
                <MathText text={String(data.explanation ?? "")} />
              </p>
              <TutorFollowUp askTutor={context?.askTutor} item={data} compact draft={context?.draft} />

              {quizState === "lapse_typing" ? (
                 <div className="flex flex-col gap-3 p-5 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20">
                   <p className="text-sm font-bold text-red-600 dark:text-red-400 flex items-center gap-2">
                     这题刚才选错过。可选择解释原选项的问题，也可直接继续；本次仍记为需要复习。
                   </p>
                   {lapseInput&&<details><summary>旧版未提交的巩固输入</summary><input aria-label="旧版巩固输入" value={lapseInput} readOnly/></details>}
                   <SourceReviewLauncher registerGuard={registerStudyNavigationGuard} worksheet={sourceWorksheet({kind:'distinction',binding:JSON.stringify([data.prompt,data.options,data.answer]),target:firstWrong?`原选项：${firstWrong}`:'本题选项的区别',reference:data.explanation||`材料给出的正确选项：${data.answer}`})} createDraft={context?.draft?.createTemporary} label="解释为什么原选项不对（可跳过）"/>
                   <button 
                     onClick={handleLapseSubmit}
                     disabled={context?.draft?.isPending?.()}
                     className="study-primary-action w-full mt-2 disabled:opacity-50"
                   >
                     记为需复习并继续
                   </button>
                 </div>
              ) : (
                <button 
                  onClick={() => onGrade("good")}
                  className="study-primary-action"
                >
                  继续
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
};

function NonWordQuizAdapter({data,context,onGrade}:PluginRenderProps<QuizData>){
  const [state,setState]=useLearningDraftState<NonWordQuizState>(context?.draft,'nonwordQuizState',{selection:[],first:null,phase:'answer',retry:null});
  const root=useRef<HTMLDivElement>(null);useStudyShortcuts(root);
  const assistance=useAssistance(context?.draft);
  useAssistanceDisplay(assistance,'answer-feedback','nonword-quiz-feedback',Boolean(state.first)&&!state.phase.startsWith('retry'));
  return <NonWordQuiz data={data} state={state} setState={setState} onGrade={onGrade} rootRef={root}
    submitObservation={()=>{assistance?.submit();}} renderMath={text=><MathText text={text}/>}
    lifecycle={context?.nonWordLearning} pending={context?.draft?.isPending}
    hasSavedFeedback={context?.draft?.hasSavedFeedback} continueAfterFeedback={context?.draft?.continueAfterFeedback}/>;
}
export const QuizPlugin:StudyPlugin<QuizData>={...LegacyQuizPlugin,name:'选择题',description:'支持单选、多选、选项排除与来源解析。',renderUI:props=>props.context?.nonWordLearning?<NonWordQuizAdapter {...props}/>:props.data.learningSupport?<StructuredQuiz {...props} data={{...props.data,learningSupport:props.data.learningSupport}}/>:<LegacyQuizPlugin.renderUI {...props}/>};
