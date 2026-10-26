import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';
import {tsxFunction} from './fixtures/tsx-functions.mjs';

const support={schemaVersion:1,type:'quiz',selection:'multiple',options:[{optionId:'a',text:'Claim A'},{optionId:'b',text:'Claim B'},{optionId:'c',text:'Wrong claim'}],correctOptionIds:['a','b']};
const data={prompt:'Select supported claims',learningSupport:support};
function fixture(file,name,props){
 const hooks=createHooks();
 const overrides={
  'app/learning-draft.ts':{useLearningDraftState:(draft,key,fallback)=>hooks.api.useState(()=>draft?.read?.(key,fallback)??fallback)},
  'app/assistance-display.ts':{useAssistance:()=>undefined,useAssistanceDisplay(){}},
  'app/use-study-shortcuts.ts':{useStudyShortcuts(){}},
  'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
 };
 const load=loader(hooks.api,overrides),Component=load(file)[name];
 const first=Component===undefined?null:hooks.mount(Component,props);
 // Public quiz entrypoints validate material before rendering their stateful UI.
 if(typeof first?.type==='function'&&['NonWordQuiz','StructuredQuiz'].includes(name))hooks.mount(first.type,first.props);
 const render=()=>{const view=hooks.render();hooks.flush();return view;};
 return {hooks,render,view:()=>hooks.view()};
}
for(const [selection,rating] of [[['a','b'],'good'],[['a'],'hard'],[['a','c'],'again']]){
 for(const path of ['continue','skip-remediation','complete-remediation']){
  test(`F02 nonword first ${rating} survives ${path} and saved-feedback receipt`,async()=>{
   let state={selection,first:null,phase:'answer',retry:null},f;
   const grades=[],assessments=[],remediations=[];
   const props=()=>({data,state,setState:next=>{state=typeof next==='function'?next(state):next;},onGrade:grade=>grades.push(grade),lifecycle:{submit:async()=>{},assess:async value=>assessments.push(value),recordRemediation:async(_,value)=>remediations.push(value)}});
   f=fixture('src/features/nonword-study/quiz.tsx','NonWordQuiz',props());
   await button(f.view(),'提交答案').props.onClick();await tick();
   f.hooks.render({...props(),material:{selection:'multiple',options:support.options.map(o=>({id:o.optionId,text:o.text})),correctIds:['a','b']}});f.hooks.flush();
   assert.equal(assessments[0].rating,rating);
   const first=structuredClone(state.first);
   if(path==='complete-remediation'&&rating!=='good'){
    button(f.view(),'收起解释，再试一次').props.onClick();
    f.hooks.render({...props(),material:{selection:'multiple',options:support.options.map(o=>({id:o.optionId,text:o.text})),correctIds:['a','b']}});
    for(const choice of ['Claim A','Claim B']){
     [...nodes(f.view())].find(n=>n.type==='button'&&text(n).includes(choice)).props.onClick();
     f.hooks.render({...props(),material:{selection:'multiple',options:support.options.map(o=>({id:o.optionId,text:o.text})),correctIds:['a','b']}});
    }
    button(f.view(),'核对这次补练').props.onClick();await tick();
    f.hooks.render({...props(),material:{selection:'multiple',options:support.options.map(o=>({id:o.optionId,text:o.text})),correctIds:['a','b']}});
    assert.equal(remediations[0].rating,'good');assert.deepEqual(state.first,first);
   }
   const finish=[...nodes(f.view())].find(n=>n.type==='button'&&text(n).includes('继续'));
   finish.props.onClick();await tick();finish.props.onClick();await tick();
   assert.deepEqual(grades,[rating]);
   // A saved formal receipt must advance rather than emit a second grade.
   let advances=0;
   const saved=fixture('src/features/nonword-study/quiz.tsx','NonWordQuiz',{...props(),hasSavedFeedback:()=>true,continueAfterFeedback:()=>++advances});
   [...nodes(saved.view())].find(n=>n.type==='button'&&text(n).includes('继续')).props.onClick();await tick();
   assert.equal(advances,1);assert.deepEqual(grades,[rating]);
  });
 }
 test(`F02/A01 structured ${rating} emits matching grade and focuses concise feedback once`,()=>{
  const grades=[],f=fixture('app/plugins/structured-quiz.tsx','StructuredQuiz',{data,onGrade:r=>grades.push(r),context:{draft:{read:(key,fallback)=>key==='quizSelectedIds'?selection:fallback}}});
  button(f.view(),'提交答案').props.onClick();f.hooks.render();
  const title=[...nodes(f.view())].find(n=>n.type==='h3');assert.equal(title.props.tabIndex,-1);
  let focused=0;title.props.ref.current={focus:()=>focused++};f.hooks.flush();
  assert.equal(focused,1);f.render();assert.equal(focused,1,'later input renders must not steal focus');
  const status=[...nodes(f.view())].find(n=>n.props.role==='status'&&text(n).includes('已提交'));assert.ok(status);
  [...nodes(f.view())].find(n=>n.type==='button'&&text(n).includes('继续')).props.onClick();assert.deepEqual(grades,[rating]);
 });
}

test('A02 tutor retains a stable error region, relates input, clears stale error on retry',async()=>{
 const request=deferred(),questions=[];
 let calls=0;
 const f=fixture('app/plugins/tutor-follow-up.tsx','TutorFollowUp',{item:{},askTutor:async q=>{questions.push(q);if(++calls===1)throw Error('Synthetic failure');return request.promise;}});
 let input=[...nodes(f.view())].find(n=>n.type==='input');
 let region=[...nodes(f.view())].find(n=>n.props.role==='status'&&n.props.id);
 assert.ok(region,'error notification container exists before a failure');const id=region.props.id;
 input.props.onChange({target:{value:'Why is A incomplete?'}});f.render();button(f.view(),'提问').props.onClick();await tick();f.render();
 input=[...nodes(f.view())].find(n=>n.type==='input');region=[...nodes(f.view())].find(n=>n.props.id===id);
 assert.equal(input.props['aria-describedby'],id);assert.equal(input.props['aria-invalid'],true);assert.equal(text(region),'Synthetic failure');assert.equal(input.props.value,'Why is A incomplete?');
 button(f.view(),'提问').props.onClick();f.render();region=[...nodes(f.view())].find(n=>n.props.id===id);
 assert.equal(text(region),'');assert.equal([...nodes(f.view())].find(n=>n.type==='input').props.value,'Why is A incomplete?');
 request.resolve('A omits B');await tick();f.render();assert.equal(text([...nodes(f.view())].find(n=>n.props.id===id)),'');assert.deepEqual(questions,['Why is A incomplete?','Why is A incomplete?']);
});

test('A03 paper source tabs have one stop and keyboard selection agrees with panel linkage',()=>{
 const f=fixture('app/paper-sources-panel.tsx','PaperSourcesPanel',{services:{},onImport:async()=>{}});
 button(f.view(),'选择论文 / 上传文件').props.onClick();f.render();
 const tabs=()=>[...nodes(f.view())].filter(n=>n.props.role==='tab');
 const focus=[];
 const assertState=index=>{
  const items=tabs();assert.equal(items.filter(n=>n.props.tabIndex===0).length,1);assert.equal(items[index].props['aria-selected'],true);assert.equal(items[index].props.tabIndex,0);
  const panel=[...nodes(f.view())].find(n=>n.props.role==='tabpanel');assert.ok(panel);assert.equal(panel.props.id,items[index].props['aria-controls']);assert.equal(panel.props['aria-labelledby'],items[index].props.id);
 };
 assertState(0);
 for(const [key,index] of [['ArrowRight',1],['End',2],['ArrowRight',0],['ArrowLeft',2],['Home',0]]){
  tabs().forEach((tab,i)=>{tab.props.ref({focus:()=>focus.push(i)});});
  const current=tabs().find(n=>n.props['aria-selected']);let prevented=false;
  current.props.onKeyDown({key,preventDefault:()=>prevented=true});f.render();assert.equal(prevented,true);assertState(index);assert.equal(focus.at(-1),index);
 }
 tabs()[2].props.onClick();f.render();assertState(2);assert.equal(focus.at(-1),2);
 tabs()[1].props.onFocus();f.render();assertState(1);
});

for(const [file,owner,ready] of [
 ['../src/features/nonword-study/quiz.tsx','QuizInteraction',{feedback:{status:'partial'}}],
 ['../app/plugins/structured-quiz.tsx','StructuredQuizUI',{submitted:true}],
])test(`A01 ${owner} consumes focus intent once and preserves a newer input focus`,()=>{
 const origin={},newInput={},document={activeElement:newInput,body:{}},feedbackFocus={current:{origin}};let focused=0;
 const effect=tsxFunction(new URL(file,import.meta.url),owner,{...ready,document,feedbackFocus,feedbackTitle:{current:{focus:()=>focused++}}},{effect:'feedbackFocus.current'});
 effect();assert.equal(focused,0);assert.equal(feedbackFocus.current,null);
 document.activeElement=origin;effect();assert.equal(focused,0,'a later render cannot replay skipped focus');
 feedbackFocus.current={origin};effect();assert.equal(focused,1);effect();assert.equal(focused,1);
});

test('A03 switching to an unconnected source invalidates a previous catalog read',async()=>{
 const request=deferred();let queries=0;
 const props={services:{localLibraryId:'fixture',libraryClient:{catalog:()=>{queries++;return request.promise;}}},onImport:async()=>{}};
 const f=fixture('app/paper-sources-panel.tsx','PaperSourcesPanel',props);
 button(f.view(),'选择论文 / 上传文件').props.onClick();f.render();
 button(f.view(),'Obsidian / 本机').props.onClick();f.render();assert.equal(queries,1);
 f.hooks.render({...props,services:{localLibraryId:'fixture'}});
 button(f.view(),'Notion').props.onClick();f.render();
 request.reject(Error('obsolete catalog failure'));await tick();f.render();
 assert.ok(text(f.view()).includes('连接 Companion 后可读取'));
 assert.ok(!text(f.view()).includes('obsolete catalog failure'));
 assert.ok(!text(f.view()).includes('正在读取并整理正文'));
});

test('A02 tutor Enter preserves input-method composition and rejects repeat submission',async()=>{
 const request=deferred();let calls=0;
 const f=fixture('app/plugins/tutor-follow-up.tsx','TutorFollowUp',{item:{},askTutor:()=>{calls++;return request.promise;}});
 [...nodes(f.view())].find(n=>n.type==='input').props.onChange({target:{value:'Question'}});f.render();
 const input=[...nodes(f.view())].find(n=>n.type==='input'),event={key:'Enter',nativeEvent:{},preventDefault(){}};
 input.props.onCompositionStart();input.props.onKeyDown(event);assert.equal(calls,0);
 input.props.onCompositionEnd();input.props.onKeyDown({...event,nativeEvent:{isComposing:true}});assert.equal(calls,0);
 input.props.onKeyDown(event);input.props.onKeyDown(event);assert.equal(calls,1);
 request.resolve('Answer');await tick();
});

test('F02 source-reference mismatch preserves the saved first partial rating',async()=>{
 const grades=[],first={selection:['a'],result:{status:'partial',matched:['a'],missing:['b'],wrong:[]}};
 const f=fixture('src/features/nonword-study/quiz.tsx','NonWordQuiz',{
  data:{...data,learningSupport:{...support,correctOptionIds:['c']}},
  state:{selection:['a'],first,phase:'feedback',retry:null},setState(){},onGrade:r=>grades.push(r),
 });
 assert.ok(text(f.view()).includes('当前参考与已保存结果不一致'));
 [...nodes(f.view())].find(n=>n.type==='button'&&text(n).includes('继续')).props.onClick();await tick();assert.deepEqual(grades,['hard']);
});
