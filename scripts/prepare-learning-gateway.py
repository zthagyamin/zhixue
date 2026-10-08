"""Prepare a local migration preview; NEVER mutate the source learning vault."""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import gateway_cli
import index_gateway


def prepare(vault: Path, staging: Path, config: dict) -> dict:
    vault=vault.resolve(strict=True)
    staging=staging.resolve()
    if staging.exists() or staging.is_relative_to(vault) or vault.is_relative_to(staging):
        raise ValueError('Staging must be a new, separate directory outside the real vault.')
    staging.mkdir(parents=True)
    originals={}
    def staged(relative):
        path=Path(relative)
        if path.is_absolute() or path.drive or '..' in path.parts:
            raise ValueError('Preview target must be a relative staging path.')
        target=(staging/path).resolve()
        if target==staging or not target.is_relative_to(staging):
            raise ValueError('Preview target escapes staging.')
        return target
    def copy(relative):
        source=index_gateway._path(vault,relative)
        data=source.read_bytes()
        originals[relative]=hashlib.sha256(data).hexdigest()
        target=staged(relative)
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,target)
    for subject in config['subjects']:
        source=index_gateway._path(vault,subject['root'],directory=True,must_exist=False)
        for path in source.rglob('*.md'):
            relative=path.relative_to(vault).as_posix()
            if not any(part.startswith('.') or part in {'_Archive','backups'} for part in path.relative_to(source).parts):
                copy(relative)
    for relative in config.get('include',[]):
        copy(relative)
    for move in config.get('moves',[]):
        copy(move['from'])
        target=staged(move['to'])
        target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():
            raise ValueError('Migration target already exists: '+move['to'])
        staged(move['from']).rename(target)
        # Old links remain valid as a non-learning redirect. No second active card/source.
        old=staged(move['from'])
        old.write_text('---\ntype: zhixue-migration-redirect\nstatus: inactive\n---\n# 已迁至学科目录\n\n[['+move['to']+'|打开原内容]]\n\n本页只保留旧链接兼容；正文、进度和后续内容在所属学科生长。\n',encoding='utf-8')
    for identified in config.get('identify_tables',[]):
        path=staged(identified['path'])
        text=path.read_text(encoding='utf-8-sig')
        heading='## '+identified['heading']
        if text.count(heading)!=1:
            raise ValueError('Missing unique table heading: '+heading)
        before, section=text.split(heading,1)
        lines=section.splitlines()
        table_row=0
        for index,line in enumerate(lines):
            if line.startswith('## '):
                break
            if not line.startswith('|'):
                continue
            prefix='ID' if table_row==0 else '---' if table_row==1 else 'question-'+hashlib.sha256(line.split('|',2)[1].strip().encode()).hexdigest()[:16]
            lines[index]='| '+prefix+' '+line
            table_row+=1
        path.write_text(before+heading+'\n'.join(lines)+'\n',encoding='utf-8')
    gateway_cli.init(staging)
    for subject in config['subjects']:
        gateway_cli.add_subject(staging,subject['id'],subject['name'],subject['domain'],subject['plugin'],subject['root'],subject.get('group_size',20))
        if subject.get('identity')=='legacy':
            path=staging/index_gateway.GATEWAY_ROOT/'subjects'/f"{subject['id']}.md"
            path.write_text(path.read_text(encoding='utf-8').replace('identity: "scoped"','identity: "legacy"'),encoding='utf-8')
        if subject.get('refs'):
            path=staging/index_gateway.GATEWAY_ROOT/'subjects'/f"{subject['id']}.md"
            rows='\n| id | content_ref | format | state_ref |\n|---|---|---|---|\n'+''.join(f"| {ref['id']} | {ref['ref']} | {ref['format']} | {ref.get('state','')} |\n" for ref in subject['refs'])
            with path.open('a',encoding='utf-8') as handle:
                handle.write(rows)
    for edit in config.get('edits',[]):
        path=staged(edit['path'])
        if not path.exists():
            copy(edit['path'])
        text=path.read_text(encoding='utf-8-sig')
        if text.count(edit['old']) != 1:
            raise ValueError('Expected exactly one replacement in '+edit['path'])
        path.write_text(text.replace(edit['old'],edit['new']),encoding='utf-8')
    for relative,text in config.get('new_notes',{}).items():
        path=staged(relative)
        if path.exists():
            raise ValueError('New note already exists: '+relative)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(text,encoding='utf-8')
    catalog=index_gateway.load_gateway(staging,refresh=True)
    changes=[]
    for path in staging.rglob('*'):
        if not path.is_file():
            continue
        relative=path.relative_to(staging).as_posix()
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != originals.get(relative):
            changes.append({'path':relative,'before':originals.get(relative),'after':digest})
    manifest={'sourceVault':str(vault),'staging':str(staging),'sourceHashes':originals,'changes':changes,'moves':config.get('moves',[]),'subjects':[{'id':subject['id'],'items':len(subject['items'])} for subject in catalog['subjects']],'diagnostics':catalog['diagnostics'],'status':'preview-only'}
    return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault',required=True)
    parser.add_argument('--staging',required=True)
    parser.add_argument('--config',required=True)
    args=parser.parse_args()
    manifest=prepare(Path(args.vault),Path(args.staging),json.loads(Path(args.config).read_text(encoding='utf-8-sig')))
    target=Path(args.staging).parent/(Path(args.staging).name+'-manifest.json')
    target.write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({key:manifest[key] for key in ('subjects','diagnostics','status')},ensure_ascii=False,indent=2))
    print('Manifest:',target)
    raise SystemExit(2 if manifest['diagnostics'] else 0)
