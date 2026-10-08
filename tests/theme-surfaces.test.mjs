import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const css=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const tokens=css('app/tokens.css'),library=css('app/learning-library.css'),paper=css('app/plugins/paper.css');
const luminance=hex=>{const h=hex.length===4?'#'+[...hex.slice(1)].map(c=>c+c).join(''):hex;return [1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);};
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
for(const [name,selector] of [['light',':root'],['dark','.dark']])test(name+' surface palette supports normal text and placeholders',()=>{
 const block=tokens.slice(tokens.indexOf(selector+' {')).split('}')[0];
 const value=key=>{const match=block.match(new RegExp('--study-'+key+':\\s*(#[a-f0-9]+)','i'));assert.ok(match,'Missing palette token '+key);return match[1];};
 for(const foreground of ['ink','muted'])for(const background of ['paper','surface','surface-2'])assert.ok(contrast(value(foreground),value(background))>=4.5,name+' '+foreground+' on '+background);
 assert.match(block,new RegExp('color-scheme:\\s*'+name+';'));
});
test('library and paper surfaces never use the undefined card variable',()=>{
 for(const source of [library,paper]){assert.doesNotMatch(source,/var\(\s*--card\b/);assert.match(source,/background:\s*var\(--surface\)/);}
});
test('library controls, metadata and placeholders have explicit paired theme colours',()=>{
 assert.match(library,/\.learning-library input::placeholder\s*\{[^}]*color:\s*var\(--muted\);[^}]*opacity:\s*1/);
 assert.match(library,/\.learning-library-toolbar\s*>\s*button\s*\{[^}]*background:\s*var\(--surface\);[^}]*color:\s*var\(--ink\)/);
 assert.match(library,/\.learning-subject-open span\{[^}]*color:var\(--muted\)/);
 assert.match(library,/\.learning-subject-open:hover\{background:var\(--surface-2\)/);
});
test('paper word hover and vocabulary badge do not inherit a mismatched light-only pair',()=>{
 assert.match(paper,/\.paper-workshop \.paper-raw button:hover\{background:var\(--accent-soft\);color:var\(--ink\)/);
 assert.match(paper,/\.paper-tray h2 span\{[^}]*background:var\(--paper-soft\);color:var\(--paper-accent\)/);
 assert.match(paper,/\.paper-dialog :is\(input, textarea\)::placeholder\s*\{[^}]*opacity:\s*1/);
});
test('keyboard focus remains explicit for search, selects and portaled controls',()=>{
 for(const source of [library,paper])assert.match(source,/:focus-visible\s*\{\s*outline:\s*2px solid var\(--study-accent-text\)/);
});
test('the persistent CI includes all 12 theme browser cases without removing previous suites',()=>{
 const workflow=css('.github/workflows/ci.yml');
 assert.match(workflow,/- suite: theme\s+expected: 12/);
 assert.match(workflow,/- suite: first-visit\s+expected: 16/);
 assert.match(workflow,/- suite: feedback\s+expected: 10/);
 const browser=css('.github/theme-browser.mjs');
 for(const text of ['LearningLibrary','PaperWorkshopLauncher','inspectContrast','colorScheme:opposite','page.reload()'])assert.ok(browser.includes(text));
});
