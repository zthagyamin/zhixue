import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {dashboardJsxProp} from './fixtures/dashboard-functions.mjs';
const source=ts.createSourceFile('progress.tsx',readFileSync(new URL('../app/study-progress-overview.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function clicks(label,bindings){
 const result=[];function visit(node){
  if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='button'&&node.getText(source).includes(label)){
   const attribute=node.openingElement.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(source)==='onClick');
   result.push(new Function(...Object.keys(bindings),`return (${attribute.initializer.expression.getText(source)})`)(...Object.values(bindings)));
  }ts.forEachChild(node,visit);
 }visit(source);return result;
}
for(const [label,prop,expected,count] of [['同步状态','onSync','sync',2],['连接资料来源','onSources','sources',1]])test(`actual progress buttons route ${label} to ${expected}`,()=>{
 const opened=[],action=dashboardJsxProp('StudyProgressOverview',prop,{openSources:view=>opened.push(view)});
 const handlers=clicks(label,{[prop]:action,onSettings:()=>{throw new Error('Wrong generic settings target');}});
 assert.equal(handlers.length,count);handlers.forEach(click=>click());assert.deepEqual(opened,Array(count).fill(expected));
});
