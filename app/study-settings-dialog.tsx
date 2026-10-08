"use client";

import {StudyPanel} from './study-session-shell';

export type SettingsModalKind='exporting'|'export-done'|'export-partial'|'confirm-clear'|'clearing'|'clear-done'|'blocked'|'failed';
const titles:Record<SettingsModalKind,string>={
  exporting:'正在生成恢复包','export-done':'恢复包已生成','export-partial':'仅生成部分恢复包',
  'confirm-clear':'清理读取缓存',clearing:'正在清理读取缓存','clear-done':'读取缓存已清理',
  blocked:'暂未执行',failed:'操作未完成',
};
export function SettingsActionDialog({kind,message,onClose,onConfirm}:{kind:SettingsModalKind|null;message:string;onClose:()=>void;onConfirm:()=>void}){
  const busy=kind==='exporting'||kind==='clearing';
  const success=kind==='export-done'||kind==='clear-done';
  return <StudyPanel open={kind!==null} onClose={onClose} title={kind?titles[kind]:'数据操作'} variant="center" dismissible={!busy}>
    <div className="settings-action-result" data-outcome={success?'success':busy?'pending':'notice'}>
      <span className={busy?'settings-action-spinner':'settings-action-symbol'} aria-hidden="true">{busy?'':success?'✓':kind==='confirm-clear'?'?':'!'}</span>
      {kind==='confirm-clear'?<>
        <p>只清理可重建的本机读取视图。题目、作答、草稿与待同步记录保留，不删除云端或学习知识库的数据。</p>
        <div className="settings-action-buttons"><button type="button" className="study-secondary-action" onClick={onClose}>取消</button><button type="button" className="study-primary-action" onClick={onConfirm}>确认清理读取缓存</button></div>
      </>:<>
        <p role="status">{busy?(kind==='exporting'?'正在核对并生成恢复数据，请稍候…':'正在清理读取视图，请稍候…'):message}</p>
        {!busy&&<button type="button" className="study-secondary-action" onClick={onClose}>知道了</button>}
      </>}
    </div>
  </StudyPanel>;
}
