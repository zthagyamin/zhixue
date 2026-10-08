import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Local preparation only: no remote push, reset, checkout or history rewriting.
export function prepareSnapshot(source,publisher,expectedParent){
  const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true}).trim();
  source=resolve(source);publisher=resolve(publisher);
  for(const cwd of [source,publisher])if(git(cwd,'status','--porcelain'))throw new Error('Working tree must be clean: '+cwd);
  const parent=git(publisher,'rev-parse','HEAD');
  if(!/^[a-f0-9]{40}$/.test(expectedParent)||parent!==expectedParent)throw new Error('Publisher parent changed; verify the live release mapping first.');
  const project=cwd=>JSON.parse(git(cwd,'show','HEAD:.openai/hosting.json')).project_id;
  if(!project(source)||project(source)!==project(publisher))throw new Error('Sites project mismatch');
  const sourceCommit=git(source,'rev-parse','HEAD');
  git(publisher,'fetch','--no-tags',source,sourceCommit);
  const tree=git(publisher,'rev-parse',sourceCommit+'^{tree}');
  let publicationCommit=parent;
  if(tree!==git(publisher,'rev-parse',parent+'^{tree}'))publicationCommit=git(publisher,'commit-tree',tree,'-p',parent,'-m',`Publish source ${sourceCommit}`);
  if(git(publisher,'rev-parse',publicationCommit+'^{tree}')!==tree)throw new Error('Snapshot tree mismatch');
  return {sourceCommit,publicationCommit,parent,tree,projectId:project(source)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [source,publisher,parent]=process.argv.slice(2);
  if(!source||!publisher||!parent)throw new Error('Usage: node scripts/prepare-sites-snapshot.mjs SOURCE PUBLISHER EXPECTED_PARENT');
  console.log(JSON.stringify(prepareSnapshot(source,publisher,parent),null,2));
}
