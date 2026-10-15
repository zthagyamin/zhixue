"""Actual plan apply must not replace an editor's changed note."""
import tempfile
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import plan_area
import plan_authority
import test_plan_authority as fixture
import test_companion as companion_fixture


class PlanNoteConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Path(self.temp.name)
        self.area = plan_area.plan_area_root(self.vault)
        self.note = self.vault / plan_authority.PLAN_RELATIVE_PATH
        self.note.parent.mkdir(parents=True)

    def apply(self):
        return plan_area.apply_plan_revision(self.area, fixture.candidate(), 'synthetic-user',
                                            'synthetic-plan', expected_revision=0)

    def check_interleaving(self, initial, edit):
        if initial is not None:
            self.note.write_bytes(initial)
        write = Path.write_text

        def after_temporary_write(path, *args, **kwargs):
            result = write(path, *args, **kwargs)
            if path.name.startswith(f'.{self.note.name}.zhixue') and path.name.endswith('.tmp'):
                edit()
            return result

        with mock.patch.object(Path, 'write_text', after_temporary_write):
            with self.assertRaisesRegex(ValueError, 'stale-vault-edit'):
                self.apply()
        self.assertEqual(plan_area.read_revisions(self.area), [])
        self.assertEqual(list(self.note.parent.glob(f'.{self.note.name}.zhixue*.tmp')), [])

    def test_changed_existing_note_is_preserved_without_revision(self):
        edited = b'# Plan\r\n\r\nINDEPENDENT EDIT\r\n'
        self.check_interleaving(b'# Plan\r\n', lambda: self.note.write_bytes(edited))
        self.assertEqual(self.note.read_bytes(), edited)

    def test_newly_created_note_is_not_replaced_by_initial_plan(self):
        edited = b'# USER CREATED NOTE\n'
        self.check_interleaving(None, lambda: self.note.write_bytes(edited))
        self.assertEqual(self.note.read_bytes(), edited)

    def test_independently_removed_note_is_not_recreated(self):
        self.check_interleaving(b'# Plan\n', self.note.unlink)
        self.assertFalse(self.note.exists())

    def test_revision_failure_preserves_edit_after_completed_plan_write(self):
        self.note.write_bytes(b'# Original plan\n')
        observed = {}

        def fail_revision(*_, **__):
            observed['edited'] = self.note.read_bytes() + b'\nUSER EDIT AFTER PLAN WRITE\n'
            self.note.write_bytes(observed['edited'])
            raise OSError('synthetic revision failure')

        with mock.patch.object(plan_area, '_append_revision', side_effect=fail_revision):
            with self.assertRaisesRegex(OSError, 'synthetic revision failure'):
                self.apply()
        self.assertEqual(plan_area.read_revisions(self.area), [])
        self.assertEqual(self.note.read_bytes(), observed['edited'])

    def test_revision_failure_does_not_claim_edit_after_plan_writer_returns(self):
        self.note.write_bytes(b'# Original plan\n')
        original = plan_authority.apply_current_plan
        observed = {}

        def apply_then_edit(*args, **kwargs):
            result = original(*args, **kwargs)
            observed['edited'] = self.note.read_bytes() + b'\nUSER EDIT AFTER PLAN RECEIPT\n'
            self.note.write_bytes(observed['edited'])
            return result

        with mock.patch.object(plan_authority, 'apply_current_plan', side_effect=apply_then_edit), \
                mock.patch.object(plan_area, '_append_revision', side_effect=OSError('synthetic revision failure')):
            with self.assertRaisesRegex(OSError, 'synthetic revision failure'):
                self.apply()
        self.assertEqual(plan_area.read_revisions(self.area), [])
        self.assertEqual(self.note.read_bytes(), observed['edited'])

    def test_revision_failure_restores_the_actual_write_preimage(self):
        self.note.write_bytes(b'# Earlier reader snapshot\n')
        edited = b'# User edit before the actual write\n'
        original = plan_authority.apply_current_plan

        def edit_before_apply(*args, **kwargs):
            self.note.write_bytes(edited)
            return original(*args, **kwargs)

        with mock.patch.object(plan_authority, 'apply_current_plan', side_effect=edit_before_apply), \
                mock.patch.object(plan_area, '_append_revision', side_effect=OSError('synthetic revision failure')):
            with self.assertRaisesRegex(OSError, 'synthetic revision failure'):
                self.apply()
        self.assertEqual(self.note.read_bytes(), edited)
        self.assertEqual(plan_area.read_revisions(self.area), [])

    def test_actual_plan_http_reports_edit_conflict_with_note_preserved(self):
        server = companion_fixture.server
        harness = companion_fixture.CompanionSyncTests('test_state_projection_failure_rolls_back_event_and_vault_log')
        harness.setUp()
        self.addCleanup(harness.tearDown)
        note = harness.vault / plan_authority.PLAN_RELATIVE_PATH
        edited = note.read_bytes() + b'\nUSER EDIT DURING HTTP PLAN SAVE\n'
        origin = 'http://127.0.0.1:3080'
        server.CONFIG['allowed_origins'] = [origin]
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        def stop():
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=3)
        self.addCleanup(stop)
        base = f'http://127.0.0.1:{httpd.server_address[1]}'
        headers = {'Origin': origin, 'Content-Type': 'application/json'}
        request = urllib.request.Request(base + '/v1/pair', method='POST', headers=headers,
            data=json.dumps({'code': 'A1B2C3', 'userId': 'synthetic-plan-owner'}).encode())
        with urllib.request.urlopen(request, timeout=5) as response:
            paired = json.load(response)
        headers['X-Study-Loop-Session'] = paired['sessionToken']
        write = Path.write_text

        def edit_during_staging(path, *args, **kwargs):
            result = write(path, *args, **kwargs)
            if path.name.startswith(f'.{note.name}.zhixue') and path.name.endswith('.tmp'):
                note.write_bytes(edited)
            return result

        request = urllib.request.Request(base + '/v1/plan/apply', method='POST', headers=headers,
            data=json.dumps({'candidate': fixture.candidate(), 'expectedRevision': 0}).encode())
        with mock.patch.object(Path, 'write_text', edit_during_staging):
            try:
                urllib.request.urlopen(request, timeout=5).close()
                self.fail('A changed note was accepted')
            except urllib.error.HTTPError as error:
                with error:
                    self.assertEqual(error.code, 409)
                    payload = json.load(error)
        self.assertEqual(payload['status'], 'stale')
        self.assertIn('重新读取', payload['message'])
        self.assertNotIn(str(harness.vault), payload['message'])
        self.assertEqual(note.read_bytes(), edited)
        self.assertEqual(plan_area.read_revisions(plan_area.plan_area_root(harness.vault)), [])
