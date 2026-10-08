import {readFileSync,existsSync} from 'node:fs';
import ts from 'typescript';
/** Execute an actual TSX handler/effect with its external boundary injected.
 * No parallel implementation of the component state machine lives here. */
export function tsxFunction(file,name,bindings,{effect=false,within}={}){
  if(!existsSync(file))return null;
  const text=readFileSync(file,'utf8'),source=ts.createSourceFile(file.href??String(file),text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let selected;function walk(node){if(selected)return;if(ts.isFunctionDeclaration(node)&&node.name?.text===name){selected=node;return;}
    if(ts.isVariableDeclaration(node)&&node.name.getText(source)===name){selected=node.initializer;return;}ts.forEachChild(node,walk);}
  let target=source;
  if(within){let owner;function findOwner(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===within){owner=node;return;}ts.forEachChild(node,findOwner);}findOwner(source);if(!owner)throw Error(`Missing component ${within}`);target=owner;}
  walk(target);if(!selected)throw new Error(`Missing actual handler ${name}`);
  if(effect){let callback;function find(node){if(callback)return;if(ts.isCallExpression(node)&&['useEffect','useLayoutEffect'].includes(node.expression.getText(source))&&(effect===true||node.arguments[0].getText(source).includes(effect))){callback=node.arguments[0];return;}ts.forEachChild(node,find);}find(selected);selected=callback;}
  if(!selected)throw new Error(`Missing actual effect ${name}`);
  if(ts.isCallExpression(selected)&&selected.expression.getText(source)==='useCallback')selected=selected.arguments[0];
  const code=ts.transpileModule(`const selected=${selected.getText(source)};exports.fn=selected;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};new Function(...Object.keys(bindings),'exports',code)(...Object.values(bindings),exports);return exports.fn;
}
export function tsxCalls(file,callee,bindings,{within}={}){
  const text=readFileSync(file,'utf8'),source=ts.createSourceFile(String(file),text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),calls=[];
  function walk(node){if(ts.isCallExpression(node)&&node.expression.getText(source)===callee)calls.push(node.getText(source));ts.forEachChild(node,walk);}let target=source;if(within){let owner;const find=node=>{if((ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node))&&node.name?.text===within){owner=node;return;}ts.forEachChild(node,find);};find(source);if(!owner)throw Error(`Missing component ${within}`);target=owner;}walk(target);
  const code=ts.transpileModule(calls.join(';'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function(...Object.keys(bindings),code)(...Object.values(bindings));
}
