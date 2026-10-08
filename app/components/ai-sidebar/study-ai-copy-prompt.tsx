'use client';
import {useState} from 'react';
import {buildStudyAICopyPrompt} from '../../ai/study-ai-prompt-fallback';
import type {StudyAIContext} from '../../ai/study-ai-types';
import {useStudyAIContext} from './study-ai-workspace';

export function StudyAICopyPrompt({context,includePage=true}:{context?:StudyAIContext;includePage?:boolean}){
 const reported=useStudyAIContext();
 const prompt=buildStudyAICopyPrompt(context??reported.context,includePage);
 const [result,setResult]=useState<{prompt:string;message:string}|null>(null);
 async function copy(){try{await navigator.clipboard.writeText(prompt);setResult({prompt,message:'已复制。可粘贴到你使用的网页 AI 中继续学习。'});}catch{setResult({prompt,message:'浏览器未允许复制，请展开预览，选中提示词后手动复制。'});}}
 return <section className="study-ai-copy-prompt" data-ai-private><strong>没有 API Key？也可以开始。</strong><p>复制后粘贴到 ChatGPT、Claude、豆包或 Kimi 网页。点击复制只写入剪贴板，不向模型发送内容。</p><details><summary>预览将复制的提示词</summary><textarea aria-label="伴学提示词预览" readOnly rows={7} value={prompt} onFocus={event=>event.currentTarget.select()}/></details><button type="button" onClick={()=>void copy()}>复制当前题型伴学提示词</button>{result?.prompt===prompt&&<p role="status">{result.message}</p>}</section>;
}
