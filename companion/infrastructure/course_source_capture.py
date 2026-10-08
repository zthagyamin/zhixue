"""Immutable authenticated native course snapshots; source files stay read-only.

The native content signature is not a portable StudyItem hash. Public snapshots
carry that signature unchanged; SQLite alone retains original routing/documents.
The composition root supplies the owner-aware effective catalog loader and the
existing Companion data directory. Historical reads never load today's catalog.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

import index_gateway as gateway
from account_sync_export import source_fingerprint
from account_sync_schema import canonical_json, study_digest, study_hash, study_id, study_object
from assistance_binding import binding_hash
from course_study_domain import course_task_hash, resolve_course_task
from vault_identity import local_vault_library_id

IDENTITY_KEYS = ('schemaVersion', 'libraryId', 'itemKey', 'contentHash', 'localBindingHash')
PUBLIC_KEYS = ('schemaVersion', 'captureId', 'identity', 'item', 'taskHash')
SCHEMA = '''CREATE TABLE IF NOT EXISTS native_course_sources (
    owner TEXT NOT NULL, library_id TEXT NOT NULL, vault_root TEXT NOT NULL,
    capture_id TEXT NOT NULL, identity_hash TEXT NOT NULL,
    payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
    PRIMARY KEY (owner, library_id, vault_root, capture_id)
)'''


def _normalize(item, identity, subject):
    """Remove only known empty adapter placeholders; never invent a reference."""
    if item.get('word'):
        raise ValueError('course-task-word')
    practice = item.get('practiceItem') or item
    for source in (item, practice):
        for field in ('answer', 'explanation', 'reviewPoint', 'options'):
            if field in source:
                value = source[field]
                empty = value == '' if field != 'options' else value == []
                if not empty:
                    raise ValueError('duplicate-course-reference')
    mode = practice.get('questionType') or item.get('pluginType') or subject['pluginType']
    support = item.get('learningSupport', practice.get('learningSupport'))
    result = {'schemaVersion': 2, 'kind': 'practice', 'eventKind': 'due',
              'itemKey': identity['itemKey'], 'contentHash': identity['contentHash'],
              'learningSupport': copy.deepcopy(support),
              'practice': {'questionType': mode, 'prompt': practice.get('prompt'),
                           'domain': item.get('domain') or subject['domain']}}
    task = resolve_course_task(result)
    return result, course_task_hash(task)


class NativeCourseSources:
    def __init__(self, vault_root, owner, catalog_loader, store_path):
        # Authentication happens before construction. A request cannot select an
        # owner or a path, and this adapter never guesses an account/library ID.
        self.owner = study_digest(owner)
        self.root_reference = Path(vault_root)
        self.vault = self.root_reference.resolve()
        self.root = os.path.normcase(str(self.vault))
        self.library = local_vault_library_id(self.vault)
        if self.library is None or not callable(catalog_loader):
            raise ValueError('native-course-source-unavailable')
        self.catalog_loader = catalog_loader
        self.store_path = Path(store_path)

    def _identity(self, raw):
        identity = study_object(raw, IDENTITY_KEYS)
        if type(identity['schemaVersion']) is not int or identity['schemaVersion'] != 1:
            raise ValueError('unsupported-native-course-identity')
        if (os.path.normcase(str(self.root_reference.resolve())) != self.root
                or local_vault_library_id(self.vault) != self.library
                or identity['libraryId'] != self.library):
            raise ValueError('native-course-library-mismatch')
        study_id(identity['itemKey'], 'item-key')
        if not identity['itemKey'].startswith('practice:'):
            raise ValueError('unsupported-native-course-identity')
        for field in ('contentHash', 'localBindingHash'):
            study_digest(identity[field])
        return copy.deepcopy(identity)

    def _capture(self, identity):
        with gateway.LOCK:
            catalog = self.catalog_loader(self.vault, owner=self.owner, refresh=False)
            if (not catalog.get('active') or catalog.get('diagnostics')
                    or catalog.get('mappingDiagnostics')):
                raise ValueError('native-course-catalog-incomplete')
            binding = gateway.lookup_binding(catalog, identity['itemKey'])
            matches = [(subject, item) for subject in catalog.get('subjects', [])
                       for item in subject.get('items', [])
                       if 'practice:' + str(item.get('itemId')) == identity['itemKey']]
            if binding is None or len(matches) != 1:
                raise ValueError('native-course-source-not-found')
            subject, item = matches[0]
            if (binding.get('signature') != identity['contentHash']
                    or item.get('contentHash') != identity['contentHash']):
                raise ValueError('native-course-source-changed')
            paths, documents, digests = {}, {}, {}

            def read(ref):
                path = gateway._path(self.vault, ref)
                raw = path.read_bytes()
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError('native-course-source-too-large')
                digest = hashlib.sha256(raw).hexdigest()
                if ((ref in paths and paths[ref] != path)
                        or (path in digests and digests[path] != digest)):
                    raise ValueError('native-course-capture-conflict')
                paths[ref], digests[path] = path, digest
                documents[ref] = {'sha256': digest, 'text': raw.decode('utf-8')}
                return raw

            entry = catalog.get('entryRef') or (gateway.GATEWAY_ROOT / 'index.md').as_posix()
            if not gateway._boolean(gateway._meta(read(entry).decode('utf-8-sig')), 'enabled', True):
                raise ValueError('native-course-catalog-incomplete')
            for definition in catalog.get('planningDefinitions', []):
                read(definition['indexRef'])
            fingerprints = {}
            for ref in dict.fromkeys((binding['documentPath'], binding['sourceNote'])):
                fingerprints[ref] = source_fingerprint(read(ref))
            for ref in dict.fromkeys((binding['stateRef'], binding['progressRef'])):
                read(ref)
            actual_hash = binding_hash(self.vault, binding, fingerprints)
            if (actual_hash != identity['localBindingHash']
                    or item.get('localBindingHash', actual_hash) != actual_hash):
                raise ValueError('native-course-source-changed')
            normalized, task_hash = _normalize(item, identity, subject)
            again = self.catalog_loader(self.vault, owner=self.owner, refresh=False)
            if study_hash(catalog) != study_hash(again):
                raise ValueError('native-course-capture-conflict')
            for ref, path in paths.items():
                actual = gateway._path(self.vault, ref)
                if actual != path or hashlib.sha256(actual.read_bytes()).hexdigest() != digests[path]:
                    raise ValueError('native-course-capture-conflict')
            self._identity(identity)
            body = {'schemaVersion': 1, 'identity': identity, 'item': normalized, 'taskHash': task_hash}
            public = {**body, 'captureId': study_hash(body)}
            private = {'binding': copy.deepcopy(binding), 'sourceFingerprints': fingerprints,
                       'documents': documents}
            return {'public': public, 'private': private}

    def _key(self, identity, capture_id):
        study_digest(capture_id)
        return self.owner, identity['libraryId'], self.root, capture_id

    def _verified(self, row, identity, capture_id):
        try:
            identity_hash, raw, expected_hash = row
            payload = study_object(json.loads(raw), ('public', 'private'))
            public = study_object(payload['public'], PUBLIC_KEYS)
            private = study_object(payload['private'], ('binding', 'sourceFingerprints', 'documents'))
            binding, fingerprints = private['binding'], private['sourceFingerprints']
            # Verify frozen route/source integrity using saved bytes alone.
            # Missing cache entries must fail before binding_hash could read a
            # current file and accidentally make historical admission mutable.
            for ref in dict.fromkeys((binding['documentPath'], binding['sourceNote'])):
                document = private['documents'][ref]
                raw_source = document['text'].encode('utf-8')
                if (hashlib.sha256(raw_source).hexdigest() != document['sha256']
                        or source_fingerprint(raw_source) != fingerprints[ref]):
                    raise ValueError('native-course-capture-integrity')
            if (study_hash(payload) != expected_hash or identity_hash != study_hash(identity)
                    or public['identity'] != identity or public['captureId'] != capture_id
                    or type(public['schemaVersion']) is not int or public['schemaVersion'] != 1
                    or public['item']['contentHash'] != identity['contentHash']
                    or public['item']['itemKey'] != identity['itemKey']
                    or binding['signature'] != identity['contentHash']
                    or binding_hash(self.vault, binding, fingerprints) != identity['localBindingHash']
                    or study_hash({key: value for key, value in public.items() if key != 'captureId'}) != capture_id
                    or course_task_hash(resolve_course_task(public['item'])) != public['taskHash']):
                raise ValueError('native-course-capture-integrity')
            return payload
        except (ValueError, TypeError, KeyError) as error:
            raise ValueError('native-course-capture-integrity') from error

    def capture(self, identity):
        identity = self._identity(identity)
        payload = self._capture(identity)
        public = payload['public']
        key = self._key(identity, public['captureId'])
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.store_path, timeout=10)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            db.execute(SCHEMA)
            row = db.execute('''SELECT identity_hash, payload, payload_hash FROM native_course_sources
                                WHERE owner=? AND library_id=? AND vault_root=? AND capture_id=?''', key).fetchone()
            if row:
                existing = self._verified(row, identity, public['captureId'])
                if (study_hash(existing['public']) != study_hash(public)
                        or study_hash(existing['private']['binding']) != study_hash(payload['private']['binding'])
                        or existing['private']['sourceFingerprints'] != payload['private']['sourceFingerprints']):
                    raise ValueError('native-course-capture-conflict')
                # Machine-owned index/queue bytes can change without changing
                # native identity. Retain the original saved documents/receipt.
                public = existing['public']
            else:
                db.execute('INSERT INTO native_course_sources VALUES (?,?,?,?,?,?,?)',
                           (*key, study_hash(identity), canonical_json(payload), study_hash(payload)))
            # Return only after the transaction's receipt is durable. A failed
            # insert/commit cannot emit a public success or overwrite an old row.
            db.commit()
        return copy.deepcopy(public)

    def _read(self, identity, capture_id):
        identity = self._identity(identity)
        key = self._key(identity, capture_id)
        if not self.store_path.is_file():
            raise ValueError('native-course-capture-not-found')
        # URI read-only mode avoids creating/migrating storage during a read.
        uri = self.store_path.resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(uri, uri=True, timeout=10)) as db:
            try:
                row = db.execute('''SELECT identity_hash, payload, payload_hash FROM native_course_sources
                                    WHERE owner=? AND library_id=? AND vault_root=? AND capture_id=?''', key).fetchone()
            except sqlite3.OperationalError as error:
                raise ValueError('native-course-capture-not-found') from error
        if row is None or row[0] != study_hash(identity):
            raise ValueError('native-course-capture-not-found')
        return self._verified(row, identity, capture_id)

    def read(self, identity, capture_id):
        return copy.deepcopy(self._read(identity, capture_id)['public'])

    def verify_current(self, identity, capture_id):
        """Read-only source fence, safe inside an existing event transaction.

        This checks today's registered source against an already known capture.
        It neither inserts a snapshot nor returns an answer/grade receipt.
        """
        identity = self._identity(identity)
        study_digest(capture_id)
        public = self._capture(identity)['public']
        if public['captureId'] != capture_id:
            raise ValueError('native-course-source-changed')
        return copy.deepcopy(public)

    def read_binding(self, identity, capture_id):
        """Private routing port for trusted application code; never an HTTP body."""
        return copy.deepcopy(self._read(identity, capture_id)['private'])
