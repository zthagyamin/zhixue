import assert from 'node:assert/strict';
import test from 'node:test';
import {auditSources,readDependencies} from '../scripts/architecture.mjs';

test('dependency parser sees runtime, type, re-export and dynamic imports',()=>{
 const edges=readDependencies('sample.ts',`import type {A} from './a'; import {type B,c} from './b'; export type {D} from './d'; export * from './e'; const f=()=>import('./f'); type G=import('./g').G;`);
 assert.deepEqual(edges.map(({specifier,typeOnly})=>[specifier,typeOnly]),[['./a',true],['./b',false],['./d',true],['./e',false],['./f',false],['./g',true]]);
});
test('domain rejects UI type dependencies, ambient I/O and indirect dynamic imports',()=>{
 const result=auditSources({'src/domain/assessment/check.ts':`import type {X} from '../../features/study/view'; const x=window.localStorage; fetch('/api'); export const lazy=(p)=>import(p);`, 'src/features/study/view.ts':'export type X=string;'});
 for(const code of ['layer-direction','domain-effect','nonliteral-import'])assert.ok(result.violations.some(v=>v.code===code),code);
});
test('one-way public module interfaces pass, internal cross-module access fails',()=>{
 const sources={'src/domain/content/index.ts':"export {x} from './value.ts';",'src/domain/content/value.ts':'export const x=1;','src/domain/assessment/check.ts':"import {x} from '../content/index.ts'; export const y=x;"};
 assert.deepEqual(auditSources(sources).violations,[]);
 sources['src/domain/assessment/check.ts']="import {x} from '../content/value.ts'; export const y=x;";
 assert.ok(auditSources(sources).violations.some(v=>v.code==='private-module-import'));
});
test('runtime cycles fail while type-only references do not create execution cycles',()=>{
 const sources={'src/domain/content/a.ts':"import {b} from './b.ts'; export const a=b;",'src/domain/content/b.ts':"import {a} from './a.ts'; export const b=a;"};
 assert.equal(auditSources(sources).cycles.length,1);assert.ok(auditSources(sources).violations.some(v=>v.code==='new-runtime-cycle'));
 sources['src/domain/content/b.ts']="import type {a} from './a.ts'; export const b=1;";
 assert.equal(auditSources(sources).cycles.length,0);
});
test('legacy budgets prevent growth including compressed single-line code',()=>{
 const sources={'app/controller.ts':'export const data="more-than-before";','app/new-flat-helper.ts':'export const x=1;'};
 const result=auditSources(sources,{legacyRootFiles:['app/controller.ts'],hotspots:{'app/controller.ts':{lines:2,bytes:10,imports:0}},allowedCycleEdges:[]});
 assert.ok(result.violations.some(v=>v.code==='legacy-growth'));assert.ok(result.violations.some(v=>v.code==='new-flat-legacy-file'));
});
test('new domains cannot hide reverse dependencies behind compatibility facades or aliases',()=>{
 const sources={'src/domain/content/x.ts':"export * from '@/app/legacy';",'app/legacy.ts':'export const x=1;'};
 assert.ok(auditSources(sources).violations.some(v=>v.code==='layer-direction'));
});
test('known legacy cycle edges do not permit an added cycle edge',()=>{
 const sources={'app/a.ts':"import './b'; import './c';",'app/b.ts':"import './a';",'app/c.ts':"import './a';"};
 const result=auditSources(sources,{allowedCycleEdges:['app/a.ts -> app/b.ts','app/b.ts -> app/a.ts']});
 assert.ok(result.violations.some(v=>v.code==='new-runtime-cycle'&&v.message.includes('app/c.ts')));
});
test('application rejects React packages and views reject database implementations',()=>{
 const result=auditSources({'src/application/learning/session.ts':"import type {ReactNode} from 'react';",'src/features/study/view.ts':"import {sql} from 'drizzle-orm';"});
 assert.ok(result.violations.some(v=>v.code==='application-external'));
 assert.ok(result.violations.some(v=>v.code==='feature-infrastructure'));
});
test('TypeScript import-equals and ambient UUID/clock cannot bypass the domain boundary',()=>{
 const result=auditSources({'src/domain/content/index.ts':"import type legacy = require('../../../app/legacy'); export type Value=legacy.Value; export const id=()=>crypto.randomUUID(); export const now=()=>performance.now();",'app/legacy.ts':'export type Value=string;'});
 assert.ok(result.violations.some(v=>v.code==='layer-direction'));
 assert.equal(result.violations.filter(v=>v.code==='domain-effect').length,2);
});
test('deterministic content digests remain allowed while extracting random APIs is rejected',()=>{
 assert.deepEqual(auditSources({'src/domain/content/hash.ts':"export const hash=bytes=>crypto.subtle.digest('SHA-256',bytes);"}).violations,[]);
 assert.ok(auditSources({'src/domain/content/hash.ts':"const {randomUUID}=crypto; export const id=randomUUID;"}).violations.some(v=>v.code==='domain-effect'));
});
