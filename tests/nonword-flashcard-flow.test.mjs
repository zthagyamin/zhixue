import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';

function fixture({purpose='first',failSubmit=false,failAssess=false,failGrade=false,submitWait,noPort=false,restored}={}){
  const hooks=createHooks(),calls=[],grades=[],assessments=[],moves=[];let submitted=false,submitFailures=Number(failSubmit),assessFailures=Number(failAssess),gradeFailures=Number(failGrade),swipe;
  const lifecycle={ready:true,purpose,intent:'review',attemptId:'synthetic-card-attempt',get submitted(){return submitted;},
    async submit(answer){calls.push(['submit',answer]);await submitWait?.promise;if(submitFailures-- >0)throw Error('synthetic answer save failure');submitted=true;},
    async assess(outcome){calls.push(['assess',outcome.rating]);if(assessFailures-- >0)throw Error('synthetic assessment save failure');assessments.push(outcome);},
    async waitForReview(){assert.fail('explicit self-assessment is not an invented unknown verdict');},async continuePending(){assert.fail('explicit self-assessment does not use unknown continuation');},
    async startRemediation(){calls.push(['start-child']);},async finishRemediation(){moves.push('finish-child');},
  };
  function MathText(){return null;}
  const load=loader(hooks.api,{'app/math-text.tsx':{MathText},'app/study-guidance.tsx':{StudyGuidance:()=>null},
    'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},'app/assistance-display.tsx':{useAssistance:()=>({submit:()=>calls.push(['observation'])}),useAssistanceDisplay(){}},
    'app/use-study-swipe.ts':{useStudySwipe:props=>{swipe=props;return{};}},'src/features/remediation/index.ts':{CandidateLauncher:()=>null}},
    {addEventListener(){},removeEventListener(){}});
  const store=load('app/learning-draft-store.ts').createLearningDraftStore('flashcard-flow'),draft=store.adapter('A','flashcard:1');
  for(const [field,value]of Object.entries(restored??{}))draft.write(field,value);
  if(restored?.flashcardSaved){submitted=true;store.commit(draft.begin(),()=>moves.push('formal'));}
  const data={itemId:'A',front:'$F = ma$ 中三个符号各表示什么？',back:'力 $F$ 等于质量 $m$ 与加速度 $a$ 的乘积。'};
  const props={data,context:{draft,...(noPort?{}:{nonWordLearning:lifecycle})},
    async onGrade(rating,options){grades.push({rating,options});if(gradeFailures-- >0)throw Error('synthetic formal save failure');if(options?.deferAdvance){const ticket=draft.begin();if(ticket)store.commit(ticket,()=>moves.push('formal'));}}};
  const shell=load('app/plugins/plugin-flashcard.tsx').FlashcardPlugin.renderUI(props);hooks.mount(shell.type,shell.props);hooks.flush();
  return {hooks,store,draft,calls,grades,assessments,moves,lifecycle,data,MathText,props:shell.props,swipe:()=>swipe,
    click:async(label)=>{const target=button(hooks.view(),label)||[...nodes(hooks.view())].find(node=>node.type==='button'&&text(node).startsWith(label));assert.ok(target,`Missing ${label}`);await target.props.onClick();await settle(hooks);}};
}
async function settle(hooks){for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}}

test('a refreshed lifecycle object for the same durable attempt does not cancel its own rating save',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});await f.click('显示答案');
  const operation=f.click('忘记');await tick();
  const refreshed=Object.create(Object.getPrototypeOf(f.lifecycle),Object.getOwnPropertyDescriptors(f.lifecycle));
  f.hooks.render({...f.props,context:{...f.props.context,nonWordLearning:refreshed}});f.hooks.flush();
  wait.resolve();await operation;
  assert.equal(f.assessments.length,1);assert.equal(f.grades.length,1);assert.doesNotMatch(text(f.hooks.view()),/正在保存自评/);f.hooks.unmount();
});
test('a different durable attempt still rejects the old card save when its receipt arrives late',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});await f.click('显示答案');const operation=f.click('忘记');await tick();
  f.hooks.render({...f.props,context:{...f.props.context,nonWordLearning:{...f.lifecycle,attemptId:'different-card-attempt'}}});f.hooks.flush();
  wait.resolve();await operation;assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);f.hooks.unmount();
});

for(const [rating,label,status] of [['again','忘记','incorrect'],['hard','困难','partial'],['good','良好','correct'],['easy','极易','correct']])
  test(`explicit ${label} records an empty oral answer and durable self-assessment without resetting the card`,async()=>{
    const f=fixture();assert.equal(f.calls.length,0);await f.click('显示答案');assert.equal(f.grades.length,0);await f.click(label);
    assert.deepEqual(f.calls.filter(call=>call[0]==='submit'),[['submit','']]);assert.equal(f.assessments[0].source,'self-assess');assert.equal(f.assessments[0].status,status);assert.equal(f.assessments[0].rating,rating);
    assert.deepEqual(f.grades,[{rating,options:{deferAdvance:true}}]);assert.equal(f.draft.read('isFlipped',false),true);assert.equal(f.moves.length,0);
    await f.click('继续');await f.click('继续');assert.deepEqual(f.moves,['formal']);assert.equal(f.grades.length,1);f.hooks.unmount();
  });
test('oral answer must finish durable submission before assessment or formal grading starts',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});await f.click('显示答案');const operation=f.click('忘记');await tick();
  assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);await f.swipe().onGrade('good');assert.equal(f.calls.filter(call=>call[0]==='submit').length,1);
  wait.resolve();await operation;assert.equal(f.assessments[0].rating,'again');assert.equal(f.grades[0].rating,'again');f.hooks.unmount();
});
for(const failure of ['failSubmit','failAssess','failGrade'])test(`${failure} keeps the revealed back and selected forgotten rating retryable`,async()=>{
  const f=fixture({[failure]:true});await f.click('显示答案');await f.click('忘记');assert.equal(f.draft.read('isFlipped',false),true);
  assert.equal(f.draft.read('flashcardRating',null),'again');assert.match(text(f.hooks.view()),/save failure/);assert.equal(f.moves.length,0);
  await f.click('重试保存自评');assert.equal(f.assessments.at(-1).rating,'again');assert.equal(f.draft.hasSavedFeedback(),true);
  await f.click('继续');assert.deepEqual(f.moves,['formal']);f.hooks.unmount();
});
test('front and revealed back strings use their actual formula renderer',async()=>{
  const f=fixture();assert.ok([...nodes(f.hooks.view())].some(node=>node.type===f.MathText&&node.props.text===f.data.front));
  assert.equal([...nodes(f.hooks.view())].some(node=>node.type===f.MathText&&node.props.text===f.data.back),false);
  await f.click('显示答案');assert.ok([...nodes(f.hooks.view())].some(node=>node.type===f.MathText&&node.props.text===f.data.back));f.hooks.unmount();
});
test('forgotten feedback supports hiding the explanation and retrying the same card through a child',async()=>{
  const f=fixture();await f.click('显示答案');await f.click('忘记');assert.match(text(f.hooks.view()),/首轮需要复习/);
  await f.click('收起解释，再回忆一次');assert.ok(f.calls.some(call=>call[0]==='start-child'));assert.equal(f.grades.length,1);assert.equal(f.assessments[0].rating,'again');f.hooks.unmount();
});
test('remediation explicit self-assessment stays a child and finishes the parent continuation',async()=>{
  const f=fixture({purpose:'remediation'});assert.equal(f.draft.read('isFlipped',false),false);await f.click('显示答案');await f.click('良好');
  assert.equal(f.assessments[0].rating,'good');assert.equal(f.grades.length,0);await f.click('结束补练，继续');assert.deepEqual(f.moves,['finish-child']);f.hooks.unmount();
});
test('nonword swipe delegates to the same reliable oral self-assessment path',async()=>{
  const f=fixture();await f.swipe().onReveal();await settle(f.hooks);await f.swipe().onGrade('again');await settle(f.hooks);
  assert.deepEqual(f.calls.filter(call=>call[0]==='submit'),[['submit','']]);assert.equal(f.assessments[0].rating,'again');assert.equal(f.grades[0].rating,'again');f.hooks.unmount();
});
test('a retired card does not assess or grade after its oral save finishes late',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});await f.click('显示答案');const operation=f.click('良好');await tick();f.hooks.unmount();wait.resolve();await operation;
  assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);
});
test('the absent nonword port retains old immediate rating and flip reset',async()=>{
  const f=fixture({noPort:true});await f.click('显示答案');await f.click('良好');assert.deepEqual(f.grades,[{rating:'good',options:undefined}]);
  assert.equal(f.assessments.length,0);assert.equal(f.draft.read('isFlipped',true),false);f.hooks.unmount();
});
test('a recovered canonical self-assessment keeps the source feedback visible and continues without submitting again',async()=>{
  const f=fixture({restored:{isFlipped:false,flashcardRating:'again',flashcardSaved:true}});
  assert.ok([...nodes(f.hooks.view())].some(node=>node.type===f.MathText&&node.props.text===f.data.back));assert.equal(f.grades.length,0);assert.equal(f.calls.length,0);
  await f.click('继续');assert.deepEqual(f.moves,['formal']);assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);f.hooks.unmount();
});
for(const checkpointFails of [false,true])test(`a truly cold card resumes through the production linked host without another official writer (checkpoint failure=${checkpointFails})`,async t=>{
  const parentHooks=createHooks(),parentLoad=loader(parentHooks.api),childHooks=createHooks(),calls=[];let rendered,writes=0,markCalls=0;
  t.after(()=>{childHooks.unmount();parentHooks.unmount();});
  const state={attemptId:'oral-first',answer:'',submitted:{answer:'',submittedAt:'2026-10-05T01:00:00.000Z'},
    evaluation:{status:'resolved',rating:'again',correct:false,outcome:'incorrect',source:'self-assess',feedback:'用户主动自评为忘记。'},
    formal:{status:'linked',eventId:'existing-event',rating:'again'},checkpoint:{phase:'feedback',purpose:'first',intent:'practice',traversed:false}};
  const originalDraft=parentLoad('app/learning-draft-store.ts').createLearningDraftStore('cold').adapter('A','flashcard');
  const driver={runtime:{purpose:'first',status:async()=>'本次结果已保存。',afterWrite:async()=>{},groupSeconds:async()=>0,
    session:{snapshot:()=>structuredClone(state),save:async()=>{},updateView:async()=>{},markTraversed:async()=>{markCalls++;if(checkpointFails&&markCalls===1)throw Error('checkpoint save failure');state.checkpoint.traversed=true;}}},
    restore:()=>({isFlipped:false,flashcardRating:'again',flashcardSaved:true}),fields:()=>({}),answer:()=>'',phase:()=> 'feedback',verifiedCore:async()=> 'a'.repeat(64)};
  parentHooks.mount(parentLoad('src/features/nonword-study/host.tsx').NonWordStudyHost,{bindingKey:'original-scope',mode:'flashcard',draft:originalDraft,reference:'原卡解释',recallConfigured:false,
    createDriver:async()=>driver,renderPlugin:(draft,lifecycle,grade)=>{rendered={draft,lifecycle,grade};return null;},onGrade:async()=>{writes++;},resumeFormal:rating=>calls.push(rating),continuePending:()=>assert.fail('linked oral result is not pending'),renderMath:()=>null});
  await settle(parentHooks);
  const slot=[...nodes(parentHooks.view())].find(node=>node.props.renderPlugin&&node.props.lifecycle&&node.props.draft);
  if(slot&&typeof slot.type==='function')slot.type(slot.props);
  assert.ok(rendered,text(parentHooks.view()));assert.equal(originalDraft.hasSavedFeedback(),false);
  const childLoad=loader(childHooks.api,{'app/math-text.tsx':{MathText:()=>null},'app/study-guidance.tsx':{StudyGuidance:()=>null},'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
    'app/assistance-display.tsx':{useAssistance:()=>({submit:()=>assert.fail('cold Continue cannot invent another oral submission')}),useAssistanceDisplay(){}},
    'app/use-study-swipe.ts':{useStudySwipe:()=>({})},'src/features/remediation/index.ts':{CandidateLauncher:()=>null}}, {addEventListener(){},removeEventListener(){}});
  const props={data:{itemId:'A',front:'原卡问题',back:'原卡解释'},context:{draft:rendered.draft,nonWordLearning:rendered.lifecycle},onGrade:rendered.grade};
  const shell=childLoad('app/plugins/plugin-flashcard.tsx').FlashcardPlugin.renderUI(props);childHooks.mount(shell.type,shell.props);childHooks.flush();
  await button(childHooks.view(),'继续').props.onClick();await settle(childHooks);
  if(checkpointFails){
    assert.deepEqual(calls,[]);await settle(parentHooks);assert.match(text(parentHooks.view()),/checkpoint save failure/);
    const retry=button(parentHooks.view(),'重试继续');assert.ok(retry);await retry.props.onClick();await settle(parentHooks);
  }
  await button(childHooks.view(),'继续').props.onClick();assert.deepEqual(calls,['again']);assert.equal(writes,0);assert.equal(state.formal.eventId,'existing-event');assert.equal(state.checkpoint.traversed,true);
  childHooks.unmount();parentHooks.unmount();
});
