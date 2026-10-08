"""Data-only onboarding for the fixed learning-vault gateway."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import index_gateway as gateway


def _create(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as handle:
        handle.write(text)


def init(vault: Path) -> None:
    path = gateway._path(vault, (gateway.GATEWAY_ROOT / 'index.md').as_posix(), must_exist=False)
    if path.exists():
        fields = gateway._meta(gateway._read(path))
        if fields.get('type') != 'zhixue-gateway' or fields.get('schema_version') != str(gateway.SCHEMA_VERSION):
            raise ValueError('已有入口存在问题；未覆盖，请先 validate。')
        return
    _create(path, '---\ntype: zhixue-gateway\nschema_version: 1\nenabled: true\n---\n# 知学 · 学习知识库入口\n\n本目录仅保存索引与协议。学科索引位于 `subjects/`；内容、原始资料和进度属于各学科。\n\n新增学科登记一次；已登记目录中的合规内容自动收录，无需重新发布网站或 Companion。\n')


def add_subject(vault: Path, subject_id: str, name: str, domain: str, plugin: str, root: str, quota: int, language: str = '') -> None:
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', subject_id):
        raise ValueError('subject_id 必须为稳定 ASCII 标识。')
    if plugin not in gateway.PLUGINS or not 1 <= quota <= 500:
        raise ValueError('不支持的练习方式或组大小。')
    if not name.strip() or any(char in name + domain for char in '\r\n'):
        raise ValueError('学科名称和领域必须为单行文本。')
    if language and not re.fullmatch(r'[a-z]{2,3}(?:-[a-z0-9]{2,8})*', language):
        raise ValueError('language 必须为明确的小写语言代码，例如 en；不自动推断。')
    content = gateway._path(vault, root, directory=True, must_exist=False)
    index = gateway._path(vault, (gateway.GATEWAY_ROOT / 'subjects' / f'{subject_id}.md').as_posix(), must_exist=False)
    state = gateway._path(vault, (content.relative_to(vault) / '知学练习/学习状态.md').as_posix(), must_exist=False)
    if index.exists() or state.exists():
        raise ValueError('学科索引或练习状态已存在；未覆盖。请编辑已有索引。')
    init(vault)
    state_ref = state.relative_to(vault).as_posix()
    root_ref = content.relative_to(vault).as_posix()
    _create(state, f'---\ntype: zhixue-practice-state\nsubject_id: {subject_id}\n---\n# {name} · 知学练习证据\n\n[[{gateway.GATEWAY_ROOT.as_posix()}/subjects/{subject_id}|知学学科索引]]\n\n本页仅投影网站练习证据，不替代课程、论文或项目的正式掌握判断。\n')
    fields = {'type':'zhixue-subject-index','schema_version':1,'subject_id':subject_id,'name':name,'domain':domain or subject_id,'plugin':plugin,'content_root':root_ref,'progress_ref':f'[[{state_ref}]]','records_root':root_ref+'/知学练习/记录','identity':'scoped','group_size':quota,'enabled':True,'auto':True}
    if language:
        fields['language'] = language
    frontmatter = '\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}' for key,value in fields.items())
    _create(index, f'---\n{frontmatter}\n---\n# {name} · 知学索引\n\n[[{root_ref}/知学练习/学习状态|练习状态]] · [[{gateway.GATEWAY_ROOT.as_posix()}/index|总入口]]\n\n只在已登记目录收录 `zhixue: true` 内容及约定的词库、来源表、学习结果卡。原始资料通过双链引用，不复制到此页。\n')


def main(argv: list[str] | None = None) -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault',required=True)
    commands=parser.add_subparsers(dest='command',required=True)
    for command in ('init','refresh','validate'):
        commands.add_parser(command)
    add=commands.add_parser('add-subject')
    add.add_argument('--id',required=True)
    add.add_argument('--name',required=True)
    add.add_argument('--domain',default='')
    add.add_argument('--plugin',required=True,choices=sorted(gateway.PLUGINS))
    add.add_argument('--root',required=True)
    add.add_argument('--group-size',type=int,default=20)
    add.add_argument('--language',default='',help='Explicit language code, e.g. en; never inferred from spelling')
    args=parser.parse_args(argv)
    try:
        vault=Path(args.vault).resolve(strict=True)
        if not vault.is_dir():
            raise ValueError('Vault 必须是已有目录。')
        if args.command=='init':
            init(vault)
        elif args.command=='add-subject':
            add_subject(vault,args.id,args.name,args.domain,args.plugin,args.root,args.group_size,args.language)
        catalog=gateway.load_gateway(vault,refresh=args.command=='refresh')
        summary={'mode':catalog['mode'],'subjectCount':len(catalog['subjects']),'itemCount':sum(len(subject['items']) for subject in catalog['subjects']),'diagnostics':catalog['diagnostics']}
        print(json.dumps(summary,ensure_ascii=False,indent=2))
        return 0 if catalog['active'] and not catalog['diagnostics'] else 2
    except (OSError,ValueError) as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False))
        return 2


if __name__=='__main__':
    raise SystemExit(main())
