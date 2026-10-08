import hashlib
import hmac
import importlib.util
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import test_index_gateway as fixtures
from test_account_sync_credentials import FakeKeyring
from test_account_sync_worker import FakeCloud, ORIGIN
if importlib.util.find_spec('account_sync_service'):
    import account_sync_service as service
else:
    service = None


class AccountSyncServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(service, 'Companion account sync lifecycle must exist')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name); self.local_db = self.data / 'study-loop.db'
        self.salt = bytes(range(32)); self.user_id = 'cloud-user-a'
        self.owner = hmac.new(self.salt, self.user_id.encode(), hashlib.sha256).hexdigest()
        with closing(sqlite3.connect(self.local_db)) as db, db:
            db.execute('CREATE TABLE installation_owner(singleton INTEGER PRIMARY KEY,user_hash TEXT,created_at TEXT)')
            db.execute('CREATE TABLE installation_metadata(key TEXT PRIMARY KEY,value TEXT)')
            db.execute("INSERT INTO installation_metadata VALUES('user_hash_salt',?)", (self.salt.hex(),))
            db.execute("INSERT INTO installation_owner VALUES(1,?,'test')", (self.owner,))
        self.fixture = fixtures.IndexGatewayTests(); self.fixture.setUp(); self.addCleanup(self.fixture.tearDown)
        self.vault = self.fixture.vault; self.cloud = FakeCloud(); self.keyring = FakeKeyring()
        self.runtime = self.make_service(); self.addCleanup(self.runtime.shutdown)

    def make_service(self):
        return service.AccountSyncService(self.data, self.local_db, lambda: self.vault, [ORIGIN], self.keyring,
            transport=self.cloud, clock=lambda: datetime(2026, 9, 1, tzinfo=timezone.utc), interval_seconds=60)

    def prepare(self):
        prepared = self.runtime.prepare(self.owner, ORIGIN, 'Computer')
        self.cloud.info.update(grantId=prepared['grantId'], libraryId=prepared['libraryId'])
        return prepared

    def test_existing_owner_verification_is_readonly_and_missing_salt_never_created(self):
        before = self.local_db.read_bytes()
        self.assertTrue(service.verify_installation_owner(self.local_db, self.owner, self.user_id))
        self.assertFalse(service.verify_installation_owner(self.local_db, self.owner, 'other-user'))
        self.assertEqual(self.local_db.read_bytes(), before)
        with closing(sqlite3.connect(self.local_db)) as db, db:
            db.execute("DELETE FROM installation_metadata WHERE key='user_hash_salt'")
        self.assertFalse(service.verify_installation_owner(self.local_db, self.owner, self.user_id))
        with closing(sqlite3.connect(self.local_db)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM installation_metadata').fetchone()[0], 0)
        missing = self.data / 'missing.db'
        self.assertFalse(service.verify_installation_owner(missing, self.owner, self.user_id)); self.assertFalse(missing.exists())

    def test_prepare_is_scoped_inert_and_library_id_stable_for_same_vault(self):
        first = self.prepare(); retry = self.runtime.prepare(self.owner, ORIGIN, 'Computer')
        self.assertEqual(first, retry)
        second = self.runtime.prepare(self.owner, ORIGIN, 'Computer two')
        self.assertEqual(first['libraryId'], second['libraryId']); self.assertNotEqual(first['grantId'], second['grantId'])
        self.assertEqual(self.cloud.calls, [])
        self.assertNotIn(str(self.vault), str(first))
        with self.assertRaises(ValueError): self.runtime.prepare('b' * 64, ORIGIN, 'Wrong owner')

    def test_start_runs_without_browser_then_stop_persists_pause_across_restart(self):
        prepared = self.prepare(); self.runtime.start(self.owner, prepared['grantId'])
        handle = self.runtime.workers[prepared['grantId']]
        self.assertTrue(handle['firstTick'].wait(3))
        self.assertTrue(any(call[2] == 'records' for call in self.cloud.calls))
        stopped = self.runtime.stop(self.owner, prepared['grantId'])
        self.assertEqual(stopped['status'], 'stopped')
        self.runtime.shutdown()
        restarted = self.make_service(); self.addCleanup(restarted.shutdown)
        restarted.resume(); self.assertEqual(restarted.workers, {})
        self.assertEqual(restarted.status(self.owner)['links'][0]['state'], 'paused')

    def test_start_refuses_wrong_cloud_account_and_changed_local_vault(self):
        prepared = self.prepare(); self.cloud.info['userId'] = 'other-user'
        with self.assertRaises(ValueError): self.runtime.start(self.owner, prepared['grantId'])
        self.assertNotIn('activate-grant', [call[2] for call in self.cloud.calls])
        self.cloud.info['userId'] = self.user_id
        self.vault = self.data
        with self.assertRaises(ValueError): self.runtime.start(self.owner, prepared['grantId'])

    def test_stop_during_inflight_request_reports_stopping_until_thread_finishes(self):
        prepared = self.prepare(); entered, release = threading.Event(), threading.Event(); self.addCleanup(release.set)
        original = self.cloud.request
        def delayed(*args, **kwargs):
            if args[3] == 'records': entered.set(); release.wait(3)
            return original(*args, **kwargs)
        self.cloud.request = delayed
        self.runtime.start(self.owner, prepared['grantId']); self.assertTrue(entered.wait(3))
        result = self.runtime.stop(self.owner, prepared['grantId'], timeout=0)
        self.assertEqual(result['status'], 'stopping')
        release.set(); self.runtime.workers[prepared['grantId']]['thread'].join(3)
        self.assertEqual(self.runtime.status(self.owner)['links'][0]['workerStatus'], 'stopped')

    def test_explicit_stop_wins_even_if_activation_finishes_its_local_state_write_later(self):
        prepared = self.prepare(); entering, release = threading.Event(), threading.Event(); errors = []
        original = self.runtime.links.mark_state
        def delayed(owner, grant, state):
            if state == 'active': entering.set(); release.wait(3)
            return original(owner, grant, state)
        self.runtime.links.mark_state = delayed
        def start():
            try: self.runtime.start(self.owner, prepared['grantId'])
            except Exception as error: errors.append(type(error).__name__)
        starter = threading.Thread(target=start); starter.start(); self.assertTrue(entering.wait(3))
        self.runtime.stop(self.owner, prepared['grantId'], timeout=0)
        release.set(); starter.join(3)
        self.assertEqual(self.runtime.links.list_links(self.owner)[0]['state'], 'paused')
        self.runtime.shutdown(); restarted = self.make_service(); self.addCleanup(restarted.shutdown)
        restarted.resume(); self.assertEqual(restarted.workers, {})

    def test_late_older_start_cannot_stop_a_newer_active_grant(self):
        import copy
        from account_sync_worker import CloudFailure
        older = self.prepare(); older_secret = self.runtime.links.secret(self.owner, older['grantId'])
        newer = self.runtime.prepare(self.owner, ORIGIN, 'Second connection')
        self.cloud.info.update(grantId=newer['grantId'], libraryId=newer['libraryId'])
        entering, release = threading.Event(), threading.Event(); self.addCleanup(release.set); old_results = []
        original = self.cloud.request; delayed_once = False
        def delayed(*args, **kwargs):
            nonlocal delayed_once
            if args[2] == older_secret and args[3] == 'grant-info':
                if not delayed_once:
                    delayed_once = True; entering.set(); release.wait(3)
                    return {**copy.deepcopy(self.cloud.info), 'grantId': older['grantId'], 'state': 'active'}
                raise CloudFailure(401, 'authentication-required')
            return original(*args, **kwargs)
        self.cloud.request = delayed
        def start_old():
            try: old_results.append(self.runtime.start(self.owner, older['grantId']))
            except Exception: old_results.append({'status': 'cancelled'})
        thread = threading.Thread(target=start_old); thread.start(); self.assertTrue(entering.wait(3))
        self.runtime.start(self.owner, newer['grantId']); self.assertTrue(self.runtime.workers[newer['grantId']]['firstTick'].wait(3))
        release.set(); thread.join(3)
        self.assertEqual(next(link for link in self.runtime.links.list_links(self.owner) if link['grantId'] == newer['grantId'])['state'], 'active')
        self.assertTrue(self.runtime.workers[newer['grantId']]['thread'].is_alive())
        self.assertNotEqual(old_results[0]['status'], 'running')

    def test_private_route_change_publishes_a_new_snapshot_even_when_questions_match(self):
        root = self.fixture.subject('words', 'three-stage', 'legacy')
        self.fixture.write(root + '/words.md', '---\ntype: vocabulary-database\n---\n| word | meaning | example |\n|---|---|---|\n| Tree | 树 | A tree grows. |\n')
        prepared = self.prepare(); link = self.runtime.links.list_links(self.owner)[0]
        sync = self.runtime._worker(self.owner, link, threading.Event())
        first, bindings, first_catalog, first_materials, first_facts, first_routes = sync.publisher(None)
        self.runtime.inbox.start_publication(self.owner, first, bindings, 0, planning=(first_catalog, first_materials, first_facts,first_routes))
        index = self.vault / self.fixture.entry / 'subjects/words.md'
        index.write_text(index.read_text(encoding='utf-8').replace(root + '/records', root + '/new-records'), encoding='utf-8')
        second = sync.publisher(first['snapshot'])
        self.assertIsNotNone(second)
        self.assertEqual(second[0]['items'], first['items'])
        self.assertEqual(second[0]['snapshot']['revision'], 2)
        self.assertNotEqual(second[1], bindings)


if __name__ == '__main__': unittest.main()
