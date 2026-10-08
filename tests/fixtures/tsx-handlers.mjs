import {readFileSync} from 'node:fs';
import ts from 'typescript';
function extract(file,predicate,bindings){
  const source=ts.createSourceFile('component.tsx',readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let expression;
  function visit(node){if(expression)return;const found=predicate(node,source);if(found){expression=found;return;}ts.forEachChild(node,visit);}visit(source);
  if(!expression)throw new Error('Component handler not found');
  const code=ts.transpileModule(`exports.fn=${expression.getText(source)}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,out={};
  new Function(...Object.keys(bindings),'exports',code)(...Object.values(bindings),out);return out.fn;
}
export const tsxHandler=(file,name,bindings)=>extract(file,node=>ts.isVariableDeclaration(node)&&node.name.getText()===name?node.initializer:null,bindings);
export const tsxEffect=(file,needle,bindings)=>extract(file,(node,source)=>ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes(needle)?node.arguments[0]:null,bindings);
