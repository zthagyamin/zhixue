import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {isSpellingComplete} from '../app/plugins/spelling-core.ts';
const file=new URL('../app/plugins/plugin-spelling.tsx',import.meta.url);
test('requesting spelling reference cannot grade before the reference render commits',()=>{
  let grades=0,shown=false,cancelled=false;const revealPending={current:false};tsxFunction(file,'reveal',{done:null,revealPending,window:{clearTimeout:()=>cancelled=true},finishTimer:{current:1},word:'term',setShowWord:()=>shown=true,setState(){},finish:()=>grades++})();
  assert.equal(shown,true);assert.equal(grades,0);assert.equal(revealPending.current,true);
  assert.equal(cancelled,true);
});
test('phonics reveal cancels completion and a queued old callback cannot report independent success',()=>{
 const timers=new Map(),revealPending={current:false},finishTimer={current:undefined},grades=[];
 const window={setTimeout:callback=>{timers.set(1,callback);return 1;},clearTimeout:id=>timers.delete(id)};
 const state={word:'ship',input:'shi',wrong:'',wrongCount:0};
 tsxFunction(file,'acceptInput',{done:null,state,window,finishTimer,revealPending,groupAt:()=>-1,setGroupErrors(){},performance:{now:()=>100},setClock(){},setState(){},isSpellingComplete,showWord:false,finish:correct=>grades.push(correct)})({...state,input:'ship'});
 const queued=timers.get(1);
 tsxFunction(file,'reveal',{done:null,window,finishTimer,revealPending,word:'ship',setShowWord(){},setState(){}})();
 assert.equal(timers.size,0);queued();assert.deepEqual(grades,[false]);
});
test('composition keydown never advances letters or blocks IME controls',()=>{
 for(const flag of [true,false]){let accepted=0,prevented=0;
 tsxFunction(file,'handleKeyDown',{done:null,composing:{current:flag},evaluateKeypress:()=>{throw Error('must not inspect IME keys');},acceptInput:()=>accepted++})({key:'s',nativeEvent:{isComposing:!flag},preventDefault:()=>prevented++});
 assert.equal(accepted,0);assert.equal(prevented,0);}
});
test('a new reveal commits one again grade after display, but a restored reveal never auto-grades',()=>{
  for(const requested of [true,false]){const grades=[],revealPending={current:requested};
    const frames=new Map();let sequence=0;const window={requestAnimationFrame:callback=>{frames.set(++sequence,callback);return sequence;},cancelAnimationFrame:id=>frames.delete(id)};
    const effect=tsxFunction(file,'SpellingUI',{showWord:true,revealPending,window,finish:value=>grades.push(value)},{effect:'revealPending.current'});
    const first=effect();first?.();const second=effect();assert.deepEqual(grades,[]);
    for(const [id,callback] of frames){frames.delete(id);callback();}second?.();assert.deepEqual(grades,requested?[false]:[]);
  }
});
