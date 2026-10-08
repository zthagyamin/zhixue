import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {approveCandidates,candidateDocument} from '../src/domain/practice-candidates/index.ts';
function python(script,input){
 const result=spawnSync(process.env.PYTHON||'python',['-I','-B','-X','utf8','-c',script,fileURLToPath(new URL('../companion/',import.meta.url))],{encoding:'utf8',input:JSON.stringify(input)});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
test('approved export reaches the real importer without changing mathematical symbols, pipes or newlines',()=>{
 const reference='A | B\nUse x > 0 & y < 1\n😀 keeps UTF-16 offsets';
 const source={kind:'card',key:'parent-card',version:'v1',versionKind:'item-content',title:'Card',fragments:[{id:'back',label:'背面',text:reference}]};
 const row={id:'one',question:'Does x < 5 hold?',reference,keyPoints:'',category:'recall',fragmentId:'back',quote:reference};
 const artifact=approveCandidates(source,[row],{reviewed:true,workload:true,currentVersion:'v1'}),text=candidateDocument(artifact);
 const output=python(`import sys,json
sys.path.insert(0,sys.argv[1])
from note_imports import _document,learning_items
raw=json.load(sys.stdin).encode('utf-8')
doc=_document('test.zhixue-candidates.json',raw,'auto')
first=learning_items([doc],'synthetic-source')
second=learning_items([doc],'synthetic-source')
assert first==second
print(json.dumps(first,ensure_ascii=False))`,text);
 assert.equal(output.length,1);assert.equal(output[0].prompt,row.question);assert.equal(output[0].answer,reference);
 assert.match(output[0].material,/parent-card/);assert.match(output[0].material,/sourceVersion/);assert.notEqual(output[0].identity,source.key);assert.equal('rating' in output[0],false);
});
