import test from 'node:test';
import assert from 'node:assert/strict';
import {loader,createHooks} from './helpers/causal-harness.mjs';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {nativeScopeReference} from '../src/infrastructure/course-study/native-scope.ts';
import {parseNativeMathIdentity} from '../src/domain/math-study/index.ts';
const {scopeForNonWord,inlineNonWordScope}=loader(createHooks().api)('app/study-dashboard/nonword-scopes.ts');

test('actual subject and inline scopes carry complete original math/code references without changing word scope',async()=>{
    const math=await sealStudyItem(quizBody({itemKey:'math',schemaVersion:2,learningSupport:{schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',step:{stepId:'one',prompt:'中间值',reference:'2',mode:'numeric'}},
        practice:{itemId:'math',abilityId:'math',domain:'math',questionType:'calculation',prompt:'1+2',answer:'3',sourceLabel:'Synthetic'}}));
    const code=await sealStudyItem(quizBody({itemKey:'code',practice:{itemId:'code',abilityId:'code',domain:'python',questionType:'code',prompt:'Implement f',initialCode:'pass',testCode:'assert True',sourceLabel:'Synthetic'}}));
    const word=await sealStudyItem(wordBody()),items=[math,code,word],snapshot=await sealStudySnapshot(snapshotBody(items));
    const loaded={bundle:{snapshot,items},bundles:[]},base={workspaceId:'account:test',ownerId:'owner',libraryId:snapshot.libraryId,loaded,enabled:true};
    for(const item of items){
        const raw={accountItemKey:item.itemKey,itemId:item.kind==='practice'?item.practice.itemId:item.itemKey,contentHash:item.contentHash};
        const scope=scopeForNonWord(base,raw,item.itemKey,'group','round');
        const inline=inlineNonWordScope({isDemoMode:false,accountLibraryId:snapshot.libraryId,data:{},accountLoaded:loaded,workspaceId:base.workspaceId,
            sessionUser:{userId:'owner'},practiceItems:[raw],currentDay:'2026-10-08'},raw);
        if(item.kind==='word'){assert.equal(scope.courseReference,undefined);assert.equal(inline.courseReference,undefined);}
        else{assert.deepEqual(scope.courseReference,{item,snapshot});assert.deepEqual(inline.courseReference,{item,snapshot});}
    }
    assert.throws(()=>scopeForNonWord(base,{accountItemKey:'math',contentHash:'f'.repeat(64)},'math','group','round'));
});

test('legacy local drafts are not Native math captures and do not crash subject traversal',()=>{
    const source={workspaceId:'guest:local',ownerId:'guest:local',libraryId:'synthetic-library',loaded:null,enabled:true};
    const raw={questionType:'calculation',pluginType:'calculation',prompt:'2+2',answer:'4',contentHash:'a'.repeat(64),localBindingHash:'b'.repeat(64)};
    const scope=scopeForNonWord(source,raw,'practice:q0','group','round');
    assert.equal(scope.libraryId,'synthetic-library');assert.equal(scope.nativeMathIdentity,undefined);
    assert.deepEqual(nativeScopeReference({...scope,libraryId:'local-vault:'+ 'a'.repeat(64),snapshotId:'legacy-snapshot'},raw),{});
    assert.throws(()=>parseNativeMathIdentity({schemaVersion:1,libraryId:source.libraryId,itemKey:'practice:q0',contentHash:raw.contentHash,localBindingHash:raw.localBindingHash}),/native-math-identity/);
});
