import {readFileSync} from 'node:fs';
import {openD1} from '../helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../../db/account-study-store.ts';
import {AccountStudyAccessStore} from '../../db/account-study-access-store.ts';
import {D1LearningAttemptStore} from '../../src/infrastructure/learning-attempt/index.ts';
import {D1PracticeEvidenceStore} from '../../src/infrastructure/practice-evidence/index.ts';
import {D1MathMappingStore} from '../../src/infrastructure/math-study/index.ts';
import {courseEvidenceOriginal} from '../../src/application/course-study/index.ts';
import {createAccountStudyApplication} from '../../src/application/account-study/index.ts';
import {machineTokenHash} from '../../src/domain/account-study/index.ts';
import {sealStudyItem,sealStudySnapshot} from '../../app/account-study-content.ts';
import {snapshotBody} from './account-study-fixtures.mjs';
import {attempt} from './practice-evidence-fixtures.mjs';
// Explicit authored synthetic reviews. These exercise binding; they do not establish real-material acceptance.
export const reviewedCases=[
 {templateId:'cancel-domain',parameters:{k:2,nonzero:0},conditions:['x is real; zero is included'],
  prompt:'For real x including zero, is dividing both sides of x(x-2)=0 by x always valid?',answer:'not allowed',
  sourceQuote:'real x including zero',rationale:'The original asks whether cancellation loses the zero solution. The cancel-domain exercise checks the same nonzero divisor condition; the prepared parameters retain zero in the domain and change only the other factor.'},
 {templateId:'sqrt-sign',parameters:{x:-2},conditions:['x is a negative real number'],
  prompt:'Let x=-3, a negative real number. Evaluate the principal square root sqrt(x^2) and explain the sign.',answer:'3',
  sourceQuote:'principal square root sqrt(x^2)',rationale:'The original distinguishes the nonnegative principal root from the signed input. The sqrt-sign exercise retains a negative real input and asks both the numerical root and the valid sign-interval expression; changing -3 to -2 preserves this ability.'},
 {templateId:'context-linear',parameters:{rate:2,baseline:2,target:12},conditions:['time is nonnegative; rate is constant and positive; target is at least baseline'],
  prompt:'A record begins at 4 and rises at a constant positive rate of 3 per minute. With nonnegative fractional time allowed, how long until it reaches 16?',answer:'4',
  sourceQuote:'constant positive rate of 3 per minute',rationale:'The original requires subtracting the initial record before dividing by the constant rate. The context-linear exercise preserves nonnegative fractional time, positive constant rate, and an attainable target; its changed readings test the same affine-model inversion.'},
 {templateId:'inverse-linear',parameters:{x:2,b:3,y:10},conditions:['a is real; the input coefficient is nonzero'],
  prompt:'For real a, f(t)=a*t+4 and f(3)=10. The input coefficient is nonzero. Determine a.',answer:'2',
  sourceQuote:'f(t)=a*t+4 and f(3)=10',rationale:'The original substitutes a known nonzero input, subtracts the intercept, then divides to recover a real slope. The inverse-linear exercise preserves that nonzero-coefficient branch with different values; it assesses recovering the coefficient rather than merely evaluating the function.'},
];
export function reviewedSource(example=reviewedCases[0]){
 const mappingId=`reviewed-${example.templateId}`,contentHash='a'.repeat(64),itemKey=`synthetic-${example.templateId}`;
 const item={schemaVersion:2,kind:'practice',itemKey,contentHash,eventKind:'due',subjectId:'synthetic',title:'Reviewed synthetic calculation',sourceHash:'b'.repeat(64),completionRule:'graded-practice',
  practice:{itemId:itemKey,abilityId:example.templateId,domain:'synthetic',sourceLabel:'Reviewed synthetic material',questionType:'calculation',prompt:example.prompt,answer:example.answer},
  learningSupport:{schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',variantMappingId:mappingId,conditions:example.conditions}};
 const preparation={schemaVersion:1,snapshotId:'synthetic-snapshot',mapping:{schemaVersion:1,mappingId,parentItemKey:itemKey,parentContentHash:contentHash,hashKind:'content',templateVersion:1,
  templateId:example.templateId,parameters:example.parameters,sourceConditions:example.conditions},review:{sourceQuote:example.sourceQuote,rationale:example.rationale}};
 return structuredClone({item,preparation});
}
export async function mappingFixture(t,example=reviewedCases[0],options={}){
 const db=await openD1();t.after(()=>db.sqlite.close());
 for(const sql of ['0023_practice_evidence_v1','0024_math_variant_mappings_v1'])if(!db.sqlite.prepare('SELECT name FROM sqlite_master WHERE name=?').get(sql==='0023_practice_evidence_v1'?'practice_evidence_v1':'math_variant_mappings_v1')&&!options.old)
  db.sqlite.exec(readFileSync(new URL(`../../drizzle/${sql}.sql`,import.meta.url),'utf8'));
 const scope={userId:'owner',libraryId:'library'},now=()=>new Date('2026-10-08T01:00:00.000Z'),access=new AccountStudyAccessStore(db.binding,now),secret='synthetic-mapping-device-credential-0000000000000000000';
 await access.register(scope.userId,{grantId:'publisher',libraryId:scope.libraryId,tokenHash:await machineTokenHash(secret),label:'Synthetic publisher',expectedProfileRevision:0,replaceLibrary:false});
 const device={principal:await access.activate(secret)},browser={principal:{kind:'browser',userId:scope.userId}};
 const source=reviewedSource(example);delete source.item.contentHash;
 if(options.legacy){source.item.schemaVersion=1;delete source.item.learningSupport;}
 const item=await sealStudyItem(source.item),snapshot=await sealStudySnapshot(snapshotBody([item],{libraryId:scope.libraryId,snapshotId:'synthetic-snapshot'}));
 const study=new AccountStudyStore(db.binding);await study.putSnapshot(scope,{snapshot,items:[item]},0);
 const preparation={...source.preparation,mapping:{...source.preparation.mapping,parentContentHash:item.contentHash}},a=attempt('calculation');
 a.binding={...a.binding,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash};
 a.answer=a.submitted.answer='3';
 db.sqlite.prepare('INSERT INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(scope.userId,scope.libraryId,a.attemptId,a.binding.groupId,a.revision,JSON.stringify(a),a.updatedAt);
 const attempts=new D1LearningAttemptStore(db.binding),original=courseEvidenceOriginal(study,attempts),store=new D1MathMappingStore(db.binding,study);
 const deps={now,getAccessStore:async()=>access,getStudyStore:async()=>study,getAttemptStore:async()=>attempts,getMathMappingStore:async()=>store,getPracticeEvidenceMapping:async()=>store,getPracticeEvidenceStore:async service=>new D1PracticeEvidenceStore(db.binding,original,{service,mapping:store})};
 const app=createAccountStudyApplication(deps),send=(body,auth=browser)=>app.post(structuredClone(body),auth,new AbortController().signal);
 const provenance={originGrantId:'publisher',publishedAt:now().toISOString()};
 return {db,scope,study,store,preparation,item,snapshot,a,deps,device,browser,send,provenance};
}
