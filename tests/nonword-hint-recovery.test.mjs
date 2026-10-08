import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick,extract} from './helpers/causal-harness.mjs';
const scope={workspaceId:'account:hint-test',libraryId:'library',itemKey:'question',contentHash:'a'.repeat(64)};
async function settle(hooks){for(let i=0;i<12;i++){hooks.flush();await tick();hooks.render();}}
function hookFixture({recovered=null,controlled=true,persist=async()=>{}}={}) {
  const hooks=createHooks(),legacy=[],writes=[];let durable=recovered;
  const load=loader(hooks.api,{
    'app/recall-attempt-state.ts':{openRecallAttempt:async()=>{legacy.push('open');return {schemaVersion:1,attemptId:'legacy-unclosed',maxPreHintLevel:2};},recordRecallHint:async(_scope,id,level)=>{legacy.push('record');return {schemaVersion:1,attemptId:id,maxPreHintLevel:Math.max(2,level)};}},
    'app/study-submission-journal.ts':{createSubmissionJournal:()=>({list:async()=>{legacy.push('journal');return [];}})},
  });
  const draft=load('app/learning-draft-store.ts').createLearningDraftStore('hint-hook').adapter('question','recall');
  const policy=load('app/use-recall-support.ts').useRecallSupport;
  const options=controlled?{recover:()=>durable,persist:async state=>{const currentId=durable?.attemptId;writes.push(structuredClone(state));await persist(state);if(durable?.attemptId===currentId)durable=structuredClone(state);}}:undefined;
  hooks.mount(()=>policy(true,draft,scope,true,options),{});
  return {hooks,legacy,writes,draft,policy:()=>hooks.view(),setRecovered:value=>{durable=value;},durable:()=>durable};
}
test('controlled hints await a reliable receipt and recover metadata without reading legacy per-material state',async()=>{
  const gate=deferred(),f=hookFixture({recovered:{schemaVersion:1,attemptId:'current-run',maxPreHintLevel:0},persist:state=>state.maxPreHintLevel?gate.promise:Promise.resolve()});await settle(f.hooks);
  const saving=f.policy().record(2);await settle(f.hooks);assert.equal(f.policy().state.maxPreHintLevel,0);assert.equal(f.policy().pending,true);
  gate.resolve();await saving;await settle(f.hooks);assert.equal(f.policy().state.maxPreHintLevel,2);assert.equal(f.durable().maxPreHintLevel,2);assert.deepEqual(f.legacy,[]);f.hooks.unmount();
});
test('recovered level two and full reference level three retain strict caps while a new run starts separately',async()=>{
  const f=hookFixture({recovered:{schemaVersion:1,attemptId:'first-run',maxPreHintLevel:2}});await settle(f.hooks);const grades=[];
  await f.policy().grade('good',rating=>grades.push(rating));assert.deepEqual(grades,['hard']);await f.policy().record(3);await settle(f.hooks);await f.policy().grade('good',rating=>grades.push(rating));assert.deepEqual(grades,['hard','again']);
  f.setRecovered({schemaVersion:1,attemptId:'new-normal-run',maxPreHintLevel:0});f.hooks.render();await settle(f.hooks);assert.equal(f.policy().state.attemptId,'new-normal-run');assert.equal(f.policy().state.maxPreHintLevel,0);assert.deepEqual(f.legacy,[]);f.hooks.unmount();
});
test('malformed controlled metadata and invalid levels fail closed without publishing a ready policy',async()=>{
  const f=hookFixture({recovered:{schemaVersion:1,attemptId:'invalid id',maxPreHintLevel:4}});await settle(f.hooks);assert.equal(f.policy().ready,false);assert.equal(f.policy().state,null);assert.equal(f.writes.length,0);f.hooks.unmount();
  const valid=hookFixture({recovered:{schemaVersion:1,attemptId:'valid-run',maxPreHintLevel:0}});await settle(valid.hooks);
  for(const level of [-1,1.5,4])await assert.rejects(valid.policy().record(level),/invalid-recall-hint-level/);assert.equal(valid.policy().state.maxPreHintLevel,0);valid.hooks.unmount();
});
test('a late old-run hint receipt cannot publish into a newly recovered run',async()=>{
  const gate=deferred(),f=hookFixture({recovered:{schemaVersion:1,attemptId:'old-run',maxPreHintLevel:0},persist:state=>state.attemptId==='old-run'&&state.maxPreHintLevel?gate.promise:Promise.resolve()});await settle(f.hooks);
  const old=f.policy().record(3);f.setRecovered({schemaVersion:1,attemptId:'new-run',maxPreHintLevel:0});f.hooks.render();await settle(f.hooks);gate.resolve();await assert.rejects(old,/已变化/);await settle(f.hooks);
  assert.equal(f.policy().state.attemptId,'new-run');assert.equal(f.policy().state.maxPreHintLevel,0);f.hooks.unmount();
});
test('no-option legacy word hook still opens its old scope and applies the original hint cap',async()=>{
  const f=hookFixture({controlled:false});await settle(f.hooks);assert.equal(f.policy().state.attemptId,'legacy-unclosed');assert.equal(f.policy().state.maxPreHintLevel,2);const ratings=[];
  await f.policy().grade('good',rating=>ratings.push(rating));assert.deepEqual(ratings,['hard']);assert.deepEqual(f.legacy,['open','record']);assert.equal(f.writes.length,0);f.hooks.unmount();
});
function pluginFixture({recovered=null,failHints=false}={}) {
  const hooks=createHooks(),records=[],submissions=[],assessments=[],pending=[],legacy=[],persisted=[];let durable=recovered,submitted=false,frozen,aiError=false;
  const failure=extract('app/account-study-runtime.ts','accountAiFailureMessage')({});
  const load=loader(hooks.api,{
    'app/study-guidance.tsx':{StudyGuidance:()=>null},'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
    'app/assistance-display.tsx':{useAssistance:d=>d?.assistance,useAssistanceDisplay(){}},'app/math-text.tsx':{MathText:()=>null},'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:()=>null},
    'app/account-study-runtime.ts':{accountAiFailureMessage:failure},
    'app/recall-attempt-state.ts':{openRecallAttempt:async()=>{legacy.push('open');return {schemaVersion:1,attemptId:'unclosed-old-material',maxPreHintLevel:3};},recordRecallHint:async()=>{legacy.push('record');throw Error('Legacy hint store must not be used');}},
    'app/study-submission-journal.ts':{createSubmissionJournal:()=>({list:async()=>{legacy.push('journal');return [];}})},
  },{confirm:()=>true,addEventListener(){},removeEventListener(){}});
  const store=load('app/learning-draft-store.ts').createLearningDraftStore('hint-plugin'),draft=store.adapter('current-question','recall');if(recovered)draft.write('recallAttempt',recovered);
  const lifecycle={ready:true,purpose:'first',intent:'review',get submitted(){return submitted;},get submittedHintLevel(){return frozen;},get answerRevealed(){return false;},
    async recordHint(state){if(failHints&&state.maxPreHintLevel)throw Error('Hint durable write failed');durable=structuredClone(state);persisted.push(durable);},
    async submit(answer){if(submitted)return;submissions.push(answer);frozen=durable?.maxPreHintLevel;submitted=true;},async assess(result){assessments.push(result);},async waitForReview(reason){pending.push(reason);},async continuePending(){},
  };
  const data={itemId:'hint-question',fingerprint:'source-v1',prompt:'为什么验证集必须独立于训练数据？',explanation:'独立采样避免把训练中的记忆误当作泛化表现。',learningSupport:{schemaVersion:1,type:'recall',criteria:[{id:'independence',text:'独立采样'}],hints:['先区分训练与核对的作用。','列出数据来源与使用阶段。','完整参考：独立采样避免训练记忆污染核对。']}};
  const props={data,context:{draft,nonWordLearning:lifecycle,recallScope:scope,recallPersistenceRequired:true,recallNavigation:{continueLabel:'结束本轮',onSkip(){}},gradeRecall:async()=>{if(aiError)throw Error('Synthetic AI offline');return {correct:true,verdict:'correct',rating:'good',source:'ai',feedback:'独立采样，条件完整。',matchedPointIds:['independence'],missedPointIds:[]};}},
    onGrade:async(rating,options)=>{records.push({rating,options});const ticket=draft.begin();if(ticket)store.commit(ticket,()=>{});},
  };
  hooks.mount(load('app/plugin-recall.tsx').RecallPlugin.renderUI,props);
  return {hooks,draft,records,submissions,assessments,pending,legacy,persisted,lifecycle,setAiError:value=>{aiError=value;},
    async type(value){nodes(hooks.view()).find(node=>node.type==='textarea').props.onChange({target:{value}});await settle(hooks);},
    async click(label){const target=button(hooks.view(),label);assert.ok(target,`Missing ${label}`);assert.equal(target.props.disabled,false,`Disabled ${label}`);await target.props.onClick();await settle(hooks);},
    get view(){return hooks.view();},
  };
}
test('failed first hint persistence shows no hint and blocks written and oral first submission',async()=>{
  const f=pluginFixture({failHints:true});await settle(f.hooks);await f.type('My first attempt.');await f.click('给我一个方向');
  assert.equal(f.draft.read('recallHintDisplay',0),0);assert.equal(nodes(f.view).some(node=>node.props?.text==='先区分训练与核对的作用。'),false);assert.equal(button(f.view,'提交并核对').props.disabled,true);
  button(f.view,'忘记了，查看要点').props.onClick();await settle(f.hooks);assert.deepEqual(f.submissions,[]);assert.deepEqual(f.records,[]);assert.deepEqual(f.legacy,[]);f.hooks.unmount();
});
test('recovered pre-submit hints are frozen but the plugin sends raw semantic rating to the controlled host',async()=>{
  const f=pluginFixture({recovered:{schemaVersion:1,attemptId:'recovered-pre-two',maxPreHintLevel:2}});await settle(f.hooks);await f.type('独立采样可以防止训练记忆被当作泛化。');await f.click('提交并核对');await f.click('结束本轮');
  assert.equal(f.lifecycle.submittedHintLevel,2);assert.equal(f.assessments[0].rating,'good');assert.equal(f.records[0].rating,'good');assert.equal(f.records[0].options.deferAdvance,true);assert.deepEqual(f.legacy,[]);f.hooks.unmount();
});
test('post-submission reference use does not downgrade the immutable first answer or its requested grade',async()=>{
  const f=pluginFixture();await settle(f.hooks);await f.type('独立采样，防止训练记忆污染。');f.setAiError(true);await f.click('提交并核对');assert.equal(f.lifecycle.submittedHintLevel,0);
  await f.click('给我一个方向');await f.click('结构提示（不改变首轮结果）');await f.click('完整参考（不改变首轮结果）');assert.equal(f.draft.read('recallAttempt',null).maxPreHintLevel,3);assert.equal(f.lifecycle.submittedHintLevel,0);
  f.setAiError(false);await f.click('提交并核对');await f.click('结束本轮');assert.equal(f.submissions.length,1);assert.equal(f.submissions[0],'独立采样，防止训练记忆污染。');assert.equal(f.records[0].rating,'good');assert.equal(f.assessments[0].status,'correct');assert.doesNotMatch(text(f.view),/本轮已用完整参考，按需要复习记录/);assert.deepEqual(f.legacy,[]);f.hooks.unmount();
});
