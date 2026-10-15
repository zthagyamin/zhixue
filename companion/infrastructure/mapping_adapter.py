"""Local mapping receipts; setup and confirmation share the existing source lock."""
from contextlib import closing
import hashlib
import json
import sqlite3
import time
import uuid
import vault_topology as topology
from application.mapping import MappingApplication, MappingPorts
from infrastructure.mapping_snapshot import snapshot

PREVIEW_TTL_SECONDS = 15 * 60


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS mapping_previews(preview_id TEXT PRIMARY KEY,owner TEXT NOT NULL,context_id TEXT NOT NULL,revision INTEGER NOT NULL,rules_hash TEXT NOT NULL,source_hash TEXT NOT NULL,created_at REAL NOT NULL,applied_revision INTEGER)')


def mapping_request(services, owner, payload=None, *, now=time.time):
    # Normal /v1/setup uses this same RLock; no switch can interleave metadata save
    # or derived registration. External filesystem edits remain snapshot-checked.
    with services.NOTE_SOURCE_LOCK:
        root = services.source_path('learning_vault_root')
        database = services.LOCAL_DATABASE_PATH.with_name('vault-mappings.db')

        def context(request_owner):
            if request_owner != services.installation_owner_hash():
                raise ValueError('mapping-owner-required')
            selected_root = services.source_path('learning_vault_root')
            if not selected_root.is_dir():
                raise ValueError('vault-root-unavailable')
            return _hash([str(selected_root.resolve()), request_owner, services.CONFIG.get('workspace_generation', 0)])

        def inspect(request_owner):
            return {**topology.load(database, root, request_owner), **topology.inspect(root)}

        def preview(request_owner, selected, rules):
            before = snapshot(root, rules)
            diagnostics = []; items = topology.extract(root, rules, diagnostics=diagnostics)
            if snapshot(root, rules) != before:
                raise ValueError('mapping-source-changed')
            revision = topology.load(database, root, request_owner)['revision']
            identity = uuid.uuid4().hex
            with closing(sqlite3.connect(database)) as db:
                _schema(db)
                db.execute('INSERT INTO mapping_previews VALUES(?,?,?,?,?,?,?,NULL)', (identity, request_owner, selected, revision, _hash(rules), before, now()))
                db.commit()
            return dict(previewId=identity, revision=revision, itemCount=len(items), items=items[:20], diagnostics=diagnostics)

        def confirm(request_owner, selected, identity, rules, revision):
            with closing(sqlite3.connect(database)) as db:
                _schema(db); db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT owner,context_id,revision,rules_hash,source_hash,created_at,applied_revision FROM mapping_previews WHERE preview_id=?', (identity,)).fetchone()
                if row is None:
                    raise ValueError('mapping-preview-required')
                if row[:4] != (request_owner, selected, revision, _hash(rules)):
                    raise ValueError('mapping-preview-mismatch')
                elapsed = now() - row[5]
                if elapsed < 0 or elapsed > PREVIEW_TTL_SECONDS:
                    raise ValueError('mapping-preview-expired')
                if snapshot(root, rules) != row[4]:
                    raise ValueError('mapping-source-changed')
                if context(request_owner) != selected:
                    raise ValueError('mapping-context-changed')
                if row[6] is None:
                    saved = topology.save_in_transaction(db, root, request_owner, rules, revision)
                    db.execute('UPDATE mapping_previews SET applied_revision=? WHERE preview_id=?', (saved['revision'], identity))
                else:
                    saved = topology.load(database, root, request_owner)
                    if saved['revision'] != row[6] or saved['rules'] != rules:
                        raise ValueError('stale-mapping')
                db.commit()
            # Receipt commits with mapping metadata. Files are not a SQL transaction:
            # a failed registration stays retryable and is never reported as success.
            catalog = services.effective_gateway(root, owner=request_owner, mapping_source_hash=row[4])
            return {**saved, 'diagnostics': catalog.get('mappingDiagnostics', [])}

        return MappingApplication(MappingPorts(context, inspect, topology.validate, preview, confirm)).request(owner, payload)
