import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxHandler,tsxEffect} from './fixtures/tsx-handlers.mjs';
import {isSpellingComplete} from '../app/plugins/spelling-core.ts';
const flash=new URL('../app/plugins/plugin-flashcard.tsx',import.meta.url);
class Element{constructor(interactive=false){this.interactive=interactive;}closest(){return this.interactive?this:null;}}
test('flashcard Space does not steal keyboard activation from dialogs or input controls',()=>{
  for(const [interactive,modal]of [[true,false],[false,true]]){
    let flipped=false,prevented=false;
    const handler=tsxHandler(flash,'handleKeyDown',{Element,document:{querySelector:()=>modal?{}:null},isFlipped:false,setIsFlipped:value=>flipped=value});
    handler({code:'Space',target:new Element(interactive),preventDefault:()=>prevented=true});
    assert.equal(flipped,false);assert.equal(prevented,false);
  }
});
test('ordinary background Space still reveals the flashcard, but modifiers do not',()=>{
  for(const modified of [false,true]){
    let flipped=false;
    const handler=tsxHandler(flash,'handleKeyDown',{Element,context:undefined,lifecycle:undefined,saving:false,chooseGrade:()=>assert.fail('Space must reveal without grading'),document:{querySelector:()=>null},isFlipped:false,ready:true,showAnswer:false,consumed:{current:false},setIsFlipped:value=>flipped=value});
    handler({code:'Space',target:new Element(),ctrlKey:modified,preventDefault(){}});assert.equal(flipped,!modified);
  }
});
test('spelling completion timer is cancelled when editing resumes or the plugin unmounts',()=>{
  const file=new URL('../app/plugins/plugin-spelling.tsx',import.meta.url),timers=new Map(),finishTimer={current:undefined};let token=0;
  const window={setTimeout:fn=>{timers.set(++token,fn);return token;},clearTimeout:id=>timers.delete(id)};
  const base={word:'cat',input:'ca',wrong:'',wrongCount:0},full={...base,input:'cat'};
  const env={done:null,showWord:false,finishTimer,window,setState(){},groupAt:()=>-1,setClock(){},performance:{now:()=>100},isSpellingComplete,finish(){throw new Error('Cancelled attempt must not be graded');}};
  tsxHandler(file,'acceptInput',{...env,state:base})(full);assert.equal(timers.size,1);
  tsxHandler(file,'acceptInput',{...env,state:full})(base);assert.equal(timers.size,0);
  tsxHandler(file,'acceptInput',{...env,state:base})(full);
  const cleanup=tsxEffect(file,'finishTimer',{window,finishTimer})();cleanup();assert.equal(timers.size,0);
});
test('restored spelling keeps answer-reveal and mistake penalties',()=>{
  const file=new URL('../app/plugins/plugin-spelling.tsx',import.meta.url);
  for(const [showWord,wrongCount,correct]of [[true,0,false],[false,3,false],[false,1,true]]){
    let result;tsxHandler(file,'submitRestored',{showWord,state:{wrongCount},finish:value=>result=value})();assert.equal(result,correct);
  }
});
test('unmounted draft setters cannot clear a newly edited buffer after an old request returns',()=>{
  const file=new URL('../app/learning-draft.tsx',import.meta.url),mounted={current:true},current={current:'new input'};
  let writes=0;
  const cleanup=tsxEffect(file,'mounted.current',{mounted})();cleanup();
  const setter=tsxHandler(file,'set',{mounted,current,holder:{current:{write:()=>writes++}},field:'answer',setValue:()=>writes++,useCallback:fn=>fn});
  setter('');assert.equal(writes,0);assert.equal(current.current,'new input');
});
test('a tutor response does not erase the next question typed while waiting',async()=>{
  let resolve,question='first question';const questionRevision={current:0},response=new Promise(done=>resolve=done);
  const ask=tsxHandler(new URL('../app/plugins/tutor-follow-up.tsx',import.meta.url),'ask',{question,questionRevision,loading:false,requestBusy:{current:false},item:{},setLoading(){},setError(){},setAnswer(){},setAnswerDisplayId(){},setQuestion:value=>question=value,askTutor:()=>response});
  const pending=ask();question='next question';questionRevision.current++;resolve('response to first');await pending;
  assert.equal(question,'next question');
});
test('CodeMirror indents and outdents four spaces without claiming modified browser Tab keys',async()=>{
  const {EditorState}=await import('@codemirror/state'),{indentUnit}=await import('@codemirror/language');
  const {codeEditorKeymap}=await import('../app/components/code-editor-runtime.ts');
  let state=EditorState.create({doc:'pass',extensions:[indentUnit.of('    ')]});
  const view={get state(){return state;},dispatch:transaction=>{state=transaction.state;}};
  const binding=codeEditorKeymap.find(key=>key.key==='Tab');assert.ok(binding);
  assert.equal(binding.run(view),true);assert.equal(state.doc.toString(),'    pass');
  assert.equal(binding.shift(view),true);assert.equal(state.doc.toString(),'pass');
  assert.equal(codeEditorKeymap.some(key=>['Ctrl-Tab','Meta-Tab','Alt-Tab'].includes(key.key)),false);
});
test('a quick tutor hint preserves a different unsent question',async()=>{
 let question='我的下一条思路',answer='',asked='';
 const ask=tsxHandler(new URL('../app/plugins/tutor-follow-up.tsx',import.meta.url),'ask',{question,questionRevision:{current:0},loading:false,requestBusy:{current:false},item:{},setLoading(){},setError(error){assert.equal(error,'');},setAnswer:value=>answer=value,setAnswerDisplayId(){},setQuestion:value=>question=value,askTutor:async prompt=>{asked=prompt;return'先检查边界。';}});
 await ask('只给我一个小提示');assert.equal(asked,'只给我一个小提示');assert.equal(answer,'先检查边界。');assert.equal(question,'我的下一条思路');
});
