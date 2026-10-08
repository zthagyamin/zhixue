import assert from 'node:assert/strict';
import test from 'node:test';
import {sourceWorksheet,quizMistakes,recalculationResult,codeRunFailure,codeRunSuccess} from '../src/domain/remediation/index.ts';

test('source worksheet does not invent a verified counterexample or formal success',()=>{
 const worksheet=sourceWorksheet({kind:'condition',target:'需要独立样本',reference:'材料中声明需要独立样本。',binding:'item:v1'});
 assert.equal(worksheet.mode,'source-review');assert.equal(worksheet.reference,'材料中声明需要独立样本。');assert.equal(worksheet.automaticallyScored,false);
 assert.equal(sourceWorksheet({kind:'condition',target:'x',reference:'',binding:'item:v1'}),null);
});
test('quiz feedback distinguishes wrong selection from omitted answers without changing the answer set',()=>{
 const support={correctOptionIds:['a','b'],options:[{optionId:'a',text:'A'},{optionId:'b',text:'B'},{optionId:'c',text:'C'}]};
 assert.deepEqual(quizMistakes(support,['a','c']),{wrong:['c'],missing:['b']});assert.deepEqual(support.correctOptionIds,['a','b']);
});
test('temporary recalculation preserves numeric zero and unknown unsupported syntax',()=>{
 assert.equal(recalculationResult('0','0').kind,'checked');assert.equal(recalculationResult('1','0').kind,'different');
 assert.equal(recalculationResult('sqrt(x)','sqrt(x)',{mode:'symbolic',variables:['x']}).kind,'unknown');
});
test('runtime/test infrastructure failure never becomes a student error by guessing from text',()=>{
 assert.equal(codeRunFailure({name:'RuntimeError',message:'invalid tests',testDefinitionError:true}).kind,'test-error');
 assert.equal(codeRunFailure({name:'RuntimeError',message:'load failed'}).kind,'environment-error');
 assert.equal(codeRunFailure({name:'PythonError',message:'NameError',executionPhase:'tests'}).kind,'unknown');
 assert.equal(codeRunFailure({name:'PythonError',message:'ValueError',executionPhase:'program'}).kind,'student-error');
 assert.equal(codeRunFailure({name:'PythonError',message:'unknown phase'}).kind,'unknown');
 assert.equal(codeRunSuccess({output:'done',assertionsPassed:0},'tests').kind,'test-error');
 assert.equal(codeRunSuccess({output:'done',assertionsPassed:2},'tests').kind,'checked');
 assert.equal(codeRunSuccess({output:'done'},'trial').kind,'trial');
});
