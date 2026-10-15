"""Actual legacy writer failures must preserve independent edits in temporary notes."""
import sqlite3
import unittest
from unittest import mock

import server
import test_companion as fixture_module


class NativeWriterRollbackTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.CompanionSyncTests('test_state_projection_failure_rolls_back_event_and_vault_log')
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.connection = sqlite3.connect(':memory:')
        self.addCleanup(self.connection.close)
        self.state_ref = '01 学习/专项课程/Test/学习记录/第01讲 学习状态.md'
        self.state = self.fixture.vault / self.state_ref
        self.payload = self.fixture.make_v3_activity(
            'evt-independent-edit-rollback', state_ref=self.state_ref, ability_id='calculation-synthetic')

    def fail_with(self, projection):
        with mock.patch.object(server.state_projection, 'project_mapped_events', side_effect=projection):
            with self.assertRaisesRegex(OSError, 'synthetic projection failure'):
                server.accept_study_event_v3(
                    self.connection, self.fixture.vault, 'account-001', self.payload)
        self.assertEqual(self.connection.execute('SELECT count(*) FROM study_events_v3').fetchone()[0], 0)
        self.assertEqual(self.fixture.count_jsonl_event(self.payload['event']['eventId']), 0)

    def test_failure_does_not_replace_an_independent_edit_before_projection(self):
        edited = self.state.read_bytes() + b'\nINDEPENDENT USER EDIT\n'

        def projection(*_, **__):
            self.state.write_bytes(edited)
            raise OSError('synthetic projection failure')

        self.fail_with(projection)
        self.assertEqual(self.state.read_bytes(), edited)

    def test_failure_does_not_replace_an_independent_edit_after_projection(self):
        original = server.state_projection.project_mapped_events
        observed = {}

        def projection(*args, **kwargs):
            original(*args, **kwargs)
            observed['edited'] = self.state.read_bytes() + b'\nINDEPENDENT USER EDIT AFTER WRITE\n'
            self.state.write_bytes(observed['edited'])
            raise OSError('synthetic projection failure')

        self.fail_with(projection)
        self.assertEqual(self.state.read_bytes(), observed['edited'])

    def test_failure_does_not_recreate_an_independently_removed_note(self):
        def projection(*_, **__):
            self.state.unlink()
            raise OSError('synthetic projection failure')

        self.fail_with(projection)
        self.assertFalse(self.state.exists())

    def test_commit_failure_restores_completed_own_projection(self):
        before = self.state.read_bytes()

        class FailingCommit(sqlite3.Connection):
            def commit(connection):
                if connection.execute('SELECT count(*) FROM study_event_projections').fetchone()[0]:
                    raise OSError('synthetic commit failure')
                return super().commit()

        with sqlite3.connect(':memory:', factory=FailingCommit) as connection:
            with self.assertRaisesRegex(OSError, 'synthetic commit failure'):
                server.accept_study_event_v3(connection, self.fixture.vault, 'account-001', self.payload)
            self.assertEqual(connection.execute('SELECT count(*) FROM study_events_v3').fetchone()[0], 0)
        self.assertEqual(self.state.read_bytes(), before)
        self.assertEqual(self.fixture.count_jsonl_event(self.payload['event']['eventId']), 0)

    def test_commit_failure_preserves_edit_after_completed_own_projection(self):
        state = self.state
        observed = {}

        class FailingCommit(sqlite3.Connection):
            def commit(connection):
                if connection.execute('SELECT count(*) FROM study_event_projections').fetchone()[0]:
                    observed['edited'] = state.read_bytes() + b'\nEDIT BEFORE DATABASE COMMIT\n'
                    state.write_bytes(observed['edited'])
                    raise OSError('synthetic commit failure')
                return super().commit()

        with sqlite3.connect(':memory:', factory=FailingCommit) as connection:
            with self.assertRaisesRegex(OSError, 'synthetic commit failure'):
                server.accept_study_event_v3(connection, self.fixture.vault, 'account-001', self.payload)
            self.assertEqual(connection.execute('SELECT count(*) FROM study_events_v3').fetchone()[0], 0)
        self.assertEqual(self.state.read_bytes(), observed['edited'])
        self.assertEqual(self.fixture.count_jsonl_event(self.payload['event']['eventId']), 0)

    def check_card_edit_after_receipt(self, already_written=False):
        import review_queue
        card = self.fixture.write('01 学习/学习结果/rollback-card.md',
            '---\ntype: learning-result\ndomain: course\nitem_id: rollback-card\n'
            'ability_id: rollback-ability\nreview_date: 2026-08-18\n'
            f'state_ref: "[[{self.state_ref}]]"\n---\n# Card\n复习要点：\n- Test concept\n')
        payload = self.fixture.make_v3_activity('evt-card-rollback', state_ref=self.state_ref,
            ability_id='rollback-ability', rating='again', item_key='practice:rollback-card')
        from source_admission_fixture import logical_payload, prepare_source_event
        payload = logical_payload(server, self.fixture.vault, payload)
        prepared = prepare_source_event(server, self.fixture.vault, 'account-001', payload)
        self.assertIsNotNone(prepared['claim'])
        original = review_queue.apply_result
        if already_written:
            original(self.fixture.vault, str(card.relative_to(self.fixture.vault)),
                {'name': 'Test concept'}, 'again', event_id=payload['event']['eventId'])
        observed = {}

        def apply_then_edit(*args, **kwargs):
            receipt = original(*args, **kwargs)
            observed['receipt'] = receipt
            # An independent queue edit is not an original question revision.
            current = card.read_text(encoding='utf-8')
            current = current.replace(review_queue.REVIEW_QUEUE_END,
                                      '<!-- USER CARD EDIT AFTER RECEIPT -->\n' + review_queue.REVIEW_QUEUE_END)
            observed['edited'] = current.encode('utf-8')
            card.write_bytes(observed['edited'])
            return receipt

        class FailingCommit(sqlite3.Connection):
            def commit(connection):
                if connection.execute('SELECT count(*) FROM study_event_projections').fetchone()[0]:
                    raise OSError('synthetic commit failure')
                return super().commit()

        with sqlite3.connect(':memory:', factory=FailingCommit) as connection:
            with mock.patch.object(review_queue, 'apply_result', side_effect=apply_then_edit):
                with self.assertRaisesRegex(OSError, 'synthetic commit failure'):
                    server.accept_study_event_v3(connection, self.fixture.vault, 'account-001', payload)
            self.assertEqual(connection.execute('SELECT count(*) FROM study_events_v3').fetchone()[0], 0)
        self.assertEqual(bool(observed['receipt'].get('duplicate')), already_written)
        self.assertEqual(card.read_bytes(), observed['edited'])

    def test_commit_failure_preserves_card_edit_after_actual_write_receipt(self):
        self.check_card_edit_after_receipt()

    def test_duplicate_card_receipt_never_claims_an_independent_edit(self):
        self.check_card_edit_after_receipt(already_written=True)


if __name__ == '__main__':
    unittest.main()
