"""Read-only subject goals and referenced learning units through the fixed gateway."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import index_gateway as gateway
import source_area
from task_plan_schema import COMPLETION_RULES, valid_plan_day

GOAL_COLUMNS = ('goal_id', 'title', 'target_kind', 'target_count', 'unit_ids', 'start_on', 'due_on', 'priority', 'required', 'completion_basis')
UNIT_COLUMNS = ('unit_id', 'title', 'content_ref', 'state_ref', 'ability_id', 'order', 'prerequisites', 'action', 'completion_rule')
INACTIVE = {'draft', 'inactive', 'archived', 'retired', 'paused'}


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def _visible_text(text: str) -> str:
    # Recognize code before comments: literal <!-- / %% inside code is inert.
    visible, fence, comment = [], None, None
    index = 0
    while index < len(text):
        if comment:
            end = text.find(comment, index)
            if end < 0:
                break
            end += len(comment)
            visible.append('\n' * text[index:end].count('\n'))
            index, comment = end, None
            continue
        if index == 0 or text[index - 1] == '\n':
            end = text.find('\n', index)
            end = len(text) if end < 0 else end
            line = text[index:end]
            marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
            if fence:
                if marker and marker[1][0] == fence[0] and len(marker[1]) >= fence[1] and not line[marker.end():].strip():
                    fence = None
                visible.append('\n')
                index = end + 1
                continue
            if marker or line.startswith('    ') or line.startswith('\t'):
                if marker:
                    fence = (marker[1][0], len(marker[1]))
                visible.append('\n')
                index = end + 1
                continue
        if text.startswith('<!--', index) or text.startswith('%%', index):
            comment = '-->' if text.startswith('<!--', index) else '%%'
            index += 4 if comment == '-->' else 2
            continue
        if text[index] == '`' and (index == 0 or text[index - 1] != '\\'):
            end = index
            while end < len(text) and text[end] == '`':
                end += 1
            delimiter = text[index:end]
            boundary = re.search(r'\n(?:[ \t]*\n|#{1,6}\s|`{3,}|~{3,})', text[end:])
            limit = end + boundary.start() if boundary else len(text)
            close = re.search(r'(?<!`)' + re.escape(delimiter) + r'(?!`)', text[end:limit])
            if close:
                finish = end + close.end()
                span = text[index:finish]
                visible.append('\n' * span.count('\n') if '\n' in span else span)
                index = finish
                continue
            visible.append(delimiter)
            index = end
            continue
        visible.append(text[index])
        index += 1
    return ''.join(visible)


def _tables(text: str):
    """Use existing wikilink-aware cells, but separate tables and exclude examples."""
    headers, rows = [], []
    for line in [*_visible_text(text).splitlines(), '']:
        if not line.strip().startswith('|'):
            if headers:
                yield headers, rows
            headers, rows = [], []
            continue
        escaped_pipe = '\x00PIPE\x00'
        while escaped_pipe in line:
            escaped_pipe += '\x00'
        cells = [cell.replace(escaped_pipe, '|') for cell in source_area._split_cells(line.replace('\\|', escaped_pipe))]
        if all(re.fullmatch(r':?-+:?', cell.strip()) for cell in cells):
            continue
        if not headers:
            headers = [cell.strip().lower() for cell in cells]
        else:
            rows.append(cells)


def _number(raw: str, label: str, minimum=1, maximum=9007199254740991) -> int:
    if not re.fullmatch(r'\d+', str(raw)):
        raise ValueError(f'invalid-{label}')
    value = int(raw)
    if not minimum <= value <= maximum:
        raise ValueError(f'invalid-{label}')
    return value


def _id(subject_id: str, value: str, foreign=False) -> str:
    if ':' in value:
        owner, local = value.split(':', 1)
        if not foreign and owner != subject_id:
            raise ValueError('foreign-unit-identity')
    else:
        owner, local = subject_id, value
    if not re.fullmatch(r'[\w.-]+', owner) or not re.fullmatch(r'[\w.-]+', local):
        raise ValueError('invalid-planning-id')
    return f'{owner}:{local}'


def _ids(subject_id: str, value: str) -> list[str]:
    values = [_id(subject_id, item.strip(), True) for item in value.split(',') if item.strip()]
    if len(set(values)) != len(values):
        raise ValueError('duplicate-planning-reference')
    return values


def _active(meta: dict):
    if meta.get('status', '').lower() in INACTIVE or meta.get('quality_status', '').lower() in INACTIVE:
        raise ValueError('inactive-planning-reference')


def _formal_complete(rule: str, meta: dict, text: str, ability_id: str, scoped=False) -> bool:
    if not rule.startswith('formal-'):
        return False
    rules = {
        'formal-mastered': ({'learning-state', 'review'}, 'mastery', 'mastered'),
        'formal-done': ({'project', 'paper-note'}, 'status', 'done'),
        'formal-completed-reference': ({'course', 'course-home'}, 'status', 'completed-reference'),
    }
    kinds, field, value = rules[rule]
    if meta.get('type') not in kinds:
        raise ValueError('invalid-formal-state-type')
    states = [meta.get(field)] if not scoped and meta.get('ability_id') == ability_id else []
    for headers, rows in _tables(text):
        if 'ability_id' in headers:
            for cells in rows:
                if len(cells) == len(headers):
                    row = dict(zip(headers, cells))
                    if row['ability_id'] == ability_id:
                        states.append(row.get(field))
    inline_pairs = re.findall(r'^\s*(ability_id|mastery|status)::\s*(.*?)\s*$', _visible_text(text), flags=re.M)
    inline = dict(inline_pairs)
    if inline.get('ability_id') == ability_id:
        if len(inline_pairs) != len(inline):
            raise ValueError('ambiguous-formal-ability')
        states.append(inline.get(field))
    if not ability_id or len(states) != 1:
        raise ValueError('ambiguous-formal-ability')
    if states[0] is None:
        raise ValueError('missing-formal-ability-state')
    if meta.get(field) is not None and states[0] != meta[field]:
        raise ValueError('conflicting-formal-state')
    return states[0] == value


def _validate_dependencies(units: dict):
    incoming = {key: len(unit['prerequisites']) for key, unit in units.items()}
    children = {key: [] for key in units}
    for key, unit in units.items():
        for parent in unit['prerequisites']:
            if parent not in units:
                raise ValueError('unknown-unit-dependency')
            children[parent].append(key)
    ready = [key for key, count in incoming.items() if count == 0]
    visited = 0
    while ready:
        key = ready.pop()
        visited += 1
        for child in children[key]:
            incoming[child] -= 1
            if incoming[child] == 0:
                ready.append(child)
    if visited != len(units):
        raise ValueError('cyclic-unit-dependency')


def load_planning_catalog(vault_root: Path, gateway_catalog: dict) -> dict:
    vault = Path(vault_root).resolve()
    definitions = gateway_catalog.get('planningDefinitions', [])
    roots = [gateway._path(vault, d['contentRoot'], directory=True) for d in definitions]
    dependencies, used_refs = {}, set()
    documents = {}
    assistance_roots = gateway._assistance_roots(vault)
    result = {'schemaVersion': 1, 'sourceHash': '', 'subjects': [], 'practiceSources': [], 'diagnostics': [
        {'code': d.get('code', 'invalid-gateway'), 'message': d.get('message', 'Invalid gateway')}
        for d in gateway_catalog.get('diagnostics', [])]}

    def read(ref: str, own_root=None):
        relative, fragment_name = gateway._link(ref)
        path = gateway._path(vault, relative, must_exist=False)
        if gateway.is_assistance_source(path, assistance_roots):
            raise ValueError('generated-assistance-not-learning-material')
        if own_root is not None:
            allowed = path.is_relative_to(own_root)
        else:
            allowed = any(path.is_relative_to(root) for root in roots)
        if not allowed:
            raise ValueError('outside-registered-subjects')
        if path not in documents:
            documents[path] = (gateway._read(path), hashlib.sha256(path.read_bytes()).hexdigest())
        full, digest = documents[path]
        fragment = gateway._fragment(_visible_text(full), fragment_name)
        meta = gateway._meta(full)
        if meta.get('type') == 'zhixue-assistance-summary':
            raise ValueError('generated-assistance-not-learning-material')
        dependencies[gateway._relative(vault, path)] = digest
        used_refs.add(ref)
        _active(meta)
        return path, fragment, full, meta

    sources = {s['id']: s for s in gateway_catalog.get('subjects', [])}
    for definition in definitions:
        subject_id = definition['id']
        source = sources.get(subject_id, {'name': subject_id, 'items': []})
        subject = {'subjectId': subject_id, 'name': source['name'], 'priority': 3,
                   'planningStatus': 'none', 'words': [], 'units': [], 'goals': []}
        result['subjects'].append(subject)
        try:
            index = gateway._path(vault, definition['indexRef'])
            dependencies[definition['indexRef']] = hashlib.sha256(index.read_bytes()).hexdigest()
            meta = gateway._meta(gateway._read(index))
            language = meta.get('language') or ('en' if source.get('identity') == 'legacy' else '')
            subject['priority'] = _number(meta.get('planning_priority', '3'), 'planning-priority', 1, 5)
            root = gateway._path(vault, definition['contentRoot'], directory=True)
            for item in source['items']:
                key = item['abilityId'] if item.get('word') else f"practice:{item['itemId']}"
                binding = gateway_catalog.get('bindings', {}).get(key)
                if not binding:
                    continue
                _, _, _, item_meta = read(binding['contentRef'])
                _active(item_meta)
                if item.get('word'):
                    word = {'itemKey': key, 'subjectId': subject_id, 'word': item['word'],
                        'language': language, 'sourceHash': item['contentHash'],
                        'completionRule': 'three-stage' if source['pluginType'] == 'three-stage' else 'graded-practice'}
                    if source.get('identity') == 'legacy':
                        word['legacyKeys'] = sorted({f"word:{item['word'].strip()}", f"word:{item['word'].strip().lower()}"} - {key})
                    subject['words'].append(word)
                else:
                    result['practiceSources'].append({'itemKey': key, 'subjectId': subject_id,
                        'title': str(item.get('sourceLabel') or item.get('topic') or item.get('prompt') or item['itemId']),
                        'sourceHash': item['contentHash'], 'completionRule': 'graded-practice'})
                if not item.get('word') and not item.get('reviewOnly'):
                    subject['units'].append({'unitId': f'{subject_id}:item:{item["itemId"]}', 'subjectId': subject_id,
                        'title': str(item.get('sourceLabel') or item.get('topic') or item.get('prompt') or item['itemId']),
                        'planningLabel': item.get('planningLabel') or f'练习单元 {len(subject["units"]) + 1}',
                        'order': len(subject['units']), 'prerequisites': [], 'sourceHash': item['contentHash'],
                        'action': {'kind': 'practice', 'itemKeys': [key]}, 'completionRule': 'graded-practice', 'formalComplete': False})
            planning_ref = meta.get('planning_ref')
            if not planning_ref:
                continue
            subject['planningStatus'] = 'ready'
            _, fragment, _, planning_meta = read(planning_ref, root)
            if planning_meta.get('planning_schema_version') != '1':
                raise ValueError('unsupported-planning-version')
            units, goals = [], []
            for headers, rows in _tables(fragment):
                unit_like = 'unit_id' in headers or len(set(headers) & {'content_ref', 'completion_rule', 'prerequisites', 'action'}) >= 2
                goal_like = 'goal_id' in headers or len(set(headers) & {'target_kind', 'target_count', 'completion_basis', 'unit_ids'}) >= 2
                marker = 'unit_id' if unit_like else 'goal_id' if goal_like else None
                if marker is None:
                    continue
                expected = UNIT_COLUMNS if marker == 'unit_id' else GOAL_COLUMNS
                if len(set(headers)) != len(headers) or any(name not in headers for name in expected):
                    raise ValueError('invalid-planning-table-headers')
                for cells in rows:
                    if len(cells) != len(headers):
                        raise ValueError('invalid-planning-row-width')
                    row = dict(zip(headers, cells))
                    if marker == 'unit_id':
                        unit_id = _id(subject_id, row['unit_id'])
                        if any(u['unitId'] == unit_id for u in units):
                            raise ValueError('duplicate-unit-id')
                        path, content_fragment, _, content_meta = read(row['content_ref'])
                        rule = row['completion_rule']
                        if rule not in COMPLETION_RULES:
                            raise ValueError('unsupported-completion-rule')
                        formal = False
                        if row['state_ref']:
                            _, state_text, _, state_meta = read(row['state_ref'])
                            formal = _formal_complete(rule, state_meta, state_text, row['ability_id'], bool(gateway._link(row['state_ref'])[1]))
                        elif rule.startswith('formal-'):
                            raise ValueError('missing-formal-state')
                        if row['action'] == 'open-note':
                            if rule in ('three-stage', 'graded-practice'):
                                raise ValueError('incompatible-action-completion')
                            action = {'kind': 'open-note', 'contentRef': row['content_ref']}
                        elif row['action'] == 'practice':
                            relative = gateway._relative(vault, path)
                            _, wanted_fragment = gateway._link(row['content_ref'])
                            available = {key for key, b in gateway_catalog['bindings'].items()
                                         if b['subjectId'] == subject_id and b['documentPath'] == relative}
                            if wanted_fragment:
                                refs = [ref for ref in gateway_catalog['references'] if ref['subjectId'] == subject_id and gateway._link(ref['contentRef'])[0] == relative]
                                keys = sorted(key for key in available if gateway._link(gateway_catalog['bindings'][key]['contentRef'])[1] == wanted_fragment)
                                if not keys:
                                    covering = [ref for ref in refs if not gateway._link(ref['contentRef'])[1]]
                                    if not covering:
                                        raise ValueError('unmapped-practice-unit')
                                    fmt = covering[0].get('format') or content_meta.get('zhixue_format') or gateway.AUTO_TYPES.get(content_meta.get('type'))
                                    doc_id = content_meta.get('zhixue_id') or covering[0].get('id', '')
                                    parsed = gateway._table_items(content_fragment, fmt, source, doc_id)
                                    selected = {item['abilityId'] if item.get('word') else f"practice:{item['itemId']}" for item in parsed}
                                    keys = sorted(available & selected)
                            else:
                                keys = sorted(available)
                            if not keys:
                                raise ValueError('unmapped-practice-unit')
                            items = {item['abilityId'] if item.get('word') else f"practice:{item['itemId']}": item for item in source['items']}
                            modes = [source['pluginType'] if items[key].get('word') else items[key].get('pluginType', source['pluginType']) for key in keys]
                            if rule == 'self-report' or (rule == 'three-stage' and any(mode != 'three-stage' for mode in modes)) or (rule == 'graded-practice' and 'three-stage' in modes):
                                raise ValueError('incompatible-practice-completion')
                            action = {'kind': 'practice', 'itemKeys': sorted(keys)}
                        else:
                            raise ValueError('unsupported-unit-action')
                        unit = {'unitId': unit_id, 'subjectId': subject_id, 'title': row['title'], 'planningLabel': row['title'],
                                'order': _number(row['order'], 'unit-order', 0), 'prerequisites': _ids(subject_id, row['prerequisites']),
                                'action': action, 'completionRule': rule, 'formalComplete': formal,
                                'sourceHash': _digest({'row': row, 'content': dependencies[gateway._relative(vault, path)]})}
                        if row['state_ref']:
                            unit.update(stateRef=row['state_ref'], abilityId=row['ability_id'])
                        units.append(unit)
                    else:
                        goal_id = _id(subject_id, row['goal_id'])
                        if any(g['goalId'] == goal_id for g in goals):
                            raise ValueError('duplicate-goal-id')
                        if row['target_kind'] not in ('daily', 'weekly', 'deadline') or row['required'] not in ('true', 'false'):
                            raise ValueError('invalid-goal-mode')
                        if not valid_plan_day(row['start_on']) or (row['due_on'] and not valid_plan_day(row['due_on'])):
                            raise ValueError('invalid-goal-date')
                        if row['target_kind'] == 'deadline' and not row['due_on']:
                            raise ValueError('missing-goal-deadline')
                        if row['due_on'] and row['due_on'] < row['start_on']:
                            raise ValueError('invalid-goal-date-order')
                        if row['completion_basis'] not in ('practice-round', 'self-report', 'formal-state'):
                            raise ValueError('unsupported-goal-basis')
                        goal = {'goalId': goal_id, 'subjectId': subject_id, 'title': row['title'], 'kind': row['target_kind'],
                                'targetCount': _number(row['target_count'], 'goal-quantity'), 'unitIds': _ids(subject_id, row['unit_ids']),
                                'startOn': row['start_on'], 'priority': _number(row['priority'], 'goal-priority', 1, 5),
                                'required': row['required'] == 'true', 'completionBasis': row['completion_basis']}
                        if not goal['unitIds']:
                            raise ValueError('empty-goal-unit-set')
                        if row['due_on']:
                            goal['dueOn'] = row['due_on']
                        goals.append(goal)
            subject['units'] = sorted(units, key=lambda u: (u['order'], u['unitId'])) if units else subject['units']
            subject['goals'] = goals
        except (OSError, UnicodeError, ValueError) as error:
            subject.update(planningStatus='invalid', goals=[], units=[])
            result['diagnostics'].append({'code': getattr(error, 'code', str(error)), 'message': '学科目标或引用无效，请检查规划表与来源。', 'subjectId': subject_id})

    changed = True
    while changed:
        changed = False
        all_units = {u['unitId']: u for subject in result['subjects'] for u in subject['units']}
        for subject in result['subjects']:
            if subject['planningStatus'] == 'invalid':
                continue
            try:
                reachable = {}
                pending = [u['unitId'] for u in subject['units']] + [key for goal in subject['goals'] for key in goal['unitIds']]
                while pending:
                    unit_id = pending.pop()
                    if unit_id in reachable:
                        continue
                    if unit_id not in all_units:
                        raise ValueError('unknown-unit-dependency')
                    reachable[unit_id] = all_units[unit_id]
                    pending.extend(all_units[unit_id]['prerequisites'])
                _validate_dependencies(reachable)
                for goal in subject['goals']:
                    for unit_id in goal['unitIds']:
                        rule = all_units[unit_id]['completionRule']
                        basis = 'formal-state' if rule.startswith('formal-') else 'self-report' if rule == 'self-report' else 'practice-round'
                        if goal['completionBasis'] != basis:
                            raise ValueError('conflicting-completion-basis')
            except ValueError as error:
                changed = True
                subject.update(planningStatus='invalid', goals=[], units=[])
                result['diagnostics'].append({'code': str(error), 'message': '目标单位或前置依赖不能唯一对应。', 'subjectId': subject['subjectId']})
    result['sourceHash'] = _digest({'files': dependencies, 'references': sorted(used_refs), 'subjects': result['subjects'], 'practiceSources': result['practiceSources']})
    return result
