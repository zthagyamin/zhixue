import { useState,useRef,useEffect } from "react";
import {CodeEditor} from './code-editor';
import { usePyodide } from "../hooks/use-pyodide";
import {useLearningDraftState} from '../learning-draft';
import type {LearningDraftAdapter} from '../learning-draft-store';

export function PythonPlayground({ initialCode,draft }: { initialCode: string;draft?:LearningDraftAdapter }) {
  const [code, setCode] = useLearningDraftState(draft,'sandbox.code',initialCode);
  const [output, setOutput] = useLearningDraftState<string>(draft,'sandbox.output',"");
  const [isRunning, setIsRunning] = useState(false);
  const { isReady, error, runPython, retry,cancel } = usePyodide();
  const generation=useRef(0);useEffect(()=>()=>{generation.current++;},[]);

  const runCode = async () => {
    if (!isReady||isRunning) return;
    const current=++generation.current;
    setIsRunning(true);
    setOutput("");
    
    try {
      const { result, output: capturedOutput } = await runPython(code, true);
      if(current!==generation.current)return;
      let finalOutput = capturedOutput;
      if (finalOutput.trim() === "" && result !== undefined) {
         finalOutput += String(result) + "\n";
      }
      setOutput(finalOutput || "运行完毕，无输出。");
    } catch (error: unknown) {
      if(current!==generation.current)return;
      setOutput("[Error]\n" + (error instanceof Error ? error.message : String(error)));
    } finally {
      if(current===generation.current)setIsRunning(false);
    }
  };

  return (
    <div className="study-sandbox flex flex-col w-full bg-white dark:bg-[#0D0E12] rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-sm mt-6 mb-8 group transition-all focus-within:ring-2 focus-within:ring-[#00D4FF]/30 focus-within:border-[#00D4FF]/50">
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-50 dark:bg-[#13151A] border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-xs font-mono font-bold text-zinc-500 dark:text-zinc-400">
          {error ? <span className="text-red-500">{error}</span> : "Python 3.14 (WebAssembly)"}
        </span>
        <button 
          onClick={runCode}
          disabled={!isReady || isRunning || !!error}
          className="flex items-center gap-1.5 px-3 py-1 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed rounded-md text-xs font-black uppercase tracking-widest transition-colors"
        >
          {isRunning ? "Running..." : !isReady ? "Loading Kernel..." : "▶ Run"}
        </button>
      </div>
      
      {error&&<button type="button" className="m-3 rounded-lg border border-[var(--line)] px-3 py-2" onClick={retry}>重试运行环境（保留输入）</button>}
      <CodeEditor value={code} onChange={setCode} readOnly={isRunning}/>
      {isRunning&&<button type="button" className="study-secondary-action m-3" onClick={cancel}>停止运行</button>}
      
      {output && (
        <div className="p-4 bg-zinc-50 dark:bg-black/60 border-t border-zinc-200 dark:border-zinc-800/50">
          <p className="text-[10px] uppercase font-black tracking-widest text-zinc-400 dark:text-zinc-600 mb-2">Stdout / Stderr</p>
          <pre className="text-sm font-mono text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{output}</pre>
        </div>
      )}
    </div>
  );
}
