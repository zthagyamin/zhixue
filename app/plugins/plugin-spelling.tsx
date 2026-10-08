"use client";
import {StudyGuidance} from '../study-guidance';
import {useReportStudyAIItem} from '../ai/use-report-study-ai-item';


import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {parseSpellingSupport,type SpellingSupport} from '../spelling-support';
import {useLearningDraftState} from '../learning-draft';
import {useAssistance,useAssistanceDisplay} from '../assistance-display';
import { StudyPlugin, PluginRenderProps } from "./registry";
import { evaluateKeypress, evaluateSpellingEdit, evaluateSpellingComposition, isSpellingComplete, spellingStates, SpellingState } from "./spelling-core";
import { speakWord,cancelWordSpeech } from "./speech";

/**
 * 拼写练习插件（借鉴开源项目 TypeWords 的打字学习机制）。
 *
 * 面向 IELTS 写作的产出型练习：看释义与语境（单词遮蔽），逐字母打出英
 * 文单词。错误字符原位标红且必须退格重输——刻意保留摩擦以训练拼写准
 * 确性。辅以 Web Speech 发音。0–2 次错误记 good，更多次或主动看答案记
 * again，走既有 FSRS 调度，不新增状态机制。
 */

type SpellingData = {
  learningSupport?:unknown;
  word?: string;
  meaning?: string;
  context?: string;
  example?: string;
};

function maskWord(example: string, word: string): string {
  if (!example || !word) return example || "";
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return example.replace(new RegExp(escaped, "gi"), "▢".repeat(Math.max(3, word.length)));
}

function SpellingUI({ data, onGrade, context }: PluginRenderProps<SpellingData>) {
  const assistance=useAssistance(context?.draft);
  const word = String(data.word || "");
  const meaning = String(data.meaning || "");
  const example = String(data.example || data.context || "");
  const [state, setState] = useLearningDraftState<SpellingState>(context?.draft,'state',{ word, input: "", wrong: "", wrongCount: 0 });
  const [done, setDone] = useState<null | { correct: boolean }>(null);
  const [showWord, setShowWord] = useLearningDraftState(context?.draft,'showWord',false);
  const [purpose,setPurpose]=useLearningDraftState<'production'|'dictation'>(context?.draft,'spellingPurpose','production');
  const [groupErrors,setGroupErrors]=useLearningDraftState<Record<number,number>>(context?.draft,'groupErrors',{});
  const [composition,setComposition]=useState<string|null>(null);
  const composing=useRef(false);
  const [showWpm,setShowWpm]=useState(false);
  const [motion,setMotion]=useState(true);
  const [clock,setClock]=useState<{start:number;end:number;count:number}|null>(null);
  const boxesRef=useRef<HTMLDivElement>(null);
  const caretRef=useRef<HTMLSpanElement>(null);
  let mapping:SpellingSupport|undefined;
  try{if(data.learningSupport){const parsed=parseSpellingSupport(data.learningSupport);if(parsed.word===word)mapping=parsed;}}catch{/* Invalid optional mappings never expose guessed phonetics. */}
  const groupAt=(position:number)=>{let end=0;return mapping?.segments.findIndex(segment=>{end+=segment.letters.length;return position<end;})??-1;};
  useReportStudyAIItem(context,{question:`${meaning}\n${maskWord(example,word)}`,learnerAnswer:state.input,errors:state.wrong?[`上次拼写：${state.wrong}`]:[]});
  const gradedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishTimer=useRef<number|undefined>(undefined);
  const revealPending=useRef(false);
  useAssistanceDisplay(assistance,'reference-answer','spelling-answer',showWord&&Boolean(word.trim()));
  useEffect(()=>()=>window.clearTimeout(finishTimer.current),[]);

  // Audio is a declared training mode; production must never read the hidden answer.
  useEffect(() => {
    if(purpose==='dictation')speakWord(word);else cancelWordSpeech();
    return cancelWordSpeech;
  }, [word,purpose]);

  const finish = useCallback((correct: boolean) => {
    if (gradedRef.current || !onGrade) return;
    window.clearTimeout(finishTimer.current);
    gradedRef.current = true;
    setDone({ correct });
    onGrade(correct ? "good" : "again");
  },[onGrade]);

  // Only a reveal requested in this mount schedules a grade. Restoring an
  // already-visible answer keeps G2's explicit retry and never auto-submits.
  useEffect(()=>{
    if(!showWord||!revealPending.current)return;
    const frame=window.requestAnimationFrame(()=>{if(revealPending.current){revealPending.current=false;finish(false);}});
    return()=>window.cancelAnimationFrame(frame);
  },[showWord,finish]);

  const acceptInput=(next:SpellingState)=>{
    if(done||next===state)return;
    window.clearTimeout(finishTimer.current);
    const group=groupAt(state.input.length);
    if(next.wrongCount>state.wrongCount&&group>=0)setGroupErrors(current=>({...current,[group]:(current[group]??0)+1}));
    // eslint-disable-next-line react-hooks/purity -- Called only by input/keyboard event handlers, never during render.
    const now=performance.now();
    setClock(previous=>({start:previous?.start??now,end:now,count:(previous?.count??0)+Math.max(0,next.input.length-state.input.length)}));
    setState(next);
    if(isSpellingComplete(next))finishTimer.current=window.setTimeout(()=>finish(!showWord&&!revealPending.current&&next.wrongCount<=2),450);
  };
  const submitRestored=()=>finish(!showWord&&state.wrongCount<=2);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (done) return;
    if(composing.current||event.nativeEvent.isComposing)return;
    if (event.key === "Enter") {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const next = evaluateKeypress(state, event.key);
    if (next !== state) {
      event.preventDefault();
      acceptInput(next);
      return;
    }
    if (event.key.length === 1) event.preventDefault();
  };

  const reveal = () => {
    if (done) return;
    window.clearTimeout(finishTimer.current);
    revealPending.current=true;
    setShowWord(true);
    setState((current) => ({ ...current, input: word, wrong: "" }));
  };

  const states = spellingStates(word, showWord ? word : state.input, showWord ? "" : state.wrong);
  const complete = done !== null;
  const shake = state.wrong && !complete;
  useLayoutEffect(()=>{
    const boxes=boxesRef.current,caret=caretRef.current;
    if(!boxes||!caret)return;
    const position=()=>{const active=boxes.querySelector<HTMLElement>(`[data-letter-index="${state.input.length}"]`);caret.hidden=!active||complete||showWord;if(active){caret.style.transform=`translate(${active.offsetLeft}px, ${active.offsetTop+active.offsetHeight+3}px)`;caret.style.width=`${active.offsetWidth}px`;}};
    position();const observer=new ResizeObserver(position);observer.observe(boxes);return()=>observer.disconnect();
  },[state.input.length,complete,showWord]);
  const elapsed=clock?(clock.end-clock.start)/60000:0;
  const wpm=clock&&elapsed>=1/60?Math.round(clock.count/5/elapsed):null;

  return (
    <div
      data-study-activity="spelling" data-training-purpose={purpose} data-motion={motion?'on':'off'} className="study-activity study-spelling w-full mx-auto flex flex-col items-center"
    >
      <StudyGuidance topic="spelling" context={context} engaged={Boolean(state.input||state.wrong||showWord)}/>
      <label className="study-meta">本轮训练目的<select aria-label="拼写训练目的" value={purpose} disabled={Boolean(state.input||state.wrong||showWord||done)} onChange={event=>setPurpose(event.target.value as 'production'|'dictation')}><option value="production">无音词汇产出 · 看释义与原语境</option><option value="dictation">听音拼写 · 可朗读答案词</option></select></label>
      <p className="study-meta">{purpose==='production'?'本轮不朗读答案，只接受材料中的目标拼写。':'本轮练习听音拼写，不把它当作无音词汇产出。'}</p>
      <div className="flex items-center gap-3 mb-6">
        <p className="text-2xl font-bold text-[var(--ink)]">{meaning}</p>
        {purpose==='dictation'&&<button
          className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-sm font-bold hover:bg-[rgba(0,0,0,0.04)] dark:hover:bg-[rgba(255,255,255,0.06)] transition-all"
          onClick={(event) => { event.stopPropagation(); speakWord(word); }}
          aria-label="朗读单词"
          title="朗读单词"
        >
          🔊
        </button>}
      </div>

      {example && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 italic mb-8 text-center leading-relaxed">
          {maskWord(example, word)}
        </p>
      )}

      <div ref={boxesRef} className={`relative flex flex-wrap justify-center gap-1 mb-6 ${shake ? "spelling-shake" : ""}`}>
        <span ref={caretRef} aria-hidden="true" className="spelling-caret" />
        {states.map((item, index) => (
          <span
            key={index}
            data-letter-index={index}
            data-group-help={(groupErrors[groupAt(index)]??0)>=2&&groupAt(index)===groupAt(state.input.length)?'true':undefined}
            className={`inline-grid place-items-center w-9 h-11 rounded-lg text-2xl font-serif border ${
              item.status === "correct"
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/60"
                : item.status === "wrong"
                ? "border-red-300 bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/60"
                : "border-[var(--line)] text-[var(--ink)] opacity-40"
            }`}
          >
            {item.status === "pending" && !showWord ? "" : item.char}
          </span>
        ))}
      </div>

      <input
        ref={inputRef}
        value={composition??state.input+state.wrong}
        onChange={event=>{if(composing.current){setComposition(event.target.value);return;}acceptInput(evaluateSpellingEdit(state,event.target.value));}}
        onCompositionStart={event=>{composing.current=true;window.clearTimeout(finishTimer.current);setComposition(event.currentTarget.value);}}
        onCompositionEnd={event=>{composing.current=false;setComposition(null);acceptInput(evaluateSpellingComposition(state,event.currentTarget.value));}}
        onKeyDown={handleKeyDown}
        onPaste={event=>event.preventDefault()}
        onDrop={event=>event.preventDefault()}
        aria-label="拼写输入"
        className="study-spelling-input w-full max-w-md min-h-12 border border-[var(--line)] rounded-lg bg-[var(--surface)] px-4 py-3 text-base mb-5"
        placeholder="点这里，逐字输入单词"
        inputMode="text"
        autoCapitalize="none"
        readOnly={complete}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />

      <details className="spelling-preferences-disclosure"><summary>输入显示选项</summary><div className="spelling-preferences">
        <label><input type="checkbox" checked={showWpm} onChange={event=>setShowWpm(event.target.checked)} /> 显示速度</label>
        <label><input type="checkbox" checked={motion} onChange={event=>setMotion(event.target.checked)} /> 输入动效</label>
        {showWpm&&<span>本次输入 {wpm??'—'} WPM · 不影响评分</span>}
      </div></details>
      {mapping&&(showWord||complete)?<div className="spelling-phonics" aria-label="材料提供的拼读映射">{mapping.segments.map((segment,index)=><span key={index} data-tricky={segment.isTricky?'true':undefined}><b>{segment.letters}</b><span>/{segment.phoneme}/</span>{segment.isTricky&&<small>易错拼读</small>}</span>)}</div>:mapping&&<button type="button" className="study-secondary-action" onClick={reveal}>查看拼读（显示答案，记为需复习）</button>}

      {complete ? (
        <p className={`text-sm font-black ${done.correct ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--orange)]"}`}>
          {done.correct ? `✓ 拼写已核对${state.wrongCount > 0 ? ` · 本页自行纠正 ${state.wrongCount} 次` : " · 本页首遍拼写"}；保存状态见页面提示` : showWord?"已显示答案 · 本次按需复习提交":`本页自行纠正 ${state.wrongCount} 次 · 本次按需复习提交`}
        </p>
      ) : isSpellingComplete(state) ? (
        <button type="button" className="study-primary-action" onClick={submitRestored}>提交这次拼写</button>
      ) : (
        <div className="flex items-center gap-4 text-xs font-bold text-[var(--ink)] opacity-60">
          <button
            className="underline underline-offset-4 hover:opacity-80 transition-opacity"
            onClick={(event) => { event.stopPropagation(); reveal(); }}
          >
            不会，显示答案
          </button>
        </div>
      )}
    </div>
  );
}

export const SpellingPlugin: StudyPlugin<SpellingData> = {
  id: "@zhixue/plugin-spelling",
  name: "拼写练习",
  description: "看释义与语境，逐字母打出单词（TypeWords 式打字拼写），训练 IELTS 写作拼写。",
  renderUI: function SpellingRender(props: PluginRenderProps<SpellingData>) {
    return <SpellingUI {...props} data={props.data as SpellingData} />;
  },
};
