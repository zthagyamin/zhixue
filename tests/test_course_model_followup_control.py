"""Synthetic QA expansion gates; no credentials, provider or real ledger."""
import json
import sys
import tempfile
import unittest
import sqlite3
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from course_model_followup_control import qa_settings, reserve_cumulative, spend_attempt, verify_ledger


class FollowupControlTests(unittest.TestCase):
    def test_override_is_detached_and_preserves_other_limits(self):
        base = dict(dailyTokenLimit=20000, dailyRequestLimit=10, concurrentLimit=1,
                    maxOutputTokens=2000, revision=0, model='synthetic')
        result = qa_settings(base)
        self.assertEqual(base['dailyTokenLimit'], 20000)
        self.assertEqual(result, {**base, 'dailyTokenLimit': 60000})
        for key, value in [('dailyTokenLimit', 60000), ('dailyRequestLimit', 11),
                           ('concurrentLimit', 2), ('maxOutputTokens', 4000), ('revision', 1)]:
            with self.assertRaises(ValueError):
                qa_settings({**base, key: value})

    def test_cumulative_budget_includes_previous_days_and_failures(self):
        calls = []
        result = reserve_cumulative(33346, 5440, lambda: calls.append('reserve') or 5440)
        self.assertEqual(result, 5440)
        self.assertEqual(calls, ['reserve'])
        for total, estimate in [(59000, 1001), (60000, 1), (-1, 1), (True, 1), (0, 0)]:
            with self.assertRaises(ValueError):
                reserve_cumulative(total, estimate, lambda: calls.append('bad'))
        self.assertEqual(calls, ['reserve'])

    def test_reservation_disagreement_is_not_allowed_to_transport(self):
        with self.assertRaisesRegex(ValueError, 'reservation-changed'):
            reserve_cumulative(33346, 5440, lambda: 5441)

    def test_counter_is_preserved_and_durable_before_transport(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'count.json'
            path.write_text(json.dumps({'attempts': 6}))
            self.assertEqual(spend_attempt(path), 7)
            self.assertEqual(json.loads(path.read_text()), {'attempts': 7})
            for count in (10, 11, -1, True, '6'):
                path.write_text(json.dumps({'attempts': count}))
                before = path.read_bytes()
                with self.assertRaises(ValueError):
                    spend_attempt(path)
                self.assertEqual(path.read_bytes(), before)

    def test_missing_or_malformed_counter_is_never_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'count.json'
            with self.assertRaises(FileNotFoundError):
                spend_attempt(path)
            path.write_text('{}')
            with self.assertRaises(ValueError):
                spend_attempt(path)
            self.assertEqual(path.read_text(), '{}')

    def test_ledger_counts_all_days_and_checks_identity_receipts_and_no_claims(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'qa.db'
            db = sqlite3.connect(path)
            self.addCleanup(db.close)
            db.execute('CREATE TABLE native_course_requests(owner,library,root,request_id,reserved,budget_day,state)')
            db.execute('CREATE TABLE native_course_claims(claim)')
            expected = {'a': (100, '2026-10-06'), 'b': (200, '2026-10-07')}
            db.executemany('INSERT INTO native_course_requests VALUES (?,?,?,?,?,?,?)',
                           [('owner', 'library', 'root', key, tokens, day, 'pending')
                            for key, (tokens, day) in expected.items()])
            db.commit()
            self.assertEqual(verify_ledger(path, expected), 300)
            for sql in ["UPDATE native_course_requests SET owner='other' WHERE request_id='a'",
                        "UPDATE native_course_requests SET budget_day='2026-10-08' WHERE request_id='a'",
                        "UPDATE native_course_requests SET state='inflight' WHERE request_id='a'",
                        "UPDATE native_course_requests SET request_id='c' WHERE request_id='a'",
                        "INSERT INTO native_course_claims VALUES ('formal')"]:
                db.execute('SAVEPOINT mutation')
                db.execute(sql)
                db.commit()
                with self.assertRaises(ValueError):
                    verify_ledger(path, expected)
                if 'claims' in sql:
                    db.execute('DELETE FROM native_course_claims')
                else:
                    db.execute('DELETE FROM native_course_requests')
                    db.executemany('INSERT INTO native_course_requests VALUES (?,?,?,?,?,?,?)',
                                   [('owner', 'library', 'root', key, tokens, day, 'pending')
                                    for key, (tokens, day) in expected.items()])
                db.commit()
            db.close()


if __name__ == '__main__':
    unittest.main()
