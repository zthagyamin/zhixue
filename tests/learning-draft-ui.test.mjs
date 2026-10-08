import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {dashboardJsxProp} from './fixtures/dashboard-functions.mjs';
const samples=[
  ['three-stage','plugins/plugin-three-stage.tsx','PluginThreeStage',{word:'cat',meaning:'猫',stage:1},{revealed:true,learned:true},/继续练习/],
  ['spelling','plugins/plugin-spelling.tsx','SpellingPlugin',{word:'cat',meaning:'猫'},{state:{word:'cat',input:'c',wrong:'x',wrongCount:3}},/value="cx"/],
  ['flashcard','plugins/plugin-flashcard.tsx','FlashcardPlugin',{front:'题面',back:'已展开参考'},{isFlipped:true},/已展开参考/],
  ['quiz','plugins/plugin-quiz.tsx','QuizPlugin',{topic:'阅读',prompt:'问题',options:['甲','乙'],answer:'乙',explanation:'参考'},{quizState:'lapse_typing',selectedOption:'乙',failedOnce:true,lapseInput:'尚未提交'},/value="尚未提交"/],
  ['recall','plugin-recall.tsx','RecallPlugin',{prompt:'问题',explanation:'参考'},{answer:'临时回忆输入'},/临时回忆输入/],
  ['calculation','plugin-calculation.tsx','CalculationPlugin',{prompt:'问题',answer:'3'},{value:'42'},/value="42"/],
  ['code','plugins/plugin-code.tsx','CodePlugin',{topic:'Python',prompt:'问题',initialCode:'pass',testCode:'',solutionCode:'',explanation:''},{code:'saved = 7',failedOnce:true},/saved = 7/],
];
for(const [mode,file,name,data,fields,expected]of samples)test(`${mode} restores its own temporary buffer without submitting anything`,()=>{
  const s=createLearningDraftStore(),draft=s.adapter('workspace:item:content',`${mode}:1`);for(const [key,value]of Object.entries(fields))draft.write(key,value);
  const plugin=loadTsx(new URL(`../app/${file}`,import.meta.url))[name];assert.ok(plugin);
  let grades=0;const html=renderToStaticMarkup(createElement(plugin.renderUI,{data,context:{draft:s.adapter('workspace:item:content',`${mode}:1`)},onGrade:()=>grades++}));
  assert.match(html,expected);assert.equal(grades,0);
});
test('restored complete spelling requires an explicit submission rather than replaying a cancelled timer',()=>{
  const s=createLearningDraftStore(),draft=s.adapter('word','spelling:1');draft.write('state',{word:'cat',input:'cat',wrong:'',wrongCount:3});
  const plugin=loadTsx(new URL('../app/plugins/plugin-spelling.tsx',import.meta.url)).SpellingPlugin;
  const html=renderToStaticMarkup(createElement(plugin.renderUI,{data:{word:'cat'},context:{draft},onGrade(){throw new Error('Restore cannot grade');}}));
  assert.match(html,/提交这次拼写/);
});
test('nested tutor and Python workspace restore inputs without replaying a request',()=>{
  const s=createLearningDraftStore(),draft=s.adapter('nested','quiz:1');draft.write('tutor.question','我还没发送的追问');draft.write('sandbox.code','x = 9');
  const {TutorFollowUp}=loadTsx(new URL('../app/plugins/tutor-follow-up.tsx',import.meta.url)),{PythonPlayground}=loadTsx(new URL('../app/components/python-playground.tsx',import.meta.url));
  const tutor=renderToStaticMarkup(createElement(TutorFollowUp,{draft,item:{},askTutor(){throw new Error('Restore cannot ask AI');}}));
  const code=renderToStaticMarkup(createElement(PythonPlayground,{draft,initialCode:'pass'}));
  assert.match(tutor,/我还没发送的追问/);assert.match(code,/x = 9/);
});
test('a sibling mode mounted during a pending save gets a fresh generation without redirecting navigation',()=>{
  const learningDrafts=createLearningDraftStore(),draftItemId='item',old=learningDrafts.adapter(draftItemId,'three-stage:1');
  old.write('learned',true);const ticket=old.begin();
  const sibling=learningDrafts.adapter(draftItemId,'spelling:1');sibling.read('state',{});
  const key=()=>dashboardJsxProp('LearningDraftBoundary','key',{draftItemId,learningDrafts});
  const before=key();learningDrafts.commit(ticket);assert.notEqual(key(),before,'same item/mode/stage must remount after invalidation');
  assert.equal(sibling.write('state',{input:'late'}),false,'old callbacks stay invalid');
  const fresh=learningDrafts.adapter(draftItemId,'spelling:1');fresh.write('state',{word:'cat',input:'c',wrong:'',wrongCount:0});
  const plugin=loadTsx(new URL('../app/plugins/plugin-spelling.tsx',import.meta.url)).SpellingPlugin;
  const html=renderToStaticMarkup(createElement(plugin.renderUI,{data:{word:'cat'},context:{draft:learningDrafts.adapter(draftItemId,'spelling:1')},onGrade(){throw new Error('Restore cannot grade');}}));
  assert.match(html,/value="c"/);
  const stable=key();learningDrafts.clearItem('unrelated');assert.equal(key(),stable,'other items must not reset this view');
});
test('identical question content in a replacement workspace never keeps the old hook adapter',()=>{
  const draftItemId='same-question-content',key=scope=>dashboardJsxProp('LearningDraftBoundary','key',{draftItemId,learningDrafts:createLearningDraftStore(scope)});
  assert.notEqual(key('account-a:library'),key('account-b:library'));
});

for(const correct of [true,false])test(`saved calculation feedback survives remount, correct=${correct}`,()=>{
 const store=createLearningDraftStore(),draft=store.adapter('calc','calculation:1');let advances=0;
 draft.write('value','42');draft.write('result',{correct,explanation:'请保留这段完整解析'});store.commit(draft.begin(),()=>advances++);
 const plugin=loadTsx(new URL('../app/plugin-calculation.tsx',import.meta.url)).CalculationPlugin;
 const html=renderToStaticMarkup(createElement(plugin.renderUI,{data:{prompt:'计算题',answer:'42'},context:{draft:store.adapter('calc','calculation:1')},onGrade(){throw new Error('Rendering saved feedback must never submit again');}}));
 assert.match(html,/请保留这段完整解析/);assert.match(html,/>继续<\/button>/);assert.match(html,/readonly=""/i);assert.doesNotMatch(html,/>(提交|重试保存)<\/button>/);assert.equal(advances,0);
});
