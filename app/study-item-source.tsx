'use client';
import {useEffect,useId,useState} from 'react';
import {resolveItemSource,itemSourceNotice,type ItemSourceFields} from './study-item-source-model';
import {buildObsidianOpenUri,obsidianPreferenceKey,safeExistingObsidianUri} from './obsidian-link';
import {copyTextSafely} from './clipboard';
import './ux-remedies.css';
type Props={item:ItemSourceFields;source:{title:string;scope:string};canOpenLocal:boolean;getObsidianUri:(path:string)=>string;preferenceScope?:string};
export function StudyItemSource(props:Props){
 const location=resolveItemSource(props.item);
 return <div className="study-source-detail" data-ai-private>
  <p className="study-meta">当前资料</p><h3>{props.source.title}</h3><p>{props.source.scope}</p>
  <div className="study-item-source-location mt-2 pt-2 border-t border-[var(--line)]">
   <p className="text-xs font-bold text-[var(--ink)]">本题出处：{location.label}</p>
   {location.section&&<p className="study-meta">小节 / 锚点：{location.section}</p>}
   {location.description&&<p className="study-meta">来源说明：{location.description}</p>}
  </div>
  <p className="study-meta mt-2">{itemSourceNotice(location,props.canOpenLocal)}</p>
  {location.notePath&&<SourceNoteActions key={JSON.stringify([props.preferenceScope,props.source.title,props.source.scope,location.notePath,location.section])} path={location.notePath} section={location.section} {...props}/>}
  <p className="study-meta">此面板不读取或上传原文。协议链接只向本机 Obsidian 发出打开请求，不传输文件；需要本机已安装 Obsidian，并有对应笔记。未安装或路径不一致时，可复制路径查找。</p>
 </div>;
}
function SourceNoteActions({path,section,canOpenLocal,getObsidianUri,preferenceScope}:{path:string;section:string|null}&Props){
 const [vault,setVault]=useState(''),[message,setMessage]=useState('');
 const vaultHelpId=useId();
 useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(!active||!preferenceScope)return;try{const saved=localStorage.getItem(obsidianPreferenceKey(preferenceScope));if(saved&&saved.length<=200)setVault(saved);}catch{/* Optional device-only preference. */}});return()=>{active=false;};},[preferenceScope]);
 const target=path+(section?'#'+section:'');
 let existing:string|null=null;if(canOpenLocal){try{existing=safeExistingObsidianUri(getObsidianUri(target));}catch{/* Still offer copying the source. */}}
 const uri=buildObsidianOpenUri(vault,path,section)??existing;
 return <>
  {uri&&<a className="study-source-link" href={uri}>在本机 Obsidian 中打开所属笔记</a>}
  <button type="button" onClick={()=>{void copyTextSafely(target).then(ok=>setMessage(ok?'笔记路径及小节已复制。':'复制不可用，请选中下方路径手动复制。'));}}>复制笔记路径与小节</button>
  <code className="study-source-path">{target}</code>
  <details><summary>{uri?'调整本机笔记库名称':'设置本机笔记库名称以打开 Obsidian'}</summary><p className="study-meta">填写本机 Obsidian 中的库名或库 ID，不是网页登录账号。这里不配置同步，也不要求本地资料助手在线。</p>
   <label>本机 Obsidian 库名<input maxLength={200} value={vault} onChange={event=>{setVault(event.target.value);setMessage('');}} placeholder="例如：MyVault" aria-describedby={vaultHelpId} autoComplete="off"/></label>
   <p id={vaultHelpId} className="study-meta">填写 Obsidian 库切换器中显示的知识库名称，例如 MyVault 或“学习笔记”，不要填写文件夹的完整磁盘路径。</p>
   <button type="button" disabled={!vault.trim()} onClick={()=>{if(!buildObsidianOpenUri(vault,path,section)){setMessage('库名或笔记路径无效，请检查。');return;}if(!preferenceScope){setMessage('库名仅用于当前来源面板；已可点击上方链接。');return;}try{localStorage.setItem(obsidianPreferenceKey(preferenceScope),vault.trim());setMessage('已记住这台设备上此学习库的名称。');}catch{setMessage('浏览器未允许保存库名，本次仍可打开链接。');}}}>记住库名</button>
  </details>
  {message&&<p role="status" className="study-meta">{message}</p>}
 </>;
}
