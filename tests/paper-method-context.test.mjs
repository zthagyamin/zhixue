import test from 'node:test';
import assert from 'node:assert/strict';
import {needsConcreteRecallQuestion,recallPrompt,buildRecallPrompt} from '../app/recall-content.ts';
import {checkContentQuality} from '../src/domain/assessment/index.ts';
const point='区分论文显式声明（使用了哪些技术、观察到什么效果）与因果推断（各项技术各自贡献多少）；旧记录中的未核验说明';
const generated={prompt:'请闭卷回答：区分论文显式声明（使用了哪些技术、观察到什么效果）与因果推断（各项技术各自贡献多少）。',sourceLabel:'AlexNet P2 · 显式声明与因果推断',reviewPoint:point,answer:point,explanation:point};
test('a learning-objective verb does not turn a copied result-card note into a real question',()=>{
 const before=structuredClone(generated);assert.equal(needsConcreteRecallQuestion(generated),true);
 assert.equal(checkContentQuality('recall',generated).capabilities.canSelfCheck,false);assert.deepEqual(generated,before);
 assert.match(recallPrompt(generated),/待补具体问题/);
});
test('result cards remain material even when a note happens to resemble a question',()=>{
 for(const point of ['区分甲与乙','为什么需要对照？参考文字','什么是过拟合？'])assert.match(buildRecallPrompt(point,'研究笔记'),/待补具体问题/);
});
test('an explicitly authored paper method question with its own answer remains intact',()=>{
 const authored={prompt:'在 ResNet（2015）的 identity shortcut 中，若目标映射 H(x)=x，残差分支 F(x) 应学成什么？',sourceLabel:'ResNet（2015） · §3.1',answer:'F(x)=0，因为 H(x)=F(x)+x。'};
 assert.equal(needsConcreteRecallQuestion(authored),false);assert.equal(recallPrompt(authored),authored.prompt);assert.equal(checkContentQuality('recall',authored).capabilities.canSelfCheck,true);
});

test('an echoing explanation cannot hide an independently authored answer',()=>{
 const authored={prompt:'请闭卷回答：什么是过拟合？',reviewPoint:'什么是过拟合？',explanation:'什么是过拟合？',answer:'模型过度拟合训练样本的偶然特征，在未见数据上表现较差。'};
 assert.equal(needsConcreteRecallQuestion(authored),false);assert.equal(recallPrompt(authored),authored.prompt);assert.equal(checkContentQuality('recall',authored).capabilities.canSelfCheck,true);
});

import {recallMaterialText} from '../src/domain/assessment/index.ts';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {recallFixture,settle,nodes,text} from './helpers/recall-flow-fixture.mjs';

test('reading-only objectives retain literal notes, not scoring-echo filtering',()=>{
 const source={prompt:'请闭卷回答：区分甲与乙。',reviewPoint:'区分甲与乙',answer:'区分甲与乙',explanation:'区分甲与乙'};
 assert.equal(needsConcreteRecallQuestion(source),true);assert.equal(recallMaterialText(source),'区分甲与乙');
});

test('per-item paper source is visible; generic collection labels are not presented as paper identity',()=>{
 const {RecallSourceCaption}=loadTsx(new URL('../src/features/remediation/recall-source-caption.tsx',import.meta.url));
 const html=renderToStaticMarkup(createElement(RecallSourceCaption,{label:'AlexNet（2012） · §4.2 Dropout',prompt:'为什么需要随机失活？'}));
 assert.match(html,/AlexNet（2012）/);assert.match(html,/§4.2 Dropout/);
 assert.equal(renderToStaticMarkup(createElement(RecallSourceCaption,{label:'论文核心观点',prompt:'为什么？'})),'');
});

test('changing paper context invalidates the old answer scope',async()=>{
 const f=recallFixture({data:{domain:'paper',sourceLabel:'Paper A',prompt:'如何对齐两个分支？',explanation:'保证参与相加的形状相同。'}});await settle(f);
 await f.type('old answer');f.props.data={...f.props.data,sourceLabel:'Paper B'};f.hooks.render();await settle(f);
 assert.match(text(f.view()),/参考内容已变化/);assert.equal([...nodes(f.view())].some(n=>n.type==='textarea'),false);assert.deepEqual(f.records,[]);
});

test('native question-bank topic supplies the same per-item source caption as account data',async()=>{
 const f=recallFixture({data:{domain:'paper',topic:'ResNet（2015） · §3.1',prompt:'残差分支应输出什么？',explanation:'加法处目标与输入的差。'}});await settle(f);
 const caption=[...nodes(f.view())].find(n=>n.type?.name==='RecallSourceCaption');assert.ok(caption);assert.equal(caption.props.label,'ResNet（2015） · §3.1');
});
