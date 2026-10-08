"""Same-source, disposable account writeback preview. Never run an installed service."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'companion'))
sys.path.insert(0, str(REPO / 'tests'))
import test_account_sync_writer as writer_fixtures
import test_account_sync_credentials as credential_fixtures
from account_sync_credentials import LinkStore
from account_sync_worker import BackgroundSync, HttpTransport
from account_sync_export import capture_catalog, export_catalog
from account_sync_planning import export_planning
from assistance_inbox import AssistanceInbox
from assistance_writer import AssistanceVaultWriter
from assistance_sync import run_account

LOGICAL_ORIGIN = 'https://study.example.test'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs): return None


class LogicalResponse:
    def __init__(self, response, logical_url):
        self.response = response
        self.logical_url = logical_url
        self.headers = response.headers
        self.status = response.status
    def geturl(self): return self.logical_url
    def read(self, limit): return self.response.read(limit)
    def __enter__(self): return self
    def __exit__(self, *_args): self.response.close()


class LoopbackOpener:
    """Test injection only: preserve production action/size/role checks.

    The logical trusted HTTPS origin maps to this ONE local fixture. This does
    not test TLS, change trusted_origin(), or contact the logical hostname.
    """
    def __init__(self, origin, *, opener=None):
        value = urlsplit(origin)
        if value.scheme != 'http' or value.hostname != '127.0.0.1' or not 3004 <= (value.port or 0) <= 3099 or value.username or value.password or value.path or value.query or value.fragment:
            raise ValueError('fixture-loopback-origin-required')
        self.origin = origin
        self.opener = opener or build_opener(NoRedirect())

    def open(self, request, timeout):
        value = urlsplit(request.full_url)
        if value.scheme + '://' + value.netloc != LOGICAL_ORIGIN or value.path != '/api/account-study' or value.fragment:
            raise ValueError('fixture-logical-route-blocked')
        target = self.origin + value.path + ('?' + value.query if value.query else '')
        actual = Request(target, data=request.data, method=request.get_method(), headers=dict(request.header_items()))
        response = self.opener.open(actual, timeout=timeout)
        if response.geturl() != target:
            response.close()
            raise ValueError('fixture-redirect-blocked')
        return LogicalResponse(response, request.full_url)


class WritebackPreview:
    def __init__(self, origin):
        self.f = writer_fixtures.AccountSyncWriterTests()
        self.f.setUp()
        self.data_root = Path(self.f.temp.name)
        self.aux_path = self.data_root / 'assistance-study.db'
        self.aux = AssistanceInbox(self.aux_path)
        self.aux_writer = AssistanceVaultWriter(self.f.vault, self.f.owner, self.aux_path)
        self.links = LinkStore(self.data_root / 'links.sqlite3', credential_fixtures.FakeKeyring(), allowed_origins=[LOGICAL_ORIGIN])
        self.registration = self.links.prepare(self.f.owner, 'library-a', LOGICAL_ORIGIN, 'Isolated writeback fixture', grant_id='isolated-writeback-grant')
        catalog, _ = capture_catalog(self.f.vault)
        cloud_catalog, materials, facts, routes = export_planning(self.f.vault, catalog, self.f.bundle)
        self.source_hash = hashlib.sha256(self.f.source.read_bytes()).hexdigest()
        self.sync = BackgroundSync(self.f.owner, self.registration['grantId'], self.links, self.f.inbox,
            HttpTransport([LOGICAL_ORIGIN], opener=LoopbackOpener(origin)), verify_owner=lambda user_id: user_id == self.f.owner,
            processor=self.f.writer.process,
            publisher=lambda head: (self.f.bundle, self.f.bindings, cloud_catalog, materials, facts, routes) if head is None else None,
            assistance_sync=lambda call, pages: run_account(self.f.owner, 'library-a', self.aux, self.aux_writer, self.f.writer, call, pages))

    def inspect(self):
        rows = self.f.inbox.records_through(self.f.owner, 'library-a')
        paths = sorted(path for path in (self.f.vault / self.f.root / 'records').rglob('*') if path.is_file())
        summaries = []
        for path in paths:
            if '/assistance/' in path.as_posix() and path.suffix == '.json':
                record = json.loads(path.read_text(encoding='utf-8'))['record']
                summary = record['summary']
                summaries.append({key: summary[key] for key in ('summaryId', 'summaryHash', 'attemptEventId', 'attemptCoreHash')})
                summaries[-1]['associationHash'] = record['associationHash']
        catalog, identities = capture_catalog(self.f.vault)
        checked, _ = export_catalog(catalog, identities, 'library-a', 'inspection', 1, self.f.bundle['snapshot']['generatedAt'])
        return {'core': [{'eventId': row['record']['event']['eventId'], 'coreHash': row['record']['event']['coreHash'], 'status': row['status']} for row in rows],
                'summaries': summaries,
                'files': [{'path': path.relative_to(self.f.vault).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths],
                'pendingCoreReceipts': len(self.f.inbox.pending_receipts(self.f.owner, 'library-a')),
                'pendingSummaryReceipts': len(self.aux.pending_receipts(self.f.owner, 'library-a')),
                'bankItems': len(checked['items']), 'sourceUnchanged': hashlib.sha256(self.f.source.read_bytes()).hexdigest() == self.source_hash}

    def close(self): self.f.doCleanups()


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    args = parser.parse_args()
    preview = WritebackPreview(args.origin)
    try:
        # Nonsecret preparation only; Node never forwards this to the browser.
        emit({'kind': 'prepared', 'owner': preview.f.owner, 'registration': preview.registration,
              'vaultRoot': str(preview.f.vault), 'dataRoot': str(preview.data_root)})
        for line in sys.stdin:
            command = json.loads(line)
            if command.get('action') == 'close': break
            try:
                if command.get('action') == 'activate':
                    preview.sync.activate()
                    result = preview.sync.run_once()
                    emit({'kind': 'ready', 'result': result, 'inspection': preview.inspect()})
                elif command.get('action') == 'tick':
                    result = preview.sync.run_once()
                    emit({'kind': 'tick', 'result': result, 'inspection': preview.inspect()})
                else:
                    raise ValueError('fixture-command-blocked')
            except Exception as error:
                emit({'kind': 'error', 'error': str(error)})
    finally:
        preview.close()


if __name__ == '__main__': main()
