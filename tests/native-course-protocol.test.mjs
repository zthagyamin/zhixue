import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {parseNativeCourseCapture, parseNativeGradeRequest, validateNativeGradeReceipt, parseNativeClaimRequest,
  validateNativeClaimReceipt, nativeCourseIso} from '../src/domain/course-study/index.ts';

const python=process.env.PYTHON||'python';
const vectors=JSON.parse(readFileSync(new URL('./fixtures/native-course-protocol-v1.json',import.meta.url)));
const script=`import sys,json,copy
sys.path[:0]=['tests','companion']
from test_native_course_service import Harness
rows=[]
for mode,action in [('recall','evaluate'),('quiz','evaluate'),('recall','self-assess')]:
 h=Harness(mode)
 try:
  request=h.request(action=action,**({'selfStatus':'incorrect'} if action=='self-assess' else {}))
  receipt=h.app.grade(request)
  claim=h.claim(request,receipt,rating='again' if action=='self-assess' else 'good')
  rows.append(dict(request=request,receipt=receipt,capture=h.capture,claim=claim,claimReceipt=h.app.claim(claim)))
 finally:h.close()
print(json.dumps(rows,ensure_ascii=False))
`;
function run(script,input){
  const result=spawnSync(python,['-X','utf8','-c',script],{input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('native application fixture with real storage produces compatible capture, diagnosis and claim receipts',async()=>{
  for(const row of run(script)){
    const capture=await parseNativeCourseCapture(row.capture),request=parseNativeGradeRequest(row.request);
    assert.deepEqual(request,row.request);
    assert.deepEqual(await validateNativeGradeReceipt(row.receipt,request,capture),row.receipt);
    const claim=parseNativeClaimRequest(row.claim);
    assert.deepEqual(claim,row.claim);
    assert.deepEqual(await validateNativeClaimReceipt(row.claimReceipt,claim),row.claimReceipt);
    assert.equal(capture.item.contentHash,request.identity.contentHash);
    assert.equal('subjectId' in capture.item,false,'native capture is not a complete portable publication');
    for(const patch of [{durable:false},{answerRevision:99},{requestId:'other'},{purpose:'guided'},
      {diagnostic:{...row.receipt.diagnostic,status:'correct',feedback:'different'}}])
      await assert.rejects(validateNativeGradeReceipt({...row.receipt,...patch},request,capture));
    await assert.rejects(parseNativeCourseCapture({...row.capture,item:{...row.capture.item,title:'invented'}}));
    await assert.rejects(validateNativeClaimReceipt({...row.claimReceipt,eventId:'other'},claim));
  }
});
test('shared closed request parser rejects client references, coerced enums and nonintegral revisions',()=>{
  const base=run(script)[0].request,cases=[];
  const add=(name,patch,nested=false)=>{const value=structuredClone(base);Object.assign(nested?value.submission:value,patch);cases.push({name,value});};
  assert.equal(vectors.schemaVersion,1);
  for(const row of vectors.invalidRequestPatches)add(row.name,row.patch,row.target==='submission');
  add('cycle',{parentAttemptId:base.attemptId,parentDiagnosticHash:'a'.repeat(64),purpose:'remediation'});
  const expected=cases.map(row=>{try{parseNativeGradeRequest(row.value);return true;}catch{return false;}});
  assert.ok(expected.every(value=>value===false));
  const actual=run(`import sys,json
sys.path.insert(0,'companion')
from native_course_schema import parse_grade_request
out=[]
for row in json.load(sys.stdin):
 try:parse_grade_request(row['value']);out.append(True)
 except (ValueError,TypeError,KeyError):out.append(False)
print(json.dumps(out))`,cases);
  assert.deepEqual(actual,expected);
});
test('native submission dates retain valid old timezone/fraction strings without calendar normalization',()=>{
  for(const value of vectors.validTimes)assert.equal(nativeCourseIso(value),value);
  for(const value of vectors.invalidTimes)assert.throws(()=>nativeCourseIso(value));
});
