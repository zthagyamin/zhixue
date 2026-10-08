"""Current-reference checks never write during a parent event transaction."""
import copy
import sqlite3
import unittest
from contextlib import closing

import test_course_source_capture as native_fixture


class NativeCourseSourceFenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = native_fixture.NativeCourseSourceTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)

    def test_fence_does_not_create_storage_or_update_registered_sources(self):
        case = self.fixture
        identity = case.identity()
        generated = case.service._capture(identity)['public']
        before = {path: path.read_bytes() for path in case.vault.rglob('*.md')}
        self.assertEqual(case.service.verify_current(identity, generated['captureId']), generated)
        self.assertFalse(case.db.exists())
        self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_fence_remains_read_only_while_event_database_has_a_write_lock(self):
        case = self.fixture
        identity = case.identity()
        captured = case.service.capture(identity)
        with closing(sqlite3.connect(case.db, timeout=1)) as database:
            database.execute('BEGIN IMMEDIATE')
            self.assertEqual(case.service.verify_current(identity, captured['captureId']), captured)
            database.rollback()
        self.assertEqual(case.service.read(identity, captured['captureId']), captured)

    def test_changed_source_or_wrong_capture_cannot_retarget_an_old_answer(self):
        case = self.fixture
        identity = case.identity()
        captured = case.service.capture(identity)
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            case.service.verify_current(identity, 'f' * 64)
        case.support = copy.deepcopy(case.support)
        case.support['criteria'][0]['text'] += ' A new reference.'
        case.source()
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            case.service.verify_current(identity, captured['captureId'])
        self.assertEqual(case.service.read(identity, captured['captureId']), captured)


if __name__ == '__main__':
    unittest.main()
