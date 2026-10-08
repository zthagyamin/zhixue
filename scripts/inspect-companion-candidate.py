"""Run inside a fresh -I Python process using only the selected payload modules."""
import argparse
import hashlib
import json
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def readonly(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        yield db
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--payload', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--vault')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    payload, data = Path(args.payload).resolve(), Path(args.data).resolve()
    sys.path.insert(0, str(payload))
    import account_sync_inbox
    import server
    assert Path(account_sync_inbox.__file__).resolve().parent == payload
    assert Path(server.__file__).resolve().parent == payload

    class ReadOnlyInbox(account_sync_inbox.Inbox):
        def __init__(self, path): self.path = Path(path)
        @contextmanager
        def _connect(self, write=False):
            assert not write
            with readonly(self.path) as db: yield db

    if args.resume:
        if not args.vault: raise ValueError('Resume requires the same explicit temporary Vault')
        from account_sync_writer import VerifiedVaultWriter
        from assistance_inbox import AssistanceInbox
        from assistance_writer import AssistanceVaultWriter
        from assistance_sync import process_pending
        inbox = account_sync_inbox.Inbox(data / 'account-study.db')
        core_writer = VerifiedVaultWriter(args.vault, args.owner, inbox, data / 'account-study.db')
        auxiliary = AssistanceInbox(data / 'assistance-study.db')
        writer = AssistanceVaultWriter(args.vault, args.owner, data / 'assistance-study.db')
        process_pending(args.owner, 'library-a', auxiliary, lambda row: writer.apply_account(row['record'], core_writer))

    inbox = ReadOnlyInbox(data / 'account-study.db')
    core = inbox.records_through(args.owner, 'library-a')
    manifest = [[row['record']['event']['eventId'], row['record']['event']['coreHash'], row['record']['envelopeHash'], row['status']] for row in core]
    integrity = {}
    for name in ('study-loop.db', 'account-study.db', 'assistance-study.db'):
        with readonly(data / name) as db:
            integrity[name] = db.execute('PRAGMA integrity_check').fetchone()[0]
            assert integrity[name] == 'ok'
    with readonly(data / 'study-loop.db') as db:
        native = [server.validate_study_event_v3(json.loads(row['event_json'])) for row in db.execute('SELECT event_json FROM study_events_v3 ORDER BY event_id')]
    with readonly(data / 'assistance-study.db') as db:
        jobs = [list(row) for row in db.execute('SELECT summary_id,association_hash,job_hash,complete FROM assistance_vault_jobs ORDER BY summary_id')]
        receipts = [list(row) for row in db.execute('SELECT receipt_id,receipt_hash,cloud_sequence FROM assistance_receipts ORDER BY sequence')]
    result = {'version': json.loads((payload / 'version.json').read_text(encoding='utf-8-sig'))['version'],
              'integrity': integrity, 'core': manifest, 'coreCount': len(manifest), 'cursor': inbox.cursor(args.owner, 'library-a'),
              'pendingCoreRecords': len(inbox.pending_records(args.owner, 'library-a')),
              'pendingCoreReceipts': len(inbox.pending_receipts(args.owner, 'library-a')),
              'native': [[event['eventId'], event['coreHash']] for event in native], 'jobs': jobs, 'receipts': receipts}
    result['coreManifestHash'] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__': main()
