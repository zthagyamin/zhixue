"use client";
import {useEffect,useRef,useState} from 'react';
import type {VaultMappingClient,VaultMappingInspection,VaultMappingRule,VaultMappingPreview} from './vault-mapping-client';
import {StudyPanel} from './study-session-shell';
import './vault-mapping.css';
type MappingFrame={client:VaultMappingClient|null;epoch:number;operation:'read'|'preview'|'save'|null;alive:boolean};
type MappingView={frame:MappingFrame;open:boolean;busy:boolean;error:string;notice:string;data:VaultMappingInspection|null;rules:VaultMappingRule[];preview:VaultMappingPreview|null};
function emptyView(frame:MappingFrame):MappingView{return {frame,open:false,busy:false,error:'',notice:'',data:null,rules:[],preview:null};}
export function VaultMappingPanel({client,onChanged}:{client:VaultMappingClient|null;onChanged?:()=>void}){
  const identity=useRef<MappingFrame>({client,epoch:0,operation:null,alive:true});
  // A client transition must retire its frame during render, before effects or
  // an already-resolving promise can restore a previous owner's data. Eager
  // retirement also fails closed if React later abandons this render.
  /* eslint-disable react-hooks/refs -- Synchronous identity retirement prevents late owner results before effects run. */
  if(identity.current.client!==client)identity.current={client,epoch:0,operation:null,alive:true};
  const frame=identity.current,renderEpoch=frame.epoch;
  const [view,setView]=useState<MappingView>(()=>emptyView(frame));
  const {open,busy,error,notice,data,rules,preview}=view.frame===frame?view:emptyView(frame);
  useEffect(()=>{frame.alive=true;return()=>{frame.alive=false;frame.epoch++;frame.operation=null;};},[frame]);
  /* eslint-enable react-hooks/refs */
  const current=(epoch:number)=>frame.alive&&identity.current===frame&&frame.epoch===epoch;
  function update(patch:Partial<MappingView>){setView(old=>({...((old.frame===frame)?old:emptyView(frame)),...patch}));}
  function changeRules(change:(rows:VaultMappingRule[])=>VaultMappingRule[]){
    if(!frame.alive||identity.current!==frame)return;
    frame.epoch++;frame.operation=null;
    setView(old=>{const value=old.frame===frame?old:emptyView(frame);return {...value,rules:change(value.rules),preview:null,notice:'',error:'',busy:false};});
  }
  async function read(){
    if(!client||!frame.alive||identity.current!==frame||frame.operation==='read'||frame.operation==='save')return;
    const epoch=++frame.epoch;frame.operation='read';
    update({busy:true,error:'',notice:'',data:null,rules:[],preview:null});
    try{const value=await client.inspect();if(!current(epoch))return;update({data:value,rules:value.rules,open:true});}
    catch(e){if(current(epoch))update({error:e instanceof Error?e.message:'读取失败'});}
    finally{if(current(epoch)){frame.operation=null;update({busy:false});}}
  }
  function edit(index:number,patch:Partial<VaultMappingRule>){changeRules(rows=>rows.map((r,i)=>i===index?{...r,...patch}:r));}
  async function run(confirm:boolean){
    if(!client||!data||!current(renderEpoch)||frame.operation)return;
    if(confirm&&!preview){update({error:'请重新预览提取结果后再确认保存。'});return;}
    const epoch=++frame.epoch;frame.operation=confirm?'save':'preview';update({busy:true,error:'',notice:'',preview:confirm?preview:null});
    try{
      if(confirm&&preview){
        const saved=await client.save(rules,preview.revision,preview);if(!current(epoch))return;
        update({data:{...data,...saved},preview:null,notice:saved.diagnostics?.length?'规则已保存，但部分资料登记失败，请检查下方提示。':'已确认映射并登记独立练习记录；原始笔记和掌握状态保持不变。'});onChanged?.();
      }else{const value=await client.preview(rules,data.contextId);if(current(epoch))update({preview:value});}
    }catch(e){if(current(epoch))update({error:e instanceof Error?e.message:'操作失败'});}
    finally{if(current(epoch)){frame.operation=null;update({busy:false});}}
  }
  function close(){if(identity.current!==frame)return;frame.epoch++;frame.operation=null;update({open:false,busy:false,preview:null,notice:'',error:''});}
  return <section className="vault-mapping"><h3>资料结构映射</h3><p>按你的目录、表格或标题提取学习内容。建议需要预览并确认。</p>{!client?<p>先连接并配对本机 Companion，再读取学习库结构。</p>:<button type="button" disabled={busy} onClick={()=>void read()}>读取并设置映射</button>}{!open&&error&&<p role="alert">{error}</p>}
    <StudyPanel open={open} onClose={close} title="学习库资料映射"><div className="vault-mapping">
      {data&&<><p>抽样 {data.sampledFiles} / 最多 {data.sampleLimit} 篇 · 建议置信度 {Math.round(data.confidence*100)}%</p>{data.ambiguous&&<p>检测到多种结构，请逐条核对建议；不会自动应用。</p>}<button type="button" disabled={busy} onClick={()=>changeRules(()=>data.suggestions)}>将抽样建议放入待预览规则</button></>}
      <p>规则按顺序匹配，每篇资料使用第一条规则。确认后会创建独立练习记录，用于本机练习和账号同步；原始笔记和原有掌握状态保持不变。</p>
      {rules.map((rule,index)=><fieldset key={index} disabled={busy}><legend>规则 {index+1}</legend>
        <label>相对路径或匹配模式<input value={rule.pathGlob} onChange={e=>edit(index,{pathGlob:e.target.value})}/></label>
        <label>学科名称<input value={rule.subjectLabel} onChange={e=>edit(index,{subjectLabel:e.target.value})}/></label>
        <label>稳定学科身份<input value={rule.subjectId} onChange={e=>edit(index,{subjectId:e.target.value})}/></label>
        <label>内容类型<select value={rule.contentKind} onChange={e=>edit(index,{contentKind:e.target.value as VaultMappingRule['contentKind']})}><option value="quiz">概念回忆</option><option value="vocabulary">词汇</option><option value="code">代码（表格格式）</option></select></label>
        <label>拆分方式<select value={rule.splitMode} onChange={e=>edit(index,{splitMode:e.target.value as VaultMappingRule['splitMode']})}><option value="heading">标题</option><option value="table">表格</option><option value="callout">提示块</option></select></label>
        {rule.splitMode==='heading'&&<label>标题级别<input type="number" min="1" max="6" value={rule.headingLevel} onChange={e=>edit(index,{headingLevel:Number(e.target.value)})}/></label>}
        <button type="button" onClick={()=>changeRules(rows=>rows.filter((_,i)=>i!==index))}>移除规则 {index+1}</button>
      </fieldset>)}
      <button type="button" disabled={busy} onClick={()=>changeRules(rows=>[...rows,{pathGlob:'Courses/**/*.md',subjectId:`mapped:subject-${crypto.randomUUID().slice(0,8)}`,subjectLabel:'新学科',contentKind:'quiz',splitMode:'heading',headingLevel:2}])}>添加规则</button>
      <button type="button" disabled={busy} onClick={()=>void run(false)}>预览提取结果</button>
      {preview&&<div aria-live="polite"><p>匹配 {preview.itemCount} 条；展示前 20 条。请确认问题、答案和来源。</p>{preview.items.map(item=><article key={item.id}><strong>{item.word||item.prompt}</strong><p>{item.meaning||item.answer}</p><small>{item.sourceNote}</small></article>)}<button type="button" disabled={busy} onClick={()=>void run(true)}>确认并保存 {rules.length} 条规则</button></div>}
      {(preview?.diagnostics??data?.diagnostics??[]).length>0&&<div role="status"><p>以下资料暂未导入；其他资料仍可使用。</p><ul>{(preview?.diagnostics??data?.diagnostics??[]).map((diagnostic,index)=><li key={`${diagnostic.path}-${index}`}>{diagnostic.path}：{diagnostic.message}</li>)}</ul></div>}
      {busy&&<p role="status">正在处理…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    </div></StudyPanel></section>;
}
