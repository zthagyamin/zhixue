import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkContentQuality} from '../app/content-quality.ts';
import {recallReference} from '../app/recall-flow-model.ts';
import {validateRecallEvaluation} from '../app/recall-evaluation.ts';
const read=name=>JSON.parse(readFileSync(new URL('fixtures/'+name,import.meta.url),'utf8')).cases;
const content=read('edu-content-quality-v1.json'),evaluation=read('edu-recall-evaluation-v1.json');
for(const c of content)test(`${c.id}: ${c.mode} technical capabilities without mutation`,()=>{
 const before=JSON.stringify(c.data),result=checkContentQuality(c.mode,c.data);
 assert.deepEqual(result.capabilities,c.capabilities);assert.deepEqual(result.issues.map(issue=>issue.code),c.codes);
 assert.equal(JSON.stringify(c.data),before);assert.equal(result.checkerVersion,'content-quality-v1');
});
for(const c of evaluation)test(`${c.id}: evaluation evidence must be consistent`,()=>{
 const before=JSON.stringify(c.result);
 if(c.error)assert.throws(()=>validateRecallEvaluation(c.result,c.criteria),error=>error.message===c.error);
 else assert.deepEqual(validateRecallEvaluation(c.result,c.criteria),c.expected);
 assert.equal(JSON.stringify(c.result),before);
});
function python(script,input){
 const processResult=spawnSync(process.env.PYTHON||'python',['-I','-X','utf8','-c',script,fileURLToPath(new URL('../companion/',import.meta.url))],{input:JSON.stringify(input),encoding:'utf8',timeout:30000,env:{...process.env,PYTHONUTF8:'1'}});
 assert.ifError(processResult.error);assert.equal(processResult.status,0,processResult.stderr);return JSON.parse(processResult.stdout);
}
test('shared TS/Python evaluation fixtures have identical outputs and rejection codes',()=>{
 const actual=python(`import sys,json
sys.path.insert(0,sys.argv[1])
from recall_quality import validate_recall_evaluation
out=[]
for case in json.load(sys.stdin):
    try: out.append({"expected":validate_recall_evaluation(case["result"],case["criteria"])})
    except ValueError as error: out.append({"error":str(error)})
print(json.dumps(out,ensure_ascii=False))`,evaluation);
 assert.deepEqual(actual,evaluation.map(c=>c.error?{error:c.error}:{expected:c.expected}));
});
test('local Companion and account/browser reference selection use the same current content',()=>{
 const fixtures=content.filter(c=>c.mode==='recall'&&c.id!=='CQ-11');
 const actual=python(`import sys,json
sys.path.insert(0,sys.argv[1])
from recall_quality import recall_reference
out=[]
for c in json.load(sys.stdin):
    data=c["data"]; support=data.get("learningSupport",{}); hints=support.get("hints",[])
    out.append(recall_reference(data,support.get("criteria"),hints[2] if len(hints)==3 else None))
print(json.dumps(out,ensure_ascii=False))`,fixtures);
 assert.deepEqual(actual,fixtures.map(({data})=>recallReference(data,data.learningSupport?.criteria,data.learningSupport?.hints?.[2])));
});
test('content checks never reuse a result after reference revision',()=>{
 const item={itemId:'same',contentHash:'old',prompt:'解释条件。',answer:'解释条件。'};
 assert.equal(checkContentQuality('recall',item).capabilities.canAutoAssess,false);
 const next={...item,contentHash:'new',answer:'需要先满足独立性。'};
 assert.equal(checkContentQuality('recall',next).capabilities.canAutoAssess,true);
 assert.equal(checkContentQuality('recall',item).capabilities.canAutoAssess,false);
});
