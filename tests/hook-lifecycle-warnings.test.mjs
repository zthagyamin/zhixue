import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createHooks,loader} from './helpers/causal-harness.mjs';

test('subject round cache survives ordinary renders and resets on owner or day changes',()=>{
 const hooks=createHooks(),useRounds=loader(hooks.api)('app/use-subject-round-sessions.ts').useSubjectRoundSessions;
 let view=hooks.mount(({owner,day})=>useRounds(owner,day),{owner:'synthetic-a',day:'2026-10-12'});
 const round={correctKeys:['q1'],wrongKeys:['q2'],resets:0};
 view.activateSubjectRound('course','library:course',round);
 const originalGet=view.getSubjectRound;
 view=hooks.render();assert.equal(view.getSubjectRound,originalGet);assert.deepEqual(view.getSubjectRound('library:course'),round);
 view=hooks.render({owner:'synthetic-b',day:'2026-10-12'});assert.equal(view.getSubjectRound('library:course'),undefined);
 view.activateSubjectRound('course','library:course',{correctKeys:['other'],wrongKeys:[],resets:0});
 view=hooks.render({owner:'synthetic-b',day:'2026-10-13'});assert.equal(view.getSubjectRound('library:course'),undefined);
 view=hooks.render({owner:'synthetic-a',day:'2026-10-12'});assert.equal(view.getSubjectRound('library:course'),undefined);
 hooks.unmount();
});

// Execute the current lifecycle closure, avoiding a duplicate implementation.
function effectSetup(file,identifiers,bindings){
 const path=new URL('../'+file,import.meta.url),source=readFileSync(path,'utf8');
 const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),matches=[];
 const visit=node=>{
  if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useLayoutEffect'
      &&node.arguments[0]&&identifiers.every(name=>node.arguments[0].getText(tree).includes(name)))matches.push(node.arguments[0]);
  ts.forEachChild(node,visit);
 };
 visit(tree);assert.equal(matches.length,1,'one owning lifecycle effect');
 const code=ts.transpileModule('const setup='+matches[0].getText(tree)+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function(...Object.keys(bindings),code+'return setup;')(...Object.values(bindings));
}

test('restart scope cleanup invalidates the latest epoch through replay and later increments',()=>{
 const restartEpoch={current:10};
 const setup=effectSetup('app/study-dashboard/use-dashboard-controller.ts',['restartEpoch'],{restartEpoch});
 let cleanup=setup();assert.equal(restartEpoch.current,11);
 restartEpoch.current+=4;cleanup();assert.equal(restartEpoch.current,16);
 cleanup=setup();assert.equal(restartEpoch.current,17);cleanup();assert.equal(restartEpoch.current,18);
});

test('practice cleanup invalidates current variant and session work instead of restoring a snapshot',()=>{
 const sessionEpoch={current:1},variantRequest={current:{epoch:3,busy:true}},ended={current:true};
 const setup=effectSetup('app/practice-session.tsx',['sessionEpoch','variantRequest'],{sessionEpoch,variantRequest,ended});
 let cleanup=setup();assert.equal(sessionEpoch.current,2);assert.equal(variantRequest.current.epoch,4);assert.equal(ended.current,false);
 sessionEpoch.current+=5;variantRequest.current.epoch+=2;variantRequest.current.busy=true;
 cleanup();assert.equal(sessionEpoch.current,8);assert.equal(variantRequest.current.epoch,7);assert.equal(variantRequest.current.busy,false);assert.equal(ended.current,true);
 cleanup=setup();cleanup();assert.equal(sessionEpoch.current,10);assert.equal(variantRequest.current.epoch,9);
});

test('deferred practice continuation sees the latest committed callback',()=>{
 const advanceRef={current:null},calls=[];
 const first=value=>calls.push(['old',value]),latest=value=>calls.push(['latest',value]);
 effectSetup('app/practice-session.tsx',['advanceRef'],{advanceRef,advance:first})();
 const deferred=summary=>advanceRef.current(summary);
 effectSetup('app/practice-session.tsx',['advanceRef'],{advanceRef,advance:latest})();
 deferred({answered:2,correct:1,wrong:1});assert.deepEqual(calls,[['latest',{answered:2,correct:1,wrong:1}]]);
});
