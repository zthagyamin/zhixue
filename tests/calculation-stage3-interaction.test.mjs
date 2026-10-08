import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';
import {createMathVariant} from '../src/domain/guided-math/index.ts';

const hash='a'.repeat(64);
const support={schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',conditions:['长度非负'],units:'米',
  step:{stepId:'subtract',prompt:'写出减去初始值后的数值。',reference:'10',mode:'numeric'}};
const diagnostic=(status='incorrect',source='deterministic')=>({answerRevision:0,stepRevision:1,stepId:'subtract',sourceVersion:hash,status,source,explanation:status==='undetermined'?'步骤已保存待核对。':'仅核对这一步。'});
function fixture({final='correct',step=diagnostic(),mode='numeric',saveFail=false,evalWait,submitWait,variant,canVariant=false,snapshotHash=hash,initialSnapshot=null,refreshSnapshot,refreshWait}={}){
  const hooks=createHooks(),calls=[],grades=[],assessments=[];
  let snapshot=initialSnapshot,submitted=false;
  const trusted={...support,step:{...support.step,mode}};
  const practice={snapshot:()=>snapshot,async refresh(){calls.push('refresh');await refreshWait?.promise;if(refreshSnapshot)snapshot=refreshSnapshot;},async saveStep(value){calls.push(['saveStep',value]);if(saveFail)throw Error('step storage failed');snapshot={attemptId:'attempt',binding:{contentHash:snapshotHash},calculation:{stepInput:{text:value,revision:1}}};},
    calculation:{support:trusted,sourceLabel:'讲义 · 例 2',canVariant,activeVariant:()=>variant??null,
      async evaluate(kind){calls.push(['evaluate',kind]);const result=await evalWait?.promise??{schemaVersion:1,attemptId:'attempt',answerRevision:0,sourceVersion:hash,
        ...(kind==='final'?{final:{status:final,source:'deterministic',explanation:'最终结果核对。'}}:{}),...(snapshot?.calculation?{step}: {})};
        if(result.step&&snapshot)snapshot={...snapshot,calculation:{...snapshot.calculation,diagnostic:result.step}};return result;}}};
  const lifecycle={attemptId:'attempt',ready:true,purpose:'first',intent:'review',get submitted(){return submitted;},practice,
    async submit(answer){calls.push(['submit',answer]);await submitWait?.promise;submitted=true;},async assess(outcome){calls.push(['assess',outcome.status]);assessments.push(outcome);},
    async waitForReview(){calls.push('pending');},async continuePending(){calls.push('continue-pending');},
    async startRemediation(){calls.push('retry');},async startVariant(seed){calls.push(['variant',seed]);}};
  const load=loader(hooks.api,{'app/math-text.tsx':{MathText:({text})=>text},'app/study-guidance.tsx':{StudyGuidance:()=>null},
    'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},'app/assistance-display.tsx':{useAssistance:()=>({submit(){}}),useAssistanceDisplay(){}},
    'app/calculation-exploration.tsx':{CalculationExploration:()=>null},'src/features/guided-math/index.ts':{MathPracticeLauncher:()=>null},
    'src/features/remediation/index.ts':{SourceReviewLauncher:()=>null},'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:()=>null}});
  const store=load('app/learning-draft-store.ts').createLearningDraftStore('stage3'),draft=store.adapter('owner','item');
  const props={data:{itemId:'item',contentHash:hash,prompt:'求最后长度。',answer:'12',explanation:'完整原题解法。'},context:{draft,nonWordLearning:lifecycle,
    async gradeCalculation(){assert.fail('Stage3 must use controlled evaluation');}},async onGrade(rating){calls.push(['grade',rating]);grades.push(rating);const ticket=draft.begin();if(ticket)store.commit(ticket,()=>{});}};
  hooks.mount(load('app/plugin-calculation.tsx').CalculationPlugin.renderUI,props);hooks.flush();
  const settle=async()=>{for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}};
  const input=(label)=>[...nodes(hooks.view())].find(n=>['input','textarea','select'].includes(n.type)&&n.props['aria-label']===label);
  return{hooks,calls,grades,assessments,practice,lifecycle,props,draft,settle,input,
    async edit(label,value){assert.ok(input(label),`missing ${label}`);input(label).props.onChange({target:{value}});await settle();},
    async click(label){const target=button(hooks.view(),label);assert.ok(target,`missing ${label}`);await target.props.onClick();await settle();}};
}
test('actual calculation view projects a saved variant into formula markup without mutating its identity',async()=>{
  const variant=await createMathVariant({parent:{parentItemKey:'item',parentContentHash:hash,hashKind:'content'},templateId:'sqrt-sign',seed:0,parameters:{x:-3}});
  const before=JSON.stringify(variant),f=fixture({variant});
  const mathTexts=[...nodes(f.hooks.view())].map(n=>n.props?.text).filter(value=>typeof value==='string');
  assert.ok(mathTexts.some(value=>value.includes('\\sqrt{x^{2}}')),'The actual prompt must reach MathText as a formula');
  assert.equal(JSON.stringify(variant),before);assert.deepEqual(f.grades,[]);f.hooks.unmount();
});
test('optional step saves before final submission and good remains good when the step is incorrect',async()=>{
  const f=fixture();await f.edit('你的答案',' 12 ');await f.edit('关键步骤','8');await f.click('提交');
  assert.deepEqual(f.calls.filter(Array.isArray).map(x=>x[0]),['saveStep','submit','evaluate','assess','grade']);
  assert.equal(f.calls.find(x=>Array.isArray(x)&&x[0]==='submit')[1],' 12 ');assert.deepEqual(f.grades,['good']);
  assert.equal(f.input('关键步骤').props.readOnly,true);assert.match(text(f.hooks.view()),/这一步有误/);f.hooks.unmount();
});
test('a correct step cannot turn an incorrect final answer into good',async()=>{
  const f=fixture({final:'incorrect',step:diagnostic('correct')});await f.edit('你的答案','4');await f.edit('关键步骤','10');await f.click('提交');
  assert.deepEqual(f.grades,['again']);assert.match(text(f.hooks.view()),/这一步正确/);f.hooks.unmount();
});
test('unknown final stays pending with raw answer and independently saved step',async()=>{
  const f=fixture({final:'undetermined',step:diagnostic('correct')});await f.edit('你的答案',' 3/4 ');await f.edit('关键步骤','10');await f.click('提交');
  assert.equal(f.calls.find(x=>Array.isArray(x)&&x[0]==='submit')[1],' 3/4 ');assert.ok(f.calls.includes('pending'));assert.deepEqual(f.grades,[]);f.hooks.unmount();
});
test('explicit semantic step recovery after formal final never regrades the final answer',async()=>{
  const f=fixture({mode:'semantic',step:diagnostic('undetermined','none')});await f.edit('你的答案','12');await f.edit('关键步骤','系数非零');await f.click('提交');
  assert.deepEqual(f.calls.filter(x=>Array.isArray(x)&&x[0]==='evaluate').map(x=>x[1]),['final']);assert.deepEqual(f.grades,['good']);
  f.practice.calculation.evaluate=async(kind)=>{f.calls.push(['evaluate',kind]);return{schemaVersion:1,attemptId:'attempt',answerRevision:0,sourceVersion:hash,step:diagnostic('correct','model')};};
  await f.click('核对这一步');assert.match(text(f.hooks.view()),/这一步正确/);assert.deepEqual(f.grades,['good']);assert.equal(f.assessments.length,1);f.hooks.unmount();
});
test('blank optional step is omitted and source conditions stay visible',async()=>{
  const f=fixture();await f.edit('你的答案','12');await f.click('提交');assert.equal(f.calls.some(x=>Array.isArray(x)&&x[0]==='saveStep'),false);
  assert.ok([...nodes(f.hooks.view())].some(n=>n.props?.text==='长度非负'));assert.match(text(f.hooks.view()),/单位：/);f.hooks.unmount();
});
test('step save failure blocks submission and evaluation without losing inputs',async()=>{
  const f=fixture({saveFail:true});await f.edit('你的答案','12');await f.edit('关键步骤','10');await f.click('提交');
  assert.equal(f.calls.some(x=>Array.isArray(x)&&x[0]==='submit'),false);assert.equal(f.calls.some(x=>Array.isArray(x)&&x[0]==='evaluate'),false);
  assert.equal(f.input('关键步骤').props.value,'10');assert.match(text(f.hooks.view()),/step storage failed/);f.hooks.unmount();
});
test('each actual step edit including clearing stages through the host before final submission',async()=>{
  const f=fixture();f.practice.stageStep=value=>f.calls.push(['stageStep',value]);
  await f.edit('关键步骤','草稿步骤');await f.edit('关键步骤','');await f.edit('关键步骤','10');await f.edit('你的答案','12');await f.click('提交');
  assert.deepEqual(f.calls.filter(x=>Array.isArray(x)&&['stageStep','saveStep','submit'].includes(x[0])),[
    ['stageStep','草稿步骤'],['stageStep',''],['stageStep','10'],['saveStep','10'],['submit','12']]);
  assert.equal(f.input('关键步骤').props.readOnly,true);assert.deepEqual(f.grades,['good']);f.hooks.unmount();
});
test('a fresh host lifecycle facade for the same attempt during submission still evaluates and grades once',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});await f.edit('你的答案','12');await f.edit('关键步骤','10');const operation=f.click('提交');await tick();
  assert.ok(f.calls.some(x=>Array.isArray(x)&&x[0]==='submit'));
  f.hooks.render({...f.props,context:{...f.props.context,nonWordLearning:{...f.lifecycle,submitted:true}}});f.hooks.flush();
  wait.resolve();await operation;
  assert.deepEqual(f.calls.filter(Array.isArray).map(x=>x[0]),['saveStep','submit','evaluate','assess','grade']);assert.deepEqual(f.grades,['good']);
  assert.match(text(f.hooks.view()),/最终结果正确/);f.hooks.unmount();
});
test('late evaluation after unmount cannot assess or grade',async()=>{
  const wait=deferred(),f=fixture({evalWait:wait});await f.edit('你的答案','12');const operation=f.click('提交');await tick();f.hooks.unmount();
  assert.ok(f.calls.some(x=>Array.isArray(x)&&x[0]==='evaluate'));
  wait.resolve({schemaVersion:1,attemptId:'attempt',answerRevision:0,sourceVersion:hash,final:{status:'correct',source:'deterministic',explanation:'late'}});await operation;
  assert.deepEqual(f.grades,[]);assert.equal(f.assessments.length,0);
});
test('a source change cancels late evaluation before it can assess the previous item',async()=>{
  const wait=deferred(),f=fixture({evalWait:wait});await f.edit('你的答案','12');const operation=f.click('提交');await tick();
  f.hooks.render({...f.props,data:{...f.props.data,itemId:'next',prompt:'另一题',contentHash:'b'.repeat(64)}});f.hooks.flush();
  wait.resolve({schemaVersion:1,attemptId:'attempt',answerRevision:0,sourceVersion:hash,final:{status:'correct',source:'deterministic',explanation:'late'}});await operation;
  assert.deepEqual(f.grades,[]);assert.equal(f.assessments.length,0);f.hooks.unmount();
});
test('a different attempt with the same question and practice port cancels old evaluation',async()=>{
  const wait=deferred(),f=fixture({evalWait:wait});await f.edit('你的答案','12');const operation=f.click('提交');await tick();
  f.hooks.render({...f.props,context:{...f.props.context,nonWordLearning:{...f.lifecycle,attemptId:'different-attempt'}}});f.hooks.flush();
  wait.resolve({schemaVersion:1,attemptId:'attempt',answerRevision:0,sourceVersion:hash,final:{status:'correct',source:'deterministic',explanation:'old attempt'}});await operation;
  assert.deepEqual(f.grades,[]);assert.equal(f.assessments.length,0);f.hooks.unmount();
});
test('refresh restores only source-matching saved step text and diagnosis',async()=>{
  const saved={attemptId:'attempt',binding:{contentHash:hash},calculation:{stepInput:{text:'10',revision:1},diagnostic:diagnostic('correct')}};
  const f=fixture({refreshSnapshot:saved});await f.settle();assert.equal(f.input('关键步骤').props.value,'10');assert.match(text(f.hooks.view()),/这一步正确/);f.hooks.unmount();
  const stale=fixture({initialSnapshot:{...saved,binding:{contentHash:'b'.repeat(64)}}});await stale.settle();assert.equal(stale.input('关键步骤').props.value,'');assert.doesNotMatch(text(stale.hooks.view()),/这一步正确/);stale.hooks.unmount();
});
test('refresh cannot overwrite an independently edited optional step',async()=>{
  const wait=deferred(),saved={attemptId:'attempt',binding:{contentHash:hash},calculation:{stepInput:{text:'old text',revision:1}}};
  const f=fixture({refreshSnapshot:saved,refreshWait:wait});await f.edit('关键步骤','new text');wait.resolve();await f.settle();assert.equal(f.input('关键步骤').props.value,'new text');f.hooks.unmount();
});
test('switching host scope with an identical displayed question does not reuse the old step',async()=>{
  const f=fixture();await f.edit('关键步骤','old private step');
  const nextPractice={...f.practice,snapshot:()=>null,async refresh(){}};
  f.hooks.render({...f.props,context:{...f.props.context,nonWordLearning:{...f.lifecycle,practice:nextPractice}}});f.hooks.flush();
  assert.equal(f.input('关键步骤').props.value,'');await f.settle();assert.equal(f.input('关键步骤').props.value,'');f.hooks.unmount();
});
test('stale source diagnostics are not restored or used to grade',async()=>{
  const f=fixture({snapshotHash:'b'.repeat(64)});await f.edit('你的答案','12');await f.edit('关键步骤','10');await f.click('提交');
  assert.deepEqual(f.grades,[]);assert.equal(f.assessments.length,0);f.hooks.unmount();
});
test('a source without variant eligibility has no variant button or missing mapping prose',async()=>{
  const f=fixture();await f.edit('你的答案','12');await f.click('提交');assert.equal(button(f.hooks.view(),'换条件，再练一题'),undefined);
  assert.doesNotMatch(text(f.hooks.view()),/尚无可靠映射/);f.hooks.unmount();
});
test('active variant renders its exact prompt and submits only answer kind and learner answer',async()=>{
  const variant={definition:{prompt:'已知 x = 0，此式是否允许同除以 x？',answerKind:'not-allowed',domain:'x 是实数'}};
  const f=fixture({variant});assert.ok([...nodes(f.hooks.view())].some(n=>n.props?.text===variant.definition.prompt));
  await f.edit('结论类型','not-allowed');await f.click('提交');assert.equal(f.calls.find(x=>Array.isArray(x)&&x[0]==='submit')[1],JSON.stringify({answerKind:'not-allowed',answer:''}));f.hooks.unmount();
});
test('variant launch uses one host-controlled seed after final result without changing the original grade',async()=>{
  const f=fixture({canVariant:true});await f.edit('你的答案','12');await f.click('提交');await f.click('换条件，再练一题');
  const seed=f.calls.find(x=>Array.isArray(x)&&x[0]==='variant')[1];assert.ok(Number.isSafeInteger(seed)&&seed>=0&&seed<=0xffffffff);assert.deepEqual(f.grades,['good']);f.hooks.unmount();
});
test('opening an original retry hides the solved answer while the child is being prepared',async()=>{
  const f=fixture({final:'incorrect'}),wait=deferred();f.lifecycle.startRemediation=()=>wait.promise;
  await f.edit('你的答案','4');await f.click('提交');const operation=f.click('收起解法重算');await tick();f.hooks.render();
  assert.equal(f.input('你的答案'),undefined);assert.doesNotMatch(text(f.hooks.view()),/最终结果有误/);wait.resolve();await operation;assert.deepEqual(f.grades,['again']);f.hooks.unmount();
});
