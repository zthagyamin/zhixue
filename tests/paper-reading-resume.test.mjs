import test from 'node:test';import assert from 'node:assert/strict';
import {matchPaperReadingResume} from '../src/application/paper-reading-resume/index.ts';
import {applyPaperReadingMutation} from '../src/domain/paper-reading/index.ts';
const source={ownerId:'u',libraryId:'l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Original reference.',pageNumber:2}]};
const unit={schemaVersion:1,unitId:'saved-prepared-unit',title:'Paper',goal:'Mechanism',source};
const workspace=applyPaperReadingMutation(null,{schemaVersion:1,kind:'register',operationId:'r',expectedRevision:0,unitId:unit.unitId,unit}).workspace;
const material={materialFingerprint:source.materialFingerprint,sourceVersion:source.sourceVersion,sections:[{id:'before',paragraphs:[{id:'x',rawEn:'Before'}]},{id:'s',paragraphs:source.paragraphs}]};
test('saved task resumes only an exact original version and contiguous source range',()=>{
 assert.deepEqual(matchPaperReadingResume(workspace,material),{position:1,count:1});
 for(const change of [{materialFingerprint:'c'.repeat(64)},{sourceVersion:'c'.repeat(64)},{sections:[{id:'s',paragraphs:[{...source.paragraphs[0],rawEn:'Different'}]}]},{sections:[{id:'s',paragraphs:[{...source.paragraphs[0],pageNumber:3}]}]}])assert.equal(matchPaperReadingResume(workspace,{...material,...change}),null);
 assert.equal(workspace.unit.unitId,'saved-prepared-unit');
});
