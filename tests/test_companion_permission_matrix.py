"""Real loopback HTTP envelope checks against a temporary synthetic installation."""
import contextlib
import io
import sqlite3
import unittest
from unittest import mock

import test_pm_route_compatibility as route_fixtures

server = route_fixtures.server


class CompanionPermissionMatrixTests(unittest.TestCase):
    def setUp(self):
        self.harness = route_fixtures.RouteCompatibilityTests()
        self.harness.setUp()
        self.addCleanup(self.harness.tearDown)
        self.identity = mock.patch.object(server, 'runtime_instance_id', return_value='synthetic-public-instance')
        self.identity.start()
        self.addCleanup(self.identity.stop)
        self.private_get = sorted(server.http_routes.GET_ROUTES)
        self.private_post = sorted(set(server.http_routes.POST_ROUTES) | {
            '/v1/account-sync/prepare', '/v1/account-sync/start', '/v1/account-sync/stop'})
        self.assertEqual((len(self.private_get), len(self.private_post)), (18, 51))
        self.assertIn('/v1/nonword/source', self.private_post)

    def database_image(self, *, exclude_sessions=False):
        with contextlib.closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            names = [row[0] for row in database.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
            return {name: database.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall()
                    for name in names if not exclude_sessions or name != 'companion_sessions'}

    def vault_image(self):
        return {path.relative_to(self.harness.fixture.vault).as_posix(): path.read_bytes()
                for path in self.harness.fixture.vault.rglob('*.md')}

    def assert_private_rejected(self, status, *, session):
        with mock.patch.object(server.http_routes, 'dispatch', side_effect=AssertionError('business-must-not-dispatch')) as dispatch:
            for path in self.private_get:
                with self.subTest(method='GET', path=path):
                    self.assertEqual(self.harness.request('GET', path, session=session)[0], status)
            for path in self.private_post:
                with self.subTest(method='POST', path=path):
                    self.assertEqual(self.harness.request('POST', path, {}, session=session)[0], status)
        dispatch.assert_not_called()

    def test_all_private_entries_reject_anonymous_without_business_or_vault_change(self):
        before, vault = self.database_image(), self.vault_image()
        self.assert_private_rejected(401, session='')
        self.assertEqual(self.database_image(), before)
        self.assertEqual(self.vault_image(), vault)

    def test_all_post_entries_reject_wrong_origin_before_pairing_or_business_dispatch(self):
        before, vault = self.database_image(), self.vault_image()
        with mock.patch.object(server.http_routes, 'dispatch', side_effect=AssertionError('business-must-not-dispatch')) as dispatch, \
                mock.patch.object(server, 'pair_account', side_effect=AssertionError('pair-must-not-run')) as pair:
            for path in self.private_post + ['/v1/pair']:
                with self.subTest(path=path):
                    self.assertEqual(self.harness.request('POST', path, {}, origin='https://other-fixture.invalid')[0], 403)
        dispatch.assert_not_called()
        pair.assert_not_called()
        self.assertEqual(self.database_image(), before)
        self.assertEqual(self.vault_image(), vault)

    def test_expired_and_revoked_sessions_cannot_reenter_private_entries(self):
        before, vault = self.database_image(exclude_sessions=True), self.vault_image()
        with contextlib.closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            database.execute('UPDATE companion_sessions SET expires_at = ?', ('2000-01-01T00:00:00+00:00',))
            database.commit()
        self.assert_private_rejected(401, session=self.harness.session)
        with contextlib.closing(sqlite3.connect(server.LOCAL_DATABASE_PATH)) as database:
            self.assertEqual(database.execute('SELECT COUNT(*) FROM companion_sessions').fetchone()[0], 0)
        with contextlib.redirect_stdout(io.StringIO()):
            status, _, paired = self.harness.request('POST', '/v1/pair', {
                'code': server.PAIRING_CODE, 'userId': 'pm-synthetic-user'})
        self.assertEqual(status, 200)
        self.harness.session = paired['sessionToken']
        status, _, revoked = self.harness.request('POST', '/v1/session/revoke', {})
        self.assertEqual(status, 200)
        self.assertTrue(revoked['revoked'])
        self.assert_private_rejected(401, session=self.harness.session)
        self.assertEqual(self.database_image(exclude_sessions=True), before)
        self.assertEqual(self.vault_image(), vault)

    def test_public_health_and_single_owner_pairing_are_not_private_route_permissions(self):
        before, vault = self.database_image(), self.vault_image()
        status, _, health = self.harness.request('GET', '/v1/health', origin='https://other-fixture.invalid', session='')
        self.assertEqual(status, 200)
        self.assertTrue(health['pairingRequired'])
        self.assertNotIn('sessionToken', health)
        self.assertEqual(self.harness.request('POST', '/v1/pair', {
            'code': 'INVALID-SYNTHETIC-CODE', 'userId': 'pm-synthetic-user'}, session='')[0], 400)
        with contextlib.redirect_stdout(io.StringIO()):
            status, _, _ = self.harness.request('POST', '/v1/pair', {
                'code': server.PAIRING_CODE, 'userId': 'different-synthetic-owner'}, session='')
        self.assertEqual(status, 400)
        self.assertEqual(self.database_image(), before)
        self.assertEqual(self.vault_image(), vault)


if __name__ == '__main__':
    unittest.main()
