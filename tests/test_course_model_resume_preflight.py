"""Synthetic preflight boundaries. No credentials, transport, or live model calls."""
from contextlib import closing
import hashlib
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('resume_preflight', ROOT / 'scripts/course-model-resume-preflight.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ResumePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = {'maximumOutboundAttempts': 6, 'sourceVersion': 'a' * 64, 'maxOutputTokens': 2000,
                     'frozenProvider': 'synthetic', 'frozenModelId': 'synthetic',
                     'promptVersion': '1', 'ruleVersion': '1',
                     'cases': [{'id': str(index)} for index in range(6)]}
        self.tasks = {'sourceVersion': 'a' * 64}
        self.plan_hash = self.write('plan.json', self.plan)
        self.task_hash = self.write('tasks.json', self.tasks)
        self.summary = {'startedAt': '2026-10-06T00:00:00+00:00', 'planHash': self.plan_hash, 'taskFileHash': self.task_hash,
                        'sourceVersion': 'a' * 64, 'outboundAttempts': 3,
                        'provider': 'synthetic', 'modelId': 'synthetic', 'promptVersion': '1', 'ruleVersion': '1',
                        'dailyTokenLimit': 20000, 'dailyRequestLimit': 10, 'maxOutputTokens': 2000,
                        'cases': [{'caseId': str(index), 'outboundAttempt': index + 1} for index in range(3)],
                        'planReservations': [{'caseId': str(index), 'reservationTokens': 5500 if index < 3 else 6000} for index in range(6)]}
        self.summary_hash = self.write('summary.json', self.summary)
        self.write('counter.json', {'attempts': 3})
        with closing(sqlite3.connect(self.root / 'qa.db')) as db, db:
            db.execute('CREATE TABLE native_course_requests(owner TEXT,budget_day TEXT,request_id TEXT,reserved INTEGER,usage INTEGER)')
            db.executemany('INSERT INTO native_course_requests VALUES (?,?,?,?,?)',
                           [('synthetic', '2026-10-06', 'model-check-' + str(index), 5500, 800) for index in range(3)])

    def write(self, name, value):
        raw = json.dumps(value).encode()
        (self.root / name).write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def run_check(self, day='2026-10-06'):
        return MODULE.preflight(*(self.root / name for name in ('plan.json', 'tasks.json', 'summary.json', 'counter.json', 'qa.db')),
                                now=datetime.fromisoformat(day).replace(tzinfo=timezone.utc),
                                expected_plan_hash=self.plan_hash, expected_task_hash=self.task_hash, expected_summary_hash=self.summary_hash)

    def test_current_budget_stops_and_every_file_is_unchanged(self):
        before = {path.name: path.read_bytes() for path in self.root.iterdir()}
        result = self.run_check()
        self.assertEqual(result['status'], 'waiting-budget')
        self.assertEqual(result['remainingAuthorization'], 3)
        self.assertEqual([row['caseId'] for row in result['remainingCases']], ['3', '4', '5'])
        self.assertFalse(result['modelInvoked'])
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.root.iterdir()})

    def test_synthetic_next_day_only_prepares_a_profile_check(self):
        result = self.run_check('2026-10-07')
        self.assertEqual(result['status'], 'ready-for-profile-check')
        self.assertEqual(result['outboundAttempts'], 3)
        self.assertEqual(result['reservedTokensToday'], 0)
        self.assertFalse(result['storageModified'])
        self.assertIn('application-budget-recheck', result['requiredBeforeExecution'])

    def test_changed_frozen_task_cannot_be_reauthorized_by_editing_summary(self):
        self.summary['taskFileHash'] = self.write('tasks.json', {'sourceVersion': 'a' * 64, 'changed': True})
        self.write('summary.json', self.summary)
        with self.assertRaisesRegex(ValueError, 'frozen-evidence-changed'):
            self.run_check()

    def test_unreported_outbound_result_never_becomes_an_uncalled_case(self):
        self.summary['cases'].pop()
        self.summary_hash = self.write('summary.json', self.summary)
        with self.assertRaisesRegex(ValueError, 'outbound-outcome-unknown'):
            self.run_check()

    def test_equal_count_case_substitution_cannot_reschedule_an_already_called_case(self):
        self.summary['cases'][0]['caseId'] = '3'
        self.write('summary.json', self.summary)
        with self.assertRaisesRegex(ValueError, 'frozen-evidence-changed'):
            self.run_check()

    def test_reducing_an_uncalled_estimate_cannot_turn_a_budget_stop_into_readiness(self):
        self.summary['planReservations'][3]['reservationTokens'] = 1
        self.write('summary.json', self.summary)
        with self.assertRaisesRegex(ValueError, 'frozen-evidence-changed'):
            self.run_check()

    def test_call_counter_type_limit_and_reservation_conflicts_fail_closed(self):
        for count in (True, -1, 7):
            self.write('counter.json', {'attempts': count})
            with self.assertRaisesRegex(ValueError, 'call-boundary'):
                self.run_check()
        self.write('counter.json', {'attempts': 3})
        with closing(sqlite3.connect(self.root / 'qa.db')) as db, db:
            db.execute("INSERT INTO native_course_requests(owner,budget_day,reserved,usage) VALUES ('synthetic','2026-10-06',100,NULL)")
        with self.assertRaisesRegex(ValueError, 'unreconciled-reservation'):
            self.run_check()

    def test_changed_budget_and_multiple_owners_cannot_expand_readiness(self):
        self.summary['dailyTokenLimit'] = 40000
        self.summary_hash = self.write('summary.json', self.summary)
        with self.assertRaisesRegex(ValueError, 'budget-boundary'):
            self.run_check()
        self.summary['dailyTokenLimit'] = 20000
        self.summary_hash = self.write('summary.json', self.summary)
        with closing(sqlite3.connect(self.root / 'qa.db')) as db, db:
            db.execute("INSERT INTO native_course_requests(owner,budget_day,reserved,usage) VALUES ('other','2026-10-06',100,NULL)")
        with self.assertRaisesRegex(ValueError, 'owner-boundary'):
            self.run_check()

    def test_same_count_ledger_identity_change_never_reauthenticates_a_paid_case(self):
        with closing(sqlite3.connect(self.root / 'qa.db')) as db, db:
            db.execute("UPDATE native_course_requests SET request_id='model-check-3' WHERE request_id='model-check-0'")
        with self.assertRaisesRegex(ValueError, 'ledger-identity'):
            self.run_check()

    def test_moving_reserved_rows_to_another_day_cannot_create_budget(self):
        with closing(sqlite3.connect(self.root / 'qa.db')) as db, db:
            db.execute("UPDATE native_course_requests SET budget_day='2026-10-05'")
        with self.assertRaisesRegex(ValueError, 'ledger-identity'):
            self.run_check()


if __name__ == '__main__':
    unittest.main()
