"""Resolve original exercise content from registered files, never the display pool."""
from __future__ import annotations

import copy
from pathlib import Path

import index_gateway
from account_sync_export import source_fingerprint
from infrastructure.source_protocol_hash import fingerprint

# Routing, display labels, queue dates and client results are deliberately absent.
PRESENTATION_FIELDS = (
    'questionType', 'prompt', 'front', 'back', 'options', 'answer', 'explanation',
    'initialCode', 'testCode', 'referenceCode', 'solutionCode', 'language', 'learningSupport',
    'codeMaterial', 'variables', 'tolerance', 'reviewPoint',
)


def exercise_presentation(item):
    practice = item.get('practiceItem') or item
    result = {key: copy.deepcopy(practice[key]) for key in PRESENTATION_FIELDS
              if key in practice and practice[key] not in (None, '', [])}
    if 'questionType' not in result:
        mode = item.get('pluginType') or item.get('type') or item.get('kind')
        if mode in ('quiz', 'recall', 'calculation', 'code', 'flashcard'):
            result['questionType'] = mode
    if item.get('learningSupport') and 'learningSupport' not in result:
        result['learningSupport'] = copy.deepcopy(item['learningSupport'])
    return result


def original_key(item):
    if item.get('kind') == 'vocabulary' and item.get('word') and item.get('meaning'):
        return item.get('abilityId') or 'word:' + str(item['word'])
    identity = item.get('itemId') or item.get('id')
    return 'practice:' + str(identity) if identity else item.get('abilityId', '')


class RegisteredExerciseResolver:
    """Injected readers must reconstruct approved items from their actual source.

    legacy_loader returns (item, route, document refs) tuples. It must not merge
    STATE/cache into these tuples. A descriptor retains source bytes' versions
    independently from the old exercise's immutable logical identity.
    """
    def __init__(self, root, owner, catalog_loader, legacy_loader=lambda: []):
        self.root_reference = Path(root)
        self.root = self.root_reference.resolve()
        self.owner = owner
        self.catalog_loader, self.legacy_loader = catalog_loader, legacy_loader

    def _entries(self):
        if self.root_reference.resolve() != self.root:
            raise ValueError('source-admission-scope')
        catalog = self.catalog_loader(self.root, owner=self.owner, refresh=False)
        if catalog.get('diagnostics') or catalog.get('mappingDiagnostics'):
            raise ValueError('source-unverified')
        entries = []
        for subject in catalog.get('subjects', []):
            for item in subject.get('items', []):
                key = original_key(item)
                binding = index_gateway.lookup_binding(catalog, key)
                if not binding:
                    continue
                card = next((card for card in catalog.get('resultCards', [])
                             if card.get('itemId') == binding['itemId']), None)
                route = {'mode': 'indexed', 'binding': copy.deepcopy(binding),
                         'context': {name: binding[name] for name in ('sourceNote', 'stateRef', 'abilityId')},
                         'reviewCardPath': card['path'] if card else None,
                         'reviewEntryName': str((card.get('reviewPoints') or [''])[0]) if card else ''}
                refs = [binding['documentPath'], binding['sourceNote']]
                entry = catalog.get('entryRef') or (index_gateway.GATEWAY_ROOT / 'index.md').as_posix()
                refs.append(entry)
                refs.extend(definition['indexRef'] for definition in catalog.get('planningDefinitions', []))
                entries.append((item, route, refs))
        # Explicit coexistence includes only independently rebuilt legacy items.
        if not catalog.get('active') or catalog.get('legacyCoexistence'):
            entries.extend(self.legacy_loader())
        return entries

    def _find(self, key):
        matches = [(item, route, refs) for item, route, refs in self._entries()
                   if original_key(item) == key]
        if len(matches) != 1:
            return None
        return matches[0]

    def is_word(self, key):
        match = self._find(key)
        if not match:
            return False
        item = match[0]
        return item.get('kind') == 'vocabulary' and bool(item.get('word') and item.get('meaning'))

    def __call__(self, query):
        match = self._find(query.get('sourceItemKey') or query['itemKey'])
        if match is None and 'sourceItemKey' not in query:
            # A legacy generated ID is not authority. Only one independently
            # reconstructed complete question/reference can establish its source.
            presented = exercise_presentation(query['presentation'])
            candidates = [(item, route, refs) for item, route, refs in self._entries()
                          if item.get('kind') != 'vocabulary' and original_key(item)
                          and exercise_presentation(item) == presented]
            if len(candidates) == 1:
                match = candidates[0]
        if not match:
            return None
        item, route, refs = match
        if item.get('kind') == 'vocabulary':
            return None
        presented = exercise_presentation(query['presentation'])
        original = exercise_presentation(item)
        # Require the complete question/reference, not a prompt-only/ID match.
        if not original or presented != original:
            return None
        documents = {}
        for ref in dict.fromkeys(refs):
            if not ref:
                continue
            path = index_gateway._path(self.root, ref)
            raw = path.read_bytes()
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError('source-admission-size')
            documents[ref] = source_fingerprint(raw)
        descriptor = {'sourceKey': original_key(item),
                      'sourceHash': fingerprint({'presentation': original, 'route': route, 'documents': documents}),
                      'eventKind': 'python' if original.get('questionType') == 'code' else 'due',
                      'item': original, 'route': route}
        return descriptor
