import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';

const error=(name,extra={})=>Object.assign(new Error('Traceback: synthetic implementation details'),{name,...extra});
function fixture({outcomes=[{output:'ok',assertionsPassed:2}],purpose='first',submitWait,failSubmit=false}={}){
  const hooks=createHooks(),calls=[],grades=[],children=[],assessments=[],moves=[];
  let submitted=false,original,failures=failSubmit?1:0;
  const lifecycle={ready:true,purpose,intent:'review',get submitted(){return submitted;},
    async submit(answer){calls.push(['submit',answer]);await submitWait?.promise;if(failures-- >0)throw Error('disk failed');if(submitted&&answer!==original)throw Error('original mutated');submitted=true;original=answer;},
    async assess(outcome){calls.push(['assess',outcome.status]);assessments.push(outcome);},
    async waitForReview(reason){calls.push(['pending',reason]);},async continuePending(){moves.push('pending');},
    async recordRemediation(answer,outcome){children.push({answer,outcome});},async startRemediation(){calls.push(['start-child']);},async finishRemediation(){moves.push('finish-child');},
  };
  const runner={isReady:true,error:null,retry(){},cancel(){},async runPython(code){calls.push(['run',code]);const outcome=outcomes.shift();if(outcome?.then)return outcome;if(outcome instanceof Error)throw outcome;return outcome;}};
  const load=loader(hooks.api,{'app/hooks/use-pyodide.ts':{usePyodide:()=>runner},'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
    'app/assistance-display.tsx':{useAssistance:()=>({submit:()=>calls.push(['observation'])}),useAssistanceDisplay(){}},
    'app/components/code-editor.tsx':{CodeEditor:()=>null},'app/study-guidance.tsx':{StudyGuidance:()=>null},
    'src/features/remediation/index.ts':{CodeRewriteLauncher:()=>null},'app/math-text.tsx':{MathText:()=>null}});
  const store=load('app/learning-draft-store.ts').createLearningDraftStore('code-flow'),draft=store.adapter('A','code:1');
  const data={topic:'Python',prompt:'Return a + b without changing the provided inputs.',initialCode:'bad',testCode:'assert add(1, 2) == 3',solutionCode:'REFERENCE_SOLUTION',explanation:'Return the sum.'};
  hooks.mount(load('app/plugins/plugin-code.tsx').CodePlugin.renderUI,{data,context:{draft,nonWordLearning:lifecycle},
    onGrade(rating,options){grades.push({rating,options});if(options?.deferAdvance){const ticket=draft.begin();if(ticket)store.commit(ticket,()=>moves.push('formal'));}}});
  hooks.flush();
  return {hooks,store,draft,lifecycle,runner,calls,grades,children,assessments,moves,data,original:()=>original,
    click:async(label)=>{const target=button(hooks.view(),label)||[...nodes(hooks.view())].find(node=>node.type==='button'&&text(node).endsWith(label));assert.ok(target,`Missing ${label}`);await target.props.onClick();await settle(hooks);},
    run:async()=>{const target=[...nodes(hooks.view())].find(node=>node.type==='button'&&text(node).includes('运行测试'));assert.ok(target);await target.props.onClick();await settle(hooks);},
    edit:async(value)=>{const editor=[...nodes(hooks.view())].find(node=>node.props.onChange&&Object.hasOwn(node.props,'readOnly')&&Object.hasOwn(node.props,'value'));assert.ok(editor);editor.props.onChange(value);await settle(hooks);}};
}
async function settle(hooks){for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}}

test('guided code feedback directs the learner to the shared independent step without an inert formal continue button',async()=>{
  const f=fixture({purpose:'guided'});await f.run();
  assert.equal(f.grades.length,0);assert.equal(button(f.hooks.view(),'继续'),undefined);
  assert.match(text(f.hooks.view()),/收起讲解后进入独立尝试/);f.hooks.unmount();
});

test('code snapshot is reliably submitted before public tests execute',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});const running=f.run();await tick();assert.equal(f.calls.some(call=>call[0]==='run'),false);
  await f.run();assert.equal(f.calls.filter(call=>call[0]==='submit').length,1);
  wait.resolve();await running;assert.deepEqual(f.calls.filter(call=>['submit','run','assess'].includes(call[0])).map(call=>call[0]),['submit','run','assess']);
  assert.equal(f.original(),'bad');assert.equal(f.assessments[0].status,'correct');assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('first attributed error saves again once; repaired public-test success belongs to a child',async()=>{
  const f=fixture({outcomes:[error('PythonError',{executionPhase:'program'}),{output:'ok',assertionsPassed:1}]});await f.run();
  assert.deepEqual(f.grades,[{rating:'again',options:{deferAdvance:true}}]);assert.equal(f.assessments[0].status,'incorrect');
  await f.edit('fixed');await f.run();assert.equal(f.original(),'bad');assert.equal(f.assessments.length,1);assert.equal(f.children[0].answer,'fixed');assert.equal(f.children[0].outcome.status,'correct');
  assert.equal(f.draft.read('firstRunKind',''),'incorrect');await f.click('继续');assert.deepEqual(f.moves,['formal']);assert.equal(f.grades.length,1);f.hooks.unmount();
});
for(const [name,details] of [['PythonError',{executionPhase:'tests'}],['RuntimeError',{}],['PythonError',{testDefinitionError:true}],['AbortError',{}],['TimeoutError',{}]])
  test(`${name} ${JSON.stringify(details)} saves pending and edited success cannot improve the first attempt`,async()=>{
    const f=fixture({outcomes:[error(name,details),{output:'ok',assertionsPassed:1}]});await f.run();assert.equal(f.grades.length,0);assert.equal(f.assessments.length,0);assert.ok(f.calls.some(call=>call[0]==='pending'));
    await f.edit('different code');await f.run();assert.equal(f.assessments.length,0);assert.equal(f.children[0].outcome.status,'correct');assert.equal(f.original(),'bad');assert.equal(f.grades.length,0);
    await f.click('保留待核对结果，继续');assert.deepEqual(f.moves,['pending']);f.hooks.unmount();
  });
test('unchanged code can resolve its original pending run after environment recovery',async()=>{
  const f=fixture({outcomes:[error('RuntimeError'),{output:'ok',assertionsPassed:1}]});await f.run();await f.run();
  assert.deepEqual(f.assessments.map(outcome=>outcome.status),['correct']);assert.equal(f.children.length,0);assert.equal(f.draft.read('firstNeedsReview',true),false);
  await f.click('继续');assert.equal(f.grades[0].rating,'good');assert.equal(f.grades.length,1);f.hooks.unmount();
});
test('viewing the solution after an unknown run cannot invent an incorrect grade',async()=>{
  const f=fixture({outcomes:[error('PythonError',{executionPhase:'tests'})]});await f.run();await f.click('查看题解');
  assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);assert.equal(f.draft.read('firstNeedsReview',false),true);await f.click('保留待核对结果，继续');assert.deepEqual(f.moves,['pending']);f.hooks.unmount();
});
test('giving up before running saves actual code as a self-assessed forgotten first attempt',async()=>{
  const f=fixture();await f.edit('my unfinished code');await f.click('查看题解');assert.equal(f.original(),'my unfinished code');
  assert.equal(f.assessments[0].source,'self-assess');assert.equal(f.assessments[0].status,'incorrect');assert.equal(f.grades[0].rating,'again');f.hooks.unmount();
});
test('storage failure leaves the answer intact and never starts execution',async()=>{
  const f=fixture({failSubmit:true});await f.run();assert.equal(f.calls.some(call=>call[0]==='run'),false);assert.equal(f.grades.length,0);
  assert.equal([...nodes(f.hooks.view())].find(node=>node.props.onChange&&Object.hasOwn(node.props,'value')).props.value,'bad');assert.equal(f.draft.read('firstRunKind','not-run'),'not-run');await f.run();assert.equal(f.assessments[0].status,'correct');f.hooks.unmount();
});
test('trial code runs create no submission, evaluation, child or formal grade',async()=>{
  const f=fixture();await f.click('试运行当前代码');assert.equal(f.calls.filter(call=>call[0]==='submit').length,0);assert.equal(f.assessments.length,0);assert.equal(f.children.length,0);assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('inline remediation uses the same editor and finishes through its parent continuation',async()=>{
  const f=fixture({purpose:'remediation'});assert.doesNotMatch(text(f.hooks.view()),/REFERENCE_SOLUTION/);await f.run();
  assert.equal(f.assessments[0].status,'correct');await f.click('结束补练，继续');assert.deepEqual(f.moves,['finish-child']);assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('a disposed code view ignores late results and never assesses or grades them',async()=>{
  const wait=deferred(),f=fixture({outcomes:[wait.promise]});const running=f.run();await tick();await tick();f.hooks.unmount();wait.resolve({output:'late',assertionsPassed:1});await running;
  assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);
});
test('failure is concise and detailed output stays inside a closed disclosure',async()=>{
  const f=fixture({outcomes:[error('PythonError',{executionPhase:'program'})]});await f.run();
  const disclosure=[...nodes(f.hooks.view())].find(node=>node.type==='details'&&text(node).includes('查看运行详情'));
  assert.ok(disclosure);assert.equal(disclosure.props.open,undefined);assert.match(text(disclosure),/Traceback/);f.hooks.unmount();
});
test('a long edited source is submitted and tested verbatim without truncation',async()=>{
  const f=fixture(),source='def add(a, b):\n    return a + b\n#'+ 'x'.repeat(30000);await f.edit(source);await f.run();
  assert.equal(f.original(),source);assert.equal(f.calls.find(call=>call[0]==='run')[1],source);f.hooks.unmount();
});
test('pending continuation is consumed once, including repeated clicks after its promise resolves',async()=>{
  const f=fixture({outcomes:[error('TimeoutError')]});await f.run();await f.click('保留待核对结果，继续');await f.click('保留待核对结果，继续');
  assert.deepEqual(f.moves,['pending']);assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('inline rewrite starts only after the original failure receipt, without opening the legacy modal',async()=>{
  const f=fixture({outcomes:[error('PythonError',{executionPhase:'program'})]});await f.run();await f.click('收起解释，再写一次');
  assert.ok(f.calls.some(call=>call[0]==='start-child'));assert.equal(f.original(),'bad');assert.equal(f.grades.length,1);f.hooks.unmount();
});
test('the production subject host honors explicit code deferral and continues the durable first result once',async()=>{
  const store=createLearningDraftStore('deferred-code'),draft=store.adapter('A','code'),submissions=[];let advances=0;
  const grade=createSubjectGradeHandler({mode:'code',completedStage:0,isDemoMode:false,draft},{
    drafts:{submit(adapter,options){const result=store.submit(adapter,options);submissions.push(result);return result;}},modeEpoch:()=>0,ownerCurrent:()=>true,canPresent:()=>true,
    prepare:request=>({input:{identity:request.identity,correct:false},frame:{},observation:null}),advance:()=>advances++,publishDemo(){},publishEvent(){},publishProgress(){},setMessage(){},invalidateView(){},
    record:async(input,ports)=>{await ports.persistEvent({eventId:input.identity.eventId,event:input});},persist:async()=>({}),sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{},
  });
  grade('again',{deferAdvance:true});await submissions[0];assert.equal(advances,0);assert.equal(draft.hasSavedFeedback(),true);
  assert.equal(draft.continueAfterFeedback(),true);assert.equal(draft.continueAfterFeedback(),false);assert.equal(advances,1);
});
