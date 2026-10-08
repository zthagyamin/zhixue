"use client";
import {useState} from 'react';
import type {VaultMappingClient,VaultMappingInspection,VaultMappingRule,VaultMappingPreview} from './vault-mapping-client';
import {StudyPanel} from './study-session-shell';
import './vault-mapping.css';
export function VaultMappingPanel({client,onChanged}:{client:VaultMappingClient|null;onChanged?:()=>void}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [data,setData]=useState<VaultMappingInspection|null>(null),[rules,setRules]=useState<VaultMappingRule[]>([]),[preview,setPreview]=useState<VaultMappingPreview|null>(null);
  async function read(){if(!client)return;setBusy(true);setError('');try{const value=await client.inspect();setData(value);setRules(value.rules);setPreview(null);setNotice('');setOpen(true);}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}}
  function edit(index:number,patch:Partial<VaultMappingRule>){setRules(rows=>rows.map((r,i)=>i===index?{...r,...patch}:r));setPreview(null);setNotice('');}
  async function run(confirm:boolean){if(!client||!data)return;setBusy(true);setError('');try{if(confirm){const saved=await client.save(rules,data.revision);setData({...data,...saved});setNotice(saved.diagnostics?.length?'规则已保存，但部分资料登记失败，请检查下方提示。':'已确认映射并登记独立练习记录；原始笔记和掌握状态保持不变。');setPreview(null);onChanged?.();}else setPreview(await client.preview(rules));}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  return <section className="vault-mapping"><h3>资料结构映射</h3><p>按你的目录、表格或标题提取学习内容。建议需要预览并确认。</p>{!client?<p>先连接并配对本机 Companion，再读取学习库结构。</p>:<button type="button" disabled={busy} onClick={()=>void read()}>读取并设置映射</button>}{!open&&error&&<p role="alert">{error}</p>}
    <StudyPanel open={open} onClose={()=>setOpen(false)} title="学习库资料映射"><div className="vault-mapping">
      {data&&<><p>抽样 {data.sampledFiles} / 最多 {data.sampleLimit} 篇 · 建议置信度 {Math.round(data.confidence*100)}%</p>{data.ambiguous&&<p>检测到多种结构，请逐条核对建议；不会自动应用。</p>}<button type="button" disabled={busy} onClick={()=>{setRules(data.suggestions);setPreview(null);setNotice('');}}>将抽样建议放入待预览规则</button></>}
      <p>规则按顺序匹配，每篇资料使用第一条规则。确认后会创建独立练习记录，用于本机练习和账号同步；原始笔记和原有掌握状态保持不变。</p>
      {rules.map((rule,index)=><fieldset key={index} disabled={busy}><legend>规则 {index+1}</legend>
        <label>相对路径或匹配模式<input value={rule.pathGlob} onChange={e=>edit(index,{pathGlob:e.target.value})}/></label>
        <label>学科名称<input value={rule.subjectLabel} onChange={e=>edit(index,{subjectLabel:e.target.value})}/></label>
        <label>稳定学科身份<input value={rule.subjectId} onChange={e=>edit(index,{subjectId:e.target.value})}/></label>
        <label>内容类型<select value={rule.contentKind} onChange={e=>edit(index,{contentKind:e.target.value as VaultMappingRule['contentKind']})}><option value="quiz">概念回忆</option><option value="vocabulary">词汇</option><option value="code">代码（表格格式）</option></select></label>
        <label>拆分方式<select value={rule.splitMode} onChange={e=>edit(index,{splitMode:e.target.value as VaultMappingRule['splitMode']})}><option value="heading">标题</option><option value="table">表格</option><option value="callout">提示块</option></select></label>
        {rule.splitMode==='heading'&&<label>标题级别<input type="number" min="1" max="6" value={rule.headingLevel} onChange={e=>edit(index,{headingLevel:Number(e.target.value)})}/></label>}
        <button type="button" onClick={()=>{setRules(rows=>rows.filter((_,i)=>i!==index));setPreview(null);}}>移除规则 {index+1}</button>
      </fieldset>)}
      <button type="button" disabled={busy} onClick={()=>{setRules(rows=>[...rows,{pathGlob:'Courses/**/*.md',subjectId:`mapped:subject-${crypto.randomUUID().slice(0,8)}`,subjectLabel:'新学科',contentKind:'quiz',splitMode:'heading',headingLevel:2}]);setPreview(null);}}>添加规则</button>
      <button type="button" disabled={busy} onClick={()=>void run(false)}>预览提取结果</button>
      {preview&&<div aria-live="polite"><p>匹配 {preview.itemCount} 条；展示前 20 条。请确认问题、答案和来源。</p>{preview.items.map(item=><article key={item.id}><strong>{item.word||item.prompt}</strong><p>{item.meaning||item.answer}</p><small>{item.sourceNote}</small></article>)}<button type="button" disabled={busy} onClick={()=>void run(true)}>确认并保存 {rules.length} 条规则</button></div>}
      {(preview?.diagnostics??data?.diagnostics??[]).length>0&&<div role="status"><p>以下资料暂未导入；其他资料仍可使用。</p><ul>{(preview?.diagnostics??data?.diagnostics??[]).map((diagnostic,index)=><li key={`${diagnostic.path}-${index}`}>{diagnostic.path}：{diagnostic.message}</li>)}</ul></div>}
      {busy&&<p role="status">正在处理…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </div></StudyPanel></section>;
}
