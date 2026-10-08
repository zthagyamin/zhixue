// Explicitly synthetic service adapters. The application components and IndexedDB implementation are real.
export const replacements={
 'app/study-guidance.tsx':'export const StudyGuidance=()=>null,StudyGuidanceHelp=()=>null;',
 'app/review-context.tsx':'export const ReviewContext=()=>null;',
 'app/study-item-source.tsx':'export const StudyItemSource=()=>null;',
 'app/math-text.tsx':"import {createElement} from 'react';export const MathText=({text})=>createElement('span',null,text);",
 'app/ai/use-report-study-ai-item.ts':'export const useReportStudyAIItem=()=>{};',
 'app/components/code-editor.tsx':'export const CodeEditor=()=>null;',
 'app/hooks/use-pyodide.ts':'export const usePyodide=()=>({isReady:false,retry(){},cancel(){}});',
 'app/saved-trial-materials.tsx':'export const SavedTrialMaterials=()=>null;',
 'app/plugins/index.ts':`import {createElement as h} from 'react';import {useLearningDraftState} from '/app/learning-draft.tsx';
 function View({data,context,onGrade}){const [value,set]=useLearningDraftState(context?.draft,'answer','');return h('section',{'data-question':data.prompt},h('h2',null,data.prompt),h('input',{'aria-label':'隔离作答',value,onChange:e=>set(e.target.value)}),h('button',{onClick:()=>onGrade('good')},'模拟答对'),h('button',{onClick:()=>onGrade('again')},'模拟答错'),h('button',{onClick:()=>onGrade('good',{deferAdvance:true})},'模拟计算提交'),context?.draft?.hasSavedFeedback?.()&&h('button',{onClick:()=>context.draft.continueAfterFeedback()},'模拟继续'));}
 export const registry={get:()=>({renderUI:View})};`
};
export const fixture=String.raw`
import React,{useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';
import {PracticeSession} from '/app/practice-session';import {NoteTrial} from '/app/note-trial';
import {TutorFollowUp} from '/app/plugins/tutor-follow-up';import {CodePlugin} from '/app/plugins/plugin-code';
import {createLearningDraftStore} from '/app/learning-draft-store';
import {confirmStudyNavigation} from '/app/study-navigation-guard';import {openTrialMaterial} from '/app/trial-material-events';
import {saveWorkspaceRecord,loadWorkspaceRecord,exportRecoveryWorkspaceRecords} from '/app/local-study-db';
import {exportTrialMaterialBackup,restoreTrialMaterialBackup} from '/app/trial-material-backup';
import {trialMaterialRecordKind} from '/app/trial-material-backup-model';
const A={itemId:'A',fingerprint:'a',questionType:'quiz',prompt:'A',options:['a','b'],answer:0,explanation:'原题解析'};const B={...A,itemId:'B',fingerprint:'b',prompt:'B'};
const owner='account:causal-fixture',library='local:causal-fixture';
const probe={records:[],done:0,variants:0,loads:0,tutor:0,resolve:null,reject:null};window.__causal=probe;window.__reactVersion=React.version;
const client={getPractice:async()=>{if(++probe.loads===1)throw Error('模拟读取失败');return{items:[A,B]};},variantPractice:()=>{probe.variants++;return new Promise((resolve,reject)=>{probe.resolve=resolve;probe.reject=reject;});}};
const stored=[{id:'stored-b',prompt:'已保存材料 B',answer:'B 原文',filename:'B.md',section:null,kind:'qa'}];
async function backupRoundtrip(){
 const questions=[{id:'a',prompt:'比较 x < 0 与 x > 0',answer:'保留完整条件',filename:'条件.md',section:'比较',kind:'qa'}],body={subject:'数学',title:'备份样例',questions};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));const item={id:'trial-'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),...body};const kind=trialMaterialRecordKind(library);
 await saveWorkspaceRecord(owner,kind,[item]);await saveWorkspaceRecord(owner,'companion-session',{token:'NEVER_EXPORT'});
 const rows=await exportRecoveryWorkspaceRecords(owner);if(!rows.some(row=>row.kind===kind)||rows.some(row=>row.kind==='companion-session'))throw Error('Recovery whitelist failed');
 const backup=await exportTrialMaterialBackup(owner,library);await saveWorkspaceRecord(owner,kind,[]);
 await restoreTrialMaterialBackup(owner,library,backup);await restoreTrialMaterialBackup(owner,library,backup);
 const result=await loadWorkspaceRecord(owner,kind,[]);if(JSON.stringify(result)!==JSON.stringify([item]))throw Error('Roundtrip differs');
 let rejected=false;try{await restoreTrialMaterialBackup('account:foreign',library,backup);}catch{rejected=true;}if(!rejected)throw Error('Foreign owner accepted');return {count:result.length,secretExcluded:true,foreignRejected:true};
}
window.__backupRoundtrip=backupRoundtrip;
function App(){const [view,setView]=useState('practice'),[version,setVersion]=useState(0),[mode,setMode]=useState('normal');
 const drafts=useMemo(()=>createLearningDraftStore('browser:'+version),[version]);const items=useMemo(()=>mode==='load'?null:mode==='calc'?[{...A,questionType:'calculation',answer:'2'}]:[A,B],[mode,version]);
 window.__openMode=(next)=>{Object.assign(probe,{records:[],done:0,variants:0,loads:0,tutor:0});setMode(next);setView(next==='trial'?'trial':next==='tutor'?'tutor':next==='code'?'code':'practice');setVersion(v=>v+1);};
 return <main className="study-app" data-view={view}><button onClick={()=>{if(confirmStudyNavigation())setView('settings');}}>前往设置</button><button onClick={()=>openTrialMaterial(owner,library,stored)}>打开材料 B</button>
 {view==='practice'&&<PracticeSession key={version} items={items} drafts={drafts} companionClient={client} onRecordAttempt={async value=>{probe.records.push(value.item.itemId);}} onFinish={()=>{probe.done++;setView('done');}}/>}
 {view==='trial'&&<NoteTrial owner={owner} library={library} featured onConnect={()=>{if(confirmStudyNavigation())setView('settings');}}/>}
 {view==='tutor'&&<TutorFollowUp key={version} item={A} draft={drafts.adapter('tutor','1')} askTutor={async()=>{probe.tutor++;return '模拟回复';}}/>}
 {view==='code'&&<CodePlugin.renderUI key={version} data={{prompt:'如果 x < 0，返回 -1；如果 x > 0，返回 1。\nvector<int>\n<img src=x onerror=alert(1)>',initialCode:'',testCode:'assert True'}} context={{draft:drafts.adapter('code','1')}} onGrade={()=>{}}/>}
 {view==='done'&&<h2>隔离会话结束</h2>}{view==='settings'&&<h2>隔离设置页</h2>}
 </main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`;
