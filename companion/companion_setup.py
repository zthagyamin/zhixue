"""Personal, recoverable setup. No Obsidian installation or developer paths required."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import stat
import uuid
from pathlib import Path

MARKER = 'zhixue-learning-workspace-v1'


def redirects_path(info):
    if stat.S_ISLNK(info.st_mode):return True
    if not getattr(info,'st_file_attributes',0)&0x400:return False
    # Cloud Files tags hydrate data at the same path; junctions and symlinks
    # redirect names. Unknown reparse types remain unsupported.
    return getattr(info,'st_reparse_tag',0)&0xFFFF0FFF != 0x9000001A


def checked_path(value, *, exists=True):
    if not isinstance(value,str) or not value.strip():raise ValueError('setup-path-required')
    path=Path(os.path.expandvars(os.path.expanduser(value.strip().strip('"')))).absolute()
    for part in [*reversed(path.parents),path]:
        if part.exists() or part.is_symlink():
            info=part.lstat()
            if redirects_path(info):raise ValueError('setup-linked-path')
    path=path.resolve()
    if exists and not path.is_dir():raise ValueError('setup-folder-unavailable')
    return path


def _create(path, raw):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb') as handle:handle.write(raw);handle.flush();os.fsync(handle.fileno())


def initialize(root):
    root=checked_path(str(root));local=root/'config.local.json'
    if local.exists():
        try:config=json.loads(local.read_text(encoding='utf-8-sig'))
        except (ValueError,OSError):raise ValueError('setup-existing-config-invalid') from None
        if not isinstance(config,dict):raise ValueError('setup-existing-config-invalid')
        ensure_instance(root)
        return {'mode':'existing','configured':bool(config.get('learning_vault_root'))}
    try:config=json.loads((root/'config.json').read_text(encoding='utf-8-sig'))
    except (ValueError,OSError):raise ValueError('setup-template-invalid') from None
    if not isinstance(config,dict) or type(config.get('port',43121)) is not int or not 1024<=config.get('port',43121)<=65535:raise ValueError('setup-template-invalid')
    workspace=checked_path(str(root/'data'/'learning-workspace'),exists=False)
    marker=workspace/'workspace.json'
    if workspace.exists():
        try:saved=json.loads(marker.read_text(encoding='utf-8-sig'))
        except (ValueError,OSError):raise ValueError('setup-workspace-collision') from None
        if saved.get('marker')!=MARKER:raise ValueError('setup-workspace-collision')
    else:
        workspace.mkdir(parents=True)
        _create(marker,(json.dumps({'marker':MARKER,'id':str(uuid.uuid4())})+'\n').encode())
    entry=workspace/'_System/Integrations/Study Loop/gateway/index.md'
    if not entry.exists():_create(entry,b'---\ntype: zhixue-gateway\nschema_version: 1\nenabled: true\n---\n# Zhixue learning workspace\n')
    (entry.parent/'subjects').mkdir(exist_ok=True)
    config.update(learning_vault_root=str(workspace),workspace_mode='managed',setup_version=1)
    _create(local,(json.dumps(config,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
    ensure_instance(root)
    return {'mode':'managed','configured':True}


def ensure_instance(root):
    path=Path(root)/'data'/'runtime-instance.json'
    if not path.exists():_create(path,(json.dumps({'instanceId':str(uuid.uuid4())})+'\n').encode())
    return str(uuid.UUID(json.loads(path.read_text(encoding='utf-8-sig'))['instanceId']))


def initial_port(root,port):
    root=Path(root)
    if type(port) is not int or not 1024<=port<=65535:raise ValueError('setup-invalid-port')
    if any((root/'data').glob('*.db')):raise ValueError('setup-port-requires-existing-profile-review')
    config,_=settings(root);config['port']=port
    temp=root/('.config-'+uuid.uuid4().hex+'.tmp')
    try:
        _create(temp,(json.dumps(config,ensure_ascii=False,indent=2)+'\n').encode());os.replace(temp,root/'config.local.json')
    finally:
        if temp.exists():temp.unlink()


def settings(root):
    root=Path(root)
    try:raw=(root/'config.local.json').read_bytes();config=json.loads(raw.decode('utf-8-sig'))
    except (OSError,ValueError):raise ValueError('setup-existing-config-invalid') from None
    return config,hashlib.sha256(raw).hexdigest()


def configure_workspace(root, value, *, has_history):
    if not isinstance(value,dict) or set(value)-{'expectedRevision','mode','path','confirmed'}:raise ValueError('setup-invalid-request')
    if value.get('confirmed') is not True:raise ValueError('setup-confirmation-required')
    root=Path(root);config,revision=settings(root)
    if revision!=value.get('expectedRevision'):raise ValueError('setup-stale')
    if value.get('mode')!='existing':raise ValueError('setup-invalid-mode')
    selected=checked_path(value.get('path'));current=config.get('learning_vault_root','')
    if current and selected==Path(current).resolve():return config
    if has_history():raise ValueError('setup-workspace-has-history')
    before=(root/'config.local.json').read_bytes()
    config.update(learning_vault_root=str(selected),workspace_mode='existing')
    backup=root/'data'/'setup-backups'/f'{revision}.json'
    if not backup.exists():_create(backup,before)
    if (root/'config.local.json').read_bytes()!=before:raise ValueError('setup-stale')
    temp=root/f'.config-{uuid.uuid4().hex}.tmp'
    try:
        _create(temp,(json.dumps(config,ensure_ascii=False,indent=2)+'\n').encode())
        if (root/'config.local.json').read_bytes()!=before:raise ValueError('setup-stale')
        os.replace(temp,root/'config.local.json')
    finally:
        if temp.exists():temp.unlink()
    return config


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--initial-port',type=int);args=parser.parse_args()
    result=initialize(Path(args.root))
    if args.initial_port is not None:initial_port(Path(args.root),args.initial_port)
    print(json.dumps(result,ensure_ascii=False))
