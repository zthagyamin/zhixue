import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {IDBFactory} from 'fake-indexeddb';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';

function fixture({payload={verdict:'correct',correct:true,explanation:'相同的数值。'},purpose='first',submitWait,failSubmit=false,failSubmitValue,failAssess=false,failGrade=false,data:providedData,durableRuntime}={}){
  const hooks=createHooks(),calls=[],grades=[],assessments=[],moves=[];
  let submitted=false,original,submitFailures=Number(failSubmit),assessFailures=Number(failAssess),gradeFailures=Number(failGrade);
  const lifecycle={ready:true,purpose,intent:'review',get submitted(){return submitted;},
    async submit(answer){calls.push(['submit',answer]);await submitWait?.promise;if(submitFailures-- >0)throw failSubmitValue===undefined?Error('synthetic answer storage failure'):failSubmitValue;if(submitted&&answer!==original)throw Error('original mutated');if(durableRuntime)await durableRuntime.session.submit(answer);submitted=true;original=answer;},
    async assess(outcome){calls.push(['assess',outcome.status]);if(assessFailures-- >0)throw Error('synthetic evaluation storage failure');assessments.push(outcome);},
    async waitForReview(reason){calls.push(['pending',reason]);if(durableRuntime)await durableRuntime.session.pending('no-reference',reason);},async continuePending(){if(durableRuntime)await durableRuntime.session.traversePending();moves.push('pending');},
    async startRemediation(){calls.push(['start-child']);},async finishRemediation(){moves.push('finish-child');},
  };
  function MathText(){return null;}function MathPracticeLauncher(){return null;}function SourceReviewLauncher(){return null;}
  const load=loader(hooks.api,{'app/math-text.tsx':{MathText},'app/study-guidance.tsx':{StudyGuidance:()=>null},
    'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},'app/assistance-display.tsx':{useAssistance:()=>({submit:()=>calls.push(['observation'])}),useAssistanceDisplay(){}},
    'app/calculation-exploration.tsx':{CalculationExploration:()=>null},'src/features/guided-math/index.ts':{MathPracticeLauncher},
    'src/features/remediation/index.ts':{SourceReviewLauncher},'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:()=>null}});
  const store=load('app/learning-draft-store.ts').createLearningDraftStore('calc-flow'),draft=store.adapter('A','calculation:1');
  const data=providedData??{itemId:'A',contentHash:'a'.repeat(64),prompt:'计算 $\\frac{3}{4}$ 的数值。',answer:'0.75',explanation:'按分子除以分母计算。'};
  hooks.mount(load('app/plugin-calculation.tsx').CalculationPlugin.renderUI,{data,context:{draft,nonWordLearning:lifecycle,
    gradeCalculation:async(item,answer,signal)=>{calls.push(['grade',answer,item,signal]);const outcome=typeof payload==='function'?await payload(signal):payload;if(outcome instanceof Error)throw outcome;return outcome;}},
    async onGrade(rating,options){grades.push({rating,options});if(gradeFailures-- >0)throw Error('synthetic formal storage failure');if(options?.deferAdvance){const ticket=draft.begin();if(ticket)store.commit(ticket,()=>moves.push('formal'));}}});
  hooks.flush();
  return {hooks,store,draft,calls,grades,assessments,moves,lifecycle,data,original:()=>original,MathText,MathPracticeLauncher,SourceReviewLauncher,
    input:()=>[...nodes(hooks.view())].find(node=>node.type==='input'),
    edit:async(value)=>{[...nodes(hooks.view())].find(node=>node.type==='input').props.onChange({target:{value}});await settle(hooks);},
    click:async(label)=>{const target=button(hooks.view(),label);assert.ok(target,`Missing ${label}`);await target.props.onClick();await settle(hooks);}};
}
async function settle(hooks){for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}}

test('exact numeric input is durably submitted before authenticated deterministic grading',async()=>{
  const wait=deferred(),f=fixture({submitWait:wait});await f.edit('  3/4  ');const operation=f.click('提交');await tick();assert.equal(f.calls.some(call=>call[0]==='grade'),false);
  await f.click('提交');assert.equal(f.calls.filter(call=>call[0]==='submit').length,1);
  wait.resolve();await operation;assert.equal(f.original(),'  3/4  ');assert.equal(f.calls.find(call=>call[0]==='grade')[1],'  3/4  ');
  assert.deepEqual(f.calls.filter(call=>['submit','grade','assess'].includes(call[0])).map(call=>call[0]),['submit','grade','assess']);
  assert.equal(f.assessments[0].source,'deterministic');assert.deepEqual(f.grades,[{rating:'good',options:{deferAdvance:true}}]);assert.equal(f.moves.length,0);f.hooks.unmount();
});
test('wrong deterministic result preserves actual input, saves again, and exposes inline child rather than a modal',async()=>{
  const f=fixture({payload:{verdict:'wrong',correct:false,explanation:'参考结果为 $0.75$。'}});await f.edit('0.25');await f.click('提交');
  assert.equal(f.original(),'0.25');assert.equal(f.input().props.readOnly,true);assert.equal(f.assessments[0].status,'incorrect');assert.equal(f.grades[0].rating,'again');
  await f.click('收起解法重算');assert.ok(f.calls.some(call=>call[0]==='start-child'));assert.equal([...nodes(f.hooks.view())].some(node=>node.type===f.SourceReviewLauncher),false);
  await f.click('继续');assert.deepEqual(f.moves,['formal']);assert.equal(f.grades.length,1);f.hooks.unmount();
});
for(const payload of [{verdict:'unknown',correct:null,explanation:'暂不支持这个表达式。'},new Error('连接失败'),{verdict:'correct',correct:false,explanation:'矛盾结果'},
  {verdict:'correct',correct:true,source:'ai',explanation:'模型猜测'}, {verdict:'correct',correct:true,source:'self-assess',explanation:'自己感觉正确'}])
  test(`unknown or unsupported evidence remains pending (${payload instanceof Error?'transport':payload.source??payload.verdict})`,async()=>{
    const f=fixture({payload});await f.edit('3/4');await f.click('提交');assert.equal(f.original(),'3/4');assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);assert.ok(f.calls.some(call=>call[0]==='pending'));
    assert.equal(f.input().props.readOnly,true);await f.click('保留待核对结果，继续');await f.click('保留待核对结果，继续');assert.deepEqual(f.moves,['pending']);f.hooks.unmount();
  });
test('answer storage failure never invokes the grader or makes an evaluation',async()=>{
  const f=fixture({failSubmit:true});await f.edit('3/4');await f.click('提交');assert.equal(f.calls.some(call=>call[0]==='grade'),false);
  assert.equal(f.grades.length,0);assert.equal(f.assessments.length,0);assert.equal(f.input().props.value,'3/4');assert.match(text(f.hooks.view()),/storage failure/);f.hooks.unmount();
});

test('an aborted answer save without an Error does not claim a grading result was retained',async()=>{
  const f=fixture({failSubmit:true,failSubmitValue:null});await f.edit(' 3/4 ');await f.click('提交');
  assert.equal(f.calls.some(call=>call[0]==='grade'),false);assert.equal(f.grades.length,0);assert.equal(f.assessments.length,0);
  assert.equal(f.input().props.value,' 3/4 ');assert.match(text(f.hooks.view()),/作答未完成，当前输入保留。/);
  assert.doesNotMatch(text(f.hooks.view()),/核对结果已保留/);f.hooks.unmount();
});
for(const failure of ['failAssess','failGrade'])test(`${failure} preserves correct feedback and retries persistence without rerunning mathematics`,async()=>{
  const f=fixture({[failure]:true});await f.edit('3/4');await f.click('提交');assert.equal(f.draft.read('result',{}).correct,true);assert.equal(f.input().props.value,'3/4');
  await f.click('重试保存');assert.equal(f.calls.filter(call=>call[0]==='grade').length,1);assert.equal(f.draft.hasSavedFeedback(),true);
  assert.equal(f.draft.read('result',{}).correct,true);f.hooks.unmount();
});
test('the displayed question uses actual formula rendering and a long solution stays folded',async()=>{
  const solution='从给定条件逐步计算。\n'.repeat(120),f=fixture({payload:{verdict:'correct',correct:true,explanation:solution}});
  assert.ok([...nodes(f.hooks.view())].some(node=>node.type===f.MathText&&node.props.text===f.data.prompt));
  await f.edit('3/4');await f.click('提交');const details=[...nodes(f.hooks.view())].find(node=>node.type==='details'&&text(node).includes('查看完整解析'));
  assert.ok(details);assert.equal(details.props.open,undefined);assert.ok([...nodes(details)].some(node=>node.type===f.MathText&&node.props.text===solution));f.hooks.unmount();
});
test('no authoritative source-template mapping means no fabricated variation launcher',async()=>{
  const f=fixture();await f.edit('3/4');await f.click('提交');assert.equal([...nodes(f.hooks.view())].some(node=>node.type===f.MathPracticeLauncher),false);
  assert.equal(button(f.hooks.view(),'换条件，再练一题'),undefined);assert.equal(button(f.hooks.view(),'收起解法重算'),undefined);f.hooks.unmount();
});
test('a remediation calculation uses the same source and answer control, records no formal grade, and finishes through the parent',async()=>{
  const f=fixture({purpose:'remediation'});assert.equal(f.input().props.value,'');assert.equal([...nodes(f.hooks.view())].some(node=>node.type===f.MathText&&node.props.text===f.data.explanation),false);
  await f.edit('0.75');await f.click('提交');assert.equal(f.assessments[0].status,'correct');assert.equal(f.grades.length,0);await f.click('结束补练，继续');assert.deepEqual(f.moves,['finish-child']);f.hooks.unmount();
});
test('late results after leaving the calculation view cannot evaluate or grade the old answer',async()=>{
  const wait=deferred(),f=fixture({payload:()=>wait.promise});await f.edit('3/4');const operation=f.click('提交');await tick();await tick();f.hooks.unmount();wait.resolve({verdict:'correct',correct:true});await operation;
  assert.equal(f.assessments.length,0);assert.equal(f.grades.length,0);
});
test('rechecking a pending original input can resolve it without accepting a different answer',async()=>{
  const responses=[{verdict:'unknown',correct:null,explanation:'本次环境未能判定。'},{verdict:'correct',correct:true,explanation:'确定性结果一致。'}];
  const f=fixture({payload:()=>responses.shift()});await f.edit(' 3/4 ');await f.click('提交');assert.equal(f.grades.length,0);assert.equal(f.input().props.readOnly,true);
  await f.click('提交');assert.deepEqual(f.calls.filter(call=>call[0]==='grade').map(call=>call[1]),[' 3/4 ',' 3/4 ']);
  assert.equal(f.original(),' 3/4 ');assert.equal(f.assessments.length,1);assert.equal(f.assessments[0].status,'correct');assert.equal(f.grades.length,1);f.hooks.unmount();
});

test('actual Python legacy reference responses leave the actual plugin answer durable and pending without a grade',async()=>{
  globalThis.indexedDB=new IDBFactory();
  const cases=[['NaN','计算 1 + 1。','2'],['Infinity','计算 1 + 1。','2'],['1e999','计算 1 + 1。','2'],['42','42','42']];
  const script=`import json,sys
sys.path.insert(0,'companion')
import practice_engine
values=json.load(sys.stdin)
print(json.dumps([practice_engine.grade_answer({'questionType':'calculation','prompt':prompt,'answer':reference},answer,ai_available=False) for reference,prompt,answer in values],ensure_ascii=True))`;
  const result=spawnSync(process.env.PYTHON||'python',['-B','-X','utf8','-c',script],{input:JSON.stringify(cases),encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  const replies=JSON.parse(result.stdout);
  for(const [index,[reference,prompt,answer]] of cases.entries()){
    const scope={workspaceId:'guest:local',ownerId:'calc-reference-owner',libraryId:'calc-reference-library',snapshotId:'s',itemKey:'q-'+index,contentHash:'a'.repeat(64),groupId:'g-'+index,roundId:'r-'+index,cloud:false};
    const runtime=await createNonWordRuntime(scope,'calculation');await runtime.session.open();
    const f=fixture({payload:replies[index],durableRuntime:runtime,data:{itemId:scope.itemKey,contentHash:scope.contentHash,prompt,answer:reference}});
    try{
      await f.edit(answer);await f.click('提交');
      assert.equal(f.grades.length,0);assert.equal(f.assessments.length,0);
      const reopened=await createNonWordRuntime(scope,'calculation');await reopened.session.open();
      assert.equal(reopened.session.snapshot().submitted.answer,answer);
      assert.equal(reopened.session.snapshot().evaluation.status,'pending');assert.equal(reopened.session.snapshot().formal,null);
      await f.click('保留待核对结果，继续');assert.deepEqual(f.moves,['pending']);
      const stored=await runtime.repository.read(runtime.session.snapshot().attemptId);
      assert.equal(stored.checkpoint.traversed,true);assert.equal(stored.formal,null);
    }finally{f.hooks.unmount();}
  }
});
