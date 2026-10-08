"use client";

import { useRef,useState } from "react";
import {useLearningDraftState} from '../learning-draft';
import {useAssistanceDisplay} from '../assistance-display';
import type {LearningDraftAdapter} from '../learning-draft-store';

// 讲解处的 AI 导师追问（主旨一：交互式 AI 学习）。askTutor 缺省时整块
// 不渲染；回答只在会话内展示，不进入学习事件流。
export function TutorFollowUp({
  askTutor,
  item,
  compact,
  draft,
}: {
  askTutor?: (question: string, item: unknown) => Promise<string>;
  item: unknown;
  compact?: boolean;
  draft?:LearningDraftAdapter;
}) {
  const [question, setQuestion] = useLearningDraftState(draft,'tutor.question',"");
  const questionRevision=useRef(0),composing=useRef(false),requestBusy=useRef(false);
  const [answer, setAnswer] = useLearningDraftState(draft,'tutor.answer',"");
  const [answerDisplayId,setAnswerDisplayId]=useLearningDraftState<string|null>(draft,'tutor.answerDisplayId',null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useLearningDraftState(draft,'tutor.error',"");
  useAssistanceDisplay(draft?.assistance,'ai-tutor',answerDisplayId,Boolean(askTutor&&answer.trim()));

  if (!askTutor) return null;

  const ask = async (prompt=question) => {
    const trimmed = prompt.trim();
    if (!trimmed || loading || requestBusy.current) return;
    requestBusy.current=true;
    const requestRevision=questionRevision.current;
    const fromInput=trimmed===question.trim();
    setLoading(true);
    setError("");
    try {
      const result = await askTutor(trimmed, item);
      if(typeof result!=='string'||!result.trim())throw new Error('AI 导师未返回可显示的内容，请重试。');
      setAnswer(result);
      setAnswerDisplayId(crypto.randomUUID());
      if(fromInput&&questionRevision.current===requestRevision)setQuestion("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 导师暂时无法回答。");
    } finally {
      requestBusy.current=false;
      setLoading(false);
    }
  };

  return (
    <div className={compact ? "study-tutor mt-3" : "study-tutor mt-4 p-4 rounded-xl border border-[var(--line)] bg-[var(--surface)]"}>
      <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-50 mb-2">问 AI 导师 · 从卡住的一步继续</p>
      <div className="study-tutor-prompts" aria-label="选择追问方式"><button type="button" disabled={loading} onClick={()=>void ask('只给我一个最小提示，用一个问题引导我思考，不直接给出完整答案。')}>给一个小提示</button><button type="button" disabled={loading||!question.trim()} onClick={()=>void ask(`请先检查我这段思路，指出第一个需要重新想的地方，用问题引导，不直接给完整答案：${question}`)}>检查我的思路</button></div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={question}
          onChange={(event) => {questionRevision.current++;setQuestion(event.target.value);}}
          onCompositionStart={()=>{composing.current=true;}}
          onCompositionEnd={()=>{composing.current=false;}}
          onKeyDown={(event) => {
            if(event.key!=="Enter"||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.repeat||composing.current||event.nativeEvent.isComposing||event.nativeEvent.keyCode===229)return;
            event.preventDefault();void ask();
          }}
          placeholder="针对这道题追问，例如：为什么第二种情况不成立？"
          aria-label="向 AI 导师追问"
          className="flex-1 rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ink)]"
        />
        <button
          className="px-4 py-2 rounded-xl bg-[var(--ink)] text-[var(--surface)] font-black text-sm hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
          onClick={() => void ask()}
          disabled={loading || !question.trim()}
        >
          {loading ? "思考中…" : "提问"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs font-bold text-[var(--orange)]">{error}</p>}
      {answer && (
        <div className="mt-3 p-3 rounded-lg border border-[var(--line)] bg-[rgba(0,0,0,0.02)] dark:bg-[rgba(255,255,255,0.04)]">
          <p className="text-[10px] font-black uppercase tracking-widest text-[var(--ink)] opacity-40 mb-1">AI 导师</p>
          <p aria-live="polite" className="text-sm text-[var(--ink)] opacity-85 leading-relaxed whitespace-pre-wrap">{answer}</p>
        </div>
      )}
    </div>
  );
}
