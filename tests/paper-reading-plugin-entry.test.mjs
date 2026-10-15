import test from 'node:test';
import assert from 'node:assert/strict';
import {extract} from './helpers/causal-harness.mjs';
const jsx=(type,props)=>({type,props});
const PaperPlugin=extract('app/plugins/plugin-paper.tsx','PaperPlugin')({exports:{},parsePaperStudyData:value=>value,PaperReadingEntry:'Focused',PaperWorkshop:'Workshop',require:()=>({jsx,jsxs:jsx})});
test('direct registered paper plugin uses the focused page and retains the legacy workshop as optional tools',()=>{
 const paper={paperId:'p'},services={owner:'u',library:'l'};
 const node=PaperPlugin.renderUI({data:{paper},context:{paperServices:services}});
 assert.equal(node.type,'Focused');assert.equal(node.props.initialPaper,paper);assert.equal(node.props.services,services);
 const tools=node.props.renderTools(paper);assert.equal(tools.type,'Workshop');assert.equal(tools.props.restoreLast,false);assert.equal(tools.props.showMaterialManager,false);
});
test('paper plugin without a bound library does not create a reading workspace',()=>{
 const node=PaperPlugin.renderUI({data:{paper:{}},context:{}});assert.equal(node.type,'p');
});
