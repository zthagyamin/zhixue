import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePaperFigures,figureReferences,figureCrop} from '../app/paper-figures.ts';
import {parsePaperStudyData,DEMO_PAPER_ALEXNET} from '../app/paper-study.ts';
import {paperFingerprint} from '../app/paper-draft-store.ts';
import {paperFromSource} from '../app/paper-import.ts';
import {createPaperLibraryClient} from '../app/paper-library-client.ts';
const figure={assetId:'fig1',label:'Figure 1',title:'Network',caption:'The registered figure.',sourceVersion:'a'.repeat(64),assetVersion:'b'.repeat(64),kind:'pdf',page:3,region:{x:0.1,y:0.2,width:0.5,height:0.4}};
test('multiline captions survive source import and canceled reads abort transport',async()=>{
 const source={title:'Paper',pages:[{text:'Figure 1 explains this result.'}],version:figure.sourceVersion,origin:{kind:'vault',path:'paper.pdf'},figures:[{...figure,caption:'First line.\nSecond line.'}]};
 assert.equal(paperFromSource(source).figures[0].caption,source.figures[0].caption);
 const client=createPaperLibraryClient('http://localhost:8765','paired',async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})));
 for(const action of ['catalog','figure']){const controller=new AbortController();const pending=action==='catalog'?client.catalog('',controller.signal):client.figure({},controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});}
});
test('figures preserve bounded identity and reject arbitrary URLs, duplicates and invalid crops',()=>{
 assert.deepEqual(parsePaperFigures([figure]),[figure]);
 for(const invalid of [[{...figure,url:'file:///private'}],[figure,figure],[{...figure,region:{...figure.region,x:0.9}}],[{...figure,page:0}],[{...figure,sourceVersion:'old'}]])assert.throws(()=>parsePaperFigures(invalid));
});
test('only registered literal references activate, avoiding code and partial labels',()=>{
 const text='Fig. 1 and Figure 1. Figure 12 and `Figure 1` remain text; Table 2.';
 const refs=figureReferences(text,[figure]);
 assert.deepEqual(refs.map(r=>text.slice(r.start,r.end)),['Fig. 1','Figure 1']);
 assert.equal(figureReferences('preFigure 1; Figure 1(a)',[figure]).length,0);
});
test('normalized region scales within different rendered viewports',()=>{
 assert.deepEqual(figureCrop(1000,2000,figure.region),{x:100,y:400,width:500,height:800});
 assert.deepEqual(figureCrop(300,600,figure.region),{x:30,y:120,width:150,height:240});
});
test('absent figure metadata retains old fingerprint; figure identity participates when present',async()=>{
 const old=parsePaperStudyData(DEMO_PAPER_ALEXNET);
 assert.equal(Object.hasOwn(old,'figures'),false);
 assert.equal(await paperFingerprint(old),await paperFingerprint({...old,figures:undefined}));
 const next=parsePaperStudyData({...old,figures:[figure]});
 assert.deepEqual(next.figures,[figure]);
 assert.notEqual(await paperFingerprint(old),await paperFingerprint(next));
});
