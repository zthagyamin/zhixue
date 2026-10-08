import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction,tsxCalls} from './fixtures/tsx-functions.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
const display=new URL('../app/assistance-display.tsx',import.meta.url);
function renderEffects(path,values,submitted=false){
  const draft=createLearningDraftStore().adapter('item','mode'),assistance=draft.assistance;assistance.cover();if(submitted)assistance.submit();
  const document=new EventTarget();document.visibilityState='visible';
  const env={assistance,draft,context:{draft},useAssistanceDisplay(observer,action,displayId,active=true){const stop=tsxFunction(display,'useAssistanceDisplay',{observer,action,displayId,active,document},{effect:true})();stop?.();},...values};
  tsxCalls(new URL('../app/'+path,import.meta.url),'useAssistanceDisplay',env,path==='plugins/plugin-quiz.tsx'?{within:'QuizUI'}:{});return assistance.snapshot();
}
test('the three-stage render distinguishes meaning study, meaning check and a still-hidden definition',()=>{
  const path='plugins/plugin-three-stage.tsx';
  assert.deepEqual(renderEffects(path,{revealed:true,learned:true,data:{meaning:'definition'}}).preSubmitAssistance,[{action:'meaning-study',count:1}]);
  assert.deepEqual(renderEffects(path,{revealed:true,learned:false,data:{meaning:'definition'}}).preSubmitAssistance,[{action:'meaning-check',count:1}]);
  assert.deepEqual(renderEffects(path,{revealed:false,learned:false,data:{meaning:'definition'}}).preSubmitAssistance,[]);
});
test('flashcard and spelling count a displayed answer but not the unrevealed state',()=>{
  for(const [path,values,hidden] of [['plugins/plugin-flashcard.tsx',{showAnswer:true,visibleBack:'reference'},{showAnswer:false,visibleBack:'reference'}],['plugins/plugin-spelling.tsx',{showWord:true,word:'term'},{showWord:false,word:'term'}]]){
    assert.deepEqual(renderEffects(path,values).preSubmitAssistance,[{action:'reference-answer',count:1}]);assert.deepEqual(renderEffects(path,hidden).preSubmitAssistance,[]);
  }
});
test('quiz counts a visible retry hint but not an old hint hidden by the answer panel',()=>{
  const data={quizState:'guessing',hintText:'hint',hintDisplayId:'hint-one',feedbackDisplayId:null,selectedOption:null};
  assert.deepEqual(renderEffects('plugins/plugin-quiz.tsx',data,true).postSubmitFeedback,[{action:'ai-hint',count:1}]);
  assert.deepEqual(renderEffects('plugins/plugin-quiz.tsx',{...data,quizState:'answered'},true).postSubmitFeedback,[]);
});
test('recall self-assessment reference is pre-help, while displayed AI grading is feedback',()=>{
  const path='plugin-recall.tsx',data={hintLevel:0,policy:{state:null},revealed:true,reference:'reference',result:{source:'self-assess',aiFallback:true},feedbackDisplayId:null};
  assert.deepEqual(renderEffects(path,data).preSubmitAssistance,[{action:'reference-answer',count:1}]);
  const graded=renderEffects(path,{...data,result:{source:'ai',verdict:'partial'},feedbackDisplayId:'grade-one'},true);
  assert.deepEqual(graded.preSubmitAssistance,[]);assert.deepEqual(graded.postSubmitFeedback,[{action:'answer-feedback',count:1}]);
});
test('code references respect the first-run phase and running text is not result feedback',()=>{
  const path='plugins/plugin-code.tsx',data={codeState:'gave_up',data:{solutionCode:'return 1',explanation:''},testOutput:'',testOutputId:null,isTesting:false};
  assert.deepEqual(renderEffects(path,data).preSubmitAssistance,[{action:'reference-answer',count:1}]);
  assert.deepEqual(renderEffects(path,data,true).postSubmitFeedback,[{action:'reference-answer',count:1}]);
  assert.deepEqual(renderEffects(path,{...data,codeState:'coding',isTesting:true,testOutput:'Running tests...',testOutputId:'old-result'},true).postSubmitFeedback,[]);
});
test('calculation failure and unavailable Tutor callbacks do not manufacture assistance',()=>{
  assert.deepEqual(renderEffects('plugin-calculation.tsx',{result:{correct:null},feedbackDisplayId:'old-result'},true).postSubmitFeedback,[]);
  assert.deepEqual(renderEffects('plugins/tutor-follow-up.tsx',{askTutor:undefined,answer:'old answer',answerDisplayId:'old-reply'},true).postSubmitFeedback,[]);
});
test('Tutor counts each actually visible nonempty reply by its stable display ID',()=>{
  const result=renderEffects('plugins/tutor-follow-up.tsx',{askTutor:async()=>'',answer:'help',answerDisplayId:'reply-one'},true);
  assert.deepEqual(result.postSubmitFeedback,[{action:'ai-tutor',count:1}]);
});
