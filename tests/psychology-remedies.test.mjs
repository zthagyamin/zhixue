import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractTrialQuestions,validateTrialFiles,TRIAL_BYTE_LIMIT} from '../app/note-trial-model.ts';
import {buildObsidianOpenUri,safeExistingObsidianUri,safeObsidianReference,obsidianPreferenceKey} from '../app/obsidian-link.ts';
import {resolveItemSource} from '../app/study-item-source-model.ts';
import {PAPER_SLOT_TEMPLATES,currentPaperSlots,paperTemplate,setPaperTemplate,setPaperSlot,paperOutlineMarkdown,paperReviewerActions} from '../app/paper-slot-templates.ts';
import {emptyPaperDraft,DEMO_PAPER_ALEXNET,paperReviewerPrompt} from '../app/paper-study.ts';
import {readingNoteMarkdown} from '../app/paper-reading-note.ts';
import {paperFromPages} from '../app/paper-import.ts';
import {groupIsCollapsed,parseCollapsedGroups,libraryDisclosureKey} from '../app/library-disclosure.ts';
import {reviewContextText} from '../app/review-context-model.ts';
import {mayStartGeneratedPlan} from '../app/generated-start-model.ts';
const source=text=>({name:'课程.md',text}),qa='Q: 什么是卷积？\nA: 按局部连接对输入进行加权求和。';
const read=name=>readFileSync(new URL('../app/'+name,import.meta.url),'utf8');

test('local trial accepts one or two nonempty text files only',()=>{
 assert.equal(validateTrialFiles([{name:'A.MD',size:200},{name:'b.txt',size:20}]),null);
 for(const files of [[],Array(3).fill({name:'a.md',size:1}),[{name:'a.pdf',size:1}],[{name:'a.md.exe',size:10}],[{name:'a.md',size:0}],[{name:'a.md',size:NaN}],[{name:'a.md',size:TRIAL_BYTE_LIMIT+1}]])assert.equal(typeof validateTrialFiles(files),'string');
});
test('trial heading and callout QA extraction preserve original answers and source',()=>{
 const [q]=extractTrialQuestions([source('\uFEFF---\ntitle: private metadata\n---\r\n# 卷积\r\n> [!question]\r\n> Q: 什么是卷积？\r\n>\r\n> A: 按局部连接对输入进行加权求和。')]);
 assert.equal(q.kind,'qa');assert.equal(q.section,'卷积');assert.equal(q.filename,'课程.md');assert.equal(q.answer,'按局部连接对输入进行加权求和。');assert.equal(q.prompt,'什么是卷积？');
});
test('trial chooses at most three with fair representation of both supplied files',()=>{
 const qs=extractTrialQuestions([{name:'a.md',text:[qa,qa,qa,qa].join('\n\n')},{name:'b.txt',text:'问：什么是导数？\n答：函数在某点的变化率。'}]);
 assert.equal(qs.length,3);assert.deepEqual(qs.map(q=>q.filename),['a.md','b.txt','a.md']);assert.equal(new Set(qs.map(q=>q.id)).size,3);
});
test('recall fallback quotes a real paragraph rather than inventing a factual answer',()=>{
 const text='这是一个完整的学习段落，包含定义、条件与限制，供学习者对照原文检查。';const [q]=extractTrialQuestions([source('# 第一讲\n'+text)]);
 assert.equal(q.kind,'recall');assert.equal(q.answer,text);assert.match(q.prompt,/第一讲/);assert.doesNotMatch(q.answer,/答案是/);
});
test('fenced code, comments, embeds and frontmatter are never questions',()=>{
 assert.deepEqual(extractTrialQuestions([source('---\nsecret: ignored\n---\n```md\n'+qa+'\n```\n<!--\n'+qa+'\n-->\n![[private.md]]\n![image](https://invalid)')]),[]);
});
test('trial preserves literal markup and math as text without interpreting HTML',()=>{
 const [q]=extractTrialQuestions([source('Q: 原样输出？\nA: <img src=x onerror=alert(1)> $x^2$ 与 ∀ε>0。')]);assert.equal(q.answer,'<img src=x onerror=alert(1)> $x^2$ 与 ∀ε>0。');
});
test('trial rejects binary and oversized Unicode input rather than truncating a supposed answer',()=>{
 assert.throws(()=>extractTrialQuestions([source('ab\0cd')]));assert.throws(()=>extractTrialQuestions([source('汉'.repeat(TRIAL_BYTE_LIMIT))]));assert.throws(()=>extractTrialQuestions([]));assert.throws(()=>extractTrialQuestions([source(qa),source(qa),source(qa)]));
});
test('trial does not invent missing questions or display incomplete overlong answers',()=>{
 assert.equal(extractTrialQuestions([source(qa)]).length,1);assert.deepEqual(extractTrialQuestions([source('太短了')]),[]);assert.deepEqual(extractTrialQuestions([source('Q: huge\nA: '+'a'.repeat(8001))]),[]);
});

test('Obsidian link encodes Chinese names, query punctuation and a heading as data',()=>{
 const result=buildObsidianOpenUri('我的 & 学习库','课程/a&b.md','第 3 节 #条件'),url=new URL(result);
 assert.equal(url.hostname,'open');assert.equal(url.searchParams.get('vault'),'我的 & 学习库');assert.equal(url.searchParams.get('file'),'课程/a&b.md#第 3 节 #条件');assert.equal(url.hash,'');assert.equal([...url.searchParams].length,2);
});
test('sourcePath is accepted only as a current-item relative Markdown reference',()=>{
 assert.equal(resolveItemSource({sourcePath:'数学/a.md#定理'}).section,'定理');assert.equal(resolveItemSource({sourcePath:'https://example.org/a.md'}).kind,'unlocated');
});
test('generated source links reject traversal, absolute paths, URI schemes and controls',()=>{
 for(const path of ['../a.md','a/../b.md','./a.md','C:\\x.md','/a.md','//host/a.md','https://e/a.md','javascript:alert.md','notes.md?x=1','a\nb.md','']){assert.equal(safeObsidianReference(path),false,path);assert.equal(buildObsidianOpenUri('vault',path),null,path);}
 assert.equal(buildObsidianOpenUri('', 'a.md'),null);assert.equal(buildObsidianOpenUri('bad\nvault','a.md'),null);
});
test('existing open links are checked rather than accepting arbitrary app actions',()=>{
 for(const uri of ['obsidian://new?file=x','obsidian://open?file=x.md&append=secret','obsidian://open?file=x.md&overwrite=true','https://example.org','obsidian://open?file=a.md&file=b.md','obsidian://open?path=/a.md&file=b.md','obsidian://open?file=../a.md','obsidian://open?file=a.md#heading','obsidian://open?file=a.md&callback=https://example.org'])assert.equal(safeExistingObsidianUri(uri),null,uri);
 const uri='obsidian://open?file=a.md%23heading';assert.equal(safeExistingObsidianUri(uri),uri);const absolute='obsidian://open?path=C%3A%5CNotes%5Ca.md';assert.equal(safeExistingObsidianUri(absolute),absolute);
});
test('device vault aliases are scoped by the caller and cannot collide by punctuation',()=>{
 assert.notEqual(obsidianPreferenceKey('a:b'),obsidianPreferenceKey('a%3Ab'));assert.notEqual(obsidianPreferenceKey('owner-a/library'),obsidianPreferenceKey('owner-b/library'));
});

test('paper templates have 5/4/3 fields and preserve legacy empirical keys',()=>{
 assert.deepEqual(PAPER_SLOT_TEMPLATES.map(t=>t.fields.length),[5,4,3]);assert.equal(paperTemplate(undefined).id,'empirical');const old={...emptyPaperDraft(),slots:{motivation:'my question'}};assert.equal(currentPaperSlots(old)[0].value,'my question');
});
test('switching templates never clears another outline, summaries or position',()=>{
 let draft={...emptyPaperDraft(),position:2,summaries:{one:'keep'}};draft=setPaperSlot(draft,'motivation','experiment');draft=setPaperTemplate(draft,'theory');draft=setPaperSlot(draft,'thesis','theorem');draft=setPaperTemplate(draft,'free');draft=setPaperSlot(draft,'problem','question');
 assert.equal(draft.slots.motivation,'experiment');assert.equal(draft.templateSlots.theory.thesis,'theorem');assert.equal(draft.templateSlots.free.problem,'question');assert.equal(draft.position,2);assert.deepEqual(draft.summaries,{one:'keep'});for(const id of ['empirical','theory','free'])assert.ok(currentPaperSlots(setPaperTemplate(draft,id))[0].value);
});
test('unknown template/field and oversized values do not mutate draft state',()=>{
 const draft=emptyPaperDraft();assert.equal(setPaperTemplate(draft,'constructor'),draft);assert.equal(setPaperSlot(draft,'__proto__','bad'),draft);assert.equal(setPaperSlot(draft,'motivation','a'.repeat(3001)),draft);assert.deepEqual(draft.slots,{});
});
test('paper export retains active and other populated outlines, never sample reference slots',()=>{
 let draft=setPaperSlot(emptyPaperDraft(),'motivation','MY EXPERIMENT');draft=setPaperTemplate(draft,'theory');draft=setPaperSlot(draft,'thesis','MY THESIS');const text=readingNoteMarkdown(DEMO_PAPER_ALEXNET,draft);assert.match(text,/理论概念型/);assert.match(text,/MY THESIS/);assert.match(text,/MY EXPERIMENT/);assert.match(text,/其他模板中的草稿/);assert.match(text,/自评不等于正式掌握/);assert.doesNotMatch(paperOutlineMarkdown(draft),/15\.3%/);
});
test('reviewer actions and context follow the selected template instead of forcing tensor exercises',()=>{
 assert.ok(paperReviewerActions('empirical').includes('Tensor Shape 推导'));assert.ok(!paperReviewerActions('theory').includes('Tensor Shape 推导'));let draft=setPaperTemplate({...emptyPaperDraft(),slots:{motivation:'INACTIVE'}},'theory');draft=setPaperSlot(draft,'thesis','ACTIVE');const prompt=paperReviewerPrompt('论证结构',DEMO_PAPER_ALEXNET,DEMO_PAPER_ALEXNET.sections[0].paragraphs[0],draft);assert.match(prompt,/ACTIVE/);assert.doesNotMatch(prompt,/INACTIVE/);
});
test('PDF separators and a UTF8 BOM normalize without stripping mathematical text',()=>{
 const paper=paperFromPages('理论笔记',[{pageNumber:1,text:'\uFEFF# 定理\n\n∀ε>0, ∃δ>0。这是数学中的定义与必要条件。\f第二段是对应的证明，保留 x² 与 αβ。'}],{filename:'theory.txt',version:'v1',kind:'upload'});const text=paper.sections.flatMap(s=>s.paragraphs.map(p=>p.rawEn)).join('\n');assert.match(text,/∀ε/);assert.match(text,/αβ/);assert.ok(!text.includes('\f'));
});

test('small libraries stay open while large libraries fold later groups by default',()=>{
 assert.equal(groupIsCollapsed({},'computing',1,4,false),false);assert.equal(groupIsCollapsed({},'language',0,12,false),false);assert.equal(groupIsCollapsed({},'computing',1,12,false),true);
});
test('explicit folding preferences override defaults but searching temporarily opens all matches',()=>{
 assert.equal(groupIsCollapsed({computing:false},'computing',1,100,false),false);assert.equal(groupIsCollapsed({language:true},'language',0,4,false),true);assert.equal(groupIsCollapsed({language:true},'language',0,4,true),false);assert.equal(groupIsCollapsed({language:true},'language',0,4,false),true);
});
test('invalid folding data does not override classification or leak prototype values',()=>{
 for(const value of ['bad','null','[]','"x"'])assert.deepEqual(parseCollapsedGroups(value),{});assert.deepEqual(parseCollapsedGroups('{"language":true,"computing":"true","__proto__":true}'),{language:true});
});
test('folding keys isolate owners and libraries without touching classification keys',()=>{
 const a=libraryDisclosureKey('a','b');assert.notEqual(a,libraryDisclosureKey('b','a'));assert.notEqual(a,libraryDisclosureKey('a','c'));assert.match(a,/library-disclosure/);
});

test('review context does not manufacture a date or recall percentage without evidence',()=>{
 const text=reviewContextText({});assert.match(text.label,/当前任务/);assert.doesNotMatch(text.label,/%|天后|\d{4}/);assert.match(reviewContextText({completedStage:0}).label,/阶段 1/);assert.match(reviewContextText({completedStage:2}).label,/阶段 3/);
});
test('only a parseable timezone-qualified date is shown as a stored schedule',()=>{
 const now=Date.parse('2026-09-13T00:00:00Z');assert.match(reviewContextText({due:'2026-09-12T00:00:00Z'},now).label,/到期复习/);assert.match(reviewContextText({due:'2026-09-14T00:00:00Z'},now).label,/已有复习安排/);for(const due of ['bad','2026-09-14','2026-09-14T00:00:00','2026-99-99T00:00:00Z'])assert.doesNotMatch(reviewContextText({due},now).label,/已有复习安排|到期复习/);
});
test('after saving, stale due dates are not mislabeled as a freshly confirmed next review',()=>{
 const text=reviewContextText({recorded:true,due:'2026-09-14T00:00:00Z'});assert.match(text.label,/新排期待核对/);assert.doesNotMatch(text.label,/2026|4 天/);
});
test('trial and extra practice always describe isolation before other metadata',()=>{
 const text=reviewContextText({temporary:true,recorded:true,due:'2026-09-14T00:00:00Z'});assert.match(text.label,/临时练习/);assert.doesNotMatch(text.label,/2026/);
});
test('generation auto-start requires the exact acknowledged plan, same scope and visible page',()=>{
 const intent={scope:'a/day',hash:'new',generation:3};assert.equal(mayStartGeneratedPlan(intent,'a/day','new',true,false,3),true);for(const [scope,hash,visible,disabled,generation] of [['b/day','new',true,false,3],['a/day','old',true,false,3],['a/day',undefined,true,false,3],['a/day','new',false,false,3],['a/day','new',true,true,3],['a/day','new',true,false,4]])assert.equal(mayStartGeneratedPlan(intent,scope,hash,visible,disabled,generation),false);assert.equal(mayStartGeneratedPlan(null,'a/day','new',true,false,3),false);
});

test('personal-note trial has no persistence/network service and is excluded from AI selection',()=>{
 const code=read('note-trial.tsx');assert.match(code,/data-ai-private/);assert.match(code,/不上传、不调用 AI、不写学习记录/);assert.doesNotMatch(code,/\bfetch\s*\(|localStorage|indexedDB|recordStudyAttempt|companionClient|dangerouslySetInnerHTML/);assert.match(read('ai/study-ai-selection.ts'),/\[data-ai-private\]/);
});
test('paper tabs retain both panels mounted and do not override closed-book state',()=>{
 const code=read('paper-workspace-panels.tsx');assert.match(code,/\[reading,board\]\.map/);assert.match(code,/hidden=\{narrow&&index!==active\}/);assert.match(code,/aria-controls/);assert.match(code,/ArrowRight/);assert.doesNotMatch(code,/setHidden|setPaper|session\.update|abort\(/);
});
test('one-click start does not approve or write a plan as a side effect',()=>{
 const code=read('generated-plan-start.tsx');assert.doesNotMatch(code,/approveTodayPlan|writeBack|fetch\s*\(/);assert.match(code,/mayStartGeneratedPlan/);assert.match(code,/consumed\.current/);
});
test('settings distinguish opt-in AI, explicit writeback and unsubmitted page input',()=>{
 const code=read('study-dashboard/sources-view.tsx');assert.doesNotMatch(code,/永不修改原文件|不上传完整私密上下文|备份全部本地作答、草稿/);assert.match(code,/AI/);assert.match(code,/尚未提交/);assert.match(code,/确认/);
});
