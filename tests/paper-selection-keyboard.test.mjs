import test from 'node:test';
import assert from 'node:assert/strict';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
test('Escape belongs to the IME while composing, and otherwise dismisses only the toolbar',()=>{
  const source={},raw={current:source},panel={current:{style:{visibility:'visible'},getClientRects:()=>[{}]}},listeners=new Map(),closed=[];
  const document={querySelector:()=>({contains:node=>node===source}),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const effect=tsxFunction(new URL('../app/components/paper-selection-toolbar.tsx',import.meta.url),'PaperSelectionToolbar',{panel,raw,document,onClose:value=>closed.push(value)},{effect:'const escape='});
  const cleanup=effect();const captured=[];
  const key=(isComposing=false,keyCode=27)=>({key:'Escape',isComposing,keyCode,defaultPrevented:false,preventDefault:()=>captured.push('prevent'),stopPropagation:()=>captured.push('stop')});
  listeners.get('keydown')(key(true));listeners.get('keydown')(key(false,229));assert.deepEqual(closed,[]);assert.deepEqual(captured,[]);
  listeners.get('keydown')(key());assert.deepEqual(closed,[true]);assert.deepEqual(captured,['prevent','stop']);
  cleanup();assert.equal(listeners.size,0);
});
test('showing the tray transfers focus without replacing its chosen scroll position',()=>{
  const calls=[];const show=tsxFunction(new URL('../app/plugins/plugin-paper.tsx',import.meta.url),'showTray',{
    closeSelection:()=>calls.push('close'),tray:{current:{scrollIntoView:options=>calls.push(['scroll',options]),focus:options=>calls.push(['focus',options])}},window:{matchMedia:()=>({matches:true})},
  });
  show();assert.equal(calls[0],'close');assert.deepEqual(calls[1],['scroll',{block:'start',behavior:'auto'}]);assert.deepEqual(calls[2],['focus',{preventScroll:true}]);
});
