import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCourseGradeRequest} from '../src/domain/course-ai/index.ts';

const request = {schemaVersion:1,attemptId:'course-attempt:one',taskId:'task-one',taskHash:'a'.repeat(64),answerRevision:0,evidenceRevision:1};
test('course request binds identities and revisions without accepting any client reference or answer',()=>{
  assert.deepEqual(parseCourseGradeRequest(request),request);
  for(const extra of [{answer:'fabricated answer'},{source:'fabricated source'},{criteria:[]},{trusted:true}])assert.throws(()=>parseCourseGradeRequest({...request,...extra}));
  for(const change of [{schemaVersion:2},{attemptId:'other\nowner'},{taskId:'中文task'},{taskHash:'A'.repeat(64)},{answerRevision:-1},{answerRevision:0.5},{evidenceRevision:0},{evidenceRevision:true}])assert.throws(()=>parseCourseGradeRequest({...request,...change}));
});
