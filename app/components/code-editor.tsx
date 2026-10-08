'use client';
import {useEffect,useRef,useState} from 'react';
import type {mountCodeEditor} from './code-editor-runtime';

export function CodeEditor({value,onChange,readOnly=false,language='python'}:{value:string;onChange:(value:string)=>void;readOnly?:boolean;language?:'python'|'c'|'cpp'}){
  const host=useRef<HTMLDivElement>(null),fallback=useRef<HTMLTextAreaElement>(null),editor=useRef<Awaited<ReturnType<typeof mountCodeEditor>>|null>(null);
  const callback=useRef(onChange),initial=useRef(value),locked=useRef(readOnly);
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
  useEffect(()=>{callback.current=onChange;initial.current=value;locked.current=readOnly;},[onChange,value,readOnly]);
  const label=language==='python'?'Python 代码编辑器':language==='c'?'C 代码编辑器':'C++ 代码编辑器';
  useEffect(()=>{
    let active=true;let mounted:Awaited<ReturnType<typeof mountCodeEditor>>|null=null;
    const parent=host.current;if(!parent)return;
    import('./code-editor-runtime').then(async module=>{
      const next=await module.mountCodeEditor(parent,{value:initial.current,readOnly:locked.current,language,label,onChange:next=>callback.current(next)});
      if(!active){next.destroy();return;}
      mounted=next;editor.current=next;
      next.setValue(initial.current);next.setReadOnly(locked.current);
      const hadFocus=document.activeElement===fallback.current;setReady(true);if(hadFocus)next.focus();
    }).catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;mounted?.destroy();if(editor.current===mounted)editor.current=null;};
  },[language,label]);
  useEffect(()=>{editor.current?.setValue(value);editor.current?.setReadOnly(readOnly);},[value,readOnly,ready]);
  return <div className="w-full min-w-0"><div ref={host}/>{!ready&&<textarea ref={fallback} aria-label={label} value={value} onChange={event=>onChange(event.target.value)} readOnly={readOnly} spellCheck={false} wrap="off" className="w-full min-h-[260px] bg-[#161b22] text-[#e6edf3] font-mono text-sm p-4"/>}<p className="bg-[#13161c] text-zinc-400 text-xs px-4 py-2">{failed?'专业编辑器暂不可用，可继续在文本框中编辑。':ready?'Tab 缩进 · Shift+Tab 缩退 · Ctrl+/ 注释 · 先按 Esc 再按 Tab 离开编辑器':'正在加载编辑器，可先输入代码。'}</p></div>;
}
