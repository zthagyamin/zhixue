import copy
import json
import sys
import tempfile
import unittest
import re
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from study_day import study_day, study_day_bounds, recorded_day_matches, source_review_due_at
import task_events
import account_sync_schema
from infrastructure.dashboard_reader import read_activity_events
from infrastructure.legacy_activity_writer import accept_activity

class StudyDayTests(unittest.TestCase):
    def test_legacy_overnight_retry_remains_idempotent_and_returns_learning_day(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);tz=timezone(timedelta(hours=8));fixed=datetime(2026,9,23,1,tzinfo=tz)
            path=lambda d:root/(d.isoformat()+'.jsonl')
            read=lambda d:read_activity_events(d,event_log_path=path)
            report_days=[]
            def report(day,events):
                report_days.append(day.isoformat());return root/'report.md'
            ports=dict(EVENT_ID_PATTERN=re.compile(r'[A-Za-z0-9_-]{6,128}'),EVENT_DOMAINS={'ielts'},EVENT_OUTCOMES={'completed'},LOCAL_TZ=tz,
                DATA_LOCK=threading.RLock(),learning_vault_path=lambda *_:root,daily_dashboard=lambda d:{'date':d.isoformat()},event_log_path=path,
                read_activity_events=read,render_daily_report=report,dashboard_activity_events=read,relative_note_path=lambda p:p.name,now=lambda:fixed)
            payload={'eventId':'legacy-night','domain':'ielts','outcome':'completed','occurredAt':fixed.isoformat(),'title':'Synthetic'}
            first=accept_activity(payload,**ports);second=accept_activity(payload,**ports)
            self.assertFalse(first['duplicate']);self.assertTrue(second['duplicate'])
            self.assertEqual(second['dashboard']['date'],'2026-09-22');self.assertEqual(report_days,['2026-09-22'])
            self.assertEqual(sum(len(p.read_text().splitlines()) for p in root.glob('*.jsonl')),1)

    def test_shared_boundary_vectors_and_transition_window(self):
        fixture=json.loads((Path(__file__).parent/'fixtures/study-day-4am.json').read_text(encoding='utf-8'))
        for instant, day in fixture['cases']:
            with self.subTest(instant=instant):
                self.assertEqual(study_day(instant).isoformat(), day)
        start,end=study_day_bounds('2026-09-22')
        self.assertEqual((end-start).total_seconds(), 28*3600)
        self.assertEqual(source_review_due_at('2026-09-23T00:00:00+08:00'),'2026-09-23T04:00:00+08:00')

    def test_legacy_and_new_task_days_read_without_changing_hashes(self):
        source=json.loads((Path(__file__).parent/'fixtures/task-event-v1.json').read_text(encoding='utf-8'))
        for day in ('2026-09-22','2026-09-23'):
            event={**source,'day':day,'occurredAt':'2026-09-22T19:59:59.999Z'}
            event.pop('coreHash')
            event['coreHash']=account_sync_schema.study_hash(event)
            before=copy.deepcopy(event)
            task_events.validate_task_event(event)
            account_sync_schema._task_core(event)
            self.assertEqual(event,before)
        self.assertFalse(recorded_day_matches(event['occurredAt'],'2026-09-21'))

    def test_mixed_log_partitions_aggregate_overnight_once_without_rewriting_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);day=study_day('2026-09-22T19:00:00.000Z')
            event={'eventId':'night-event','occurredAt':'2026-09-22T19:00:00.000Z'}
            raw=json.dumps(event)+'\n';(root/'2026-09-22.jsonl').write_text(raw);(root/'2026-09-23.jsonl').write_text(raw)
            self.assertEqual(read_activity_events(day,event_log_path=lambda d:root/(d.isoformat()+'.jsonl')),[event])
            self.assertEqual((root/'2026-09-23.jsonl').read_text(),raw)
