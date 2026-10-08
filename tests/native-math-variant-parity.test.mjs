import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createMathVariant,evaluateMathVariant} from '../src/domain/guided-math/variant.ts';
import {seededParameters} from '../src/domain/guided-math/templates.ts';

const rows=JSON.parse(readFileSync(new URL('./fixtures/stage3-math-variant-parity.json',import.meta.url),'utf8'));

test('native Python shared fixtures retain actual four-template definitions, hashes, seeds and final rules',async()=>{
    assert.equal(rows.length,90);
    assert.deepEqual(new Set(rows.map(row=>row.templateId)),new Set(['cancel-domain','sqrt-sign','context-linear','inverse-linear']));
    for(const row of rows){
        const context=`${row.templateId}, seed ${row.seed}, parameters ${JSON.stringify(row.parameters)}`;
        assert.deepEqual(seededParameters(row.templateId,row.seed),row.seededParameters,context);
        const variant=await createMathVariant({parent:row.parent,templateId:row.templateId,seed:row.seed,parameters:row.parameters});
        assert.deepEqual(variant,row.variant,context);
        for(const [input,expected] of row.grades){
            const {final,steps}=evaluateMathVariant(variant,input);
            assert.equal(steps,null,context);
            assert.deepEqual({status:{correct:'correct',wrong:'incorrect',unknown:'undetermined'}[final.verdict],
                source:'deterministic',explanation:final.explanation},expected,`${context}: ${JSON.stringify(input)}`);
        }
    }
});
