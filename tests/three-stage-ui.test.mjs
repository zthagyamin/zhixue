import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const text=await readFile(new URL('../app/plugins/plugin-three-stage.tsx',import.meta.url),'utf8');
const source=ts.createSourceFile('three.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function buttons(label,bindings){const result=[];function visit(n){if(ts.isJsxElement(n)&&n.openingElement.tagName.getText(source)==='button'&&n.children.some(child=>(typeof label==='string'?child.getText(source).includes(label):label.test(child.getText(source))))){const attr=n.openingElement.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(source)==='onClick');const expression=attr.initializer.expression;const code=ts.transpileModule(`exports.fn=${expression.getText(source)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const out={};new Function(...Object.keys(bindings),'exports',code)(...Object.values(bindings),out);result.push(out.fn);}ts.forEachChild(n,visit);}visit(source);return result;}

test('not knowing in each stage reveals the meaning before committing a grade',()=>{
  let revealed,learned,grade;
  const actions=buttons(/label="(?:不认识|想不起来)"/,{setRevealed:v=>revealed=v,setLearned:v=>learned=v,onGrade:v=>grade=v});
  assert.equal(actions.length,3);
  for(const action of actions){revealed=false;learned=false;grade=null;action();assert.equal(revealed,true);assert.equal(learned,true);assert.equal(grade,null);}
});

test('after first seeing the meaning all three stages record a relearning attempt',()=>{
  let grade;
  const actions=buttons('继续练习',{learned:true,onGrade:v=>grade=v});assert.equal(actions.length,3);
  for(const action of actions){grade=null;action();assert.equal(grade,'again');}
});
