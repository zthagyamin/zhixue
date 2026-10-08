import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareSnapshot} from '../scripts/prepare-sites-snapshot.mjs';
test('publication snapshot has exact source tree and only publisher parent; refuses dirty, stale and foreign sources',()=>{
  const root=mkdtempSync(join(tmpdir(),'zhixue-snapshot-test-'));
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  function repo(name,project){const cwd=join(root,name);mkdirSync(cwd);git(cwd,'init');git(cwd,'config','user.email','test@example.invalid');git(cwd,'config','user.name','Test');mkdirSync(join(cwd,'.openai'));writeFileSync(join(cwd,'.openai','hosting.json'),JSON.stringify({project_id:project}));writeFileSync(join(cwd,'page.txt'),name);git(cwd,'add','.');git(cwd,'commit','-m','initial');return cwd;}
  try{
    const source=repo('source','same'),publisher=repo('publisher','same'),foreign=repo('foreign','other'),parent=git(publisher,'rev-parse','HEAD');
    const snapshot=prepareSnapshot(source,publisher,parent);
    assert.equal(snapshot.tree,git(source,'rev-parse','HEAD^{tree}'));
    assert.equal(git(publisher,'rev-list','--parents','-n','1',snapshot.publicationCommit),snapshot.publicationCommit+' '+parent);
    assert.equal(git(publisher,'rev-parse','HEAD'),parent);
    assert.throws(()=>prepareSnapshot(source,publisher,'0'.repeat(40)),/parent changed/);
    assert.throws(()=>prepareSnapshot(foreign,publisher,parent),/project mismatch/);
    writeFileSync(join(source,'dirty.txt'),'do not overwrite');assert.throws(()=>prepareSnapshot(source,publisher,parent),/must be clean/);
    git(publisher,'merge','--ff-only',snapshot.publicationCommit);
    assert.equal(prepareSnapshot(publisher,publisher,snapshot.publicationCommit).publicationCommit,snapshot.publicationCommit);
  }finally{rmSync(root,{recursive:true,force:true});}
});
