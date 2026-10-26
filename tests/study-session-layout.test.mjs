import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,button} from './helpers/causal-harness.mjs';

function fixture(narrow){
  let effectiveNarrow=narrow;
  const hooks=createHooks(),load=loader(hooks.api,{
    'app/study-layout-control.tsx':{useStudyLayoutMedia:()=>effectiveNarrow},
  },{matchMedia:()=>({matches:false})});
  const ui=load('app/study-session-shell.tsx');
  hooks.mount(ui.StudySessionShell,{title:'Synthetic subject',scope:'Synthetic scope',progress:'1 / 2',mode:'Recall',onExit(){},options:null,source:null,queue:'Synthetic queue',subjects:null,children:'Synthetic question'});
  return {hooks,ui,panel:()=>[...nodes(hooks.view())].find(node=>node.type===ui.StudyPanel),setNarrow(value){effectiveNarrow=value;hooks.render();hooks.flush();hooks.render();}};
}
test('a 1280px window in manual mobile layout opens the group queue in the dialog',()=>{
  const previous=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>{fn();return 1;};
  try{const f=fixture(true);button(f.hooks.view(),'本组清单').props.onClick();f.hooks.render();
    assert.equal(f.panel().props.open,true);assert.equal(f.panel().props.title,'本组清单');
    assert.equal([...nodes(f.hooks.view())].find(node=>node.type==='aside').props.hidden,true);
    f.hooks.unmount();
  }finally{globalThis.requestAnimationFrame=previous;}
});
test('an open desktop rail moves into a dialog when effective layout becomes narrow',()=>{
  const previous=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>{fn();return 1;};
  try{const f=fixture(false);f.hooks.flush();button(f.hooks.view(),'本组清单').props.onClick();f.hooks.render();f.hooks.flush();
    f.setNarrow(true);assert.equal(f.panel().props.open,true);assert.equal(f.panel().props.title,'本组清单');
    assert.equal([...nodes(f.hooks.view())].find(node=>node.type==='aside').props.hidden,true);f.hooks.unmount();
  }finally{globalThis.requestAnimationFrame=previous;}
});
test('desktop effective layout keeps the group queue in its inline rail',()=>{
  const previous=globalThis.requestAnimationFrame;globalThis.requestAnimationFrame=fn=>{fn();return 1;};
  try{const f=fixture(false);button(f.hooks.view(),'本组清单').props.onClick();f.hooks.render();
    assert.equal(f.panel().props.open,false);
    assert.equal([...nodes(f.hooks.view())].find(node=>node.type==='aside').props.hidden,false);
    f.hooks.unmount();
  }finally{globalThis.requestAnimationFrame=previous;}
});
