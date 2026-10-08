const [origin,expectedVersion]=process.argv.slice(2);
if(!origin||!/^\d+\.\d+\.\d+$/.test(expectedVersion??''))throw new Error('Usage: node scripts/smoke-public-release.mjs ORIGIN VERSION');
const base=new URL(origin);
if(base.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(base.hostname))throw new Error('Use HTTPS for public checks');
if(base.username||base.password||base.search||base.hash)throw new Error('Provide only the public origin');
const checks=[['/',200],['/help',200],['/updates',200],['/api/release',200]];
for(const [path,status]of checks){
  const response=await fetch(new URL(path,base),{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(30000)});
  if(response.status!==status)throw new Error(`${path}: expected ${status}, got ${response.status}`);
  if(path==='/api/release'){
    const body=await response.json();
    if(body.schemaVersion!==1||body.version!==expectedVersion)throw new Error('Live version mismatch');
    if(!response.headers.get('cache-control')?.includes('no-store'))throw new Error('Release metadata must not be cached');
  }else if(!(await response.text()).includes('知学'))throw new Error(`${path}: unexpected page`);
  console.log(`PASS ${path}`);
}
const study=await fetch(new URL('/study',base),{redirect:'manual',signal:AbortSignal.timeout(30000)});
if(![302,303,307,308].includes(study.status)||new URL(study.headers.get('location')??'',base).pathname!=='/')throw new Error('Anonymous study page did not return to homepage');
console.log('PASS anonymous study redirect; this does not verify authenticated learning or writeback.');
