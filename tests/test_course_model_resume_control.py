"""Execution gates with synthetic callbacks only; never import credentials or models."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from course_model_resume_control import run_resume, read_verified_profile
import json


class ResumeControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lock = Path(self.temp.name) / 'owned-run.lock'
        self.calls = []
        self.ready = {'status': 'ready-for-profile-check', 'outboundAttempts': 3, 'remainingAuthorization': 3}

    def execute(self):
        self.assertTrue(self.lock.is_file())
        self.calls.append('execution')
        return {'status': 'synthetic-execution'}

    def test_budget_stop_and_no_execute_flag_never_touch_lock_or_executor(self):
        for state, execute in [({'status': 'waiting-budget'}, True), (self.ready, False)]:
            self.assertEqual(run_resume(lambda: state, self.execute, self.lock, execute_requested=execute), state)
            self.assertFalse(self.lock.exists())
        self.assertEqual(self.calls, [])

    def test_fresh_lock_covers_executor_and_is_removed_after_return(self):
        result = run_resume(lambda: self.ready, self.execute, self.lock, execute_requested=True)
        self.assertEqual(result['status'], 'synthetic-execution')
        self.assertEqual(self.calls, ['execution'])
        self.assertFalse(self.lock.exists())

    def test_an_existing_unknown_run_is_not_stolen_or_deleted(self):
        self.lock.write_text('other-run')
        with self.assertRaises(FileExistsError):
            run_resume(lambda: self.ready, self.execute, self.lock, execute_requested=True)
        self.assertEqual(self.lock.read_text(), 'other-run')
        self.assertEqual(self.calls, [])

    def test_changed_preflight_between_lock_and_execution_stops_without_invoking(self):
        for changed in ({'status': 'waiting-budget'}, {**self.ready, 'outboundAttempts': 4}):
            answers = iter([self.ready, changed])
            with self.assertRaisesRegex(ValueError, 'preflight-changed'):
                run_resume(lambda: next(answers), self.execute, self.lock, execute_requested=True)
            self.assertFalse(self.lock.exists())
        self.assertEqual(self.calls, [])

    def test_executor_failure_is_not_retried_and_releases_only_its_own_lock(self):
        def failure():
            self.calls.append('failure')
            raise RuntimeError('synthetic-failure')
        with self.assertRaisesRegex(RuntimeError, 'synthetic-failure'):
            run_resume(lambda: self.ready, failure, self.lock, execute_requested=True)
        self.assertEqual(self.calls, ['failure'])
        self.assertFalse(self.lock.exists())

    def test_actual_credential_comes_from_one_verified_read_and_settings_are_detached(self):
        settings = {'revision': 0, 'provider': 'synthetic'}
        old_key, new_key = object(), object()
        rows = iter([('original', 'library', settings, old_key, set()),
                     ('changed', 'other-library', settings, new_key, set())])
        calls = []
        def read():
            calls.append('read')
            return next(rows)
        fingerprint = lambda value: json.dumps(value, sort_keys=True)
        expected = fingerprint(settings)
        frozen, key = read_verified_profile(read, 'original', 'library', expected, fingerprint)
        self.assertIs(key, old_key)
        self.assertEqual(calls, ['read'])
        settings['provider'] = 'changed'
        self.assertEqual(frozen['provider'], 'synthetic')
        with self.assertRaisesRegex(ValueError, 'profile-or-budget-context-changed'):
            read_verified_profile(read, 'original', 'library', expected, fingerprint)

    def test_owner_library_settings_new_ledger_or_missing_key_reject_before_use(self):
        settings = {'revision': 0}
        fingerprint = lambda value: json.dumps(value, sort_keys=True)
        expected = fingerprint(settings)
        for row in [('other', 'library', settings, 'fake', set()),
                    ('original', 'other', settings, 'fake', set()),
                    ('original', 'library', {'revision': 1}, 'fake', set()),
                    ('original', 'library', settings, 'fake', {'native_course_requests'}),
                    ('original', 'library', settings, None, set())]:
            with self.assertRaisesRegex(ValueError, 'profile-or-budget-context-changed'):
                read_verified_profile(lambda: row, 'original', 'library', expected, fingerprint)


if __name__ == '__main__':
    unittest.main()
