import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCodeLearningSupportV1} from '../src/domain/content/code-learning-support.ts';
const support=()=>({schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[1,2],expected:3,hint:'Check addition.'}]});
test('function cases are bounded JSON with approved identifiers and unique IDs',()=>{assert.deepEqual(parseCodeLearningSupportV1(support()),{...support(),cases:[{...support().cases[0],kwargs:{}}]});for(const value of [{...support(),schemaVersion:2},{...support(),functionNames:['add()']},{...support(),cases:[{...support().cases[0],functionName:'other'}]},{...support(),cases:Array(33).fill(support().cases[0])},{...support(),cases:[{...support().cases[0],args:[NaN]}]},{...support(),cases:[{...support().cases[0],expected:'x'.repeat(5000)}]}])assert.throws(()=>parseCodeLearningSupportV1(value));});

import {readFileSync} from 'node:fs';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/stage3-code-support-contract.json',import.meta.url),'utf8'));
test('Node and Python consume the same versioned function-case contract fixtures',()=>{for(const row of fixtures){if(row.valid)assert.equal(parseCodeLearningSupportV1(row.input).schemaVersion,1,row.name);else assert.throws(()=>parseCodeLearningSupportV1(row.input),row.name);}});
