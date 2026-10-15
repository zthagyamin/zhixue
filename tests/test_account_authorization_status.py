"""Verified in-memory grant status and safe recovery errors; no real cloud calls."""
import copy
import sqlite3
import threading
import unittest
from contextlib import closing
from datetime import datetime, timezone
from unittest import mock

import test_account_sync_service as service_fixtures
import test_account_sync_worker as worker_fixtures
import account_sync_local_api
import account_sync_worker as worker

ORIGIN = worker_fixtures.ORIGIN
CHECKED = '2026-09-01T00:00:00.000Z'
EXPIRY = '2026-10-01T00:00:00.000Z'


class WorkerAuthorizationStatusTests(unittest.TestCase):
    def setUp(self):
        self.h = worker_fixtures.AccountSyncWorkerTests()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)

    def test_only_verified_active_principal_records_authorization(self):
        self.assertIsNone(getattr(self.h.sync, 'authorization', None))
        original = self.h.cloud.request

        def activate(*args, **kwargs):
            if args[3] == 'activate-grant':
                self.assertIsNone(getattr(self.h.sync, 'authorization', None))
            return original(*args, **kwargs)

        self.h.cloud.request = activate
        self.h.sync.activate()
        self.assertEqual(self.h.sync.authorization, {'expiresAt': EXPIRY, 'checkedAt': CHECKED})
        old = copy.deepcopy(self.h.sync.authorization)
        for field, value in [('userId', 'other-user'), ('libraryId', 'other-library'),
                             ('grantId', 'other-grant'), ('kind', 'browser'),
                             ('expiresAt', 'malformed')]:
            with self.subTest(field=field):
                self.h.cloud.info[field], saved = value, self.h.cloud.info[field]
                with self.assertRaises(worker.AccountBindingFailure):
                    self.h.sync.activate()
                self.assertEqual(self.h.sync.authorization, old)
                self.h.cloud.info[field] = saved

    def test_principal_expired_after_owner_verification_is_never_recorded(self):
        now = [datetime(2026, 9, 1, tzinfo=timezone.utc)]
        self.h.sync.clock = lambda: now[0]

        def verify(_user):
            now[0] = datetime(2026, 10, 2, tzinfo=timezone.utc)
            return True

        self.h.sync.verify_owner = verify
        self.h.cloud.info['state'] = 'active'
        with self.assertRaisesRegex(ValueError, 'account-authorization-required'):
            self.h.sync.activate()
        self.assertIsNone(getattr(self.h.sync, 'authorization', None))

    def test_failure_categories_preserve_last_check_and_existing_queue(self):
        self.h.sync.activate()
        self.h.inbox.receive_page(self.h.owner, 'library-a', self.h.page((0,), through=1))
        before = self.h.inbox.pending_records(self.h.owner, 'library-a')
        old = copy.deepcopy(self.h.sync.authorization)
        cases = [(worker.CloudFailure(401, 'secret-remote-code'), 'paused', 'account-authorization-required'),
                 (worker.CloudFailure(403, 'secret-remote-code'), 'paused', 'account-authorization-required'),
                 (worker.CloudFailure(503, 'secret-remote-code'), 'retry', 'account-cloud-unavailable'),
                 (OSError('private network detail'), 'retry', 'account-cloud-unavailable'),
                 (worker.AccountBindingFailure('private binding'), 'paused', 'account-cloud-link-changed')]
        for failure, status, code in cases:
            with self.subTest(failure=type(failure).__name__, code=code):
                self.h.links.mark_state(self.h.owner, 'grant-one', 'active')
                with mock.patch.object(self.h.cloud, 'request', side_effect=failure):
                    result = self.h.sync.run_once()
                self.assertEqual(result, {'status': status, 'error': code})
                self.assertEqual(self.h.sync.authorization, old)
                self.assertEqual(self.h.inbox.pending_records(self.h.owner, 'library-a'), before)
        self.h.links.mark_state(self.h.owner, 'grant-one', 'active')
        self.h.cloud.info['expiresAt'] = '2026-08-31T00:00:00.000Z'
        self.assertEqual(self.h.sync.run_once(), {'status': 'paused', 'error': 'account-authorization-required'})
        self.assertEqual(self.h.sync.authorization, old)
        self.assertEqual(self.h.inbox.pending_records(self.h.owner, 'library-a'), before)
        self.h.cloud.info['expiresAt'] = EXPIRY
        for state in ('pending', 'revoked'):
            self.h.links.mark_state(self.h.owner, 'grant-one', 'active')
            self.h.cloud.info['state'] = state
            self.assertEqual(self.h.sync.run_once(), {'status': 'paused', 'error': 'account-authorization-required'})
            self.assertEqual(self.h.sync.authorization, old)
            self.assertEqual(self.h.inbox.pending_records(self.h.owner, 'library-a'), before)


class ServiceAuthorizationStatusTests(unittest.TestCase):
    def setUp(self):
        self.h = service_fixtures.AccountSyncServiceTests()
        self.h.setUp()
        self.addCleanup(self.h.doCleanups)
        self.prepared = self.h.prepare()

    def status_link(self, runtime=None, grant=None):
        return next(link for link in (runtime or self.h.runtime).status(self.h.owner)['links']
                    if link['grantId'] == (grant or self.prepared['grantId']))

    def start_and_wait(self):
        self.h.runtime.start(self.h.owner, self.prepared['grantId'])
        self.assertTrue(self.h.runtime.workers[self.prepared['grantId']]['firstTick'].wait(4))

    def test_status_is_readonly_and_stopped_metadata_is_history_restart_unknown(self):
        self.assertNotIn('authorization', self.status_link())
        self.assertEqual(self.h.cloud.calls, [])
        self.start_and_wait()
        expected = {'expiresAt': EXPIRY, 'checkedAt': CHECKED}
        self.assertEqual(self.status_link()['authorization'], expected)
        self.h.runtime.stop(self.h.owner, self.prepared['grantId'])
        before = self.h.runtime.path.read_bytes()
        calls = list(self.h.cloud.calls)
        status = self.status_link()
        self.assertEqual(status['workerStatus'], 'stopped')
        self.assertEqual(status['state'], 'paused')
        self.assertEqual(status['authorization'], expected)
        status['authorization']['expiresAt'] = 'tampered'
        self.assertEqual(self.status_link()['authorization'], expected)
        self.assertEqual(self.h.runtime.path.read_bytes(), before)
        self.assertEqual(self.h.cloud.calls, calls)
        restarted = self.h.make_service()
        self.addCleanup(restarted.shutdown)
        self.assertNotIn('authorization', self.status_link(restarted))
        self.assertEqual(self.h.cloud.calls, calls)
        with closing(sqlite3.connect(self.h.runtime.path)) as database:
            self.assertFalse(any('authorization' in str(row).lower() for row in
                database.execute("SELECT sql FROM sqlite_master WHERE type='table'")))

    def test_failed_start_has_no_authorization_metadata(self):
        self.h.cloud.info['userId'] = 'other-user'
        with self.assertRaises(worker.AccountBindingFailure):
            self.h.runtime.start(self.h.owner, self.prepared['grantId'])
        self.assertNotIn('authorization', self.status_link())

    def test_stop_during_late_activation_cannot_publish_metadata(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.h.cloud.request
        errors = []

        def delayed(*args, **kwargs):
            if args[3] == 'grant-info':
                entered.set()
                release.wait(4)
            return original(*args, **kwargs)

        def start():
            try:
                self.h.runtime.start(self.h.owner, self.prepared['grantId'])
            except (ValueError, worker.SyncStopped) as error:
                errors.append(type(error).__name__)

        self.h.cloud.request = delayed
        thread = threading.Thread(target=start)
        thread.start()
        self.assertTrue(entered.wait(3))
        self.assertNotIn('authorization', self.status_link())
        self.h.runtime.stop(self.h.owner, self.prepared['grantId'], timeout=0)
        release.set()
        thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors)
        self.assertNotIn('authorization', self.status_link())

    def test_old_generation_cannot_publish_expiry_into_newer_link(self):
        older = self.prepared
        secret = self.h.runtime.links.secret(self.h.owner, older['grantId'])
        newer = self.h.runtime.prepare(self.h.owner, ORIGIN, 'Newer connection')
        self.h.cloud.info.update(grantId=newer['grantId'], libraryId=newer['libraryId'],
                                expiresAt='2026-10-02T00:00:00.000Z')
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.h.cloud.request
        errors = []

        def delayed(*args, **kwargs):
            if args[2] == secret:
                entered.set()
                release.wait(4)
                return {**self.h.cloud.info, 'state': 'active', 'grantId': older['grantId'], 'expiresAt': EXPIRY}
            return original(*args, **kwargs)

        def start_old():
            try:
                self.h.runtime.start(self.h.owner, older['grantId'])
            except (ValueError, worker.SyncStopped) as error:
                errors.append(type(error).__name__)

        self.h.cloud.request = delayed
        thread = threading.Thread(target=start_old)
        thread.start()
        self.assertTrue(entered.wait(3))
        self.h.runtime.start(self.h.owner, newer['grantId'])
        self.assertTrue(self.h.runtime.workers[newer['grantId']]['firstTick'].wait(4))
        release.set()
        thread.join(4)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors)
        self.assertNotIn('authorization', self.status_link(grant=older['grantId']))
        self.assertEqual(self.status_link(grant=newer['grantId'])['authorization'],
                         {'expiresAt': '2026-10-02T00:00:00.000Z', 'checkedAt': CHECKED})

    def test_stop_during_running_check_keeps_only_prior_verified_expiry(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.h.cloud.request
        requests = []

        def delayed(*args, **kwargs):
            if args[3] == 'grant-info':
                requests.append(True)
                if len(requests) == 2:
                    entered.set()
                    release.wait(4)
                    return {**self.h.cloud.info, 'expiresAt': '2026-12-01T00:00:00.000Z'}
            return original(*args, **kwargs)

        self.h.cloud.request = delayed
        self.h.runtime.start(self.h.owner, self.prepared['grantId'])
        self.assertTrue(entered.wait(3))
        expected = {'expiresAt': EXPIRY, 'checkedAt': CHECKED}
        self.assertEqual(self.status_link()['authorization'], expected)
        self.h.runtime.stop(self.h.owner, self.prepared['grantId'], timeout=0)
        release.set()
        self.h.runtime.workers[self.prepared['grantId']]['thread'].join(4)
        status = self.status_link()
        self.assertEqual(status['workerStatus'], 'stopped')
        self.assertEqual(status['authorization'], expected)

    def test_transport_failure_is_cloud_error_but_status_poll_is_offline(self):
        with mock.patch.object(self.h.cloud, 'request', side_effect=OSError('private network detail')):
            status, body = account_sync_local_api.dispatch(self.h.runtime, 'POST', '/v1/account-sync/start',
                self.h.owner, ORIGIN, [ORIGIN], {'grantId': self.prepared['grantId']})
        self.assertEqual((status, body['error']), (503, 'account-cloud-unavailable'))
        self.assertNotIn('private', str(body))
        with mock.patch.object(self.h.cloud, 'request', side_effect=AssertionError('status-must-not-call-cloud')):
            self.assertNotIn('authorization', self.status_link())


class LocalAuthorizationErrorsTests(unittest.TestCase):
    def test_safe_errors_distinguish_authorization_binding_and_cloud_outage(self):
        for error, status, code in (
            (worker.CloudFailure(401, 'private-code'), 409, 'account-authorization-required'),
            (worker.CloudFailure(403, 'private-code'), 409, 'account-authorization-required'),
            (worker.AccountBindingFailure('private-code'), 409, 'account-cloud-link-changed'),
            (worker.CloudFailure(503, 'private-code'), 503, 'account-cloud-unavailable'),
            (worker.AccountNetworkFailure('private network'), 503, 'account-cloud-unavailable'),
            (OSError('private local file'), 503, 'account-sync-runtime-unavailable'),
            (sqlite3.OperationalError('private sqlite'), 503, 'account-sync-runtime-unavailable')):
            runtime = mock.NonCallableMock()
            runtime.start.side_effect = error
            with self.subTest(error=type(error).__name__, code=code):
                actual_status, body = account_sync_local_api.dispatch(runtime, 'POST', '/v1/account-sync/start',
                    'a' * 64, ORIGIN, [ORIGIN], {'grantId': 'grant-one'})
                self.assertEqual(actual_status, status)
                self.assertEqual(body['error'], code)
                self.assertNotIn('private', str(body))


if __name__ == '__main__':
    unittest.main()
