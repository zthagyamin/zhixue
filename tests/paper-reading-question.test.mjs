import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {applyPaperReadingMutation} from '../src/domain/paper-reading/workspace.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
const {PaperReadingQuestion}=loadTsx(new URL('../src/features/paper-reading/question.tsx',import.meta.url));
const source={ownerId:'u',libraryId:'l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Reference source.'}]};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain',source};
const registered=applyPaperReadingMutation(null,{schemaVersion:1,operationId:'r',unitId:'unit',expectedRevision:0,kind:'register',unit}).workspace;
const task=paperReadingTask({taskId:'t',revision:1,source,origin:'prepared',goal:'Explain',ability:'mechanism',question:'What causes the effect?',reference:[{point:'Hidden reference answer.',paragraphId:'p',quote:'Reference source.'}]});
const ready=applyPaperReadingMutation(registered,{schemaVersion:1,operationId:'t',unitId:'unit',expectedRevision:1,kind:'task',task},'service').workspace;
const state=workspace=>({ready:true,saving:false,busy:false,workspace,input:'',error:'',notice:'',cloud:'device-only'});
const props={onBegin(){},onAnswer(){},onSubmit(){},onReveal(){},onRetry(){},onEvaluate(){},onSync(){},onContinue(){},renderText:text=>createElement('p',null,text)};
test('beginning is explicit and ready questions conceal the reference',()=>{
 assert.match(renderToStaticMarkup(createElement(PaperReadingQuestion,{...props,state:state(registered)})),/开始学习/);
 const markup=renderToStaticMarkup(createElement(PaperReadingQuestion,{...props,state:state(ready)}));
 assert.match(markup,/What causes the effect/);assert.match(markup,/你的回答/);assert.doesNotMatch(markup,/Hidden reference answer/);
});
test('pending answers have recovery and continuation without mastery or automatic self-rating',()=>{
 const submitted=applyPaperReadingMutation(ready,{schemaVersion:1,operationId:'s',unitId:'unit',expectedRevision:2,kind:'submit',answer:'I forgot',referenceSeen:false,submittedAt:'2026-10-08T09:00:00Z'}).workspace;
 const markup=renderToStaticMarkup(createElement(PaperReadingQuestion,{...props,state:{...state(submitted),busy:true,input:'I forgot'}}));
 assert.match(markup,/待核对/);assert.match(markup,/继续/);assert.doesNotMatch(markup,/已掌握|自评|恭喜|已理解/);
 assert.doesNotMatch(markup,/<button[^>]*disabled[^>]*>继续/);
});
test('revealed key points offer same-page conceal-and-retry; failed saving keeps visible input',()=>{
 const submitted=applyPaperReadingMutation(ready,{schemaVersion:1,operationId:'s',unitId:'unit',expectedRevision:2,kind:'submit',answer:'Original answer',referenceSeen:false,submittedAt:'2026-10-08T09:00:00Z'}).workspace;
 const shown=applyPaperReadingMutation(submitted,{schemaVersion:1,operationId:'v',unitId:'unit',expectedRevision:3,kind:'reference'}).workspace;
 const markup=renderToStaticMarkup(createElement(PaperReadingQuestion,{...props,state:{...state(shown),input:'Original answer'}}));
 assert.match(markup,/Hidden reference answer/);assert.match(markup,/收起答案再试/);
 const failed=renderToStaticMarkup(createElement(PaperReadingQuestion,{...props,state:{...state(ready),input:'保留这段输入',error:'quota'}}));
 assert.match(failed,/保留这段输入/);assert.match(failed,/保存失败/);
});
