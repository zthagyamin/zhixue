import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {companionDownloads} from '../src/infrastructure/downloads/index.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);

export async function prepareCompanionRuntime(root){
 const manifest=JSON.parse(await readFile(resolve(root,'companion/runtime-manifest.json'),'utf8'));
 if(manifest.archive!=='runtime-windows-x64.zip'||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw Error('Invalid runtime manifest');
 const target=resolve(root,'companion',manifest.archive);
 try{if(createHash('sha256').update(await readFile(target)).digest('hex')===manifest.sha256)return {runtimeCached:true};}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const portable=resolve(root,'public/downloads',companionDownloads.downloads.portable.filename);
 if(!assetMatches(await readFile(portable),companionDownloads.downloads.portable))throw Error('Portable archive integrity failed');
 const temporary=target+'.'+randomUUID()+'.tmp';
 const script=`import hashlib,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n data=z.read('zhixue-companion/runtime-windows-x64.zip')\nif hashlib.sha256(data).hexdigest()!=sys.argv[3]: raise ValueError('runtime-hash-mismatch')\nwith open(sys.argv[2],'xb') as f: f.write(data)`;
 try{
  await execFileAsync(process.env.PYTHON||(process.platform==='win32'?'python':'python3'),['-X','utf8','-c',script,portable,temporary,manifest.sha256],{windowsHide:true});
  await rename(temporary,target);
 }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return {runtimeCached:false};
}

export function assetMatches(bytes,expected){
  return bytes.length===expected.sizeBytes && createHash('sha256').update(bytes).digest('hex')===expected.sha256;
}

/** Downloads fixed maintainer build inputs, never runs an installer or changes an installation. */
export async function prepareCompanionAssets(root,{fetcher=fetch}={}){
  const directory=resolve(root,'public/downloads');
  await mkdir(directory,{recursive:true});
  const results=[];
  for(const expected of Object.values(companionDownloads.downloads)){
    if(!['Zhixue-Companion-Setup.exe','zhixue-companion-windows.zip'].includes(expected.filename))throw Error('Unrecognized build asset');
    const url=new URL(expected.url);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Invalid fixed asset URL');
    const target=resolve(directory,expected.filename);
    try{if(assetMatches(await readFile(target),expected)){results.push({filename:expected.filename,cached:true});continue;}}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const response=await fetcher(expected.url,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error(`Build asset download failed (${response.status}): ${expected.filename}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!assetMatches(bytes,expected))throw Error(`Build asset hash/size mismatch: ${expected.filename}`);
    const temporary=target+'.'+randomUUID()+'.tmp';
    try{
      const {writeFile}=await import('node:fs/promises');
      await writeFile(temporary,bytes,{flag:'wx'});
      await rename(temporary,target);
    }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    results.push({filename:expected.filename,cached:false});
  }
  results.push(await prepareCompanionRuntime(root));
  return results;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await prepareCompanionAssets(fileURLToPath(new URL('..',import.meta.url)))));
}
