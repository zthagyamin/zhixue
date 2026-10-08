import test from 'node:test';
import assert from 'node:assert/strict';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {observeStudyAIReplies,studyAIRepliesForContext} from '../app/ai/study-ai-assistance.ts';
const reply={id:'reply-one',role:'assistant',content:'A hint',provider:'deepseek'};
test('unrelated or unknown old conversations are not recorded as help for the current question',()=>{
 const {draft}=attempt();observeStudyAIReplies(draft.assistance,studyAIRepliesForContext([reply,{...reply,id:'other',contextId:'old-question'}],'current-question'),true);assert.deepEqual(draft.assistance.snapshot().preSubmitAssistance,[]);
 const current=attempt();observeStudyAIReplies(current.draft.assistance,studyAIRepliesForContext([reply],'current-question','current-question'),true);assert.deepEqual(current.draft.assistance.snapshot().preSubmitAssistance,[{action:'ai-tutor',count:1}]);
});
test('switching legacy conversation identity before its messages load cannot attribute the previous reply',()=>{const {draft}=attempt();observeStudyAIReplies(draft.assistance,studyAIRepliesForContext([reply],'new-question','new-question',false),true);assert.deepEqual(draft.assistance.snapshot().preSubmitAssistance,[]);});
function attempt(){const store=createLearningDraftStore('owner:library'),draft=store.adapter('item','recall:1');draft.assistance.cover();return {store,draft};}
test('hidden, empty and user-only messages do not become observed assistance',()=>{
 const {draft}=attempt();observeStudyAIReplies(draft.assistance,[reply],false);observeStudyAIReplies(draft.assistance,[{...reply,role:'user'},{...reply,content:''}],true);
 assert.deepEqual(draft.assistance.snapshot().preSubmitAssistance,[]);
});
test('stream chunks and reopening history count one displayed response while preserving attempts',()=>{
 const {store,draft}=attempt();draft.write('answer','my attempt');observeStudyAIReplies(draft.assistance,[reply],true);observeStudyAIReplies(draft.assistance,[{...reply,content:'A hint with another chunk'}],true);
 assert.equal(draft.read('answer',''),'my attempt');assert.equal(store.isPending(),false);
 assert.deepEqual(draft.assistance.snapshot().preSubmitAssistance,[{action:'ai-tutor',count:1}]);
});
test('a stale sidebar observer cannot add aid to another owner or new attempt',()=>{
 const {store,draft}=attempt();store.clear();const next=store.adapter('item','recall:1');next.assistance.cover();observeStudyAIReplies(draft.assistance,[reply],true);
 assert.deepEqual(next.assistance.snapshot().preSubmitAssistance,[]);
});
