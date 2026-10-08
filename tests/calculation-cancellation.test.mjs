import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';
import {readDashboardSourceSync} from './helpers/dashboard-source.mjs';
import {createHooks,loader} from './helpers/causal-harness.mjs';
test('both real dashboard grading callbacks forward the same cancellation signal',async()=>{
 const source=ts.createSourceFile('dashboard.tsx',readDashboardSourceSync(),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),callbacks=[];
 function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='gradeCalculation'&&node.initializer.getText(source).includes('gradeAccountCalculation'))callbacks.push(node.initializer.getText(source));ts.forEachChild(node,visit);}visit(source);assert.equal(callbacks.length,1,'the remaining inline callback is still exercised from its actual source');
 for(const callback of callbacks){let seen;const code=ts.transpileModule(`return (${callback});`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;const fn=new Function('accountLoaded','companionPlanClient','learningDrafts','gradeAccountCalculation',code)(true,null,{grade:f=>f()},async(_item,_answer,signal)=>{seen=signal;return{correct:null};});const controller=new AbortController();await fn({},'x',controller.signal);assert.equal(seen,controller.signal);controller.abort();assert.equal(seen.aborted,true);}
 const {subjectLearningServices}=loader(createHooks().api)('app/study-dashboard/nonword-services.ts');let seen;
 const services=subjectLearningServices({account:true,item:{},run:()=>assert.fail('calculation must not call recall AI'),evaluate:work=>work(),calculation:async(_item,_answer,signal)=>{seen=signal;return{correct:null};}});
 const controller=new AbortController();await services.gradeCalculation({},'x',controller.signal);assert.equal(seen,controller.signal);controller.abort();assert.equal(seen.aborted,true);
});
