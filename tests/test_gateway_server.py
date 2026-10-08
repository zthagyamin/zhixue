"""Indexed mode must not silently re-enter legacy discovery or write routing."""
import json
import contextlib
from datetime import datetime
import unittest
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest import mock

import test_companion as fixtures
import test_index_gateway as gateway_fixtures
import index_gateway

server = fixtures.server


class GatewayServerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CompanionSyncTests()
        self.fixture.setUp()
        self.vault = self.fixture.vault
        self.builder = gateway_fixtures.IndexGatewayTests()
        self.builder.vault = self.vault
        self.builder.entry = index_gateway.GATEWAY_ROOT.as_posix()
        self.fixture.write(self.builder.entry + '/index.md', '---\ntype: zhixue-gateway\nschema_version: 1\n---\n# Gateway\n')
        self.root = self.builder.subject()
        self.source = self.builder.quiz(self.root)
        self.key = 'practice:astronomy-fixture:lesson-a:q1'

    def tearDown(self):
        self.fixture.tearDown()

    def accept(self, payload):
        with server.local_database() as db:
            return server.accept_study_event_v3(db, self.vault, 'account', payload)

    def payload(self, event_id='gateway-event-001'):
        return self.fixture.make_v3_activity(event_id, item_key=self.key, state_ref=self.root + '/state.md', ability_id='astronomy-fixture:lesson-a:q1')

    def test_snapshot_uses_only_gateway_and_reads_new_subject_without_restart(self):
        method = getattr(server, 'indexed_study_payload', None)
        self.assertIsNotNone(method)
        with mock.patch.object(server, 'due_review_items', side_effect=AssertionError('legacy scan')):
            payload = method(self.vault, 'account')
            self.assertEqual([s['id'] for s in payload['subjects']], ['astronomy-fixture'])
            self.assertEqual(payload['dashboard']['dueReviews'], [])
            second = self.builder.subject('botany-fixture')
            self.builder.quiz(second)
            self.assertEqual(len(method(self.vault, 'account')['subjects']), 2)

    def test_refresh_does_not_need_ai_or_inspect_arbitrary_sources(self):
        with mock.patch.object(server, 'resolve_current_source', side_effect=AssertionError('legacy scan')), mock.patch.object(server, 'deepseek_key', side_effect=AssertionError('AI unnecessary')):
            server.safe_refresh()
        self.assertEqual(server.STATE['gateway']['mode'], 'indexed')

    def test_event_writes_subject_journal_and_progress_without_mutating_content(self):
        original = self.source.read_bytes()
        payload = self.payload()
        first = self.accept(payload)
        self.assertEqual(first['mappingStatus'], 'mapped')
        self.assertEqual(self.accept(payload)['status'], 'duplicate')
        journals = list((self.vault / self.root / 'records').rglob('*.jsonl'))
        self.assertEqual(len(journals), 1)
        self.assertEqual(len(journals[0].read_text(encoding='utf-8').splitlines()), 1)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertIn('ZHIXUE', (self.vault / self.root / 'state.md').read_text(encoding='utf-8'))
        snapshot = server.indexed_study_payload(self.vault, 'account')
        self.assertEqual(len(snapshot['gateway']['progressEvents']), 1)
        self.assertEqual(server.indexed_study_payload(self.vault, 'other')['gateway']['progressEvents'], [])
        self.assertFalse((self.vault / '_System/Integrations/Study Loop/events').exists())
        event_day=datetime.fromisoformat(payload['event']['occurredAt'].replace('Z','+00:00')).astimezone(server.LOCAL_TZ).date()
        dashboard=server.indexed_study_payload(self.vault,'account',day=event_day)['dashboard']
        self.assertEqual(dashboard['activityMinutes'],payload['localContext']['durationMin'])

    def test_conflicting_context_does_not_acquire_a_write_target(self):
        self.fixture.write('unrelated.md', '---\ntype: project\n---\n# Other\n')
        payload = self.payload()
        payload['localContext']['stateRef'] = 'unrelated.md'
        with self.assertRaises(ValueError):
            self.accept(payload)
        self.assertNotIn('ZHIXUE', (self.vault / 'unrelated.md').read_text(encoding='utf-8'))

    def test_unknown_item_remains_unmapped_even_with_client_state_path(self):
        payload = self.payload()
        payload['event']['item']['key'] = 'practice:unknown'
        payload['event']['coreHash'] = server.compute_study_event_core_hash(payload['event'])
        result = self.accept(payload)
        self.assertEqual(result['mappingStatus'], 'unmapped')
        self.assertFalse((self.vault / self.root / 'records').exists())

    def test_projection_failure_rolls_back_journal_and_database(self):
        payload = self.payload()
        with mock.patch.object(server.state_projection, 'project_mapped_events', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                self.accept(payload)
        self.assertEqual(list((self.vault / self.root / 'records').rglob('*.jsonl')), [])
        self.assertEqual(self.accept(payload)['status'], 'accepted')

    def test_task_evidence_cannot_commit_a_practice_event_that_later_rolls_back(self):
        from concurrent.futures import ThreadPoolExecutor
        import task_events
        import test_task_events
        payload = self.payload('practice-pending-rollback')
        catalog = index_gateway.load_gateway(self.vault)
        unit = server.planning_catalog.load_planning_catalog(self.vault, catalog)['subjects'][0]['units'][0]
        task = test_task_events.sealed(subjectId='astronomy-fixture', unitIds=[unit['unitId']], source='evidence',
            evidenceRefs=[payload['event']['eventId']], day='2026-08-24', occurredAt='2026-08-24T10:00:00.001Z')
        projecting, release, observed = threading.Event(), threading.Event(), threading.Event()
        def fail_projection(*args, **kwargs):
            projecting.set()
            if not release.wait(5):
                raise RuntimeError('fixture barrier timed out')
            raise OSError('fixture rollback')
        def validate(event):
            observed.set()
            return server.validate_study_event_v3(event)
        with mock.patch.object(server.state_projection, 'project_mapped_events', side_effect=fail_projection), ThreadPoolExecutor(2) as pool:
            practice = pool.submit(self.accept, payload)
            try:
                self.assertTrue(projecting.wait(3))
                report = pool.submit(task_events.append_task_event, self.vault, catalog, 'account', task, validate_practice_event=validate)
                observed.wait(.2)
            finally:
                release.set()
            with self.assertRaises(OSError):
                practice.result(timeout=5)
            with self.assertRaises(ValueError):
                report.result(timeout=5)
        self.assertEqual(task_events.read_task_events(self.vault, catalog, 'account'), [])

    def test_damaged_record_is_diagnostic_and_does_not_erase_other_subjects(self):
        self.accept(self.payload())
        journal = next((self.vault / self.root / 'records').rglob('*.jsonl'))
        row = json.loads(journal.read_text(encoding='utf-8'))
        row['event']['attempt']['correct'] = not row['event']['attempt']['correct']
        journal.write_text(json.dumps(row) + '\n', encoding='utf-8')
        payload = server.indexed_study_payload(self.vault, 'account')
        self.assertEqual(len(payload['subjects']), 1)
        self.assertEqual(payload['gateway']['progressEvents'], [])
        self.assertTrue(payload['gateway']['diagnostics'])

    def result_card(self, bom=False):
        ref = self.root + '/state.md'
        return self.fixture.write(self.root + '/card.md', ('\ufeff' if bom else '') + f'---\ntype: learning-result\nitem_id: stable-card\nability_id: card-ability\nreview_enabled: true\nreview_date: 2026-01-01\nsource_note: "[[{ref}]]"\nstate_ref: "[[{ref}]]"\n---\n# Card\n\n复习要点：\n- Stable review point\n')

    def test_result_queue_keeps_existing_identity_and_accepts_bom(self):
        card = self.result_card(bom=True)
        relative = card.relative_to(self.vault).as_posix()
        server.review_queue.apply_result(self.vault,relative,{'name':'Stable review point'},'good',event_id='older-event')
        payload = self.fixture.make_v3_activity('card-bom-event',rating='hard',item_key='practice:stable-card',state_ref=self.root+'/state.md',ability_id='card-ability')
        self.assertEqual(self.accept(payload)['projectionStatus'],'applied')
        queue = server.review_queue.read_queue(self.vault,relative)
        self.assertEqual(len(queue),1)
        self.assertEqual(queue[0]['attempts'],1)

    def test_pending_retry_uses_frozen_binding_after_index_is_changed(self):
        self.result_card()
        payload = self.fixture.make_v3_activity('card-retry-event',item_key='practice:stable-card',state_ref=self.root+'/state.md',ability_id='card-ability')
        with mock.patch.object(server.review_queue,'apply_result',side_effect=ValueError('stale-vault-edit')):
            self.assertEqual(self.accept(payload)['projectionStatus'],'pending')
        index = self.vault / self.builder.entry / 'subjects/astronomy-fixture.md'
        index.write_text(index.read_text(encoding='utf-8').replace('/records','/different-records'),encoding='utf-8')
        payload['localContext']['stateRef']='no-longer-exists.md'
        self.assertEqual(self.accept(payload)['projectionStatus'],'applied')
        self.assertFalse((self.vault/self.root/'different-records').exists())

    def test_shared_state_keeps_other_subject_evidence_after_database_recovery(self):
        shared=self.fixture.write('shared.md','---\ntype: learning-state\n---\n# Shared\n')
        for subject_id in ('astronomy-fixture','botany-fixture'):
            root = self.root if subject_id=='astronomy-fixture' else self.builder.subject(subject_id)
            path = self.builder.quiz(root)
            path.write_text(path.read_text(encoding='utf-8').replace('| 解析 |','| 解析 | state_ref |').replace('| Grounded explanation |','| Grounded explanation | [[shared]] |').replace('|---|---|---|---|---|','|---|---|---|---|---|---|'),encoding='utf-8')
            payload=self.fixture.make_v3_activity('initial-'+subject_id,item_key=f'practice:{subject_id}:lesson-a:q1',state_ref='shared.md',ability_id=f'{subject_id}:lesson-a:q1')
            self.accept(payload)
        server.LOCAL_DATABASE_PATH=self.vault/'fresh.db'
        payload=self.fixture.make_v3_activity('recovered-event',item_key=self.key,state_ref='shared.md',ability_id='astronomy-fixture:lesson-a:q1')
        self.accept(payload)
        self.assertIn('botany-fixture:lesson-a:q1',shared.read_text(encoding='utf-8'))
        # Removing the last playable file must not remove the subject's history root.
        (self.vault/'subjects/botany-fixture/lesson.md').unlink()
        server.LOCAL_DATABASE_PATH=self.vault/'another-fresh.db'
        payload=self.fixture.make_v3_activity('recovered-empty-subject-event',item_key=self.key,state_ref='shared.md',ability_id='astronomy-fixture:lesson-a:q1')
        self.accept(payload)
        self.assertIn('botany-fixture:lesson-a:q1',shared.read_text(encoding='utf-8'))

    def test_failed_projection_does_not_restore_over_unrelated_user_edit(self):
        state=self.vault/self.root/'state.md'
        def concurrent_edit(*args,**kwargs):
            state.write_text('New user edit\n',encoding='utf-8')
            raise OSError('fixture write failure')
        with mock.patch.object(server.state_projection,'project_mapped_events',side_effect=concurrent_edit):
            with self.assertRaises(OSError):
                self.accept(self.payload())
        self.assertEqual(state.read_text(encoding='utf-8'),'New user edit\n')

    def test_legacy_pending_event_does_not_acquire_new_index_mapping(self):
        payload=self.payload()
        with server.local_database() as db:
            server.ensure_study_v3_schema(db)
            event=payload['event']
            db.execute('INSERT INTO study_events_v3 VALUES (?,?,?,?,?,?,?)',('account',event['eventId'],event['coreHash'],event['occurredAt'],json.dumps(event),json.dumps({'stateRef':'old.md'}),'now'))
            db.execute('INSERT INTO study_event_projections VALUES (?,?,?,?)',('account',event['eventId'],'pending','now'))
        with self.assertRaisesRegex(ValueError,'legacy-pending'):
            self.accept(payload)

    def test_http_planning_evidence_is_paired_and_bound_to_the_context_epoch(self):
        self.result_card()
        payload = self.fixture.make_v3_activity('http-evidence-frame', item_key='practice:stable-card', state_ref=self.root + '/state.md', ability_id='card-ability')
        self.accept(payload)
        server.CONFIG['allowed_origins'] = ['http://127.0.0.1:3080']
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True);thread.start()
        base = f'http://127.0.0.1:{httpd.server_address[1]}'
        headers = {'Origin': 'http://127.0.0.1:3080', 'Content-Type': 'application/json'}
        def request(path, payload=None):
            req = urllib.request.Request(base + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.loads(response.read())
        try:
            headers['X-Study-Loop-Session'] = request('/v1/pair', {'code': 'A1B2C3', 'userId': 'planning-evidence-fixture'})['sessionToken']
            # A different account cannot see the existing account's fixture history.
            context = request('/v1/plan/context')
            self.assertIn('task-planning-v1', request('/v1/health').get('capabilities', []))
            self.assertIn('task-planning-v1', context['capabilities'])
            self.assertIn('sourceReviews', context);self.assertIn('planRevision', context)
            query = urllib.parse.urlencode({'sourceHash': context['catalog']['sourceHash'], 'planRevision': context['planRevision']})
            page = request('/v1/plan/evidence?' + query)
            self.assertEqual(page['records'], [])
            account = server.authenticate_session(headers['X-Study-Loop-Session'])
            with server.local_database() as database:
                server.accept_study_event_v3(database, self.vault, account, self.payload('paired-evidence-event'))
            context = request('/v1/plan/context')
            query = urllib.parse.urlencode({'sourceHash': context['catalog']['sourceHash'], 'planRevision': context['planRevision']})
            page = request('/v1/plan/evidence?' + query)
            self.assertEqual(len(page['records']), 1)
            self.assertNotIn('localContext', page['records'][0])
            self.assertEqual(page['sourceHash'], context['catalog']['sourceHash'])
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/plan/evidence?' + urllib.parse.urlencode({'sourceHash': '0' * 64, 'planRevision': context['planRevision']}))
            self.assertEqual(error.exception.code, 409)
        finally:
            httpd.shutdown();httpd.server_close();thread.join(timeout=5)

    def test_http_v2_plan_checks_integrity_and_source_epoch_before_writing(self):
        import task_plan_schema
        import plan_authority
        server.CONFIG['allowed_origins'] = ['http://127.0.0.1:3080']
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True);thread.start()
        base = f'http://127.0.0.1:{httpd.server_address[1]}'
        headers = {'Origin': 'http://127.0.0.1:3080', 'Content-Type': 'application/json'}
        def request(path, payload=None):
            req = urllib.request.Request(base + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.loads(response.read())
        try:
            headers['X-Study-Loop-Session'] = request('/v1/pair', {'code': 'A1B2C3', 'userId': 'task-plan-fixture'})['sessionToken']
            catalog = request('/v1/plan/context')['catalog'];unit = catalog['subjects'][0]['units'][0]
            task = {key: unit[key] for key in ('subjectId', 'title', 'sourceHash', 'completionRule', 'action')}
            task.update(taskId='manual-unit-one', category='subject', origin='manual', required=False, unitIds=[unit['unitId']], quantity=1)
            candidate = {'schemaVersion': 2, 'day': '2026-08-31', 'sourceHash': catalog['sourceHash'], 'inputHash': 'a' * 64,
                'draftVersion': 1, 'tasks': [task], 'manual': {'lockedTaskIds': [task['taskId']], 'excludedUnitIds': []},
                'vocabulary': {'target': 20, 'assignedLexemeKeys': []}}
            candidate['planHash'] = task_plan_schema.hash_task_plan(candidate)
            result = request('/v1/plan/apply', {'candidate': candidate, 'expectedRevision': 0})
            self.assertEqual(result['revision']['after'], candidate)
            tampered = json.loads(json.dumps(candidate));tampered['tasks'][0]['title'] = 'Changed without hash'
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/plan/apply', {'candidate': tampered, 'expectedRevision': 1})
            self.assertEqual(error.exception.code, 400)
            self.assertIn('hash', json.loads(error.exception.read())['message'])
            path = self.vault / plan_authority.PLAN_RELATIVE_PATH;before = path.read_bytes()
            self.source.write_bytes(self.source.read_bytes() + b'\nSource changed\n')
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/plan/apply', {'candidate': candidate, 'expectedRevision': 1})
            self.assertEqual(error.exception.code, 409)
            self.assertEqual(path.read_bytes(), before)
            plan_authority.apply_current_plan(self.vault, candidate, 2)
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/plan/current')
            self.assertEqual(error.exception.code, 409)
        finally:
            httpd.shutdown();httpd.server_close();thread.join(timeout=5)

    def test_http_task_events_are_paired_idempotent_and_separate_from_practice(self):
        import task_events
        import test_task_events
        server.CONFIG['allowed_origins'] = ['http://127.0.0.1:3080']
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True);thread.start()
        base = f'http://127.0.0.1:{httpd.server_address[1]}'
        headers = {'Origin': 'http://127.0.0.1:3080', 'Content-Type': 'application/json'}
        def request(path, payload=None):
            req = urllib.request.Request(base + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.loads(response.read())
        try:
            event = test_task_events.sealed(subjectId='astronomy-fixture', unitIds=[])
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/tasks/events', {'event': event})
            self.assertEqual(error.exception.code, 401)
            headers['X-Study-Loop-Session'] = request('/v1/pair', {'code': 'A1B2C3', 'userId': 'task-event-fixture'})['sessionToken']
            result = request('/v1/tasks/events', {'event': event})
            self.assertEqual(result['status'], 'accepted');self.assertTrue(result['durable'])
            self.assertEqual(request('/v1/tasks/events', {'event': event})['status'], 'duplicate')
            self.assertEqual(request('/v1/tasks/events')['events'], [event])
            changed = {**event, 'taskId': 'conflicting-task'};changed['coreHash'] = task_events.hash_task_event(changed)
            with self.assertRaises(urllib.error.HTTPError) as error:
                request('/v1/tasks/events', {'event': changed})
            self.assertEqual(error.exception.code, 409)
            self.assertEqual(request('/v1/study-data')['gateway']['progressEvents'], [])
            self.accept(self.payload('practice-after-task-001'))
        finally:
            httpd.shutdown();httpd.server_close();thread.join(timeout=5)

    def test_http_task_suggestions_rebuild_catalog_and_never_save(self):
        server.CONFIG['allowed_origins'] = ['http://127.0.0.1:3080']
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{httpd.server_address[1]}'
        headers = {'Origin': 'http://127.0.0.1:3080', 'Content-Type': 'application/json'}
        def request(path, payload=None):
            req = urllib.request.Request(base + path, headers=headers, data=None if payload is None else json.dumps(payload).encode())
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.loads(response.read())
        try:
            headers['X-Study-Loop-Session'] = request('/v1/pair', {'code': 'A1B2C3', 'userId': 'suggestion-fixture'})['sessionToken']
            context = request('/v1/plan/context')
            payload = {'day': '2026-08-31', 'sourceHash': context['catalog']['sourceHash'], 'draftVersion': 4,
                'excludedUnitIds': [], 'selectedUnitIds': [], 'intent': 'standard'}
            before = {path.relative_to(self.vault): path.read_bytes() for path in self.vault.rglob('*.md')}
            with mock.patch.object(server, 'deepseek_key', return_value=None), mock.patch.object(server.plan_area, 'apply_plan_revision', side_effect=AssertionError('must not save')):
                result = request('/v1/plan/suggest', payload)
                self.assertEqual(result['mode'], 'fallback')
                self.assertIn('DeepSeek Key', result['message'])
                self.assertTrue(result['selections'])
                with self.assertRaises(urllib.error.HTTPError) as error:
                    request('/v1/plan/suggest', {**payload, 'sourceHash': 'c' * 64})
                self.assertEqual(error.exception.code, 409)
                headers['Origin'] = 'https://untrusted.invalid'
                with self.assertRaises(urllib.error.HTTPError) as error:
                    request('/v1/plan/suggest', payload)
                self.assertEqual(error.exception.code, 403)
            self.assertEqual(before, {path.relative_to(self.vault): path.read_bytes() for path in self.vault.rglob('*.md')})
            self.assertEqual(list((self.vault / self.root / 'records').rglob('*.jsonl')), [])
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_http_indexed_routes_never_reenter_legacy_discovery(self):
        server.CONFIG['allowed_origins']=['http://127.0.0.1:3080']
        httpd=ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        base=f'http://127.0.0.1:{httpd.server_address[1]}'
        headers={'Origin':'http://127.0.0.1:3080','Content-Type':'application/json'}
        def request(path,payload=None):
            req=urllib.request.Request(base+path,headers=headers,data=None if payload is None else json.dumps(payload).encode())
            with urllib.request.urlopen(req,timeout=5) as response:
                return json.loads(response.read())
        try:
            headers['X-Study-Loop-Session']=request('/v1/pair',{'code':'A1B2C3','userId':'gateway-http-fixture'})['sessionToken']
            with contextlib.ExitStack() as stack:
                for name in ('due_review_items','active_project_stages','active_research_sessions','resolve_current_source','count_supported','deepseek_key'):
                    stack.enter_context(mock.patch.object(server,name,side_effect=AssertionError('legacy '+name)))
                for name in ('read_projection','detect_changes','approved_source_documents'):
                    stack.enter_context(mock.patch.object(server.change_detect,name,side_effect=AssertionError('legacy '+name)))
                for path in ('/v1/study-data','/v1/dashboard/today','/v1/practice','/v1/changes'):
                    self.assertIsInstance(request(path),dict)
                context = request('/v1/plan/context')
                self.assertEqual(context['catalog']['subjects'][0]['subjectId'], 'astronomy-fixture')
                self.assertEqual(context['catalog']['subjects'][0]['planningStatus'], 'none')
                self.assertTrue(context['catalog']['subjects'][0]['units'])
                self.assertEqual(request('/v1/refresh',{})['gateway']['mode'],'indexed')
                self.assertEqual(request('/v1/changes/scan',{})['changes'],[])
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    request('/v1/changes/decide',{'changeId':'old','decision':'approved'})
                self.assertEqual(failure.exception.code,400)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)
