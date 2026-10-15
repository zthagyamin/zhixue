import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {DEMO_PAPER_ALEXNET,emptyPaperDraft} from '../app/paper-study.ts';

const {PaperNoteSavePanel}=loadTsx(new URL('../app/paper-sources-panel.tsx',import.meta.url));
function render(location){
  const draft={...emptyPaperDraft(),noteReceipt:{requestId:'synthetic-request',localLibraryId:'synthetic-library',status:'written',...location}};
  return renderToStaticMarkup(createElement(PaperNoteSavePanel,{paper:DEMO_PAPER_ALEXNET,draft,
    session:{snapshot:()=>({draft,error:''})},services:{onSources(){}}}));
}
test('existing malformed receipt state cannot render an arbitrary protocol or foreign link',()=>{
  for(const url of ['obsidian://new?name=Synthetic-note','https://synthetic.invalid/note','data:text/html,synthetic','//www.notion.so/'+ 'a'.repeat(32),'https://www.notion.so/'+ 'a'.repeat(32)+'\n']){
    const html=render({kind:'notion',url});assert.doesNotMatch(html,/<a\b/);assert.match(html,/保存位置待核对/);
  }
});
test('valid Notion link remains available and Obsidian receipt remains plain text',()=>{
  const url='https://www.notion.so/'+ 'a'.repeat(32);
  assert.match(render({kind:'notion',url}),new RegExp('href="'+url+'"'));
  const html=render({kind:'obsidian',path:'notes/原阅读笔记.md'});assert.doesNotMatch(html,/<a\b/);assert.match(html,/notes\/原阅读笔记.md/);
});
test('a mismatched receipt kind cannot promote its extra URL to a Notion link',()=>{
  for(const location of [{kind:'obsidian',url:'obsidian://new?name=Synthetic-note'},
    {kind:'notion',path:'notes/ambiguous.md',url:'https://www.notion.so/'+ 'a'.repeat(32)}]){
    const html=render(location);assert.doesNotMatch(html,/<a\b/);assert.match(html,/保存位置待核对/);
  }
});
