import test from 'node:test';import assert from 'node:assert/strict';
import {recallReference,recallChosenRating,recallResultRating,waitForRecallResult} from '../app/recall-flow-model.ts';
import {advanceSubjectRound,emptySubjectRound,isSubjectRoundComplete,isSubjectPassComplete,practicedSubjectKeys,skipSubjectRound} from '../app/subject-round.ts';
import {firstPendingRoundIndex,createSubjectRoundSessions} from '../app/subject-round-resume.ts';
import {createExtraPracticeState,advanceExtraPractice,skipExtraPractice} from '../app/extra-practice-state.ts';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {recallFixture,settle,nodes,text,deferred} from './helpers/recall-flow-fixture.mjs';
for(const rating of ['again','hard','good','easy'])test(`one recall rated ${rating} ends traversal without falsifying correctness`,()=>{
 const correct=['good','easy'].includes(rating),out=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['A'],currentIndex:0,correct,completeAfterAttempt:true});
 assert.equal(out.complete,true);assert.equal(isSubjectPassComplete(out.round,['A']),true);assert.deepEqual(out.round.correctKeys,correct?['A']:[]);
 assert.equal(isSubjectRoundComplete({pluginType:'recall',items:['A'],itemStages:{},keyOf:x=>x,round:out.round}),correct);
});
test('A forgotten then B correct finishes the pass; B does not cycle back to A',()=>{
 const a=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['A','B'],currentIndex:0,correct:false,completeAfterAttempt:true});assert.equal(a.nextIndex,1);assert.equal(a.complete,false);
 const b=advanceSubjectRound({round:a.round,itemKeys:['A','B'],currentIndex:1,correct:true,completeAfterAttempt:true});assert.equal(b.complete,true);assert.deepEqual(b.round.correctKeys,['B']);assert.deepEqual(b.round.wrongKeys,['A']);assert.deepEqual(practicedSubjectKeys(b.round).sort(),['A','B']);
});
test('skip traverses but adds no grade, practice count or reset',()=>{
 const out=skipSubjectRound(emptySubjectRound(),['A'],0);assert.equal(out.complete,true);assert.equal(out.round.resets,0);assert.deepEqual(out.round.correctKeys,[]);assert.deepEqual(practicedSubjectKeys(out.round),[]);assert.deepEqual(out.round.skippedKeys,['A']);
});
test('a mixed round does not force a visited recall to repeat while other modes retain their rules',()=>{
 let out=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['R','Q'],currentIndex:0,correct:false,completeAfterAttempt:true});
 out=advanceSubjectRound({round:out.round,itemKeys:['R','Q'],currentIndex:1,correct:false});assert.equal(out.complete,false);assert.equal(out.nextIndex,1);
 out=advanceSubjectRound({round:out.round,itemKeys:['R','Q'],currentIndex:1,correct:true});assert.equal(out.complete,true);assert.deepEqual(out.round.correctKeys,['Q']);
});
test('direct legacy calls without an explicit attempt traversal policy retain the correctness queue',()=>{
 const out=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['A'],currentIndex:0,correct:false});assert.equal(out.complete,false);assert.equal(out.round.reviewedKeys,undefined);
});
test('resume preserves reviewed and skipped only inside the same task/source scope',()=>{
 const sessions=createSubjectRoundSessions(),round=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['A','B'],currentIndex:0,correct:false,completeAfterAttempt:true}).round;
 sessions.activate('s','owner-A/day/source1',emptySubjectRound());sessions.set({s:round});const restored=sessions.activate('s','owner-A/day/source1',emptySubjectRound());
 assert.equal(firstPendingRoundIndex(['A','B'],restored,'A'),1);assert.deepEqual(sessions.activate('s','owner-B/day/source1',emptySubjectRound()).correctKeys,[]);assert.equal(sessions.activate('s','owner-A/day/source2',emptySubjectRound()).reviewedKeys,undefined);
});
test('references use supplied fields, support numeric zero, and distinguish missing content',()=>{
 assert.equal(recallReference({explanation:' ',answer:0}),'0');assert.equal(recallReference({}),null);assert.equal(recallReference({},[{text:'条件'}]),'条件');assert.equal(recallReference({},[],'完整参考'),'完整参考');
});
for(const rating of ['again','hard','good','easy'])test(`forget cannot upgrade its saved rating to ${rating}`,()=>assert.equal(recallChosenRating(true,rating,{source:'ai',rating:'good'}),'again'));
test('accepting partial or wrong AI result cannot promote it through a different radio selection',()=>{
 assert.equal(recallChosenRating(false,'good',{source:'ai',rating:'hard'}),'hard');assert.equal(recallChosenRating(false,'easy',{source:'ai',rating:'again'}),'again');assert.equal(recallChosenRating(false,'again',{source:'ai',rating:'good'}),'again');assert.equal(recallResultRating({verdict:'partial'}),'hard');
});
test('cancelled pending AI releases its host grading lock and ignores later resolution',async()=>{
 const store=createLearningDraftStore(),wait=deferred(),controller=new AbortController();
 const pending=store.grade(()=>waitForRecallResult(()=>wait.promise,controller.signal));await Promise.resolve();assert.equal(store.isGrading(),true);controller.abort();await assert.rejects(pending,/cancelled/);assert.equal(store.isPending(),false);wait.resolve({verdict:'correct'});await Promise.resolve();assert.equal(store.isPending(),false);
});
test('save failure is item-scoped; successful receipt clears it and continues only once',()=>{
 const store=createLearningDraftStore(),draft=store.adapter('A','v'),other=store.adapter('B','v');let next=0;
 const t=draft.begin();store.fail(t);assert.equal(draft.hasSaveFailure(),true);assert.equal(other.hasSaveFailure(),false);
 const retry=draft.begin();store.commit(retry,()=>next++);assert.equal(draft.hasSaveFailure(),false);assert.equal(draft.continueAfterFeedback(),true);assert.equal(draft.continueAfterFeedback(),false);assert.equal(next,1);
});
test('extra recall again completes a single pass with stage zero and no formal score',()=>{
 const state=advanceExtraPractice(createExtraPracticeState(1),{index:0,revision:0,threeStage:false,recall:true,rating:'again'});assert.equal(state.complete,true);assert.deepEqual(state.stages,[0]);assert.deepEqual(state.reviewed,[0]);assert.equal(advanceExtraPractice(state,{index:0,revision:0,threeStage:false,recall:true,rating:'good'}),state);
});
test('extra skip keeps stages and reviewed counts untouched',()=>{
 const state=skipExtraPractice(createExtraPracticeState(1),0,0);assert.equal(state.complete,true);assert.deepEqual(state.stages,[0]);assert.equal(state.reviewed,undefined);
});
test('blank forgot path reveals original reference with no AI request or grade until continuing',async()=>{
 let ai=0;const f=recallFixture({gradeRecall:async()=>{ai++;}});await settle(f);assert.equal(f.button('提交并核对').props.disabled,true);
 await f.click('忘记了，查看要点');assert.equal(ai,0);assert.deepEqual(f.records,[]);assert.ok([...nodes(f.view())].some(n=>n.props.text==='参考要点：定义与适用条件。'));assert.equal(f.draft.read('answer',''),'');
 await f.click('看完了，结束本轮');assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,['continue']);f.hooks.unmount();
});
test('forgot with structured support records level 3 without AI and still permits completion',async()=>{
 const f=recallFixture({support:true});await settle(f);await f.click('忘记了，查看要点');assert.equal(f.draft.read('recallAttempt',null).maxPreHintLevel,3);await f.click('看完了，结束本轮');assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,['continue']);f.hooks.unmount();
});
test('double continuation while saving writes once and waits for receipt',async()=>{
 const f=recallFixture({manualSave:true});await settle(f);await f.click('忘记了，查看要点');const click=f.button('看完了，结束本轮').props.onClick;click();click();await settle(f);
 assert.equal(f.attempts.length,1);assert.equal(f.moves.length,0);assert.equal(f.records.length,0);f.waits[0].resolve();await settle(f);assert.equal(f.records.length,1);assert.equal(f.moves.length,1);f.hooks.flush();await settle(f);assert.equal(f.moves.length,1);f.hooks.unmount();
});
test('failed write preserves feedback and retries without asking AI or falsifying a grade',async()=>{
 let ai=0;const f=recallFixture({failSaves:1,gradeRecall:async()=>{ai++;return{source:'ai',rating:'hard',verdict:'partial',feedback:'缺少适用条件'};}});await settle(f);await f.type('我的原始答案');await f.click('提交并核对');assert.equal(f.records.length,0);
 await f.click('结束本轮');assert.equal(f.records.length,0);assert.equal(f.moves.length,0);assert.equal(f.draft.read('answer',''),'我的原始答案');assert.equal(f.draft.read('result',null).feedback,'缺少适用条件');
 await f.click('重试保存');assert.deepEqual(f.records,['hard']);assert.deepEqual(f.moves,['continue']);assert.equal(ai,1);f.hooks.unmount();
});
test('AI failure keeps useful version mismatch information and typed answer for self assessment',async()=>{
 const f=recallFixture({gradeRecall:async()=>{throw Error('本题版本已变化，请退出当前题目并刷新账号题库。');}});await settle(f);await f.type('我的回答');await f.click('提交并核对');assert.match(text(f.view()),/版本已变化.*刷新账号题库/);assert.equal(f.draft.read('answer',''),'我的回答');assert.equal(f.records.length,0);f.hooks.unmount();
});
test('no provided reference offers a no-grade skip rather than fabricating an answer',async()=>{
 const f=recallFixture({data:{explanation:undefined,answer:undefined}});await settle(f);await f.click('忘记了，查看要点');assert.match(text(f.view()),/尚未提供参考要点/);assert.equal(f.button('看完了，结束本轮'),undefined);await f.click('暂时跳过，不计成绩');assert.deepEqual(f.records,[]);assert.deepEqual(f.moves,['skip']);f.hooks.unmount();
});
test('AI late result after cancellation cannot replace self-assessment feedback',async()=>{
 const wait=deferred(),f=recallFixture({gradeRecall:()=>wait.promise});await settle(f);await f.type('我的回答');f.button('提交并核对').props.onClick();await settle(f);await f.click('停止核对，改为自评');assert.match(text(f.view()),/已停止本次核对/);wait.resolve({source:'ai',rating:'good',feedback:'LATE'});await settle(f);assert.notEqual(f.draft.read('result',null)?.feedback,'LATE');assert.equal(f.records.length,0);f.hooks.unmount();
});
test('unmount invalidates pending AI and never records a grade from a late response',async()=>{
 const wait=deferred(),f=recallFixture({gradeRecall:()=>wait.promise});await settle(f);await f.type('原始答案');f.button('提交并核对').props.onClick();await settle(f);f.hooks.unmount();wait.resolve({source:'ai',rating:'good'});await new Promise(r=>setTimeout(r,0));assert.deepEqual(f.records,[]);assert.deepEqual(f.moves,[]);
});
test('revisiting an already practiced question never double-counts it as skipped',()=>{
 const prior=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['A','B'],currentIndex:0,correct:false,completeAfterAttempt:true}).round;
 const out=skipSubjectRound(prior,['A','B'],0);assert.deepEqual(out.round.skippedKeys,[]);assert.deepEqual(practicedSubjectKeys(out.round),['A']);assert.equal(out.nextIndex,1);
});
