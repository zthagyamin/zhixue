import test from 'node:test';
import assert from 'node:assert/strict';
import {readSubjectOrganization,visibleLibraryGroups} from '../app/learning-library-model.ts';
const python={id:'python',name:'Python 100天',pluginType:'code'},vision={id:'vision',name:'CS231n',pluginType:'recall'},english={id:'english',name:'学术英语',pluginType:'three-stage'};
const subjects=[python,vision,english];
test('library search trims surrounding whitespace and matches case-insensitively',()=>{
 const groups=visibleLibraryGroups(subjects,{},'  PYTHON　');
 assert.equal(groups.length,1);assert.deepEqual(groups[0].subjects,[python]);assert.equal(groups[0].total,2);
});
test('library whitespace-only search keeps all subjects and identities',()=>{
 const result=visibleLibraryGroups(subjects,{},' \t ');assert.equal(result.flatMap(g=>g.subjects).length,3);
 assert.ok(result.flatMap(g=>g.subjects).includes(python));assert.deepEqual(subjects,[python,vision,english]);
});
test('library filtering distinguishes empty data from no matching query without inventing a card',()=>{
 assert.deepEqual(visibleLibraryGroups([],{},''),[]);assert.deepEqual(visibleLibraryGroups(subjects,{},'no such class'),[]);
});
test('library filtered counts respect manual classification',()=>{
 const groups=visibleLibraryGroups(subjects,{python:'courses'},'python');assert.equal(groups[0].id,'courses');assert.equal(groups[0].total,1);
});
test('corrupt or array preferences are safe display fallbacks, not mutations',()=>{
 for(const value of [null,undefined,7,'not an object',[],['math']])assert.deepEqual(readSubjectOrganization(value),{value:{},recovered:true});
});
test('valid preferences survive malformed neighbours and input remains unchanged',()=>{
 const raw={python:'math',vision:'unknown',english:null};const before=structuredClone(raw);
 assert.deepEqual(readSubjectOrganization(raw),{value:{python:'math'},recovered:true});assert.deepEqual(raw,before);
 assert.deepEqual(readSubjectOrganization({}),{value:{},recovered:false});
});
test('preference decoder handles prototype-shaped subject IDs as own data only',()=>{
 const raw=JSON.parse('{"__proto__":"math","constructor":"computing"}');const result=readSubjectOrganization(raw);
 assert.equal(Object.getPrototypeOf(result.value),Object.prototype);assert.equal(Object.hasOwn(result.value,'__proto__'),true);
 assert.equal(result.value.__proto__,'math');assert.equal({}.polluted,undefined);
});
