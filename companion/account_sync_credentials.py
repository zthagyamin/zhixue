"""Opt-in machine authorization, isolated from existing browser and AI secrets.

The injected provider has keyring's get/set/delete_password interface. Import
does not read credentials. Only a hash is returned to the paired browser.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from account_sync_schema import study_digest, study_hash, study_id, study_text

CREDENTIAL_SERVICE = 'Zhixue Companion Account Study'


def machine_token_hash(secret):
    if type(secret) is not str or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', secret):
        raise ValueError('invalid-machine-credential')
    return hashlib.sha256(secret.encode('ascii')).hexdigest()


def trusted_origin(value, allowed_origins):
    if type(value) is not str or value not in allowed_origins:
        raise ValueError('untrusted-account-origin')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment or parsed.port not in (None, 443)
            or value != f'https://{parsed.netloc}' or any(ord(c) <= 32 for c in value)):
        raise ValueError('untrusted-account-origin')
    return value


class LinkStore:
    def __init__(self, database_path, provider, *, allowed_origins):
        self.path = Path(database_path); self.path.parent.mkdir(parents=True, exist_ok=True)
        self.provider = provider; self.allowed_origins = tuple(allowed_origins)
        with self._connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS account_sync_links(
                owner_id TEXT NOT NULL,grant_id TEXT PRIMARY KEY,library_id TEXT NOT NULL,origin TEXT NOT NULL,
                label TEXT NOT NULL,token_hash TEXT NOT NULL,credential_ref TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL,metadata_hash TEXT NOT NULL)''')

    @contextmanager
    def _connect(self, write=False):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None); db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            db.commit()
        except BaseException:
            db.rollback(); raise
        finally:
            db.close()

    def _keyring(self, operation, *args):
        try:
            return getattr(self.provider, operation)(CREDENTIAL_SERVICE, *args)
        except Exception:
            # Provider exceptions may include sensitive Windows/keyring details.
            raise ValueError('account-credential-unavailable') from None

    def _checked(self, row):
        if not row:
            raise ValueError('unknown-account-link')
        value = dict(row)
        study_digest(value['owner_id']); study_id(value['grant_id']); study_id(value['library_id'])
        trusted_origin(value['origin'], self.allowed_origins); study_text(value['label'], maximum=80)
        study_digest(value['token_hash'])
        expected_ref = 'machine:' + study_hash([value['owner_id'], value['library_id'], value['grant_id']])
        if (value['credential_ref'] != expected_ref or value['state'] not in ('prepared', 'active', 'paused', 'revoked')
                or value['metadata_hash'] != study_hash({key: child for key, child in value.items() if key not in ('metadata_hash', 'state')})):
            raise ValueError('account-link-integrity')
        return value

    @staticmethod
    def _registration(value):
        return {'grantId': value['grant_id'], 'libraryId': value['library_id'], 'tokenHash': value['token_hash'], 'label': value['label']}

    def prepare(self, owner_id, library_id, origin, label, *, grant_id=None):
        study_digest(owner_id); study_id(library_id); trusted_origin(origin, self.allowed_origins); study_text(label, maximum=80)
        grant_id = grant_id or str(uuid4()); study_id(grant_id)
        reference = 'machine:' + study_hash([owner_id, library_id, grant_id])
        # The DB serializes preparation for the same identity. Keyring access is
        # local and short; no outbound request occurs inside this transaction.
        with self._connect(write=True) as db:
            old = db.execute('SELECT * FROM account_sync_links WHERE grant_id=?', (grant_id,)).fetchone()
            if old:
                value = self._checked(old)
                if any(value[key] != expected for key, expected in (('owner_id', owner_id), ('library_id', library_id), ('origin', origin), ('label', label))):
                    raise ValueError('account-link-conflict')
                self._secret(value)
                return self._registration(value)
            if self._keyring('get_password', reference) is not None:
                raise ValueError('account-credential-slot-conflict')
            secret = secrets.token_urlsafe(32)
            value = {'owner_id': owner_id, 'grant_id': grant_id, 'library_id': library_id, 'origin': origin,
                     'label': label, 'token_hash': machine_token_hash(secret), 'credential_ref': reference, 'state': 'prepared'}
            value['metadata_hash'] = study_hash({key: child for key, child in value.items() if key != 'state'})
            try:
                self._keyring('set_password', reference, secret)
                if self._keyring('get_password', reference) != secret:
                    raise ValueError('account-credential-write-failed')
                db.execute('INSERT INTO account_sync_links VALUES(?,?,?,?,?,?,?,?,?)', tuple(value.values()))
                # Commit errors must enter the same cleanup as insert errors.
                db.commit()
            except BaseException:
                try:
                    if self._keyring('get_password', reference) == secret:
                        self._keyring('delete_password', reference)
                except ValueError:
                    pass  # Preserve uncertain provider state; never delete another slot.
                raise
            return self._registration(value)

    def _secret(self, value):
        secret = self._keyring('get_password', value['credential_ref'])
        if not hmac.compare_digest(machine_token_hash(secret), value['token_hash']):
            raise ValueError('account-credential-binding')
        return secret

    def secret(self, owner_id, grant_id):
        study_digest(owner_id); study_id(grant_id)
        with self._connect() as db:
            value = self._checked(db.execute('SELECT * FROM account_sync_links WHERE owner_id=? AND grant_id=?', (owner_id, grant_id)).fetchone())
        return self._secret(value)

    def list_links(self, owner_id):
        study_digest(owner_id)
        with self._connect() as db:
            values = [self._checked(row) for row in db.execute('SELECT * FROM account_sync_links WHERE owner_id=? ORDER BY rowid', (owner_id,))]
        return [{**self._registration(value), 'origin': value['origin'], 'state': value['state']} for value in values]

    def mark_state(self, owner_id, grant_id, state):
        study_digest(owner_id); study_id(grant_id)
        if state not in ('prepared', 'active', 'paused', 'revoked'):
            raise ValueError('invalid-account-link-state')
        with self._connect(write=True) as db:
            value = self._checked(db.execute('SELECT * FROM account_sync_links WHERE owner_id=? AND grant_id=?', (owner_id, grant_id)).fetchone())
            if value['state'] == 'revoked' and state != 'revoked':
                raise ValueError('revoked-account-link')
            db.execute('UPDATE account_sync_links SET state=? WHERE owner_id=? AND grant_id=?', (state, owner_id, grant_id))
