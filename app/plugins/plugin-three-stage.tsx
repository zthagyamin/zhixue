"use client";
import {StudyGuidance} from '../study-guidance';
import {useRef} from 'react';
import {useStudyShortcuts} from '../use-study-shortcuts';
import {useReportStudyAIItem} from '../ai/use-report-study-ai-item';
import {makeWordContext,contextPrompt,contextFallback} from '../word-context-model';
import {WordContextView} from '../word-context-view';
import {StudyPluginOptions} from '../study-plugin-options';
import '../word-context.css';


import { useEffect } from "react";
import {useLearningDraftState} from '../learning-draft';
import {useAssistance,useAssistanceDisplay} from '../assistance-display';
import type {PluginRenderProps} from './registry';
import { speakWord, cancelWordSpeech } from "./speech";
const wordCardClass="study-word-card flex flex-col items-center w-full mx-auto";
const wordActionsClass="word-actions";

function WordStageProgress({stage,embedded}:{stage:number;embedded?:boolean}) {
  return embedded?null:<p className="study-stage-compact" aria-label="三阶段进度">{['认义','语境','自评'][stage-1]} · {stage}/3</p>;
}

function WordAnswerLabel({label,learn=false}:{label:string;learn?:boolean}) {
  return <span>{label} <kbd className="study-key-hint" aria-hidden="true">{learn?'2':'1'}</kbd></span>;
}

type WordCard = {
  word: string;
  phonetic: string;
  meaning: string;
  context: string;
  example: string;
  source: string;
  level: string;
  distractors: string[];
  stage?: number;
};

function SpeakButton({ word }: { word: string }) {
  return (
    <button
      data-study-keys="Space" aria-keyshortcuts="Space"
      onClick={(event) => { event.stopPropagation(); speakWord(word); }}
      aria-label="朗读单词"
      title="朗读单词（Space）"
      className="w-10 h-10 grid place-items-center rounded-lg border border-zinc-200 dark:border-zinc-700 text-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
    >
      🔊
    </button>
  );
}

export const PluginThreeStage = {
  id: "@zhixue/plugin-three-stage",
  name: "三阶段背词",
  description: "区分词义检索、原语境核对和自评；完成本轮不等于长期掌握。",
  renderUI: function ThreeStageUI({ data, onGrade, context }: PluginRenderProps<WordCard>) {
    const shortcutRoot=useRef<HTMLDivElement>(null);useStudyShortcuts(shortcutRoot);
    const assistance=useAssistance(context?.draft);
    const [revealed, setRevealed] = useLearningDraftState(context?.draft,'revealed',false);
    // "不认识 · 学一下"路径：允许先学释义，但本轮判 again（诚实计分）。
    const [learned, setLearned] = useLearningDraftState(context?.draft,'learned',false);
    const [clozeEnabled,setClozeEnabled]=useLearningDraftState(context?.draft,'clozeEnabled',false);
    const stage = data.stage || 1;
    const word = String(data.word || '');
    const example = makeWordContext(String(data.example || ''), word);
    const hasUsableExample = Boolean(example.plain.trim());
    const concealed = stage === 2 && clozeEnabled && example.canCloze && !revealed;
    useAssistanceDisplay(assistance,learned?'meaning-study':'meaning-check','word-reveal',revealed&&Boolean(String(data.meaning??'').trim()));

    useReportStudyAIItem(context,{question:stage===2?(concealed?contextPrompt(example,true):`${word}\n${example.plain}`):word,learnerAnswer:learned?'已选择不认识并学习释义':revealed?'已查看释义':'尚未自评'});

    // Stage 2 may become a concealed task. Never read the answer on entry, even before
    // its saved setting is restored. Cleanup also cancels a previous card's utterance.
    useEffect(() => {
      if (stage === 2) cancelWordSpeech(); else speakWord(word);
      return cancelWordSpeech;
    }, [word, stage]);
    useEffect(() => { if (concealed) cancelWordSpeech(); }, [concealed]);

    if (stage === 1) {
      return (
        <div ref={shortcutRoot} data-study-shortcuts className={wordCardClass} data-quiet-study data-stage={stage} data-revealed={revealed||undefined}><WordStageProgress stage={stage} embedded={context?.guidanceInOptions}/><StudyGuidance topic={`three-stage-${stage}` as 'three-stage-1'|'three-stage-2'|'three-stage-3'} context={context} engaged={revealed}/>
          <div className="flex items-center justify-center gap-3 mb-4">
            <h2 className="text-4xl font-serif">{data.word}</h2>
            <SpeakButton word={data.word} />
          </div>
          <p className="study-meta">词义检索 · 词形已给出{revealed?(learned?' · 本页先学释义后核对':' · 本页自报先回想再核对'):''}</p>
          {data.phonetic&&<p className="study-word-phonetic text-lg text-zinc-500 mb-8">{data.phonetic}</p>}
          
          {!revealed ? (
            <>
              <div className={wordActionsClass}>
                <button 
                  data-study-key="1" aria-keyshortcuts="1" onClick={() => setRevealed(true)}
                  className="px-6 py-3 bg-[var(--lime)] text-[var(--lime-dark)] rounded-lg font-bold hover:brightness-95 transition-all"
                >
                  <WordAnswerLabel label="认识，核对"/>
                </button>
                <button
                  data-study-key="2" aria-keyshortcuts="2" onClick={() => { setLearned(true); setRevealed(true); }}
                  className="px-6 py-3 bg-red-100 text-red-700 rounded-lg font-bold hover:bg-red-200 transition-all"
                >
                  <WordAnswerLabel label="不认识" learn/>
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center w-full animate-in fade-in">
              <p className="text-2xl font-bold mb-6">{data.meaning}</p>
              <div className={wordActionsClass}>
                <button
                  data-study-key="1" data-study-keys="Enter" aria-keyshortcuts="1 Enter" onClick={() => onGrade(learned ? "again" : "good")}
                  className="px-6 py-3 bg-[var(--lime)] text-[var(--lime-dark)] rounded-lg font-bold hover:brightness-95 transition-all"
                >
                  {learned ? "继续练习" : "想对了"} <kbd className="study-key-hint" aria-hidden="true">1</kbd>
                </button>
                {!learned && <button
                  data-study-key="2" aria-keyshortcuts="2" onClick={() => onGrade("again")}
                  className="px-6 py-3 bg-red-100 text-red-700 rounded-lg font-bold hover:bg-red-200 transition-all"
                >
                  没想对 <kbd className="study-key-hint" aria-hidden="true">2</kbd>
                </button>}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (stage === 2) {
      return (
        <div ref={shortcutRoot} data-study-shortcuts className={wordCardClass} data-quiet-study data-context-view data-stage={stage} data-revealed={revealed||undefined}>
          <WordStageProgress stage={stage} embedded={context?.guidanceInOptions}/>
          <StudyGuidance topic="three-stage-2" context={context} engaged={revealed}/>
          <p className="study-meta">{hasUsableExample?(concealed?'原语境填词 · 无音提示':'原语境词义核对'):'原文语境不可用'} · 本题自评不等于新情境迁移</p>
          <div className="study-context-heading">
            {concealed?<p>回想空缺词</p>:<h2>{word}</h2>}
            {!concealed&&<SpeakButton word={word}/>}
          </div>
          {hasUsableExample?<WordContextView model={example} concealed={concealed}/>:<p className="study-context-missing">{contextFallback(example.reason)}</p>}
          {!revealed ? (
            <div className={wordActionsClass}>
              <button data-study-key="1" aria-keyshortcuts="1" onClick={() => setRevealed(true)} className="px-6 py-3 rounded-lg font-bold">
                <WordAnswerLabel label="核对答案"/>
              </button>
              <button data-study-key="2" aria-keyshortcuts="2" onClick={() => { setLearned(true); setRevealed(true); }} className="px-6 py-3 rounded-lg font-bold">
                <WordAnswerLabel label="想不起来" learn/>
              </button>
            </div>
          ) : (
            <div className="study-context-response">
              <p className="study-context-meaning">{data.meaning}</p>
              <div className={wordActionsClass}>
                <button data-study-key="1" data-study-keys="Enter" aria-keyshortcuts="1 Enter" onClick={() => onGrade(learned ? "again" : "good")} className="px-6 py-3 rounded-lg font-bold">
                  {learned ? "继续练习" : "想对了"} <kbd className="study-key-hint" aria-hidden="true">1</kbd>
                </button>
                {!learned&&<button data-study-key="2" aria-keyshortcuts="2" onClick={() => onGrade("again")} className="px-6 py-3 rounded-lg font-bold">
                  没想对 <kbd className="study-key-hint" aria-hidden="true">2</kbd>
                </button>}
              </div>
            </div>
          )}
          <StudyPluginOptions>
            <div className="study-plugin-context-option">
              <label><input type="checkbox" checked={clozeEnabled&&example.canCloze} disabled={revealed||!example.canCloze} onChange={event=>{if(event.target.checked)cancelWordSpeech();setClozeEnabled(event.target.checked);}}/>例句挖空</label>
              <p>{example.canCloze?'先在心中回想，核对后自评；这不是自动判分的拼写题。挖空时不自动朗读答案。':contextFallback(example.reason)}</p>
              {data.source&&<details><summary>语境来源</summary><p>{data.source}</p></details>}
            </div>
          </StudyPluginOptions>
        </div>
      );
    }

    return (
      <div ref={shortcutRoot} data-study-shortcuts className={wordCardClass} data-quiet-study data-stage={stage} data-revealed={revealed||undefined}><WordStageProgress stage={stage} embedded={context?.guidanceInOptions}/><StudyGuidance topic={`three-stage-${stage}` as 'three-stage-1'|'three-stage-2'|'three-stage-3'} context={context} engaged={revealed}/>
        <div className="flex items-center justify-center gap-3 mb-8">
          <h2 className="text-4xl font-serif">{data.word}</h2>
          <SpeakButton word={data.word} />
        </div>
        <p className="study-meta">无释义提示的词义自评 · 本轮完成不代表长期掌握</p>
        
        {!revealed ? (
          <>
            <div className={wordActionsClass}>
              <button 
                data-study-key="1" aria-keyshortcuts="1" onClick={() => setRevealed(true)}
                className="px-6 py-3 bg-[var(--lime)] text-[var(--lime-dark)] rounded-lg font-bold hover:brightness-95 transition-all"
              >
                <WordAnswerLabel label="想好了，核对"/>
              </button>
              <button 
                data-study-key="2" aria-keyshortcuts="2" onClick={() => { setLearned(true); setRevealed(true); }}
                className="px-6 py-3 bg-red-100 text-red-700 rounded-lg font-bold hover:bg-red-200 transition-all"
              >
                <WordAnswerLabel label="不认识" learn/>
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center w-full animate-in fade-in">
            <p className="text-2xl font-bold mb-4">{data.meaning}</p>
            <div className={wordActionsClass}>
              <button 
                data-study-key="1" data-study-keys="Enter" aria-keyshortcuts="1 Enter" onClick={() => onGrade(learned ? "again" : "good")}
                className="px-6 py-3 bg-[#46A25F] text-white rounded-lg font-bold hover:brightness-110 transition-all"
              >
                {learned ? "继续练习" : "想对了"} <kbd className="study-key-hint" aria-hidden="true">1</kbd>
              </button>
              {!learned && <button
                data-study-key="2" aria-keyshortcuts="2" onClick={() => onGrade("again")}
                className="px-6 py-3 bg-red-100 text-red-700 rounded-lg font-bold hover:bg-red-200 transition-all"
              >
                没想对 <kbd className="study-key-hint" aria-hidden="true">2</kbd>
              </button>}
            </div>
          </div>
        )}
      </div>
    );
  }
};
