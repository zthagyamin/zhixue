import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';

const error=(name,extra={})=>Object.assign(new Error('Traceback: synthetic implementation details'),{name,...extra});
function fixture({outcomes=[{output:'ok',assertionsPassed:2}],purpose='first',submitWait,failSubmit=false,pendingOnAssess=false,pendingOnGrade=false,noGradeReceipt=false,canonicalOutcome}={}){
  const hooks=createHooks(),calls=[],grades=[],children=[],assessments=[],moves=[];
  let submitted=false,original,failures=failSubmit?1:0,sourcePending=false;
  const lifecycle={ready:true,purpose,intent:'review',get submitted(){return submitted;},get sourcePending(){return sourcePending;},
    get firstOutcome(){return assessments.length?canonicalOutcome:undefined;},
    async submit(answer){calls.push(['submit',answer]);await submitWait?.promise;if(failures-- >0)throw Error('disk failed');if(submitted&&answer!==original)throw Error('original mutated');submitted=true;original=answer;},
    async assess(outcome){calls.push(['assess',outcome.status]);assessments.push(outcome);sourcePending=pendingOnAssess;},
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
    onGrade(rating,options){grades.push({rating,options});if(pendingOnGrade){sourcePending=true;return;}if(noGradeReceipt)return;if(options?.deferAdvance){const ticket=draft.begin();if(ticket)store.commit(ticket,()=>moves.push('formal'));}}});
  hooks.flush();
  return {hooks,store,draft,lifecycle,runner,calls,grades,children,assessments,moves,data,original:()=>original,setSourcePending:value=>{sourcePending=value;pendingOnAssess=value;},
    click:async(label)=>{const target=button(hooks.view(),label)||[...nodes(hooks.view())].find(node=>node.type==='button'&&text(node).endsWith(label));assert.ok(target,`Missing ${label}`);await target.props.onClick();await settle(hooks);},
    run:async()=>{const target=[...nodes(hooks.view())].find(node=>node.type==='button'&&text(node).includes('运行测试'));assert.ok(target);await target.props.onClick();await settle(hooks);},
    edit:async(value)=>{const editor=[...nodes(hooks.view())].find(node=>node.props.onChange&&Object.hasOwn(node.props,'readOnly')&&Object.hasOwn(node.props,'value'));assert.ok(editor);editor.props.onChange(value);await settle(hooks);}};
}
async function settle(hooks){for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}}

test('remediation public pass reports the retained first review need without demanding another current-code change',async()=>{
 const f=fixture({purpose:'remediation',canonicalOutcome:{status:'incorrect',source:'deterministic',rating:'again',explanation:'Original first check failed.'}});
 try{
  await f.run();
  assert.match(text(f.hooks.view()),/公开测试通过 · 首轮仍需复习/);
  assert.doesNotMatch(text(f.hooks.view()),/公开测试通过 · 仍需修改/);
  assert.equal(f.assessments[0].status,'correct');assert.equal(f.grades.length,0);
 }finally{f.hooks.unmount();}
});

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

for(const [status,rating] of [['incorrect','again'],['partial','hard']])test('public checks do not hide the stored AI '+status+' outcome',async()=>{
 const f=fixture({canonicalOutcome:{status,source:'model',rating,explanation:'Missing the source requirement for negative inputs.'}});
 try{
  await f.run();assert.equal(f.draft.read('firstRunKind',''),'incorrect');assert.equal(f.draft.read('codeState',''),'coding');
  assert.match(f.draft.read('firstTestOutput',''),/negative inputs/);
  assert.equal(f.grades[0].rating,rating);assert.match(text(f.hooks.view()),/公开测试通过 · 仍需修改/);
 }finally{f.hooks.unmount();}
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

test('controlled-source pending keeps public-test success separate from the first formal result',async t=>{
  const f=fixture({pendingOnAssess:true});t.after(()=>f.hooks.unmount());await f.run();
  assert.equal(f.original(),'bad');assert.equal(f.draft.read('firstRunKind',''),'pending');
  assert.equal(f.draft.read('firstNeedsReview',false),true);assert.equal(f.grades.length,0);
  assert.match(text(f.hooks.view()),/待核对/);
  await f.click('保留待核对结果，继续');assert.deepEqual(f.moves,['pending']);assert.equal(f.grades.length,0);
});
test('controlled-source pending does not save an attributed error or explicit give-up as a formal again',async t=>{
  const errorFixture=fixture({pendingOnAssess:true,outcomes:[error('PythonError',{executionPhase:'program'})]});
  const giveUp=fixture({pendingOnAssess:true});t.after(()=>{errorFixture.hooks.unmount();giveUp.hooks.unmount();});
  await errorFixture.run();assert.equal(errorFixture.grades.length,0);
  assert.equal(errorFixture.draft.read('firstRunKind',''),'pending');
  await giveUp.click('查看题解');assert.equal(giveUp.original(),'bad');assert.equal(giveUp.grades.length,0);
  assert.equal(giveUp.draft.read('firstNeedsReview',false),true);
});
test('a void formal callback with no durable feedback remains retryable instead of consuming continue',async t=>{
  const f=fixture({noGradeReceipt:true});t.after(()=>f.hooks.unmount());await f.run();
  await f.click('继续');await f.click('继续');
  assert.equal(f.grades.length,2);assert.equal(f.moves.length,0);
  assert.match(text(f.hooks.view()),/尚未.*保存|持久回执/);
});
test('source becoming pending during formal callback does not consume official continuation',async t=>{
  const f=fixture({pendingOnGrade:true});t.after(()=>f.hooks.unmount());await f.run();
  await f.click('继续');assert.equal(f.grades.length,1);assert.equal(f.moves.length,0);
  assert.equal(f.draft.read('firstNeedsReview',false),true);
  await f.click('保留待核对结果，继续');assert.deepEqual(f.moves,['pending']);
});

test('actual host lifecycle persists source-pending code reports and oral ratings without an official callback',async t=>{
  const {IDBFactory}=await import('fake-indexeddb');
  globalThis.indexedDB=new IDBFactory();
  const {createNonWordRuntime,recoveryFields,rawAnswer,restoredFields,evaluationPhase}=await import('../src/infrastructure/nonword-study/index.ts');
  const {attachPracticeDriver}=await import('../src/infrastructure/practice-evidence/index.ts');
  const {waitForObservation}=await import('./helpers/causal-harness.mjs');
  for(const mode of ['code','flashcard'])await t.test(mode,async t=>{
    const parent=createHooks(),child=createHooks(),parentLoad=loader(parent.api);
    let rendered,driver,formalCalls=0;
    t.after(()=>{child.unmount();parent.unmount();});
    const scope={workspaceId:'account:pending-'+mode,ownerId:'pending-'+mode,libraryId:'synthetic-library',
      snapshotId:'synthetic-source',itemKey:'practice:'+mode,contentHash:'a'.repeat(64),groupId:'synthetic-group',
      roundId:'source-pending-round',cloud:false,sourceConfirmationRequired:true};
    const draft=parentLoad('app/learning-draft-store.ts').createLearningDraftStore(scope.workspaceId).adapter(mode,mode);
    const createDriver=async(purpose,intent,parentAttemptId,instanceId)=>{
      const runtime=await createNonWordRuntime(scope,mode,{purpose,intent,parentAttemptId,instanceId,
        sourceAdmission:async attempt=>{
          assert.equal(attempt.submitted.answer,mode==='code'?'def f():\n  return 1':'');
          return {status:'pending',reason:'可信来源已登记，专用评价仍待核对。',reasonCode:'no-reference'};
        }});
      const base={runtime,restore:()=>restoredFields(runtime.session.snapshot(),mode),
        fields:values=>recoveryFields(mode,values),answer:values=>rawAnswer(mode,values),
        phase:()=>evaluationPhase(runtime.session.snapshot()),verifiedCore:async()=>null,
        source:{review:async()=>{},beforeFormal:()=>assert.fail('Pending cannot claim source evidence.')}};
      driver=mode==='code'?await attachPracticeDriver(base,runtime):base;return driver;
    };
    parent.mount(parentLoad('src/features/nonword-study/host.tsx').NonWordStudyHost,{
      bindingKey:JSON.stringify(scope),mode,draft,reference:'Synthetic approved reference.',recallConfigured:false,
      sourceConfirmationRequired:true,createDriver,renderPlugin:(draft,lifecycle,grade)=>{
        rendered={draft,lifecycle,grade};return null;},
      onGrade:async()=>{formalCalls++;},resumeFormal:()=>assert.fail('Pending cannot continue formally.'),
      continuePending:()=>{},renderMath:value=>value});
    async function settleParent(){
      for(let i=0;i<5;i++){await settle(parent);
        const slot=[...nodes(parent.view())].find(node=>node.props.renderPlugin&&node.props.lifecycle&&node.props.draft);
        if(slot&&typeof slot.type==='function')slot.type(slot.props);
      }
    }
    await waitForObservation(settleParent,()=>Boolean(rendered?.lifecycle.ready),{label:'real '+mode+' source-pending host'});
    const runner={isReady:true,error:null,retry(){},cancel(){},
      async runPython(code,_capture,_input,_tests,options){
        assert.equal(code,'def f():\n  return 1');
        return {output:'synthetic public assertion passed',assertionsPassed:1,
          report:{schemaVersion:1,runId:1,identity:options.identity,status:'passed',phase:'tests',outcome:'success',
            assertionsPassed:1,assertionsExecuted:1,mapping:{prefixLineCount:0,originalLineCount:2}}};
      }};
    const childLoad=loader(child.api,{'app/hooks/use-pyodide.ts':{usePyodide:()=>runner},
      'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},'app/study-guidance.tsx':{StudyGuidance:()=>null},
      'app/assistance-display.tsx':{useAssistance:()=>({submit(){}}),useAssistanceDisplay(){}},
      'app/components/code-editor.tsx':{CodeEditor:()=>null},'app/math-text.tsx':{MathText:()=>null},
      'src/features/remediation/index.ts':{CodeRewriteLauncher:()=>null,CandidateLauncher:()=>null},
      'app/use-study-swipe.ts':{useStudySwipe:()=>({})}},{addEventListener(){},removeEventListener(){}});
    const props={data:mode==='code'?{topic:'Synthetic',prompt:'Return one',initialCode:'def f():\n  return 1',
      testCode:'assert f() == 1',solutionCode:'def f():\n  return 1',explanation:'Return one'}:
      {itemId:'synthetic-card',front:'Recall one fact',back:'Synthetic source fact'},
      context:{draft:rendered.draft,nonWordLearning:rendered.lifecycle},onGrade:rendered.grade};
    if(mode==='code')child.mount(childLoad('app/plugins/plugin-code.tsx').CodePlugin.renderUI,props);
    else{const shell=childLoad('app/plugins/plugin-flashcard.tsx').FlashcardPlugin.renderUI(props);child.mount(shell.type,shell.props);}
    child.flush();
    if(mode==='code'){
      await [...nodes(child.view())].find(node=>node.type==='button'&&text(node).includes('运行测试')).props.onClick();
    }else{
      await [...nodes(child.view())].find(node=>node.type==='button'&&text(node).startsWith('显示答案')).props.onClick();await settle(child);
      await [...nodes(child.view())].find(node=>node.type==='button'&&text(node).startsWith('极易')).props.onClick();
    }
    await settle(child);await settleParent();
    const saved=driver.runtime.session.snapshot();
    assert.equal(saved.evaluation.status,'pending');assert.equal(saved.formal,null);assert.equal(formalCalls,0);
    assert.equal(saved.submitted.answer,mode==='code'?'def f():\n  return 1':'');
    assert.equal(rendered.lifecycle.sourcePending,true);assert.match(text(child.view()),/待核对/);
    if(mode==='code'){
      assert.equal(rendered.draft.read('firstRunKind',''),'pending');
      assert.equal(driver.runtime.practice.snapshot().execution.first.status,'passed');
      assert.ok(button(child.view(),'保留待核对结果，继续'));
    }else{
      assert.equal(rendered.draft.read('flashcardRating',null),'easy');
      assert.equal(button(child.view(),'继续'),undefined);assert.ok(button(child.view(),'重试保存自评'));
    }
  });
});

test('a pending original run remains editable and can recover its formal feedback after reliable recheck',async t=>{
  const f=fixture({pendingOnAssess:true,outcomes:[{output:'first public run',assertionsPassed:1},{output:'retry public run',assertionsPassed:1}]});
  t.after(()=>f.hooks.unmount());await f.run();assert.equal(f.draft.read('firstRunKind',''),'pending');
  assert.equal([...nodes(f.hooks.view())].find(node=>node.props.onChange&&Object.hasOwn(node.props,'readOnly')).props.readOnly,false);
  f.setSourcePending(false);await f.run();assert.equal(f.draft.read('firstRunKind',''),'correct');
  await f.click('继续');await f.click('继续');assert.equal(f.grades.length,1);assert.deepEqual(f.moves,['formal']);
  assert.equal(f.original(),'bad');assert.equal(f.children.length,0);
});
