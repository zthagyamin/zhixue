import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createMathVariant,evaluateMathVariant,assertSeparatedFamilies} from '../src/domain/guided-math/index.ts';

export async function evaluateDevelopmentFixtures(){
    const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/guided-math-v1.json',import.meta.url),'utf8'));
    if(fixture.schemaVersion!==1||fixture.status!=='development-engineering-fixtures'||fixture.humanReviewed!==false)throw Error('unexpected-evaluation-manifest');
    const rows=[],identities=[];
    for(const sample of fixture.cases){
        const variant=await createMathVariant({parent:{parentItemKey:sample.id,parentContentHash:'synthetic-v1',hashKind:'visible-snapshot'},templateId:sample.templateId,seed:1,parameters:sample.parameters});
        identities.push({familyKey:variant.familyKey,parentItemKey:sample.id,split:'development'});
        const result=evaluateMathVariant(variant,sample.input,sample.withSteps===true);
        rows.push({id:sample.id,familyKey:variant.familyKey,final:result.final.verdict,steps:result.steps?.verdict??null,
            critical:sample.critical===true,accepted:result.final.verdict==='correct'&&(!sample.withSteps||result.steps?.verdict==='correct'),
            determined:result.final.verdict!=='unknown'&&(!sample.withSteps||result.steps?.verdict!=='unknown'),
            matchesExpected:result.final.verdict===sample.expectedFinal&&(result.steps?.verdict??null)===(sample.expectedSteps??null)});
    }
    assertSeparatedFamilies(identities);
    return {schemaVersion:1,scope:'development-engineering-fixtures',total:rows.length,matchingExpected:rows.filter(row=>row.matchesExpected).length,
        determined:rows.filter(row=>row.determined).length,unknown:rows.filter(row=>!row.determined).length,
        criticalCases:rows.filter(row=>row.critical).length,criticalFalseAccepts:rows.filter(row=>row.critical&&row.accepted).length,
        humanReviewedCases:0,unseenHoldoutCases:0,modelEvaluations:0,delayedLearnerMeasurements:0,
        note:'已经用于开发的确定性数学样例；不是人工语义保留集、模型准确率或真实学习效果。',rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    const report=await evaluateDevelopmentFixtures();
    if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    if(report.total===0||report.matchingExpected!==report.total||report.criticalFalseAccepts!==0)process.exitCode=1;
}
