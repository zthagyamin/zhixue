import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyStudySwipe,studySwipeAction} from '../app/study-swipe.ts';
import {tsxEffect} from './fixtures/tsx-handlers.mjs';

const start={x:100,y:180,time:1000};
test('only deliberate directional motion is a swipe; scroll, diagonal and long holds are not',()=>{
 assert.equal(classifyStudySwipe(start,{x:190,y:190,time:1200}), 'right');
 assert.equal(classifyStudySwipe(start,{x:10,y:185,time:1200}), 'left');
 assert.equal(classifyStudySwipe(start,{x:110,y:80,time:1200},true), 'up');
 assert.equal(classifyStudySwipe(start,{x:110,y:80,time:1200}),null);
 for(const end of [{x:130,y:180,time:1200},{x:180,y:250,time:1200},{x:200,y:180,time:5000},{x:200,y:180,time:900}])assert.equal(classifyStudySwipe(start,end,true),null);
});
test('a second pointer outside the card cancels the active gesture',()=>{
 let listener;const gesture={current:{id:1,x:0,y:0,time:0,vertical:true}};
 const window={addEventListener:(type,fn)=>{assert.equal(type,'pointerdown');listener=fn;},removeEventListener:()=>{listener=null;}};
 const cleanup=tsxEffect(new URL('../app/use-study-swipe.ts',import.meta.url),'cancelOther',{window,gesture})();
 listener({pointerId:2});assert.equal(gesture.current,null);cleanup();assert.equal(listener,null);
});
test('swipes cannot grade unrevealed, unready, submitted, or stale-owner cards',()=>{
 const ready={revealed:true,ready:true,busy:false,current:true};
 assert.equal(studySwipeAction('right',ready),'good');assert.equal(studySwipeAction('left',ready),'again');
 assert.equal(studySwipeAction('up',{...ready,revealed:false}),'reveal');
 for(const blocked of [{revealed:false},{ready:false},{busy:true},{current:false}])assert.equal(studySwipeAction('right',{...ready,...blocked}),null);
 assert.equal(studySwipeAction('up',{...ready,ready:false,revealed:false}),null);
});
