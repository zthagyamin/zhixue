import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {companionEndpointFromSearch} from '../app/companion-endpoint.ts';
const source=await readFile(new URL('../app/study/page.tsx',import.meta.url),'utf8');
function load(user){
 const Dashboard=()=>null,exports={};
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const redirect=location=>{throw Object.assign(new Error('redirect'),{location});};
 new Function('require','exports',code)(name=>{
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props})};
  if(name==='../study-dashboard')return {default:Dashboard};
  if(name==='../chatgpt-auth')return {getChatGPTUser:async()=>user};
  if(name==='next/navigation')return {redirect};
  if(name==='../companion-endpoint')return {companionEndpointFromSearch};
  throw new Error('Unexpected module '+name);
 },exports);
 return {Dashboard,render:async query=>{let node=await exports.default({searchParams:Promise.resolve(query)});while(typeof node?.type==='function'&&node.type!==Dashboard)node=await node.type(node.props);return node;}};
}
test('anonymous direct study links return to the homepage before rendering the dashboard',async()=>{
 await assert.rejects(load(null).render({}),error=>error.location==='/');
});
test('anonymous Companion links preserve a validated port on the homepage',async()=>{
 await assert.rejects(load(null).render({pair:'1',companionPort:'43125'}),error=>error.location==='/?companionPort=43125');
 await assert.rejects(load(null).render({pair:'1'}),error=>error.location==='/?companionPort=43121');
 await assert.rejects(load(null).render({companionPort:'https://outside.example'}),error=>error.location==='/?companionPort=43121');
});
test('signed-in visitors continue to the learning workspace',async()=>{
 const page=load({userId:'test-owner',email:'test@example.invalid'});assert.equal((await page.render({})).type,page.Dashboard);
});