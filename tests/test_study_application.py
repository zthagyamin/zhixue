"""Exercise the real study routes with changing synthetic source configuration."""
import sys
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import routes_study


class StudyApplicationTests(unittest.TestCase):
    def test_legacy_practice_uses_learning_day_before_four(self):
        from datetime import datetime, timezone, timedelta
        from infrastructure.study_adapter import create_study_application
        with tempfile.TemporaryDirectory() as directory:
            services = self.services(lambda _key: Path(directory))
            observed = []
            services.due_review_items = lambda day: observed.append(day.isoformat()) or []
            fixed = datetime(2026, 9, 23, 1, tzinfo=timezone(timedelta(hours=8)))
            with patch('infrastructure.study_adapter.datetime') as clock, patch('infrastructure.study_adapter.practice_engine.practice_items', return_value=[]):
                clock.now.return_value = fixed
                create_study_application(services).practice('synthetic-owner')
            self.assertEqual(observed, ['2026-09-22'])

    def services(self, source_path):
        return SimpleNamespace(
            source_path=source_path, DATA_LOCK=threading.RLock(),
            STATE={'contentMode': 'personal', 'stateFrom': 'A'},
            indexed_study_payload=lambda *_args, **_kwargs: None,
            attach_state_handles=lambda value, _owner: dict(value),
            local_vault_library_id=lambda root: root.name,
            local_database=lambda: nullcontext(object()),
            merge_source_area=lambda value, root, documents: {
                **value, 'mergedFrom': root.name, 'documents': documents},
            normalize_question_subjects=lambda value: value,
            due_review_items=lambda _day: [], LOCAL_TZ=None,
            with_connections=lambda value: value,
        )

    def test_read_keeps_library_documents_and_practice_in_the_same_source(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'A', Path(directory) / 'B'
            a.mkdir()
            b.mkdir()
            roots = iter([a, a, b, b, b, b, b, b])
            services = self.services(lambda _name: next(roots))
            replies = []
            handler = SimpleNamespace(send_json=lambda *args: replies.append(args))
            with patch('infrastructure.study_adapter.change_detect.approved_source_documents',
                       side_effect=lambda _db, root: [root.name]), patch(
                           'infrastructure.study_adapter.practice_engine.practice_items',
                           side_effect=lambda root, **_kwargs: [root.name]):
                routes_study.get_study_data(handler, services, '/v1/study-data', 'synthetic')
            status, body = replies[0]
            self.assertEqual(status, 200)
            self.assertEqual((body['localLibraryId'], body['mergedFrom'],
                              body['documents'], body['practiceItems']), ('A', 'A', ['A'], ['A']))

    def test_refresh_rebinds_source_after_refresh_replaces_state_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'A', Path(directory) / 'B'
            a.mkdir()
            b.mkdir()
            current = [a]
            services = self.services(lambda _name: current[0])

            def refresh():
                current[0] = b
                services.STATE = {'contentMode': 'personal', 'stateFrom': 'B'}

            services.safe_refresh = refresh
            replies = []
            handler = SimpleNamespace(send_json=lambda *args: replies.append(args))
            with patch('infrastructure.study_adapter.change_detect.approved_source_documents',
                       side_effect=lambda _db, root: [root.name]):
                routes_study.post_refresh(handler, services, '/v1/refresh', 'synthetic')
            status, body = replies[0]
            self.assertEqual(status, 200)
            self.assertEqual((body['stateFrom'], body['mergedFrom'], body['documents']), ('B', 'B', ['B']))

    def test_legacy_fallback_rebinds_when_index_probe_replaces_state_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'A', Path(directory) / 'B'
            a.mkdir()
            b.mkdir()
            current = [a]
            services = self.services(lambda _name: current[0])

            def indexed(_root, _owner):
                current[0] = b
                services.STATE = {'contentMode': 'personal', 'stateFrom': 'B'}
                return None

            services.indexed_study_payload = indexed
            replies = []
            handler = SimpleNamespace(send_json=lambda *args: replies.append(args))
            with patch('infrastructure.study_adapter.change_detect.approved_source_documents',
                       side_effect=lambda _db, root: [root.name]), patch(
                           'infrastructure.study_adapter.practice_engine.practice_items',
                           side_effect=lambda root, **_kwargs: [root.name]):
                routes_study.get_study_data(handler, services, '/v1/study-data', 'synthetic')
            status, body = replies[0]
            self.assertEqual(status, 200)
            self.assertEqual((body['stateFrom'], body['localLibraryId'], body['mergedFrom'],
                              body['documents'], body['practiceItems']), ('B', 'B', 'B', ['B'], ['B']))
