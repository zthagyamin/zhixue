"""Application boundaries, not a substitute for native capture persistence tests."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from application.course_sources import CourseSourceApplication, CourseSourcePorts


class CourseSourceApplicationTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.library = 'local-vault:test'
        self.identity = {'schemaVersion': 1, 'libraryId': self.library,
                         'itemKey': 'practice:course', 'contentHash': 'a' * 64,
                         'localBindingHash': 'b' * 64}
        self.capture = {'schemaVersion': 1, 'captureId': 'c' * 64, 'identity': self.identity}
        self.app = CourseSourceApplication(CourseSourcePorts(
            library_id=lambda: self.library,
            capture=lambda value: self.record('capture', value),
            read=lambda value, capture_id: self.record('read', value, capture_id)))

    def record(self, action, *values):
        self.calls.append((action, values))
        return self.capture

    def test_capture_and_historical_read_have_distinct_intents(self):
        payload = {'schemaVersion': 1, 'identity': self.identity}
        result = self.app.execute('capture', payload)
        self.assertEqual(result, {'schemaVersion': 1, 'durable': True, 'capture': self.capture})
        self.app.execute('read', {**payload, 'captureId': 'c' * 64})
        self.assertEqual([entry[0] for entry in self.calls], ['capture', 'read'])

    def test_untrusted_reference_and_owner_fields_never_reach_ports(self):
        payload = {'schemaVersion': 1, 'identity': self.identity}
        for field in ('item', 'reference', 'owner', 'answer', 'captureId'):
            with self.assertRaises(ValueError):
                self.app.execute('capture', {**payload, field: 'untrusted'})
        for version in (True, '1', 2):
            with self.assertRaises(ValueError):
                self.app.execute('capture', {**payload, 'schemaVersion': version})
        with self.assertRaises(ValueError):
            self.app.execute('grade', payload)
        self.assertEqual(self.calls, [])

    def test_wrong_library_and_root_switch_do_not_issue_receipts(self):
        payload = {'schemaVersion': 1, 'identity': self.identity}
        self.library = 'local-vault:other'
        with self.assertRaises(ValueError):
            self.app.execute('capture', payload)
        self.assertEqual(self.calls, [])
        self.library = self.identity['libraryId']

        def switch_root(value):
            self.library = 'local-vault:other'
            return self.capture

        self.app = CourseSourceApplication(CourseSourcePorts(
            library_id=lambda: self.library, capture=switch_root, read=lambda *_: self.capture))
        with self.assertRaises(ValueError):
            self.app.execute('capture', payload)

    def test_storage_failure_cannot_be_wrapped_as_durable_success(self):
        def fail(_):
            raise OSError('transaction failed')

        self.app = CourseSourceApplication(CourseSourcePorts(
            library_id=lambda: self.library, capture=fail, read=lambda *_: self.capture))
        with self.assertRaises(OSError):
            self.app.execute('capture', {'schemaVersion': 1, 'identity': self.identity})


if __name__ == '__main__':
    unittest.main()
