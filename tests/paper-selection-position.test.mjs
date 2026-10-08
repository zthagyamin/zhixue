import test from 'node:test';
import assert from 'node:assert/strict';
import {placePaperSelectionToolbar} from '../app/paper-selection-position.ts';
test('selection toolbar stays within narrow viewport and flips above an anchor near the bottom',()=>{
  const bounds={left:0,top:0,right:390,bottom:600};
  const result=placePaperSelectionToolbar({left:350,right:380,top:510,bottom:540},{width:340,height:220},bounds);
  assert.ok(result.left>=8);assert.ok(result.left+result.width<=382);
  assert.ok(result.top>=8);assert.ok(result.top+result.maxHeight<=592);assert.equal(result.placement,'above');
});
test('soft keyboard viewport offsets and short heights remain bounded',()=>{
  const bounds={left:30,top:80,right:320,bottom:280};
  const result=placePaperSelectionToolbar({left:80,right:200,top:140,bottom:170},{width:340,height:260},bounds);
  assert.ok(result.left>=38&&result.left+result.width<=312);
  assert.ok(result.top>=88&&result.top+result.maxHeight<=272);
});
test('offscreen or unavailable anchors do not create detached floating controls',()=>{
  assert.equal(placePaperSelectionToolbar({left:0,right:20,top:900,bottom:920},{width:300,height:200},{left:0,top:0,right:390,bottom:600}),null);
  assert.equal(placePaperSelectionToolbar({left:0,right:20,top:0,bottom:20},{width:300,height:200},{left:0,top:0,right:0,bottom:0}),null);
});
test('focused editing remains available when a keyboard viewport moves the original word offscreen',()=>{
  const result=placePaperSelectionToolbar({left:80,right:160,top:600,bottom:630},{width:340,height:280},{left:0,top:80,right:390,bottom:420},true);
  assert.ok(result);assert.equal(result.placement,'viewport');assert.ok(result.top>=88&&result.top+result.maxHeight<=412);
});
