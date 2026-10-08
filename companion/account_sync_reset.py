"""Explicit reset helper: remove every account machine secret before DB deletion."""
from __future__ import annotations
import argparse
import sqlite3
from contextlib import closing
from pathlib import Path
from account_sync_credentials import CREDENTIAL_SERVICE

def clear_credentials(database_path,provider):
    path=Path(database_path)
    if not path.is_file():return 0
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=5)) as db:
        try:references=[row[0] for row in db.execute('SELECT credential_ref FROM account_sync_links')]
        except sqlite3.OperationalError as error:
            if 'no such table' in str(error).lower():return 0
            raise
    for reference in references:
        if provider.get_password(CREDENTIAL_SERVICE,reference) is not None:
            provider.delete_password(CREDENTIAL_SERVICE,reference)
        if provider.get_password(CREDENTIAL_SERVICE,reference) is not None:raise RuntimeError('account-credential-reset-failed')
    return len(references)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--database',required=True);args=parser.parse_args()
    import keyring
    clear_credentials(args.database,keyring)

if __name__=='__main__':main()
