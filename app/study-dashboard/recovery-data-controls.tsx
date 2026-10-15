'use client';
import {NonwordRecoveryRestore} from '../../src/features/nonword-recovery';
import {previewNonwordRestore,restoreNonwordBackup,readRecoveryArchives} from '../../src/infrastructure/nonword-recovery';
import type {RecoveryControlPort} from '../../src/application/nonword-recovery';
export {StudyTermHelp} from '../study-term-help';
const port:RecoveryControlPort={preview:previewNonwordRestore,restore:restoreNonwordBackup,archives:readRecoveryArchives};
/** Settings composition only; no grading, model or official-history writer is exposed. */
export function RecoveryDataControls({workspaceId,ready,onExport,onChanged}:{workspaceId:string|null;ready:boolean;onExport:()=>void;onChanged:()=>void}){
 return <><section className="settings-card"><div className="flex justify-between items-center"><div>
  <h4 className="font-bold text-sm text-[var(--ink)] mb-1">导出恢复数据包</h4>
  <p className="text-xs text-[var(--ink)] opacity-60">导出当前账号在此浏览器中的恢复数据。仅当前页面暂存、尚未提交的输入不等于已保存记录，请先处理；具体内容以恢复包为准。</p>
 </div><button type="button" className="study-secondary-action" disabled={!workspaceId||!ready} onClick={onExport}>导出恢复数据包</button></div></section>
 <NonwordRecoveryRestore key={workspaceId??'no-account'} workspaceId={workspaceId} ready={ready} onChanged={onChanged} port={port}/></>;
}
