import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import {readDashboardSource} from '../helpers/dashboard-source.mjs';
import {m4Bindings} from './m4-dashboard-bindings.mjs';
const text=await readDashboardSource();
const source=ts.createSourceFile('dashboard.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(result) return;if(predicate(node)){result=node;return;}ts.forEachChild(node,visit);}visit(source);if(!result) throw new Error('dashboard expression not found');return result;}
function inSubjectSession(node){for(let parent=node.parent;parent;parent=parent.parent)if(ts.isFunctionDeclaration(parent)&&parent.name?.text==='SubjectViewSession')return true;return false;}
function compile(expression,bindings){
  const callable=ts.isFunctionDeclaration(expression)?ts.factory.createFunctionExpression(expression.modifiers?.filter(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword),expression.asteriskToken,expression.name,expression.typeParameters,expression.parameters,expression.type,expression.body):null;
  const text=callable?ts.createPrinter().printNode(ts.EmitHint.Expression,callable,source):expression.getText(source);
  const code=ts.transpileModule(`const extracted=${text}; exports.fn=extracted;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const require=name=>{if(name==='react/jsx-runtime')return jsxRuntime;throw new Error(`Unexpected dashboard dependency: ${name}`);};
  const exports={};new Function(...Object.keys(bindings),'require','exports',code)(...Object.values(bindings),require,exports);return exports.fn;
}
export function dashboardJsxProp(tag,prop,bindings){
  // The shared non-word host now owns the main slot; its onGrade is the real formal factory.
  const actualTag=tag==='Plugin.renderUI'?'NonWordPluginHost':tag;
  const element=find(node=>(!['NonWordPluginHost','LearningDraftBoundary'].includes(actualTag)||inSubjectSession(node))&&(ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)===actualTag||ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)===actualTag));
  const opening=ts.isJsxElement(element)?element.openingElement:element;
  const attribute=opening.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(source)===prop);
  if(!attribute)throw new Error(`Missing ${tag}.${prop}`);
  if(!attribute.initializer)return true;
  return compile(attribute.initializer.expression,bindings);
}
function rawFunction(name,bindings){
  const variable=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(source)===name);
  const expression=ts.isCallExpression(variable.initializer)?variable.initializer.arguments[0]:variable.initializer;
  return compile(expression,bindings);
}
export function dashboardFunction(name,bindings){
  const prepared=m4Bindings(name,bindings,rawFunction,rawFunction);
  return prepared.result??rawFunction(name,prepared.env);
}
export function dashboardValue(name,bindings){
  const variable=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(source)===name);
  return compile(variable.initializer,bindings);
}
export function dashboardDeclaredFunction(name,bindings){
  if(['detectExistingCompanion','pairCompanion','refreshSources','acceptCurrentAccountLibrary','switchToLocalMode','fetchStudyData','exportAccountCache','clearAccountCache','runSettingsRecovery','handleExportRecovery','handleClearCacheConfirmed','signOut','requestClearCache','dismissSettingsModal'].includes(name))return dashboardFunction(name,bindings);
  return compile(find(node=>ts.isFunctionDeclaration(node)&&node.name?.getText(source)===name),bindings);
}
export function dashboardIife(needle,bindings){
  const call=find(node=>ts.isCallExpression(node)&&ts.isParenthesizedExpression(node.expression)&&ts.isArrowFunction(node.expression.expression)&&node.expression.expression.body.getText(source).includes(needle));
  return compile(call.expression.expression,bindings);
}
export function dashboardEffect(needle,bindings){
  const call=find(node=>ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes(needle));
  return compile(call.arguments[0],bindings);
}
export function dashboardModuleKey(bindings){
  const element=find(node=>inSubjectSession(node)&&ts.isJsxSelfClosingElement(node)&&node.tagName.getText(source)==='NonWordPluginHost');
  const attribute=element.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(source)==='key');
  return compile(attribute.initializer.expression,bindings);
}
export function dashboardClick(needle,bindings,occurrence=0){
  let matched=0;
  const button=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(source)==='button'&&node.getText(source).includes(needle)&&matched++===occurrence);
  const attribute=button.openingElement.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(source)==='onClick');
  if(attribute.initializer.expression.getText(source).includes('restartRound()')){
    const env={...bindings,nonWordScope:bindings.nonWordScope??undefined};
    const value=find(node=>inSubjectSession(node)&&ts.isVariableDeclaration(node)&&node.name.getText(source)==='itemKeys');
    env.itemKeys=bindings.itemKeys??compile(value.initializer,env);
    env.restartRound=rawFunction('restartRound',env);
    return compile(attribute.initializer.expression,env);
  }
  return compile(attribute.initializer.expression,bindings);
}
export function dashboardStudyModule(bindings){
  function rendersJsx(node){let found=false;const visit=child=>{if(ts.isJsxElement(child)||ts.isJsxSelfClosingElement(child)){found=true;return;}ts.forEachChild(child,visit);};visit(node);return found;}
  const call=find(node=>ts.isCallExpression(node)&&node.expression.getText(source)==='moduleNavigationSubjects.map'&&rendersJsx(node.arguments[0]));
  return compile(call.arguments[0],bindings);
}
