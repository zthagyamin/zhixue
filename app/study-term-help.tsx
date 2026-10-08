"use client";
import {useId,useRef,useState} from 'react';
const terms={
  review:{label:'复习安排',text:'复习安排会参考你的作答情况，估算哪些内容需要再次练习。FSRS 是其中使用的记忆算法；安排不等于已经掌握。'},
  companion:{label:'本地资料助手',text:'Companion 是安装在电脑上的资料助手，用于读取你授权的资料并处理写回。体验示例无需安装；启用账号题库后，可在其他设备学习，读取本机资料和写回仍需要电脑助手。'},
  managed:{label:'知学维护的笔记区域',text:'“受管区域”是笔记中用标记划出的、由知学维护的部分。这里的写回目标是这一部分，而非整篇原文；操作前仍须核对预览和目标笔记。'},
} as const;
export function StudyTermHelp({term}:{term:keyof typeof terms}){
  const [open,setOpen]=useState(false),id=useId(),button=useRef<HTMLButtonElement>(null),entry=terms[term];
  return <span className="study-term-help">
    <button ref={button} type="button" onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);button.current?.focus();}}} aria-label={`${entry.label}：这是什么？`} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>这是什么？</button>
    <span id={id} hidden={!open} className="study-term-explanation" role="note">{entry.text}</span>
  </span>;
}
