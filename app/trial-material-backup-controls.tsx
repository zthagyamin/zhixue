'use client';
import {useEffect,useRef,useState} from 'react';
import {exportTrialMaterialBackup,restoreTrialMaterialBackup} from './trial-material-backup';
import {TRIAL_MATERIALS_CHANGED} from './trial-material-events';
/** Explicit device-only backup; never a general importer of events, credentials or server state. */
export function TrialMaterialBackupControls({owner,library}:{owner:string;library:string}){
 const life=useRef({active:true,busy:false}),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{const current=life.current;current.active=true;return()=>{current.active=false;};},[]);
 async function action(work:()=>Promise<void>){const current=life.current;if(current.busy)return;current.busy=true;setBusy(true);try{await work();}catch(error){if(current.active)setMessage(error instanceof Error?error.message:'材料操作失败，原材料保留。');}finally{current.busy=false;if(current.active)setBusy(false);}}
 return <details className="trial-material-backup"><summary>备份与恢复本机待学材料</summary><p>仅处理此空间已保存的题目、参考答案与出处，不包含试学输入、成绩、同步凭据或密钥。恢复是合并，不覆盖已有材料；账号恢复包也只导入此学习库的材料部分。</p>
 <button type="button" disabled={busy} onClick={()=>void action(async()=>{const backup=await exportTrialMaterialBackup(owner,library);if(!life.current.active)return;const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));try{const link=document.createElement('a');link.href=url;link.download='知学本机待学材料备份.json';link.click();setMessage('已生成本机材料备份，请妥善保存下载文件。');}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}})}>导出材料备份</button>
 <label>从材料备份或账号恢复包恢复<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;void action(async()=>{if(file.size>32*1024*1024)throw new Error('文件超过 32 MB，请使用单独的材料备份。');const raw:unknown=JSON.parse(await file.text());if(!life.current.active)return;if(!window.confirm('将校验并合并此账号、此学习库的本机待学材料；不恢复成绩或同步记录。继续吗？'))return;const count=await restoreTrialMaterialBackup(owner,library,raw,()=>life.current.active);if(life.current.active){window.dispatchEvent(new Event(TRIAL_MATERIALS_CHANGED));setMessage(`已核对恢复 ${count} 份材料；重复导入不会产生副本。`);}});}}/></label>
 {message&&<p role="status">{message}</p>}</details>;
}
