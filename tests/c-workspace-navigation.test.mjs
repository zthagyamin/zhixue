import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

const file=new URL('../app/study-workspace-navigation.tsx',import.meta.url);
const ui=existsSync(file)?loadTsx(file):{};
const subjects=[{id:'botany',name:'植物分类'},{id:'phonetics',name:'语音实验'}];
const shell=loadTsx(new URL('../app/study-session-shell.tsx',import.meta.url));
function elements(node){
  if(!node||typeof node!=='object')return [];
  return [node,...[node.props?.children].flat(Infinity).flatMap(elements)];
}
test('workspace navigation exposes dynamic subjects and every existing destination',()=>{
  assert.equal(typeof ui.StudyWorkspaceNavigation,'function');
  const html=renderToStaticMarkup(h(ui.StudyWorkspaceNavigation,{activeId:'today',subjects,onNavigate(){},onSettings(){},settingsCount:2}));
  assert.match(html,/植物分类/);assert.match(html,/语音实验/);
  assert.match(html,/aria-label="今日"/);assert.match(html,/aria-label="学习进度"/);assert.match(html,/aria-label="数据与设置"/);
  assert.match(html,/<details/);assert.match(html,/aria-current="page"/);
  assert.doesNotMatch(html,/IELTS|Python/);
});
test('choosing a subject closes its disclosure and forwards its stable identity',()=>{
  assert.equal(typeof ui.StudyWorkspaceNavigation,'function');
  let chosen=null,closed=false;
  const tree=ui.StudyWorkspaceNavigation({activeId:'today',subjects,onNavigate:id=>{chosen=id;},onSettings(){}});
  const button=elements(tree).find(node=>node.props?.['aria-label']==='语音实验');
  assert.ok(button);
  button.props.onClick({currentTarget:{closest:()=>({removeAttribute(name){if(name==='open')closed=true;}})}});
  assert.equal(chosen,'phonetics');assert.equal(closed,true);
});
test('plan metrics keep approved word scope separate from review tasks and unknown completion',()=>{
  assert.equal(typeof shell.StudyPlanMetrics,'function');
  const tasks=[{taskId:'new',category:'new-word',quantity:15},{taskId:'review',category:'review',quantity:3},{taskId:'lab',category:'subject',quantity:8}];
  const html=renderToStaticMarkup(h(shell.StudyPlanMetrics,{tasks,completedTaskIds:['review'],ready:true,itemProgressByTask:{new:{completed:8,total:15}}}));
  assert.match(html,/15/);assert.match(html,/新词/);assert.match(html,/必做复习/);
  assert.match(html,/还需复习 0 项任务/);assert.match(html,/还需学习 7 词/);
  const pending=renderToStaticMarkup(h(shell.StudyPlanMetrics,{tasks,completedTaskIds:['review'],ready:false}));
  assert.match(pending,/完成情况待核对/);assert.doesNotMatch(pending,/已完成 1/);
});
