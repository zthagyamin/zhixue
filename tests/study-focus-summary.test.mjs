import test from 'node:test';
import assert from 'node:assert/strict';
import {studyFocusSummary} from '../app/study-view-model.ts';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

test('the focus hero counts unfinished practice groups and keeps unknown evidence explicit',()=>{
 const tasks=[{taskId:'done',action:{kind:'practice'},estimatedMinutes:3},{taskId:'todo',action:{kind:'practice'},estimatedMinutes:8},{taskId:'blocked',action:{kind:'practice'},estimatedMinutes:2,blockedReason:'source changed'},{taskId:'read',action:{kind:'open-note'},estimatedMinutes:10}];
 assert.deepEqual(studyFocusSummary({ready:true,tasks,completedTaskIds:['done']}),{groups:2,minutes:10,blocked:1});
 assert.deepEqual(studyFocusSummary({ready:false,tasks,completedTaskIds:['done']}),{groups:null,minutes:null,blocked:0});
 assert.equal(studyFocusSummary({ready:true,tasks:[...tasks,{taskId:'unknown-time',action:{kind:'practice'}}],completedTaskIds:[]}).minutes,null);
});
test('the focus hero never registers a global keyboard handler and keeps native button semantics',()=>{
 const file=new URL('../app/dashboard-focus-hero.tsx',import.meta.url),source=readFileSync(file,'utf8');
 const parsed=ts.createSourceFile('hero.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const effects=[];function visit(node){if(ts.isCallExpression(node)&&/addEventListener|useEffect/.test(node.expression.getText(parsed)))effects.push(node);ts.forEachChild(node,visit);}visit(parsed);
 assert.equal(effects.length,0);assert.match(source,/type="button" className="study-primary-action" disabled=\{disabled\|\|!lead\} onClick=\{onStart\}/);
 assert.doesNotMatch(source,/<kbd>Space|preventDefault/);
});
