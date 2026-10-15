import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {NextRequest,NextResponse} from 'vinext/shims/server';

const root=fileURLToPath(new URL('../',import.meta.url));
const origin='http://localhost:3000';
function fixture() {
  const cache=new Map(),cookies=new Map(),cookieActions=[];
  function load(relative) {
    let file=path.resolve(root,relative);
    if(!existsSync(file)||statSync(file).isDirectory())file=existsSync(file+'.ts')?file+'.ts':path.join(file,'index.ts');
    if(cache.has(file))return cache.get(file);
    const exports={};cache.set(file,exports);
    const code=ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    new Function('require','exports',code)(specifier=>{
      if(specifier==='next/server')return {NextRequest,NextResponse};
      if(specifier==='next/headers')return {headers:async()=>new Headers(),cookies:async()=>({
        has:key=>cookies.has(key),set:(key,value)=>{cookies.set(key,value);cookieActions.push(['set',key,value]);},
        delete:key=>{cookies.delete(key);cookieActions.push(['delete',key]);},
      })};
      if(specifier==='next/navigation')return {redirect:location=>{throw Object.assign(new Error('redirect'),{location});}};
      if(specifier.startsWith('.'))return load(path.relative(root,path.resolve(path.dirname(file),specifier)));
      throw new Error('Unexpected dependency '+specifier);
    },exports);
    return exports;
  }
  return {load,cookies,cookieActions};
}
function mode(t,value) {
  const before=process.env.NODE_ENV;
  process.env.NODE_ENV=value;
  t.after(()=>{if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;});
}
const entries=[
  ['middleware sign-in','middleware.ts','middleware','/signin-with-chatgpt','/study',true],
  ['middleware sign-out','middleware.ts','middleware','/signout-with-chatgpt','/',false],
  ['route sign-in','app/signin-with-chatgpt/route.ts','GET','/signin-with-chatgpt','/study',true],
  ['route sign-out','app/signout-with-chatgpt/route.ts','GET','/signout-with-chatgpt','/',false],
];
const unsafe=[
  'https://outside.example/path','//outside.example/path','/\\outside.example/path',
  '/x/..//outside.example/path','/x/%2e%2e//outside.example/path',
  '/\t/outside.example/path','/\n/outside.example/path','/\r/outside.example/path',
  '/signin-with-chatgpt?return_to=/study','/signout-with-chatgpt','/callback',
  '/%73ignin-with-chatgpt','/signout-with-chatgpt/','/signin-with-chatgpt/child',
  '/callback//','/%63allback///',
];
for(const [name,file,method,pathname,fallback,signIn] of entries) {
  test(name+' refuses outside and recursive auth destinations',async t=>{
    mode(t,'development');const f=fixture(),handler=f.load(file)[method];
    for(const value of unsafe) {
      const request=new NextRequest(origin+pathname+'?'+new URLSearchParams({return_to:value}));
      const response=await handler(request),location=new URL(response.headers.get('Location'));
      assert.equal(location.origin,origin,value);assert.equal(location.pathname,'/',value);
    }
  });
  test(name+' preserves normal paths, query, fragment, defaults and cookie action',async t=>{
    mode(t,'development');const f=fixture(),handler=f.load(file)[method];
    for(const value of [undefined,'','/study','/study?pair=1&companionPort=43125#note-trial','/notes/%E4%B8%AD%E6%96%87?x=%2F#part']) {
      const query=value===undefined?'':'?'+new URLSearchParams({return_to:value});
      const response=await handler(new NextRequest(origin+pathname+query));
      const expected=value||fallback;
      assert.equal(response.headers.get('Location'),new URL(expected,origin).href);
      if(method==='middleware')assert.match(response.headers.get('set-cookie'),signIn?/local-dev-mock-auth=1/:/local-dev-mock-auth=;/);
      else assert.deepEqual(f.cookieActions.at(-1),signIn?['set','local-dev-mock-auth','1']:['delete','local-dev-mock-auth']);
    }
  });
  test(name+' retains its production behavior',async t=>{
    mode(t,'production');const f=fixture(),response=await f.load(file)[method](new NextRequest(origin+pathname+'?return_to=https%3A%2F%2Foutside.example'));
    assert.equal(response.headers.get('Location'),null);
    assert.equal(response.status,method==='GET'?404:200);
    assert.equal(f.cookieActions.length,0);
  });
}
test('authentication links return only safe reparsable destinations',t=>{
  mode(t,'production');const auth=fixture().load('app/chatgpt-auth.ts');
  for(const make of [auth.chatGPTSignInPath,auth.chatGPTSignOutPath])for(const value of unsafe) {
    const link=new URL(make(value),origin),destination=link.searchParams.get('return_to');
    assert.equal(destination,'/',value);
    assert.equal(new URL(destination,origin).origin,origin);
  }
});
test('development middleware keeps mock identity on ordinary same-origin pages',t=>{
  mode(t,'development');const f=fixture(),request=new NextRequest(origin+'/study',{headers:{cookie:'local-dev-mock-auth=1'}});
  const response=f.load('middleware.ts').middleware(request);
  assert.equal(response.headers.get('Location'),null);
  assert.equal(response.headers.get('x-middleware-request-oai-authenticated-user-id'),'local-dev-user-123');
});
