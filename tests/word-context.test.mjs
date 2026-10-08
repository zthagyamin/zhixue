import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {parseContextInline,makeWordContext,contextPrompt,contextPieces,contextFallback} from '../app/word-context-model.ts';
const good='We trained this classifier with much larger **datasets** to reduce overfitting.';
const source=name=>readFileSync(new URL('../app/'+name,import.meta.url),'utf8');

test('short screenshot-style fragment falls back without inventing missing context',()=>{
 const model=makeWordContext('use much larger **datasets**','datasets');
 assert.equal(model.canCloze,false);assert.equal(model.reason,'short');assert.equal(model.plain,'use much larger datasets');assert.equal(contextPrompt(model,true),model.plain);
 assert.equal(contextPieces(model,true).filter(x=>x.gap).length,0);assert.match(contextFallback(model.reason),/片段较短/);
});
test('formatted sentence masks the term but not surrounding emphasis markers',()=>{
 const model=makeWordContext(good,'datasets');assert.equal(model.canCloze,true);assert.equal(contextPrompt(model,true),'We trained this classifier with much larger ______ to reduce overfitting.');
 const pieces=contextPieces(model,true);assert.equal(pieces.filter(x=>x.gap).length,1);assert.ok(!JSON.stringify(pieces).includes('datasets'));assert.ok(!JSON.stringify(pieces).includes('**'));
});
test('reveal replaces the same gap with the exact original term and its formatting',()=>{
 const model=makeWordContext(good,'datasets'),pieces=contextPieces(model,false);assert.equal(pieces.map(x=>x.text).join(''),model.plain);const answer=pieces.find(x=>x.answer);assert.equal(answer.text,'datasets');assert.deepEqual(answer.marks,['strong']);
});
test('all occurrences and original case are handled, no later occurrence leaks',()=>{
 const model=makeWordContext('Datasets support our careful evaluation; these DATASETS also support additional independent tests.','datasets');assert.equal(model.matches.length,2);assert.equal(contextPieces(model,true).filter(x=>x.gap).length,2);assert.doesNotMatch(contextPrompt(model,true),/datasets/i);assert.deepEqual(contextPieces(model,false).filter(x=>x.answer).map(x=>x.text),['Datasets','DATASETS']);
});
test('a target split across emphasis nodes is still one hidden answer',()=>{
 const model=makeWordContext('We trained the neural **network** on several carefully selected examples.','neural network');assert.equal(model.canCloze,true);assert.equal(contextPieces(model,true).filter(x=>x.gap).length,1);assert.doesNotMatch(JSON.stringify(contextPieces(model,true)),/neural|network/);
 assert.equal(contextPieces(model,false).map(x=>x.text).join(''),model.plain);
});
test('partially bold compound still resolves the complete literal target',()=>{
 const model=makeWordContext('Our large **net**works were trained using several independent groups.','networks');assert.equal(model.canCloze,true);assert.doesNotMatch(contextPrompt(model,true),/net/);assert.equal(contextPieces(model,true).filter(x=>x.gap).length,1);
});
test('unicode and punctuation boundaries do not replace substrings or interpret regex',()=>{
 const model=makeWordContext('We use C++ while another team uses C in several independent examples.','C++');assert.equal(model.canCloze,true);assert.equal(model.matches.length,1);
 assert.equal(makeWordContext('The artist reviewed particles before the class ended yesterday.','art').reason,'no-match');
 assert.equal(makeWordContext('The café is located near our university and serves excellent coffee.','CAFÉ').matches.length,1);
});
test('no term or no example never generates a pretend cloze',()=>{
 assert.equal(makeWordContext('','word').reason,'missing');assert.equal(makeWordContext('  ','word').reason,'missing');assert.equal(makeWordContext(good,' ').reason,'no-match');
});
test('paper author metadata and abstract fragments are hidden as unusable vocabulary context',()=>{
 const imported='Gomez* University of Toronto author@example.edu Lukas Kaiser* Google Brain lukas@example.org Abstract The dominant sequence transduction models are based on recurrent neural netwo';
 const model=makeWordContext(imported,'decoder');
 assert.equal(model.reason,'bibliographic');assert.equal(model.plain,'');assert.deepEqual(model.runs,[]);assert.equal(model.canCloze,false);
 assert.equal(contextPrompt(model,true),'');assert.match(contextFallback(model.reason),/署名或邮箱/);
});
test('ordinary decoder context without bibliographic metadata remains available',()=>{
 const model=makeWordContext('The decoder produces a sequence from the context vector after each observed input token.','decoder');
 assert.equal(model.reason,'ready');assert.equal(model.canCloze,true);assert.match(model.plain,/decoder/);
});
test('only paired emphasis is interpreted; unmatched markers and operators remain literal',()=>{
 const s='**bold** and *italic* and __strong__ and _em_ and x*y*z and snake_case and **open';
 const runs=parseContextInline(s);assert.equal(runs.map(x=>x.text).join(''),'bold and italic and strong and em and x*y*z and snake_case and **open');assert.ok(runs.some(x=>x.text==='bold'&&x.marks.includes('strong')));assert.ok(runs.some(x=>x.text==='italic'&&x.marks.includes('em')));
});
test('escaped stars are literal rather than globally deleted',()=>{
 assert.equal(parseContextInline('Use \\*stars\\* in **text**.').map(x=>x.text).join(''),'Use *stars* in text.');
});
test('inline code and TeX content preserve stars, underscores and backslashes',()=>{
 const s='Use `x**2 + a_b` with $x*y + a_b$ and \\(z_1\\) and \\[x*y\\].';const runs=parseContextInline(s);
 assert.equal(runs.find(x=>x.kind==='code').text,'x**2 + a_b');assert.deepEqual(runs.filter(x=>x.kind==='math').map(x=>x.text),['$x*y + a_b$','\\(z_1\\)','\\[x*y\\]']);
});
test('math inside strong emphasis is protected from its asterisks closing that emphasis',()=>{
 const runs=parseContextInline('**a formula $x**2$ follows**');assert.equal(runs.map(x=>x.text).join(''),'a formula $x**2$ follows');assert.equal(runs.find(x=>x.kind==='math').text,'$x**2$');
});
test('targets inside code or formula force ordinary context rather than corruption',()=>{
 for(const example of ['We use `datasets` to prepare several carefully selected validation examples.','We use $datasets$ to prepare several carefully selected validation examples.']){const model=makeWordContext(example,'datasets');assert.equal(model.reason,'protected');assert.equal(model.canCloze,false);assert.equal(contextPieces(model,true).filter(x=>x.gap).length,0);}
});
test('HTML and links are inert literal data, not hidden metadata or active URLs',()=>{
 for(const example of ['We use <img src=x onerror=alert(1)> datasets in several independent tests.','We use [datasets](https://example.invalid/datasets) in several independent tests.']){const model=makeWordContext(example,'datasets');assert.equal(model.canCloze,false);assert.equal(model.reason,'complex');assert.ok(model.plain.includes(example.includes('<')?'<img':'https://'));}
 const view=source('word-context-view.tsx');assert.doesNotMatch(view,/dangerouslySetInnerHTML|href=/);
});
test('oversized examples are displayed unchanged, not truncated into a false answer',()=>{
 const text='**datasets** '+ 'long '.repeat(4200),model=makeWordContext(text,'datasets');assert.equal(model.plain,text);assert.equal(model.reason,'complex');assert.equal(contextPrompt(model,true),text);
});
test('eligibility is a conservative UI threshold, not a factual uniqueness claim',()=>{
 assert.equal(makeWordContext('use much larger datasets','datasets').canCloze,false);
 assert.equal(makeWordContext('We train our classifier with much larger datasets','datasets').canCloze,true);
 assert.doesNotMatch(contextFallback('short'),/唯一|错误|不合语法/);
});
test('newlines and non-target symbols remain in visible source',()=>{
 const text='We trained **datasets** carefully across several independent runs.\nAccuracy ≥ 90%; cost = $5.';const model=makeWordContext(text,'datasets');assert.ok(contextPrompt(model,true).includes('\nAccuracy ≥ 90%; cost = $5.'));
});
test('stage-two UI uses semantic example layout and relocates its live setting',()=>{
 const code=source('plugins/plugin-three-stage.tsx');assert.match(code,/<WordContextView/);assert.match(code,/<StudyPluginOptions>/);assert.doesNotMatch(code,/补全例句|clozeEnabled&&!revealed\?cloze:data\.example/);assert.match(code,/核对答案/);assert.match(code,/想不起来/);
});
test('all three hosts expose the same live options destination without replacing drafts',()=>{
 for(const name of ['study-session-shell.tsx','extra-practice-session.tsx','practice-session.tsx']){const s=source(name);assert.match(s,/<StudyPluginOptionsProvider>/);assert.match(s,/<StudyPluginOptionsSlot\//);}
 const provider=source('study-plugin-options.tsx');assert.match(provider,/createPortal\(children, host.target\)/);assert.doesNotMatch(provider,/localStorage|indexedDB|recordStudyAttempt/);
});
test('stage-two audio is opt-in only; concealed answer has no speaker',()=>{
 const s=source('plugins/plugin-three-stage.tsx');assert.match(s,/if \(stage === 2\) cancelWordSpeech\(\); else speakWord\(word\)/);assert.match(s,/return cancelWordSpeech/);assert.match(s,/!concealed&&<SpeakButton/);assert.match(s,/if \(concealed\) cancelWordSpeech/);
});
test('AI visible question uses the masked prompt rather than raw answer metadata',()=>{
 const s=source('plugins/plugin-three-stage.tsx');assert.match(s,/concealed\?contextPrompt\(example,true\)/);
});
test('reveal feedback leaves official grading and unknown-word grading distinct',()=>{
 const s=source('plugins/plugin-three-stage.tsx');assert.equal((s.match(/onGrade\(learned \? "again" : "good"\)/g)||[]).length,3);assert.equal((s.match(/onGrade\("again"\)/g)||[]).length,3);
});
test('context-only CSS does not shrink normal word cards or alter hidden errors',()=>{
 const css=source('word-context.css');assert.match(css,/data-stage="2"/);assert.match(css,/max-width:760px/);assert.doesNotMatch(css,/role=.?alert|study-save-status.*display:none|study-source-update-note.*display:none/);
});

test('speech cleanup is safe during server rendering or without browser audio',async()=>{
 const {cancelWordSpeech}=await import('../app/plugins/speech.ts');assert.doesNotThrow(()=>cancelWordSpeech());
 const previous=globalThis.window;try{globalThis.window={};assert.doesNotThrow(()=>cancelWordSpeech());}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
test('speech cleanup cancels a previously queued answer',async()=>{
 const {cancelWordSpeech}=await import('../app/plugins/speech.ts'),previous=globalThis.window;let queue=['old answer'];
 try{globalThis.window={speechSynthesis:{cancel(){queue=[];}}};cancelWordSpeech();assert.deepEqual(queue,[]);}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
test('unavailable audio getter cannot crash concealment',async()=>{
 const {cancelWordSpeech}=await import('../app/plugins/speech.ts'),previous=globalThis.window;
 try{globalThis.window={get speechSynthesis(){throw new Error('not available');}};assert.doesNotThrow(()=>cancelWordSpeech());}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;}
});
test('opt-in speaking keeps original target, language and rate',async()=>{
 const {speakWord}=await import('../app/plugins/speech.ts'),previous=globalThis.window,oldUtterance=globalThis.SpeechSynthesisUtterance;let spoken;
 try{globalThis.window={speechSynthesis:{cancel(){},speak(value){spoken=value;}}};globalThis.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};speakWord('datasets');assert.equal(spoken.text,'datasets');assert.equal(spoken.lang,'en-US');assert.equal(spoken.rate,.85);}finally{if(previous===undefined)delete globalThis.window;else globalThis.window=previous;if(oldUtterance===undefined)delete globalThis.SpeechSynthesisUtterance;else globalThis.SpeechSynthesisUtterance=oldUtterance;}
});
