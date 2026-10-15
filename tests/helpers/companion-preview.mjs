import {readFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

/** Copy only managed Python sources and public seed/version; never local config or databases. */
export async function copyCompanionPreviewSources(repo,companion){
  return copyCompanionPreviewPayload(path.join(repo,'companion'),companion);
}

/** A selected source/candidate payload is copied without its private config or records. */
export async function copyCompanionPreviewPayload(source,companion){
  const manifest=JSON.parse(await readFile(path.join(source,'program-files.json'),'utf8'));
  if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||manifest.files.some(name=>
    typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..')))
    throw Error('Invalid Companion program manifest');
  const names=manifest.files.filter(name=>name.endsWith('.py')||['version.json','data/seed.json'].includes(name));
  if(!names.includes('server.py')||!names.includes('version.json')||!names.includes('data/seed.json'))throw Error('Incomplete Companion preview sources');
  for(const name of names){
    const target=path.join(companion,name);
    await mkdir(path.dirname(target),{recursive:true});
    await copyFile(path.join(source,name),target);
  }
}

/** A proxy can advertise readiness only after its owned, copied child has bound its server. */
export async function startCompanionPreview(python,args,{cwd,env,readyText,timeout=15000,stdout=process.stdout,stderr=process.stderr}){
  const child=spawn(python,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let output='',errors='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>fail(Error('Companion preview startup timed out')),timeout);
    const cleanup=()=>{clearTimeout(timer);child.off('error',fail);child.off('exit',exited);child.stdout.off('data',ready);};
    const fail=error=>{cleanup();child.kill();reject(error);};
    const exited=(code,signal)=>fail(Error(`Companion preview exited before ready (${code??signal}): ${errors}`));
    const ready=chunk=>{
      output=(output+chunk).slice(-4096);
      if(output.includes(readyText)){cleanup();resolve();}
    };
    child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4096);stderr?.write(chunk);});
    child.stdout.on('data',chunk=>stdout?.write(chunk));
    child.stdout.on('data',ready);child.once('error',fail);child.once('exit',exited);
  });
  return child;
}

/** Return a detach function for intentional shutdown; unexpected child loss closes the proxy. */
export function watchCompanionPreview(child,proxy){
  if(!child)return()=>{};
  const exited=()=>{
    console.error('Companion preview stopped; closing its UI proxy.');
    proxy.closeAllConnections();proxy.close(()=>process.exit(1));
  };
  if(child.exitCode!==null||child.signalCode!==null)throw Error('Companion preview already stopped');
  child.once('exit',exited);
  return()=>child.off('exit',exited);
}
