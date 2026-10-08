import {execFileSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw Error('No tracked public source files to inspect');
const required=['README.md','README.zh-CN.md','LICENSE','CONTRIBUTING.md','CONTRIBUTING.zh-CN.md','SECURITY.md','SUPPORT.md','CODE_OF_CONDUCT.md','THIRD_PARTY_NOTICES.md','docs/README.md'];
for(const language of ['en','zh-CN'])for(const page of ['getting-started.md','development.md','FAQ.md','privacy.md','roadmap.md'])required.push(`docs/${language}/${page}`);
const errors=[];
for(const file of required)if(!files.includes(file))errors.push(`Missing document: ${file}`);
const forbidden=/^(?:CODEX_RELAY_|DSH_RELAY_|docs\/(?:verification|superpowers|plans|implementation-notes)\/)|(?:^|\/)(?:config\.local\.json|\.env(?:\..+)?|[^/]+\.(?:exe|zip|db|db-wal|db-shm))$/;
for(const file of files){
 if(/(^|\/)\.env\.example$/.test(file)||file==='public/knowledge-starter-kit/structure.zip')continue;
 if(forbidden.test(file))errors.push(`Excluded publication content: ${file}`);
}
const hosting=JSON.parse(await readFile('.openai/hosting.json','utf8'));
if(hosting.project_id!==null)errors.push('Production Sites project binding must not be published');
const license=await readFile('LICENSE','utf8');
if(!license.includes('MIT License')||/\[year\]|<year>|\[fullname\]|<copyright holders>/.test(license))errors.push('Incomplete MIT license');
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(pkg.license!=='MIT'||pkg.repository!=='https://github.com/zthagyamin/zhixue')errors.push('Public package metadata differs');

let linkCount=0;
for(const file of files.filter(x=>x.endsWith('.md'))){
 const text=await readFile(file,'utf8');
 if(text.includes('github.com/zthagyamin/zhixue-study-loop')||/C:[/\\]+Users[/\\]+30972|appgprj_[a-zA-Z0-9]+/.test(text))errors.push(`Private operator reference: ${file}`);
 for(const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)){
  let target=match[1].trim().split(/\s+["']/)[0].replace(/^<|>$/g,'').split('#')[0];
  if(!target||/^(?:https?:|mailto:|data:|obsidian:)/.test(target))continue;
  linkCount++;
  try{target=decodeURIComponent(target);await stat(resolve(dirname(file),target));}
  catch{errors.push(`Broken local documentation link: ${file} -> ${target}`);}
 }
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log(JSON.stringify({trackedFiles:files.length,bilingualDocuments:required.length,localLinks:linkCount,publicBoundary:'passed'}));
