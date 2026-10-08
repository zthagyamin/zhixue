import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,tick} from './helpers/causal-harness.mjs';

const identity={attemptId:'structured-attempt',revision:1,sourceVersion:'a'.repeat(64),testVersion:'a'.repeat(64)};
const support={schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[1,2],expected:3,hint:'检查两个参数是否都加到了结果中。'}]};
const report={schemaVersion:1,runId:1,identity,status:'failed',phase:'tests',outcome:'student-error',assertionsPassed:0,assertionsExecuted:1,
    mapping:{prefixLineCount:0,originalLineCount:2},firstFailure:{caseId:'sum',functionName:'add',args:[1,2],kwargs:{},expected:3,actual:-1,hint:support.cases[0].hint}};
function fixture(){
    const hooks=createHooks(),calls=[],grades=[];let saved=null;
    const lifecycle={ready:true,purpose:'first',intent:'review',submitted:false,async submit(){calls.push('submit');this.submitted=true;},
        async prepareExecution(){calls.push('prepare');return identity;},async recordExecutionReport(value,output){calls.push('report');saved={latest:value,output};},
        async assess(){calls.push('assess');},async waitForReview(){calls.push('pending');},async recordRemediation(){calls.push('child');},
        practice:{snapshot:()=>null,codeFeedback:async()=>saved??{},async recordCodeHint(){calls.push('hint');}}};
    const runner={isReady:true,error:null,retry(){},cancel(){},async runPython(...args){calls.push('run');runner.args=args;throw Object.assign(new Error('full traceback'),{name:'PythonError',report});}};
    const load=loader(hooks.api,{'app/hooks/use-pyodide.ts':{usePyodide:()=>runner},'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
        'app/assistance-display.tsx':{useAssistance:()=>({submit(){}}),useAssistanceDisplay(){}},'app/components/code-editor.tsx':{CodeEditor:()=>null},
        'app/study-guidance.tsx':{StudyGuidance:()=>null},'src/features/remediation/index.ts':{CodeRewriteLauncher:()=>null},'app/math-text.tsx':{MathText:()=>null}});
    const store=load('app/learning-draft-store.ts').createLearningDraftStore('structured-interaction'),draft=store.adapter('owner','item');
    const data={topic:'Python',prompt:'编写 add(a,b)，返回两个参数之和。',initialCode:'def add(a,b):\n return a-b',testCode:'',solutionCode:'def add(a,b):\n return a+b',explanation:'两个参数都要参与求和。',learningSupport:support};
    hooks.mount(load('app/plugins/plugin-code.tsx').CodePlugin.renderUI,{data,context:{draft,nonWordLearning:lifecycle,async requestAiHint(){calls.push('model');return 'model hint';}},onGrade:rating=>grades.push(rating)});hooks.flush();
    const settle=async()=>{for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}};
    const childHooks=createHooks(),childLoader=loader(childHooks.api);
    const feedback=()=>{
        const child=[...nodes(hooks.view())].find(node=>node.type?.name==='CodeCaseFeedback');assert.ok(child);
        childHooks.mount(childLoader('src/features/code-study/feedback.tsx').CodeCaseFeedback,child.props);childHooks.flush();
        return childHooks.view();
    };
    return {hooks,calls,grades,runner,childHooks,feedback,async run(){const target=[...nodes(hooks.view())].find(node=>node.type==='button'&&text(node).includes('运行测试'));assert.equal(target.props.disabled,false);await target.props.onClick();await settle();},async hint(){
        feedback();
        const target=button(childHooks.view(),'小提示');assert.ok(target);await target.props.onClick();childHooks.render();
    }};
}
test('structured function cases submit and save a bound report before grading, with no legacy script requirement',async()=>{
    const f=fixture();await f.run();assert.deepEqual(f.calls,['submit','prepare','run','report','assess']);
    assert.equal(f.runner.args[3],undefined);assert.equal(f.runner.args[4].identity.attemptId,identity.attemptId);
    assert.equal(f.runner.args[4].tests.cases[0].id,'sum');const visible=text(f.feedback());assert.match(visible,/预期/);assert.match(visible,/实际/);assert.match(visible,/-1/);
    assert.deepEqual(f.grades,['again']);f.childHooks.unmount();f.hooks.unmount();
});
test('a source-bound small hint appears on request without invoking AI or changing the first grade',async()=>{
    const f=fixture();await f.run();await f.hint();assert.match(text(f.childHooks.view()),/检查两个参数/);
    assert.equal(f.calls.includes('model'),false);assert.deepEqual(f.grades,['again']);f.childHooks.unmount();f.hooks.unmount();
});
