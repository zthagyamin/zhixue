import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCodeRunReport,normalizeCodeRunReport,parseCodeRunIdentity} from '../src/domain/code-execution/index.ts';
const valid=()=>({schemaVersion:1,runId:7,status:'failed',phase:'tests',outcome:'student-error',assertionsPassed:0,assertionsExecuted:1,mapping:{prefixLineCount:3,originalLineCount:4},exception:{kind:'AssertionError',message:'bad',isAssertion:true,location:{origin:'tests',file:'<题目测试>',line:2}},firstFailure:{caseId:'sum',functionName:'add',args:[1,2],kwargs:{},expected:3,actual:4}});
test('report normalizes a bounded closed structured failure and supplied identity',()=>{const r=valid();r.identity={attemptId:'attempt',revision:2,sourceVersion:'source',testVersion:'tests'};assert.deepEqual(parseCodeRunReport(r),r);assert.equal(normalizeCodeRunReport({...r,secret:1}),undefined);});
test('report rejects malformed versions, identity, contradictions and mappings',()=>{for(const patch of [{schemaVersion:2},{phase:'other'},{runId:0},{identity:{attemptId:'a'}},{status:'passed'},{assertionsPassed:3},{mapping:{prefixLineCount:4,originalLineCount:4}},{exception:{...valid().exception,kind:'CustomAssertionError'}},{firstFailure:{...valid().firstFailure,actual:'x'.repeat(5000)}}])assert.throws(()=>parseCodeRunReport({...valid(),...patch}));});
test('report never invents formal identity',()=>assert.equal(parseCodeRunReport(valid()).identity,undefined));

test('contradictory successful counts and captured matching values are rejected',()=>{
 assert.throws(()=>parseCodeRunReport({...valid(),firstFailure:{...valid().firstFailure,actual:3}}));
 const success={...valid(),status:'passed',outcome:'success',assertionsPassed:0};delete success.exception;delete success.firstFailure;
 assert.throws(()=>parseCodeRunReport(success));
});

test('execution identity retains real zero answer revision and rejects unsafe revisions',()=>{
 const identity={attemptId:'empty-attempt',revision:0,sourceVersion:'source',testVersion:'tests'};
 assert.deepEqual(parseCodeRunIdentity(identity),identity);
 assert.equal(parseCodeRunReport({...valid(),identity}).identity.revision,0);
 for(const revision of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseCodeRunIdentity({...identity,revision}));
});
