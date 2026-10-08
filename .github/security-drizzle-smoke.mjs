// Exercise the scoped esbuild override without connecting to any database.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
await mkdir('scratch',{recursive:true});
const root=await mkdtemp(resolve('scratch/security-drizzle-'));
try{
 const schema=join(root,'schema.ts'),out=join(root,'migrations');
 await writeFile(schema,"import {sqliteTable,text} from 'drizzle-orm/sqlite-core';export const audit=sqliteTable('audit_synthetic',{id:text('id').primaryKey()});\n");
 // The schema option is a glob; Windows backslashes would be interpreted as escapes.
 const result=spawnSync(process.execPath,['node_modules/drizzle-kit/bin.cjs','generate','--dialect=sqlite',`--schema=${schema.replaceAll('\\','/')}`,`--out=${out.replaceAll('\\','/')}`],{encoding:'utf8',timeout:30000});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const sql=(await readdir(out)).find(name=>name.endsWith('.sql'));assert.ok(sql,result.stdout+'\n'+result.stderr);
 assert.match(await readFile(join(out,sql),'utf8'),/CREATE TABLE `audit_synthetic`/);
 console.log('PASS: schema transpilation and SQL generation with scoped esbuild override; no database connection.');
}finally{await rm(root,{recursive:true,force:true});}
