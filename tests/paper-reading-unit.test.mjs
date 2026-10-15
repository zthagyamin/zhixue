import test from 'node:test';
import assert from 'node:assert/strict';
import {paperFromPages} from '../app/paper-import.ts';
import {paperFingerprint} from '../app/paper-draft-store.ts';
import {createPaperReadingUnit} from '../src/domain/paper-reading/unit.ts';

test('reading a contiguous source unit retains original material, paragraph IDs and physical pages',async()=>{
 const paper=paperFromPages('Source',[{pageNumber:2,text:'First source paragraph.\n\nSecond source paragraph.'},{pageNumber:3,text:'Different page.'}]);
 const before=JSON.stringify(paper),fingerprint=await paperFingerprint(paper);
 const unit=createPaperReadingUnit(paper,0,2);
 assert.equal(unit.sectionId,paper.sections[0].id);
 assert.deepEqual(unit.paragraphs.map(p=>p.id),paper.sections[0].paragraphs.map(p=>p.id));
 assert.deepEqual(unit.physicalPages,[2]);assert.equal(unit.text,'First source paragraph.\n\nSecond source paragraph.');
 assert.equal(unit.totalParagraphs,3);assert.equal(unit.position,0);assert.equal(unit.availableParagraphs,2);
 assert.equal(JSON.stringify(paper),before);assert.equal(await paperFingerprint(paper),fingerprint);
});
test('unit selection never silently crosses sections or truncates oversized text for AI',()=>{
 const paper=paperFromPages('Source',[{pageNumber:1,text:'First.'},{pageNumber:2,text:'Second.'}]);
 assert.throws(()=>createPaperReadingUnit(paper,0,2),/reading-unit-range/);
 for(const value of [-1,2,NaN,0.5])assert.throws(()=>createPaperReadingUnit(paper,value,1),/reading-unit-position/);
 const long={paperId:'long',title:'Long',sections:[{id:'s',title:'Section',paragraphs:[{id:'p1',rawEn:'中'.repeat(5000)},{id:'p2',rawEn:'English '.repeat(500)}]}]};
 const unit=createPaperReadingUnit(long,0,2);assert.ok(unit.text.length>8000);assert.equal(unit.withinTaskBudget,false);
 assert.equal(unit.paragraphs[0].rawEn,long.sections[0].paragraphs[0].rawEn);
});
