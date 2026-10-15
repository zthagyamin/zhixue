import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePaperReviewCandidate,readingCandidateArtifact} from '../src/domain/paper-reading/review-candidate.ts';
import {approveCandidates} from '../src/domain/practice-candidates/index.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
const source={ownerId:'account:u',libraryId:'account:l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.',pageNumber:3}]};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain mechanism',source};
const task=paperReadingTask({taskId:'task',revision:1,source,origin:'prepared',goal:unit.goal,ability:'mechanism',question:'Why does ReLU help?',reference:[{point:'Avoid saturation for positive inputs.',paragraphId:'p',quote:'avoids saturation for positive inputs'}]});
test('formal review proposal carries paper task and source identity but no learner answer or score',async()=>{
 const prepared=preparePaperReviewCandidate(unit,task,{paperId:'paper',sourceNote:'Papers/paper.md',sectionLabel:'Methods'});
 assert.equal(prepared.seeds[0].question,task.question);assert.equal(prepared.seeds[0].category,'');
 const selected={...prepared.seeds[0],category:'claim'};
 const approved=approveCandidates(prepared.source,[selected],{reviewed:true,workload:true,currentVersion:prepared.source.version});
 const artifact=await readingCandidateArtifact(approved,prepared);
 assert.equal(artifact.schemaVersion,2);assert.equal(artifact.readingContext.materialFingerprint,source.materialFingerprint);assert.equal(artifact.readingContext.taskRevision,1);
 assert.equal(artifact.readingContext.abilityType,'mechanism');assert.equal(artifact.readingContext.mappingStatus,'candidate');
 assert.equal(artifact.items[0].citation.page,3);assert.equal('rating' in artifact,false);assert.equal('attempts' in artifact,false);assert.equal('stateRef' in artifact.readingContext,false);
 assert.deepEqual(await readingCandidateArtifact(approved,prepared),artifact);
 const edited=structuredClone(approved);edited.items[0].question='Explain the mechanism on positive inputs.';
 assert.notEqual((await readingCandidateArtifact(edited,prepared)).items[0].id,artifact.items[0].id);
});
test('source changes and unanswerable tasks cannot become formal review proposals',()=>{
 assert.throws(()=>preparePaperReviewCandidate(unit,{...task,source:{...source,sourceVersion:'c'.repeat(64)}},{paperId:'paper'}),/binding/);
 assert.throws(()=>preparePaperReviewCandidate(unit,{...task,status:'needs-improvement'},{paperId:'paper'}),/ready/);
});
