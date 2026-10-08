import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {tsxHandler,tsxEffect} from './fixtures/tsx-handlers.mjs';
const draftFile=new URL('../app/learning-draft.tsx',import.meta.url);

test('saved calculation feedback is read-only, page-local, restorable, and continues exactly once',()=>{
 const s=createLearningDraftStore('a'),a=s.adapter('q','calculation:1');let advances=0;
 a.write('value','3');a.write('result',{correct:true,explanation:'过程'});const before=s.getItemVersion('q');
 assert.equal(s.commit(a.begin(),()=>advances++),true);assert.equal(advances,0);assert.equal(s.getItemVersion('q'),before);
 assert.equal(s.hasUnsavedInput(),false);assert.equal(s.hasBuffers(),false);assert.equal(a.begin(),null);assert.equal(a.write('value','4'),false);
 const restored=s.adapter('q','calculation:1');assert.equal(restored.hasSavedFeedback(),true);assert.deepEqual(restored.read('result',null),{correct:true,explanation:'过程'});
 assert.equal(createLearningDraftStore('a').adapter('q','calculation:1').hasSavedFeedback(),false,'not a refresh recovery store');
 assert.equal(restored.continueAfterFeedback(),true);assert.equal(a.continueAfterFeedback(),false);assert.equal(advances,1);
 assert.notEqual(s.getItemVersion('q'),before);
});
for(const action of ['clear','dispose'])test(`saved feedback cannot advance after ${action}`,()=>{
 const s=createLearningDraftStore(),a=s.adapter('q','calculation');let calls=0;s.commit(a.begin(),()=>calls++);s[action]();
 assert.equal(a.hasSavedFeedback(),false);assert.equal(a.continueAfterFeedback(),false);assert.equal(calls,0);
});
test('only learner input, not an initial program or passive feedback, requires a leave warning',()=>{
 const s=createLearningDraftStore(),a=s.adapter('q','code');a.read('code','print(1)');a.write('code','print(1)');
 a.write('result',{correct:false});a.write('revealed',true);a.write('tutor.answer','生成的回复');assert.equal(s.hasUnsavedInput(),false);
 a.write('code','print(2)');assert.equal(s.hasUnsavedInput(),true);a.write('code','print(1)');assert.equal(s.hasUnsavedInput(),false);
 a.write('tutor.question','还未发送');assert.equal(s.hasUnsavedInput(),true);a.write('tutor.question','');assert.equal(s.hasUnsavedInput(),false);
});
test('spelling and choice input are dirty, and removing the input disarms the warning',()=>{
 const s=createLearningDraftStore(),a=s.adapter('word','spelling');a.write('state',{word:'cat',input:'c',wrong:'x'});assert.equal(s.hasUnsavedInput(),true);
 a.write('state',{word:'cat',input:'',wrong:''});assert.equal(s.hasUnsavedInput(),false);
 a.write('quizSelectedIds',['option-a']);assert.equal(s.hasUnsavedInput(),true);a.write('quizSelectedIds',[]);assert.equal(s.hasUnsavedInput(),false);
});
for(const kind of ['clean','dirty','pending','failed','saved'])test(`beforeunload warning tracks ${kind} and cleans up its real listener`,()=>{
 const store=createLearningDraftStore(),draft=store.adapter('q','calculation');
 if(kind==='dirty')draft.write('value','未提交');
 if(kind==='pending')draft.begin();
 if(kind==='failed'){const ticket=draft.begin();store.fail(ticket);}
 if(kind==='saved'){draft.write('value','3');store.commit(draft.begin(),()=>{});}
 let listener,removed=0;
 const window={addEventListener:(type,fn)=>{assert.equal(type,'beforeunload');listener=fn;},removeEventListener:(type,fn)=>{assert.equal(type,'beforeunload');assert.equal(fn,listener);removed++;}};
 const needsWarning=store.isPending()||store.hasUnsavedInput()||store.failureTitles().length>0;
 const cleanup=tsxEffect(draftFile,'beforeUnload',{store,needsWarning,window})();assert.equal(Boolean(listener),['dirty','pending','failed'].includes(kind));
 if(listener){let prevented=0;const event={preventDefault:()=>prevented++,returnValue:undefined};listener(event);assert.equal(prevented,1);assert.equal(event.returnValue,'');store.clear();listener(event);assert.equal(prevented,1,'recheck live store before warning');cleanup();assert.equal(removed,1);}
});
for(const verdict of ['correct','wrong','unknown'])test(`calculation ${verdict} retains the result and requests deferred advancement only for known grades`,async()=>{
 let result,requestCount=0;const grades=[],request={current:null};
 const submit=tsxHandler(new URL('../app/plugin-calculation.tsx',import.meta.url),'handleSubmit',{
  value:'3',result:null,submitting:false,request,active:{current:true},identity:'q',currentIdentity:{current:'q'},assistance:undefined,
  data:{},context:{},setSubmitting(){},setFeedbackDisplayId(){},setResult:value=>result=value,
  gradeCalculation:async()=>{requestCount++;return{verdict,explanation:'完整解析'};},onGrade:(...args)=>grades.push(args),
 });
 await submit();assert.equal(requestCount,1);assert.equal(request.current,null);assert.equal(result.explanation,'完整解析');
 assert.deepEqual(grades,verdict==='unknown'?[]:[[verdict==='correct'?'good':'again',{deferAdvance:true}]]);
});
test('repeated calculation submit during a pending request never launches a second grader',async()=>{
 let release,calls=0;const request={current:null};
 const submit=tsxHandler(new URL('../app/plugin-calculation.tsx',import.meta.url),'handleSubmit',{
 value:'3',result:null,submitting:false,request,active:{current:true},identity:'q',currentIdentity:{current:'q'},assistance:undefined,data:{},context:{},setSubmitting(){},setFeedbackDisplayId(){},setResult(){},onGrade(){},
 gradeCalculation:async()=>{calls++;return new Promise(resolve=>release=resolve);}});
 const waiting=submit();await submit();assert.equal(calls,1);release({verdict:'unknown'});await waiting;
});
test('display labels describe stored defaults without changing the persisted ai override value',()=>{
 const source=readFileSync(new URL('../app/study-dashboard/subject-view.tsx',import.meta.url),'utf8');
 assert.match(source,/资料默认方式/);assert.doesNotMatch(source,/AI 推荐|全部一次通过/);assert.match(source,/value="ai"/);
});
test('saved-feedback subscriptions report asynchronous save completion and unsent tutor input remains protected',()=>{
 const s=createLearningDraftStore(),a=s.adapter('q','calculation');let notified=0;const stop=a.subscribe(()=>notified++);
 const initial=a.getSnapshot(),ticket=a.begin();s.commit(ticket,()=>{});
 assert.equal(notified,2);assert.ok(a.getSnapshot()>initial);assert.equal(a.hasSavedFeedback(),true);
 a.read('tutor.question','');assert.equal(a.write('tutor.question','新追问'),true);assert.equal(s.hasUnsavedInput(),true);assert.equal(s.hasBuffers(),true);
 assert.equal(a.write('value','改写已评分答案'),false);a.write('tutor.question','');assert.equal(s.hasUnsavedInput(),false);stop();
});
