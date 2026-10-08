import test from 'node:test';
import assert from 'node:assert/strict';
import {compareExpressions} from '../app/symbolic-math.ts';
import {gradeCalculationReference} from '../app/calculation-grade.ts';
import {parseLearningSupport} from '../app/learning-support.ts';
import {sealStudyItem,parseStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';
import {spawnSync} from 'node:child_process';
const cases=[['(x+1)^2','x^2+2*x+1','correct'],['sin(2*x)','2*sin(x)*cos(x)','correct'],['1/sqrt(2)','sqrt(2)/2','correct'],['x+1','x+2','wrong'],['x/x','1','unknown'],['sqrt(x)^2','x','unknown'],['sin(x)^2+cos(x)^2','1','unknown'],['__import__("os")','1','unknown'],['x'.repeat(600),'x','unknown'],['(x+1)^999999','1','unknown'],['1/0','0','unknown'],['-x^2','-(x*x)','correct']];
for(const [a,b,result] of cases)test(`bounded symbolic comparison ${a.slice(0,40)} vs ${b}`,()=>assert.equal(compareExpressions(a,b,['x']).verdict,result));
test('calculation metadata survives immutable content sealing and has no floating point fields',async()=>{
 const learningSupport={schemaVersion:1,type:'calculation',mode:'symbolic',domain:'real',variables:['x'],exploration:{expression:'x^2',parameters:[{id:'x',label:'x',min:'-2',max:'2',step:'0.1',defaultValue:'1'}]}};
 const body=quizBody({schemaVersion:2,learningSupport});body.practice={...body.practice,questionType:'calculation',answer:'x*x'};delete body.practice.options;
 const sealed=await sealStudyItem(body);assert.deepEqual((await parseStudyItem(sealed)).learningSupport,learningSupport);
 assert.throws(()=>parseLearningSupport({...learningSupport,tolerance:0.1},'calculation'));
 assert.throws(()=>parseLearningSupport(learningSupport,'recall'));
 assert.equal(gradeCalculationReference({answer:'x*x',learningSupport},'x^2').correct,true);
 assert.equal(gradeCalculationReference({answer:'x*x',learningSupport},'x/x').correct,null);
});
test('numeric invalid and missing references never become a failed attempt',()=>{for(const answer of ['NaN','Infinity','0x10',''])assert.equal(gradeCalculationReference({answer:'16'},answer).correct,null);assert.equal(gradeCalculationReference({},'1').correct,null);});
test('precision boundaries and zero powers cannot produce false positive grades',()=>{
 const learningSupport={schemaVersion:1,type:'calculation',mode:'numeric',domain:'real',variables:[],tolerance:'0'};
 assert.equal(gradeCalculationReference({answer:'9007199254740992',learningSupport},'9007199254740993').correct,false);
 assert.equal(gradeCalculationReference({answer:'1e-999',learningSupport},'0').correct,null);
 for(const expression of ['0^0','x^0','(x-x)^0','x^-+2'])assert.equal(compareExpressions(expression,'1',['x']).correct,null);
 assert.equal(compareExpressions('2^0','1',[]).correct,true);
});
test('TypeScript and Python agree on expressions and versioned calculation content hashes',async()=>{
 const learningSupport={schemaVersion:1,type:'calculation',mode:'symbolic',variables:['x'],domain:'real',exploration:{expression:'x^2',parameters:[{id:'x',label:'参数 x',min:'-2',max:'2',step:'0.1',defaultValue:'1'}]}};
 const body=quizBody({schemaVersion:2,learningSupport});body.practice={...body.practice,questionType:'calculation',answer:'(x+1)^2'};delete body.practice.options;
 const extra=Array.from({length:10},(_,i)=>[`(x+${i})^2`,`x^2+${2*i}*x+${i*i}`,'correct']);
 const pairs=[...cases,...extra];const script="import sys,json;sys.path.insert(0,'companion');from symbolic_math import compare_expressions;from account_sync_schema import seal_item;data=json.load(sys.stdin);print(json.dumps({'verdicts':[compare_expressions(a,b,['x'])['verdict'] for a,b,_ in data['cases']],'item':seal_item(data['body'])}))";
 const python=process.env.PYTHON||process.env.GATEWAY_TEST_PYTHON||(process.platform==='win32'&&spawnSync('where.exe',['py.exe']).status===0?'py':'python');
 const result=spawnSync(python,['-c',script],{cwd:new URL('../',import.meta.url),encoding:'utf8',input:JSON.stringify({cases:pairs,body}),env:{...process.env,PYTHONUTF8:'1'},timeout:10000});assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);assert.deepEqual(output.verdicts,pairs.map(([a,b])=>compareExpressions(a,b,['x']).verdict));assert.deepEqual(output.item,await sealStudyItem(body));
});
