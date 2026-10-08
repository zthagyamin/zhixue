"""Full registered catalog export; only the portable whitelist leaves the device.

Source reads are explicit and read-only. Failed/incomplete reads raise instead
of publishing an empty/partial replacement. Persist the returned private map
with the bundle before starting the staged network upload.
"""
from __future__ import annotations

import copy
import hashlib
import math
import re
from pathlib import Path
import learning_result

from account_sync_schema import JS_WHITESPACE, seal_item, seal_snapshot, study_hash, validate_bundle
from learning_support import has_executable_code_material


def source_fingerprint(raw):
    """Version original Markdown while excluding known machine-owned views."""
    text = raw.decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')
    for label in ('LEARNING-EVIDENCE', 'ACCOUNT-LEARNING-EVIDENCE', 'REVIEW-QUEUE', 'GATEWAY-INDEX'):
        begin, end = f'%% ZHIXUE:{label}:BEGIN %%', f'%% ZHIXUE:{label}:END %%'
        if text.count(begin) != text.count(end) or text.count(begin) > 1:
            raise ValueError('ambiguous-source-managed-block')
        if begin in text:
            pattern = r'\n?^' + re.escape(begin) + r'\n.*?^' + re.escape(end) + r'(?:\n|$)'
            text, count = re.subn(pattern, '', text, flags=re.MULTILINE | re.DOTALL)
            if count != 1:
                raise ValueError('ambiguous-source-managed-block')
    frontmatter = re.match(r'^---\n(?P<yaml>.*?)\n---(?:\n|$)', text, flags=re.DOTALL)
    if frontmatter and learning_result._parse_frontmatter(text).get('type') == 'learning-result':
        # These are queue state, not the original question/reference material.
        yaml = re.sub(r'^(?:review_date|review_enabled):[^\n]*(?:\n|$)', '', frontmatter['yaml'], flags=re.MULTILINE).rstrip('\n')
        text = text[:frontmatter.start('yaml')] + yaml + text[frontmatter.end('yaml'):]
    return hashlib.sha256(text.strip('\n').encode('utf-8')).hexdigest()


def capture_catalog(vault_root, *, catalog_loader=None):
    """Read only registered indexes/sources twice to detect a torn capture."""
    import index_gateway as gateway
    import planning_catalog

    vault = Path(vault_root).resolve()
    with gateway.LOCK:
        documents, aliases, captured_bytes = {}, {}, {}

        def read(ref):
            path = gateway._path(vault, ref)
            raw = path.read_bytes()
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError('account-source-too-large')
            digest = hashlib.sha256(raw).hexdigest()
            if path in documents and documents[path] != digest:
                raise ValueError('account-capture-conflict')
            documents.setdefault(path, digest)
            captured_bytes.setdefault(path, raw)
            if ref in aliases and aliases[ref] != path:
                raise ValueError('account-capture-conflict')
            aliases[ref] = path
            return gateway._meta(raw.decode('utf-8-sig'))

        catalog = (catalog_loader or gateway.load_gateway)(vault, refresh=False)
        entry = catalog.get('entryRef') or (gateway.GATEWAY_ROOT / 'index.md').as_posix()
        top = read(entry)
        if not gateway._boolean(top, 'enabled', True):
            raise ValueError('account-gateway-disabled')
        if not catalog.get('active') or catalog.get('diagnostics'):
            raise ValueError('account-catalog-incomplete')
        identities = {}
        subjects = {subject['id']: subject for subject in catalog['subjects']}
        for definition in catalog['planningDefinitions']:
            meta = read(definition['indexRef'])
            subject = subjects[definition['id']]
            language = meta.get('language') or ('en' if subject.get('identity') == 'legacy' else '')
            for item in subject['items']:
                if item.get('word'):
                    identities[item['abilityId']] = {'language': language}
        content_refs = {binding['documentPath'] for binding in catalog['bindings'].values()}
        source_refs = {ref for binding in catalog['bindings'].values() for ref in (binding['documentPath'], binding['sourceNote'])}
        for ref in sorted(source_refs):
            meta = read(ref)
            if ref in content_refs:
                planning_catalog._active(meta)
        # A change between the first parse and raw capture cannot produce a
        # mixed snapshot with new paths and an old question or old language.
        again = (catalog_loader or gateway.load_gateway)(vault, refresh=False)
        if study_hash(catalog) != study_hash(again):
            raise ValueError('account-capture-conflict')
        for ref, path in aliases.items():
            actual = gateway._path(vault, ref)
            if actual != path or hashlib.sha256(actual.read_bytes()).hexdigest() != documents[path]:
                raise ValueError('account-capture-conflict')
        catalog['publicationEnabled'] = True
        catalog['sourceFingerprints'] = {ref: source_fingerprint(captured_bytes[aliases[ref]]) for ref in sorted(source_refs)}
        return catalog, identities


def _text(value):
    return type(value) is str and bool(value.strip(JS_WHITESPACE))


def _answer_text(value):
    if type(value) is str:
        return value
    if type(value) is int:
        return str(value)
    if type(value) is float and math.isfinite(value):
        # Source numeric values have already been parsed. Never parse a source
        # string as float: decimal text must preserve its original precision.
        return str(value)
    raise ValueError('invalid-source-answer')


def _portable(item, subject, identity, fingerprints):
    key = item['abilityId'] if item.get('word') else f"practice:{item['itemId']}"
    common = {'schemaVersion': 1, 'itemKey': key, 'subjectId': subject['id'],
              'sourceHash': study_hash({'item': item['contentHash'], 'sources': fingerprints})}
    if 'learningSupport' in item:
        common.update(schemaVersion=2,learningSupport=copy.deepcopy(item['learningSupport']))
    if item.get('word'):
        word = {key: item.get(key, '') for key in ('word', 'phonetic', 'meaning', 'context', 'example', 'source', 'level')}
        word['distractors'] = copy.deepcopy(item.get('distractors', []))
        recommended = item.get('pluginType') or subject['pluginType']
        if recommended not in ('three-stage', 'recall', 'flashcard', 'spelling'):
            # Match the first existing compatible desktop mode, not a new mode.
            recommended = 'three-stage' if _text(word['example']) else 'recall'
        rule = 'three-stage' if recommended == 'three-stage' and _text(word['example']) else 'graded-practice'
        return seal_item({**common, 'kind': 'word', 'eventKind': 'word', 'title': word['word'], 'language': identity.get('language', ''),
                          'recommendedPlugin': recommended, 'completionRule': rule, 'word': word})
    p = item.get('practiceItem') or item
    kind = p.get('questionType') or item.get('pluginType') or subject['pluginType']
    label = p.get('sourceLabel') or item.get('topic') or subject['name']
    practice = {'itemId': item['itemId'], 'abilityId': item['abilityId'], 'domain': item.get('domain') or subject['domain'],
                'questionType': kind, 'prompt': p.get('prompt') or p.get('front'), 'sourceLabel': label}
    for field in ('explanation', 'reviewPoint', 'initialCode', 'testCode', 'solutionCode'):
        if field in p:
            practice[field] = p[field]
    if kind == 'quiz' and item.get('learningSupport',{}).get('type')=='quiz':
        pass  # Versioned support is the sole option/answer source.
    elif kind == 'quiz':
        options, answer = p.get('options'), p.get('answer')
        if type(options) is not list:
            raise ValueError('invalid-source-quiz')
        if type(answer) is str and answer in options:
            answer = options.index(answer)
        elif not item.get('practiceItem') or type(answer) is not int:
            raise ValueError('invalid-source-quiz-answer')
        practice.update(options=copy.deepcopy(options), answer=answer)
    elif kind == 'flashcard':
        practice['answer'] = _answer_text(p.get('back', p.get('answer', '')))
    elif 'answer' in p:
        practice['answer'] = _answer_text(p['answer'])
    if kind == 'code' and not has_executable_code_material({**practice, **({'learningSupport': common['learningSupport']} if 'learningSupport' in common else {})}):
        # Existing code result cards without executable material already route
        # to recall on desktop. Preserve their actual reference, not fake tests.
        if not any(_text(practice.get(field)) for field in ('answer', 'explanation', 'reviewPoint')):
            raise ValueError('incomplete-code-source')
        practice['questionType'] = 'recall'
    return seal_item({**common, 'kind': 'practice', 'eventKind': 'due', 'title': label,
                      'completionRule': 'graded-practice', 'practice': practice})


def export_catalog(catalog, word_identities, library_id, snapshot_id, revision, generated_at, *, event_cursor=0, task_cursor=0):
    if not catalog.get('active') or catalog.get('publicationEnabled') is not True:
        raise ValueError('account-publication-disabled')
    if catalog.get('diagnostics'):
        raise ValueError('account-catalog-incomplete')
    items, bindings = [], {}
    cards = {card['itemId']: card for card in catalog.get('resultCards', [])}
    for subject in catalog['subjects']:
        for source in subject['items']:
            key = source['abilityId'] if source.get('word') else f"practice:{source['itemId']}"
            binding = catalog['bindings'].get(key)
            if not binding or binding['subjectId'] != subject['id'] or binding['signature'] != source['contentHash']:
                raise ValueError('account-source-binding-missing')
            if key in bindings:
                raise ValueError('duplicate-account-source-item')
            refs = {binding['documentPath'], binding['sourceNote']}
            fingerprints = {ref: catalog.get('sourceFingerprints', {}).get(ref) for ref in refs}
            if any(value is None for value in fingerprints.values()):
                raise ValueError('account-source-fingerprint-missing')
            item = _portable(source, subject, word_identities.get(key, {}), fingerprints)
            card = cards.get(source['itemId'])
            private = {'contentHash': item['contentHash'], 'binding': copy.deepcopy(binding),
                       'context': {'title': item['title'], 'activityType': 'account-study', 'durationMin': 0, 'weakPoints': [],
                                   'sourceNote': binding['sourceNote'], 'stateRef': binding['stateRef'], 'abilityId': binding['abilityId']}}
            private['binding']['sourceFingerprints'] = fingerprints
            if card:
                private['reviewCardPath'] = card['path']
                private['reviewEntryName'] = (card.get('reviewPoints') or [item['title']])[0]
            bindings[key] = private; items.append(item)
    members = [{'itemKey': item['itemKey'], 'contentHash': item['contentHash']} for item in items]
    snapshot = seal_snapshot({'schemaVersion': 1, 'libraryId': library_id, 'snapshotId': snapshot_id, 'revision': revision,
                              'generatedAt': generated_at, 'sourceHash': study_hash(members), 'eventCursor': event_cursor,
                              'taskCursor': task_cursor, 'items': members})
    return validate_bundle({'snapshot': snapshot, 'items': items}), bindings
