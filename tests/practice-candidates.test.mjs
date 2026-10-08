import assert from 'node:assert/strict';
import test from 'node:test';
import {splitCardSections,paperRetestSeeds,approveCandidates,candidateDocument,sourceFingerprint} from '../src/domain/practice-candidates/index.ts';
const source={kind:'card',key:'parent',version:'hash-v1',versionKind:'item-content',title:'Parent',fragments:[{id:'back',label:'父卡背面',text:'First paragraph.\n\nSecond paragraph.'}]};
test('splitting is a bounded candidate proposal, preserving exact parent content and order',()=>{
 const rows=splitCardSections('Explain both',source.fragments[0].text);assert.equal(rows.length,2);assert.equal(rows[0].reference,'First paragraph.');
 assert.equal(rows[1].reference,'Second paragraph.');assert.equal(rows[0].approved,undefined);
});
test('paper candidates start from unresolved self-reports with no invented reference',()=>{
 const rows=paperRetestSeeds(['机制解释','边界']);assert.equal(rows.length,2);assert.equal(rows[0].reference,'');assert.equal(rows[0].category,'');
});
test('approval requires source binding, explicit review and workload confirmation',()=>{
 const rows=splitCardSections('Explain both',source.fragments[0].text);
 assert.throws(()=>approveCandidates(source,rows,{reviewed:false,workload:true,currentVersion:'hash-v1'}),/review/);
 assert.throws(()=>approveCandidates(source,rows,{reviewed:true,workload:false,currentVersion:'hash-v1'}),/workload/);
 assert.throws(()=>approveCandidates(source,rows,{reviewed:true,workload:true,currentVersion:'changed'}),/stale/);
 const artifact=approveCandidates(source,rows,{reviewed:true,workload:true,currentVersion:'hash-v1'});
 assert.equal(artifact.parent.key,'parent');assert.equal(artifact.items.length,2);assert.equal(artifact.status,'reviewed-candidates');
 assert.equal('rating' in artifact,false);assert.equal('schedule' in artifact,false);
});
test('paper evidence must match a selected original fragment and distinguish claim from inference',()=>{
 const paper={...source,kind:'paper',versionKind:'paper-origin',fragments:[{id:'p1',label:'Section · p.3',text:'The experiment observed an increase.'}]};
 const row={id:'c1',question:'What was observed?',reference:'An increase was observed.',keyPoints:'Observed, not proven causal.',category:'observation',fragmentId:'p1',quote:'observed an increase.'};
 assert.throws(()=>approveCandidates(paper,[{...row,quote:'invented'}],{reviewed:true,workload:true,currentVersion:'hash-v1'}),/quote/);
 assert.throws(()=>approveCandidates(paper,[{...row,category:''}],{reviewed:true,workload:true,currentVersion:'hash-v1'}),/category/);
 const approved=approveCandidates(paper,[row],{reviewed:true,workload:true,currentVersion:'hash-v1'});
 assert.equal(approved.items[0].citation.start,15);assert.equal(approved.items[0].category,'observation');
 assert.match(candidateDocument(approved),/sourceVersion/);assert.deepEqual(JSON.parse(candidateDocument(approved)),approved);
});
test('source fingerprints change with actual material and are reproducible',async()=>{
 assert.equal(await sourceFingerprint(source),await sourceFingerprint(source));
 assert.notEqual(await sourceFingerprint(source),await sourceFingerprint({...source,title:'Revised'}));
});
