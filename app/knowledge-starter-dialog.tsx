"use client";
import {useState} from 'react';
import {StudyPanel} from './study-session-shell';
import {knowledgeStarterPrompts,buildKnowledgeStarterPrompt} from './knowledge-starter-prompts';
import './knowledge-starter.css';
type Path='existing'|'new';
export function KnowledgeStarterDialog({open,onClose,onConnect}:{open:boolean;onClose:()=>void;onConnect?:()=>void}){
  const [path,setPath]=useState<Path|null>(null),[notice,setNotice]=useState(''),[selected,setSelected]=useState<string>('vocabulary');
  const [goal,setGoal]=useState(''),[level,setLevel]=useState(''),[dailyMinutes,setDailyMinutes]=useState('20');
  const item=knowledgeStarterPrompts.find(value=>value.id===selected)??knowledgeStarterPrompts[0];
  const prompt=buildKnowledgeStarterPrompt(item.prompt,{goal,level,dailyMinutes},path??'new');
  async function copy(){try{await navigator.clipboard.writeText(prompt);setNotice('已复制。把提示词和你自己的材料一起交给 AI；材料不会自动发送。');}catch{setNotice('剪贴板不可用，请在文本框中全选复制。');}}
  function connect(){onClose();onConnect?.();}
  const promptTools=<div className="starter-prompt-tools"><h3>按你的目标准备材料</h3><p>可选：填写背景后复制提示词。这里不会调用 AI，也不会自动上传材料。</p><div className="starter-profile"><label>学习目标<input value={goal} onChange={e=>setGoal(e.target.value)} maxLength={240} placeholder="例如：学会 Python 函数，能独立完成基础练习"/></label><label>当前基础<input value={level} onChange={e=>setLevel(e.target.value)} maxLength={120} placeholder="例如：会变量和循环，函数还不熟悉"/></label><label>每天可用时间（分钟）<input type="number" min={1} max={999} value={dailyMinutes} onChange={e=>setDailyMinutes(e.target.value)}/></label></div>
    <label>准备哪类材料<select value={selected} onChange={e=>{setSelected(e.target.value);setNotice('');}}>{knowledgeStarterPrompts.map(value=><option key={value.id} value={value.id}>{value.title}</option>)}</select></label><p>{item.description}</p><label htmlFor="starter-prompt">可复制提示词</label><textarea id="starter-prompt" readOnly value={prompt} rows={8}/><div className="starter-actions"><button type="button" onClick={()=>void copy()}>复制{item.title}提示词</button><a href={`/knowledge-starter-kit/${item.file}`} download>下载{item.title}示例</a></div><p>示例均为生成、未练习内容。先核对来源和答案，再作答；不自动记录为已掌握。</p>
  </div>;
  return <StudyPanel open={open} onClose={onClose} title="接入知学，从你的起点开始" variant="center"><div className="knowledge-starter">
    <p>已有笔记可以直接接入；还没有知识库，就从一个小目录和一份材料开始。</p>
    <div className="starter-paths" role="group" aria-label="选择知识库接入方式"><button type="button" aria-pressed={path==='existing'} onClick={()=>{setPath('existing');setNotice('');}}><strong>我已有知识库</strong><span>保留原来的笔记目录、Obsidian 库或 Notion 页面</span></button><button type="button" aria-pressed={path==='new'} onClick={()=>{setPath('new');setNotice('');}}><strong>我还没有知识库</strong><span>下载最小目录与模板，完成第一次学习闭环</span></button></div>
    {path==='existing'&&<section aria-label="已有知识库接入"><h3>保留现有结构，先接入一小部分</h3><ol><li><strong>选择原资料。</strong>普通目录、Obsidian 或其他软件的导出文件；Notion 可选择在线页面或导出 ZIP。</li><li><strong>连接并预览。</strong>配对 Companion 后，在来源设置中选一个主题的小目录或页面，核对提取结果再确认。</li><li><strong>开始学习并核对保存。</strong>原笔记保持原位置；学习记录存入当前学习空间，Notion 可另选独立记录父页。</li></ol><p>无需按入门包重建目录，也不要重复导入。已经配置固定索引或资料映射的用户，可继续原流程。</p><div className="starter-actions"><button type="button" onClick={connect}>前往来源设置</button><a href="/knowledge-starter-kit/CONNECTIONS.md" download>下载接入说明</a></div><details><summary>想先整理现有材料？使用可定制提示词</summary>{promptTools}</details></section>}
    {path==='new'&&<section aria-label="从零建立知识库"><h3>一个目录，五类示例，先做一题</h3><ol><li><strong>下载并解压。</strong>包含中文上手说明、五类示例、五份空白模板与日常维护指南。</li><li><strong>准备一份材料。</strong>先看示例，再换成自己的课程、词汇或阅读材料。无需先安装 Obsidian。</li><li><strong>接入并练习。</strong>安装配对 Companion，选择解压后的 <code>Starter/materials/</code>，预览确认后自己完成一次作答。</li></ol><div className="starter-actions"><a className="starter-primary" href="/knowledge-starter-kit/structure.zip" download>下载完整入门包</a><button type="button" onClick={connect}>材料准备好了，前往接入</button></div><p>下载与编辑无需账号；连接 Companion 需登录知学。新安装会建立独立学习空间。只选择 materials 目录，避免导入指南或空模板。</p>{promptTools}</section>}
    {path&&<section><h3>教学与日常使用</h3><div className="starter-guides"><a href="/knowledge-starter-kit/OBSIDIAN.md" download>Obsidian 从建库到接入</a><a href="/knowledge-starter-kit/QUICKSTART.md" download>10 分钟上手</a><a href="/knowledge-starter-kit/WORKFLOW.md" download>每天学习与每周整理</a><a href="/knowledge-starter-kit/TROUBLESHOOTING.md" download>常见问题</a><a href="/knowledge-starter-kit/Templates/learning-record-template.md" download>真实学习记录模板</a></div><p>Python 示例从新来源入口导入需 Companion 1.15.1 或以上。同步成功、示例测试通过与真正掌握是不同的证据。</p></section>}
    {notice&&<p role="status">{notice}</p>}
  </div></StudyPanel>;
}
