"""Content-backed vocabulary exception with no client-selected writeback route.

Ports read independent approved items, the shipped seed, and the server's
normalized original cache. Cache material grants only lexical eligibility.
Provider IDs, current display modes and request labels never confer authority.
"""
from __future__ import annotations

import copy
from infrastructure.source_protocol_hash import fingerprint

WORD_KINDS = frozenset(('word', 'vocabulary'))
NONWORD_KINDS = frozenset(('practice', 'quiz', 'recall', 'calculation', 'code',
                           'flashcard', 'python', 'due'))
WORD_BODY_FIELDS = ('word', 'meaning', 'phonetic', 'context', 'example', 'source',
                    'level', 'distractors')


def _text(value):
    return type(value) is str and bool(value.strip()) and len(value) <= 4000


def _original_word(item):
    """Legacy kindless word+meaning agrees with the original-content boundary."""
    if type(item) is not dict or not _text(item.get('word')) or not _text(item.get('meaning')):
        return False
    kind = item.get('kind')
    if kind is not None and kind not in WORD_KINDS:
        return False
    # A specialized original exercise cannot acquire the word exception by
    # having an incidental word field. Presentation plugin overrides are ignored.
    if item.get('questionType') in NONWORD_KINDS:
        return False
    practice = item.get('practiceItem')
    if isinstance(practice, dict) and practice.get('questionType') in NONWORD_KINDS:
        return False
    support = item.get('learningSupport')
    if isinstance(support, dict) and support.get('type') in NONWORD_KINDS:
        return False
    if kind not in WORD_KINDS and any(item.get(field) for field in (
            'prompt', 'front', 'back', 'options', 'initialCode', 'testCode', 'solutionCode', 'codeMaterial')):
        return False
    return True


def _body(item):
    value = {key: copy.deepcopy(item[key]) for key in WORD_BODY_FIELDS if key in item}
    value['word'], value['meaning'] = item['word'].strip(), item['meaning'].strip()
    fingerprint(value)
    return value


def _identifier(value):
    return (type(value) is str and value == value.strip() and 0 < len(value) <= 200
            and not any(ord(character) < 32 or ord(character) == 127 for character in value))


def _payload_items(payload):
    if payload is None:
        return []
    if type(payload) is not dict:
        raise ValueError('word-source-payload')
    subjects = payload.get('subjects')
    if subjects:
        if type(subjects) is not list:
            raise ValueError('word-source-payload')
        values = []
        for subject in subjects:
            if type(subject) is not dict or type(subject.get('items')) is not list:
                raise ValueError('word-source-payload')
            for item in subject['items']:
                if type(item) is not dict:
                    raise ValueError('word-source-payload')
                values.append((subject, item))
        return values
    words = payload.get('words', [])
    if type(words) is not list or any(type(item) is not dict for item in words):
        raise ValueError('word-source-payload')
    return [({'id': 'ielts-vocabulary'}, item) for item in words]


def _positive_keys(item, subject, origin):
    word = item['word'].strip()
    aliases = {'word:' + word, 'word:' + word.lower()}
    if origin in ('seed', 'cache'):
        # StableStudyItemKey chooses the word before provider id. A normalized
        # cache is not allowed to restore stripped binding/account identifiers.
        return 'word:' + word, aliases
    primary = item.get('abilityId')
    if not _identifier(primary):
        primary = 'word:' + word
    legacy = (item.get('allowLegacyAliases') is not False and
              (origin == 'approved' or subject.get('identity') == 'legacy'))
    return primary, {primary, *(aliases if legacy else ())}


def _negative_keys(item):
    """Collision evidence is a veto, never nonword source or routing authority."""
    keys = set()
    for field in ('abilityId', 'itemId', 'id', 'itemKey', 'accountItemKey'):
        value = item.get(field)
        if _identifier(value):
            keys.add(value)
            if field in ('itemId', 'id'):
                keys.add('practice:' + value.removeprefix('practice:'))
    if _text(item.get('word')):
        word = item['word'].strip()
        keys.update(('word:' + word, 'word:' + word.lower()))
    return keys


class WordSourceEligibility:
    def __init__(self, approved_loader=lambda: [], seed_loader=lambda: {},
                 cache_loader=lambda: {}):
        if not all(callable(port) for port in (approved_loader, seed_loader, cache_loader)):
            raise ValueError('word-source-port')
        self.approved_loader = approved_loader
        self.seed_loader = seed_loader
        self.cache_loader = cache_loader

    def _candidates(self, catalog):
        if type(catalog) is not dict:
            raise ValueError('word-source-catalog')
        candidates = []
        for subject, item in _payload_items(catalog):
            candidates.append(('catalog', subject, item))
        approved = self.approved_loader()
        if type(approved) is not list:
            raise ValueError('word-source-approved')
        for item in approved:
            if type(item) is not dict:
                raise ValueError('word-source-approved')
            candidates.append(('approved', {'id': item.get('subjectId', 'approved-source'),
                                             'identity': 'legacy'}, item))
        seeds = _payload_items(self.seed_loader())
        cache = _payload_items(self.cache_loader())
        candidates.extend(('seed', subject, item) for subject, item in seeds)
        # STATE starts as a copy of SEED. An exact original-content mirror is
        # the same source, not two independent authorities. Any changed material
        # or additional duplicate within either input remains a real candidate.
        mirrors = {(str(subject.get('id', '')), fingerprint(_body(item)))
                   for subject, item in seeds if _original_word(item)}
        skipped = set()
        for subject, item in cache:
            mirror = (str(subject.get('id', '')), fingerprint(_body(item))) if _original_word(item) else None
            if mirror in mirrors and mirror not in skipped:
                skipped.add(mirror)
                continue
            candidates.append(('cache', subject, item))
        return candidates

    def resolve(self, key, catalog):
        if not _identifier(key):
            return {'eligible': False, 'reason': 'word-source-unknown'}
        try:
            matches = []
            collision = False
            for origin, subject, item in self._candidates(catalog):
                if not _original_word(item):
                    collision = collision or key in _negative_keys(item)
                    continue
                primary, keys = _positive_keys(item, subject, origin)
                if key in keys:
                    body = _body(item)
                    identity = {'schemaVersion': 1, 'sourceKind': origin,
                                'subjectId': str(subject.get('id', '')),
                                'itemKey': primary, 'word': body['word'], 'meaning': body['meaning'],
                                'contentHash': fingerprint(body)}
                    matches.append(identity)
            if collision:
                return {'eligible': False, 'reason': 'word-source-collision'}
            if len(matches) != 1:
                return {'eligible': False, 'reason': 'word-source-ambiguous' if matches else 'word-source-unknown'}
            identity = matches[0]
            return {'eligible': True, 'identity': {**identity, 'identityHash': fingerprint(identity)}}
        except (ValueError, OSError, KeyError, TypeError):
            return {'eligible': False, 'reason': 'word-source-unavailable'}

    def original_word(self, key, catalog):
        """Key-only compatibility predicate; callers must also check event kind."""
        return self.resolve(key, catalog)['eligible']

    def admit(self, event, catalog):
        """Full-event port never gives a nonword event the vocabulary exemption."""
        item = event.get('item') if type(event) is dict else None
        if type(item) is not dict or item.get('kind') != 'word':
            return {'eligible': False, 'reason': 'word-event-kind-mismatch'}
        return self.resolve(item.get('key'), catalog)
