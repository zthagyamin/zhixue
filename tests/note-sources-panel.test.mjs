import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {dashboardEffect} from './fixtures/dashboard-functions.mjs';
import {companionSessionRecordKey} from '../app/companion-endpoint.ts';
const source=await readFile(new URL('../app/note-sources-panel.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const exports={};
new Function('require','exports',code)(name=>{
  if(name==='react')return React;if(name==='react/jsx-runtime')return jsx;
  if(name==='./study-session-shell')return {StudyPanel:()=>null};
  if(name.endsWith('.css'))return {};throw new Error('Unexpected dependency '+name);
},exports);
const props={endpoint:'http://127.0.0.1:43121',token:'test-session',capabilities:[],onChanged(){},onDetected(){}};
test('paired older installations have actionable upgrade and recheck controls',()=>{
  const html=renderToStaticMarkup(React.createElement(exports.NoteSourcesPanel,props));
  assert.match(html,/href="\/downloads\/Zhixue-Companion-Setup.exe"/);assert.match(html,/更新后重新检测/);
});
test('fresh users are directed to pairing while supported installs can open source management',()=>{
  assert.match(renderToStaticMarkup(React.createElement(exports.NoteSourcesPanel,{...props,token:null})),/href="#companion-pairing"/);
  assert.match(renderToStaticMarkup(React.createElement(exports.NoteSourcesPanel,{...props,capabilities:['note-sources-v1']})),/管理笔记来源/);
});
test('dashboard persists disconnected second endpoint without erasing the first session',()=>{
  const saved=new Map();const saveWorkspaceRecord=(owner,key,value)=>saved.set(owner+key,value);
  for(const [port,session] of [[43121,{token:'first'}],[43125,null]])dashboardEffect('saveWorkspaceRecord(workspaceId, companionSessionRecordKey', {storageReady:true,workspaceId:'owner',companionUrl:'http://127.0.0.1:'+port,companionSession:session,saveWorkspaceRecord,companionSessionRecordKey})();
  assert.deepEqual(saved.get('ownercompanion-session:43121'),{session:{token:'first'}});
  assert.deepEqual(saved.get('ownercompanion-session:43125'),{session:null});
});
