import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as prompts from '../app/knowledge-starter-prompts.ts';
const source=await readFile(new URL('../app/knowledge-starter-dialog.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function render(path){let first=true;const exports={};new Function('require','exports',code)(name=>{
  if(name==='react')return {...React,useState(value){const initial=first?path:value;first=false;return React.useState(initial);}};
  if(name==='react/jsx-runtime')return jsx;if(name==='./knowledge-starter-prompts')return prompts;
  if(name==='./study-session-shell')return {StudyPanel:({children})=>children};if(name.endsWith('.css'))return {};throw new Error(name);
},exports);return renderToStaticMarkup(React.createElement(exports.KnowledgeStarterDialog,{open:true,onClose(){},onConnect(){}}));}
test('existing users get a direct connection path without a rebuild requirement',()=>{
  const html=render('existing');assert.match(html,/已有知识库接入/);assert.match(html,/前往来源设置/);assert.match(html,/无需按入门包重建目录/);assert.doesNotMatch(html,/下载完整入门包/);
});
test('new users receive the starter directory and material preparation path',()=>{
  const html=render('new');assert.match(html,/从零建立知识库/);assert.match(html,/structure.zip/);assert.match(html,/Starter\/materials\//);assert.match(html,/材料准备好了，前往接入/);assert.match(html,/knowledge-starter-kit\/OBSIDIAN.md/);
});
test('personalized prompts preserve the chosen starting point and do not fabricate mastery',()=>{
  const profile={goal:'学习函数',level:'会循环',dailyMinutes:'25'};
  const existing=prompts.buildKnowledgeStarterPrompt(prompts.knowledgeStarterPrompts[1].prompt,profile,'existing');
  assert.match(existing,/我已有知识库/);assert.match(existing,/保留现有目录/);assert.match(existing,/25 分钟/);assert.match(existing,/学习函数/);assert.match(existing,/不生成 sourceNote、stateRef/);
  const fresh=prompts.buildKnowledgeStarterPrompt('整理材料',{goal:'',level:'',dailyMinutes:'-1'},'new');assert.match(fresh,/我还没有知识库/);assert.match(fresh,/尚未确定/);
});
