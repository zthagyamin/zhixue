import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {paperTokens,selectPaperRange,parsePaperStudyData,validVocabularyReceipt} from '../app/paper-study.ts';
import {paperFingerprint} from '../app/paper-draft-store.ts';
const {PaperSourceText,paperSourceSegments,resolvePaperSourceSelection,paperSourceSelectableRange,paperMathDisplayInput}=loadTsx(new URL('../src/features/paper-reading/source-text/index.ts',import.meta.url));
const {MathText}=loadTsx(new URL('../app/math-text.tsx',import.meta.url));
const renderMath=text=>createElement(MathText,{text});
const paperFor=rawEn=>parsePaperStudyData({paperId:'controlled',title:'Controlled source',sourceNote:'research/paper.md',sections:[{id:'s',title:'Mechanism',paragraphs:[{id:'p',rawEn,pageNumber:2}]}]});

test('source segmentation reconstructs raw characters and UTF16 offsets including CRLF and Unicode exactly',()=>{
 const raw='中文 🧠 Before $\\alpha+1$ after.\r\n```python\r\nx = "$skip$"\r\n```\r\nEnd `x` word.';
 const segments=paperSourceSegments(raw);assert.equal(segments.map(s=>s.raw).join(''),raw);
 for(const segment of segments)assert.equal(raw.slice(segment.start,segment.end),segment.raw);
 assert.deepEqual(segments.filter(s=>s.kind!=='text').map(s=>s.kind),['math','code','inline-code']);
 assert.equal(segments.filter(s=>s.kind==='math').length,1);
});
test('explicit paired formulas and fenced code reuse renderers while unmatched delimiters and plain PDF equations stay raw',()=>{
 const raw='Before $\\alpha$ after.\n$$x^2$$\n\\(y+1\\) and \\[z^2\\]\n```python\nx = "$literal$"\n```';
 const markup=renderToStaticMarkup(createElement(PaperSourceText,{text:raw,renderMath}));
 assert.match(markup,/class="katex"/);assert.match(markup,/<pre[^>]*><code>x = &quot;\$literal\$&quot;/);
 assert.match(markup,/<div[^>]*data-paper-source-protected="true"[^>]*><div class="nonword-text"><pre/);
 assert.doesNotMatch(markup,/<span[^>]*data-paper-source-protected="true"[^>]*><div/);
 assert.match(markup,/data-paper-source-protected="true"/);assert.match(markup,/data-paper-source-start="0"/);
 for(const literal of ['Cost is $5.','Cost $5 and $10.','Unclosed $$x+1','Unclosed \\(x+1','Unclosed \\[x+1','```python\n$literal$','f(x) = max(0, x).']){
  const parts=paperSourceSegments(literal);assert.equal(parts.map(s=>s.raw).join(''),literal);assert.ok(parts.every(s=>s.kind==='text'));
 }
});
test('inline code and source HTML are literal, formulas inside code are not sent to math renderer',()=>{
 const calls=[],text='Use `x = $literal$` then <img onerror="oops">.\n```js\n$literal$; <script>bad()</script>\n```';
 const markup=renderToStaticMarkup(createElement(PaperSourceText,{text,renderMath:value=>{calls.push(value);return createElement('b',null,value);}}));
 assert.deepEqual(calls,[]);assert.match(markup,/<code>.*\$literal\$/);assert.doesNotMatch(markup,/<img|<script>/);
 assert.match(markup,/&lt;img/);assert.match(markup,/&lt;script&gt;/);
});
test('existing word tokens keep exact source IDs and offsets on both sides of formulas and code',async()=>{
 const raw='Before $\\alpha+1$ after values.\n```py\nx=1\n```\nLater mechanism works.';
 const paper=paperFor(raw),fingerprint=await paperFingerprint(paper),seen=[];
 const markup=renderToStaticMarkup(createElement(PaperSourceText,{text:raw,renderMath,tokens:paperTokens(raw),renderWord:token=>{
  seen.push(token);return createElement('button',{'data-paper-start':token.start,'data-paper-end':token.end},token.text);
 }}));
 assert.ok(seen.some(t=>t.text==='Before'));assert.ok(seen.some(t=>t.text==='after'));assert.ok(seen.some(t=>t.text==='Later'));
 assert.equal(seen.some(t=>['alpha','py','x'].includes(t.text)),false);
 for(const token of seen)assert.equal(raw.slice(token.start,token.end),token.text);
 assert.match(markup,new RegExp('data-paper-start="'+raw.indexOf('after')+'"'));
 for(const term of ['Before','after','Later']){
  const start=raw.indexOf(term),word=selectPaperRange(paper,'p',start,start+term.length);
  assert.equal(word.id,`p:${start}:${start+term.length}`);assert.equal(word.term,term);assert.equal(word.page,2);
  const pending={requestId:'r',localLibraryId:'l',entries:[word]};
  assert.equal(validVocabularyReceipt({requestId:'r',localLibraryId:'l',results:[{id:word.id,status:'existing'}]},pending),true);
 }
 assert.equal(await paperFingerprint(paper),fingerprint);
});

function selectionFixture(raw,segments,startIndex,startOffset,endIndex,endOffset){
 const spans=segments.map(segment=>({dataset:{paperSourceStart:String(segment.start),paperSourceEnd:String(segment.end),...(segment.kind!=='text'?{paperSourceProtected:'true'}:{})},
  textContent:segment.kind==='text'?segment.raw:'rendered-formula',closest(){return this;}}));
 const nodes=spans.map(span=>({nodeType:3,parentElement:span,textContent:span.textContent}));
 const root={contains:node=>nodes.includes(node)||spans.includes(node),querySelectorAll:()=>spans.filter(span=>span.dataset.paperSourceProtected),
  ownerDocument:{createRange:()=>{let length=0;return {selectNodeContents(){},setEnd(node,offset){length=offset;},toString(){return nodes[startIndex].textContent.slice(0,length);}};}}};
 const range={collapsed:false,startContainer:nodes[startIndex],startOffset,endContainer:nodes[endIndex],endOffset};
 return {root,range,raw};
}
test('DOM selections after rendered formulas map from local source spans rather than displayed prefix length',()=>{
 const raw='Before $\\alpha+1$ after values.',segments=paperSourceSegments(raw),index=segments.findIndex(s=>s.raw.includes('after'));
 const fixture=selectionFixture(raw,segments,index,1,index,6);
 assert.deepEqual(resolvePaperSourceSelection(fixture.root,fixture.range,raw),{start:raw.indexOf('after'),end:raw.indexOf('after')+5});
 fixture.range.collapsed=true;assert.equal(resolvePaperSourceSelection(fixture.root,fixture.range,raw),null);
});
test('selection rejects transformed math/code endpoints, protected crossings and inaccurate DOM text',()=>{
 const raw='Before $\\alpha+1$ after values.',segments=paperSourceSegments(raw);
 for(const params of [[1,0,1,3],[0,0,2,6]]){
  const fixture=selectionFixture(raw,segments,...params);assert.equal(resolvePaperSourceSelection(fixture.root,fixture.range,raw),null);
 }
 const fixture=selectionFixture(raw,segments,2,1,2,6);fixture.range.startContainer.parentElement.textContent='altered source';
 assert.equal(resolvePaperSourceSelection(fixture.root,fixture.range,raw),null);
 fixture.range.startContainer={nodeType:3,parentElement:null};assert.equal(resolvePaperSourceSelection(fixture.root,fixture.range,raw),null);
});
test('keyboard/shift ranges share the source guard and display compatibility only changes explicit delimiters',()=>{
 const raw='Before $\\alpha$ after.';
 assert.deepEqual(paperSourceSelectableRange(raw,0,6),{start:0,end:6});
 assert.deepEqual(paperSourceSelectableRange(raw,raw.indexOf('after'),raw.indexOf('after')+5),{start:raw.indexOf('after'),end:raw.indexOf('after')+5});
 assert.equal(paperSourceSelectableRange(raw,0,raw.length),null);
 assert.equal(paperSourceSelectableRange(raw,-1,3),null);assert.equal(paperSourceSelectableRange(raw,3,2),null);
 assert.equal(paperSourceSelectableRange(raw,0,raw.length+1),null);
 assert.equal(paperMathDisplayInput('\\[x^2\\]'),'$$x^2$$');assert.equal(paperMathDisplayInput('f(x) = max(0,x)'),'f(x) = max(0,x)');
 assert.equal(paperMathDisplayInput('\\[x^2'),'\\[x^2');
});
test('escaped markup stays literal and a mismatched word token cannot masquerade as a source occurrence',()=>{
 const raw='Cost \\$5 and use \\`quoted\\` text.';
 assert.ok(paperSourceSegments(raw).every(segment=>segment.kind==='text'));
 assert.throws(()=>renderToStaticMarkup(createElement(PaperSourceText,{text:'hello',tokens:[{text:'forged',start:0,end:5,isWord:true}],renderWord:token=>token.text})),/paper-source-token-binding/);
});
