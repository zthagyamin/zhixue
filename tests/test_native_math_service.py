"""RED tests for native math source, raw claim and independent final/step results."""
import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import test_course_source_capture as course_fixture
from contextlib import closing
OWNER = course_fixture.OWNER
from infrastructure.math_source_capture import NativeMathSources
from infrastructure.math_grade_adapter import create_native_math_application
from infrastructure.math_grade_ledger import MathGradeLedger
from application.native_math import NativeMathApplication
from native_math_schema import native_math_rules


class NativeMathSourceTests(course_fixture.NativeCourseSourceTests):
    # Reuse synthetic TempVault construction only; course assertions are excluded.
    __unittest_skip__ = False
    def setUp(self):
        super().setUp()
        self.support = {'schemaVersion': 2, 'type': 'calculation', 'mode': 'numeric',
                        'variables': [], 'domain': 'real',
                        'step': {'stepId': 's1', 'prompt': 'Compute the intermediate value',
                                 'reference': '2', 'mode': 'numeric'}}
        self.source(answer='4', mode='calculation')
        self.service = NativeMathSources(self.vault, OWNER, self.loader, self.db)
    def source(self, **kw):
        if hasattr(self, 'support') and self.support.get('type') == 'calculation':
            config = json.dumps(self.support, ensure_ascii=False, separators=(',', ':'))
            return self.write('courses/lesson.md', f'''---
type: zhixue-content
zhixue: true
zhixue_id: lesson
zhixue_format: calculation
status: ready
---
| ID | 题干 | 答案 | 解析 | 学习配置 |
|---|---|---|---|---|
| q1 | Compute 2+2 | {kw.get('answer', '4')} | Addition | {config} |
''')
        return super().source(**kw)
    def test_math_capture_historical_integrity_and_native_hash(self):
        identity = self.identity()
        captured = self.service.capture(identity)
        self.assertEqual(captured['item']['practice']['answer'], '4')
        self.assertEqual(captured['item']['contentHash'], identity['contentHash'])
        self.source(answer='5')
        self.assertEqual(self.service.read(identity, captured['captureId']), captured)
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.service.verify_current(identity, captured['captureId'])
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE native_math_sources SET payload_hash=?", ('f'*64,))
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.service.read(identity, captured['captureId'])

# Do not inherit unrelated course test cases.
for name in list(course_fixture.NativeCourseSourceTests.__dict__):
    if name.startswith('test_'):
        setattr(NativeMathSourceTests, name, None)


class NativeMathServiceTests(NativeMathSourceTests):
    def setUp(self):
        super().setUp()
        self.capture = self.service.capture(self.identity())
        self.ledger = MathGradeLedger(self.db, OWNER, self.service.library, self.vault)
        self.app = NativeMathApplication(self.service, self.ledger, native_math_rules())
        identity = self.capture['identity']
        binding = {'ownerId': 'browser-owner', 'libraryId': identity['libraryId'],
                   'snapshotId': 'local', 'itemKey': identity['itemKey'],
                   'contentHash': identity['contentHash'], 'groupId': 'g1', 'roundId': 'r1'}
        self.claim = {'schemaVersion': 1, 'identity': identity, 'captureId': self.capture['captureId'],
                      'attempt': {'schemaVersion': 1, 'attemptId': 'a1', 'binding': binding,
                        'parentAttemptId': None, 'revision': 2, 'answerRevision': 1, 'answer': '4',
                        'updatedAt': '2026-10-08T00:00:00.000Z',
                        'checkpoint': {'phase': 'submitted', 'position': 0, 'traversed': True,
                                       'mode': 'calculation', 'purpose': 'first'},
                        'submitted': {'answer': '4', 'answerRevision': 1,
                                     'submittedAt': '2026-10-08T00:00:00.000Z', 'assistance': 'unknown'},
                        'evaluation': {'status': 'pending', 'reason': 'not-requested'},
                        'formal': None, 'operations': []},
                      'stepInput': {'text': '3', 'revision': 1, 'answerRevision': 1}}
        self.request = {'schemaVersion': 1, 'requestId': 'q1', 'attemptId': 'a1',
                        'answerRevision': 1, 'sourceVersion': identity['contentHash'], 'mode': 'final'}
    def test_claim_before_grade_independent_step_retry_and_no_event_tables(self):
        with self.assertRaisesRegex(ValueError, 'not-found'):
            self.app.evaluate(self.request)
        receipt = self.app.claim(self.claim)
        self.assertEqual(self.app.claim(copy.deepcopy(self.claim)), receipt)
        result = self.app.evaluate(self.request)
        self.assertEqual(result['final']['status'], 'correct')
        self.assertEqual(result['step']['status'], 'incorrect')
        self.assertEqual(self.app.evaluate(self.request), result)
        self.assertEqual(self.app.read({'schemaVersion': 1, 'attemptId': 'a1'})['claim']['attempt']['submitted']['answer'], '4')
        with closing(sqlite3.connect(self.db)) as db, db:
            tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        self.assertFalse(any('event' in name for name in tables))
    def test_claim_conflicts_owner_namespace_parent_revision_and_concurrency(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(self.app.claim, [self.claim, copy.deepcopy(self.claim)]))
        self.assertEqual(receipts[0], receipts[1])
        for mutate in ('answer', 'owner', 'capture'):
            bad = copy.deepcopy(self.claim)
            if mutate == 'answer': bad['attempt']['submitted']['answer'] = '9'
            if mutate == 'owner': bad['attempt']['binding']['ownerId'] = 'another-browser'
            if mutate == 'capture': bad['captureId'] = 'f'*64
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): self.app.claim(bad)
        bad = copy.deepcopy(self.claim)
        bad['attempt']['attemptId'] = 'child'
        bad['attempt']['parentAttemptId'] = 'missing'
        bad['attempt']['checkpoint']['purpose'] = 'remediation'
        with self.assertRaisesRegex(ValueError, 'parent'): self.app.claim(bad)
        bad = copy.deepcopy(self.request); bad['answerRevision'] = 2
        with self.assertRaisesRegex(ValueError, 'revision'): self.app.evaluate(bad)
    def test_source_change_keeps_raw_and_old_reference_unknown_blank_and_step_only(self):
        self.app.claim(self.claim)
        self.source(answer='5')
        result = self.app.evaluate(self.request)
        self.assertEqual(result['final']['status'], 'correct')
        step = self.app.evaluate({**self.request, 'requestId': 'q2', 'mode': 'step', 'stepRevision': 1})
        self.assertNotIn('final', step)
        self.assertEqual(step['step']['status'], 'incorrect')
        bad = copy.deepcopy(self.claim); bad['attempt']['attemptId'] = 'new'
        with self.assertRaisesRegex(ValueError, 'source-changed'): self.app.claim(bad)
    def test_formal_barrier_final_is_closed_step_recovery_is_open(self):
        self.app.claim(self.claim); self.app.evaluate(self.request)
        formal = {'schemaVersion': 1, 'action': 'formal', 'attemptId': 'a1', 'answerRevision': 1,
                  'sourceVersion': self.request['sourceVersion'], 'eventId': 'event1',
                  'evaluationHash': 'c'*64, 'occurredAt': '2026-10-08T00:00:00.000Z'}
        self.assertEqual(self.app.claim(formal), self.app.claim(formal))
        with self.assertRaisesRegex(ValueError, 'formal'): self.app.evaluate({**self.request, 'requestId': 'new'})
        self.assertNotIn('final', self.app.evaluate({**self.request, 'requestId': 'step', 'mode': 'step'}))
    def test_receipt_loss_prepared_recovery_conflicting_request_and_missing_source(self):
        self.app.claim(self.claim)
        begin = self.ledger.begin(self.request)
        raw = {'schemaVersion': 1, 'durable': True, **{k: self.request[k] for k in ('requestId', 'attemptId', 'answerRevision', 'sourceVersion')}, 'final': {'status':'correct','source':'deterministic','explanation':'Known'}}
        self.ledger.prepare(self.request, raw)
        recovered = self.app.evaluate(self.request)
        self.assertEqual(recovered['final']['status'], 'correct')
        with self.assertRaisesRegex(ValueError, 'request-conflict'):
            self.app.evaluate({**self.request, 'mode': 'step'})
        with closing(sqlite3.connect(self.db)) as db, db: db.execute('DELETE FROM native_math_sources')
        with self.assertRaises(ValueError): self.app.evaluate({**self.request, 'requestId':'missing-source'})
        self.assertEqual(self.ledger.read_attempt('a1')['claim']['attempt']['submitted']['answer'], '4')

    def test_unknown_wrong_and_blank_steps_are_not_formal(self):
        for name,answer,status in (('wrong','5','incorrect'),('unknown','not-a-number','undetermined'),('blank','','undetermined')):
            claim=copy.deepcopy(self.claim); claim['attempt']['attemptId']=name
            claim['attempt']['answer']=answer; claim['attempt']['submitted']['answer']=answer
            claim['stepInput']['text']=''
            self.app.claim(claim)
            result=self.app.evaluate({**self.request,'requestId':name,'attemptId':name})
            self.assertEqual(result['final']['status'],status)
            self.assertNotIn('step',result)
    def test_semantic_provider_failure_keeps_final_reliable_and_mock_success_bound(self):
        self.support['step']['mode']='semantic'; self.source()
        self.capture=self.service.capture(self.identity())
        self.claim['identity']=self.capture['identity']; self.claim['captureId']=self.capture['captureId']
        self.claim['attempt']['binding']['contentHash']=self.capture['identity']['contentHash']
        self.request['sourceVersion']=self.capture['identity']['contentHash']
        self.app.claim(self.claim)
        first=self.app.evaluate(self.request)
        self.assertEqual(first['final']['status'],'correct'); self.assertEqual(first['step']['status'],'undetermined')
        self.assertEqual(first['capability']['reason'],'explicit-step-request-required')
        def provider(data):
            return {**{key:data[key] for key in ('answerRevision','stepRevision','stepId','sourceVersion')},'status':'correct','source':'model','explanation':'Reference aligned'}
        self.app.semantic_step=provider
        result=self.app.evaluate({**self.request,'requestId':'semantic2','mode':'step'})
        self.assertEqual(result['step']['source'],'model'); self.assertNotIn('final',result)
    def test_symbolic_free_conditions_abstain_but_equivalence_is_reliable(self):
        self.support={'schemaVersion':2,'type':'calculation','mode':'symbolic','variables':['x'],'domain':'real','conditions':['x = 0']}
        self.source(answer='x'); self.capture=self.service.capture(self.identity())
        for name,answer,status in (('condition','2*x','undetermined'),('same','x','correct')):
            claim=copy.deepcopy(self.claim); claim.pop('stepInput')
            claim['identity']=self.capture['identity']; claim['captureId']=self.capture['captureId']
            claim['attempt']['binding']['contentHash']=self.capture['identity']['contentHash']
            claim['attempt']['attemptId']=name; claim['attempt']['answer']=answer; claim['attempt']['submitted']['answer']=answer
            self.app.claim(claim)
            result=self.app.evaluate({**self.request,'requestId':name,'attemptId':name,'sourceVersion':self.capture['identity']['contentHash']})
            self.assertEqual(result['final']['status'],status)
    def test_owner_library_scope_and_parent_claim_are_checked(self):
        self.app.claim(self.claim)
        other=MathGradeLedger(self.db,'2'*64,self.service.library,self.vault)
        self.assertIsNone(other.read_attempt('a1'))
        other=MathGradeLedger(self.db,OWNER,'local-vault:other',self.vault)
        self.assertIsNone(other.read_attempt('a1'))
        child=copy.deepcopy(self.claim); child['attempt']['attemptId']='child'; child['attempt']['parentAttemptId']='a1'
        child['attempt']['checkpoint']['purpose']='remediation'
        self.assertEqual(self.app.claim(child)['attemptId'],'child')
        changed=copy.deepcopy(self.claim); changed['attempt']['attemptId']='owner2'; changed['attempt']['binding']['ownerId']='owner2'
        with self.assertRaisesRegex(ValueError,'namespace'): self.app.claim(changed)
    def test_delayed_preparation_after_formal_barrier_cannot_replace_final(self):
        self.app.claim(self.claim); self.app.evaluate(self.request)
        delayed={**self.request,'requestId':'delayed'}; self.ledger.begin(delayed)
        self.app.claim({'schemaVersion':1,'action':'formal','attemptId':'a1','answerRevision':1,'sourceVersion':self.request['sourceVersion'],'eventId':'event1','evaluationHash':'c'*64,'occurredAt':'2026-10-08T00:00:00.000Z'})
        with self.assertRaisesRegex(ValueError,'formal'):
            self.ledger.prepare(delayed,{'schemaVersion':1,'durable':True,**{k:delayed[k] for k in ('requestId','attemptId','answerRevision','sourceVersion')},'final':{'status':'incorrect','source':'deterministic','explanation':'Late'}})
        self.assertEqual(self.app.evaluate(self.request)['final']['status'],'correct')
    def test_durable_budget_refuses_repeated_provider_key_and_day_limit(self):
        self.app.claim(self.claim); self.ledger.begin(self.request)
        settings={'maxOutputTokens':10,'dailyRequestLimit':1,'dailyTokenLimit':10000,'concurrentLimit':1}
        reservation=self.ledger.reserve('q1',{'text':'step'},settings)
        self.assertGreater(reservation,0)
        with self.assertRaisesRegex(ValueError,'outcome-unknown'): self.ledger.reserve('q1',{},settings)
        self.ledger.finish_budget('q1',5)
        self.ledger.begin({**self.request,'requestId':'budget2'})
        with self.assertRaisesRegex(ValueError,'daily-budget'): self.ledger.reserve('budget2',{},settings)

    def test_bidirectional_budget_caps_share_owner_under_same_sqlite_transaction(self):
        from test_native_course_service import Harness
        from infrastructure.course_grade_ledger import CourseGradeLedger
        h=Harness()
        self.addCleanup(h.close)
        self.ledger.clock=lambda:h.now
        course=CourseGradeLedger(self.db,OWNER,self.service.library,self.vault,clock=lambda:h.now)
        req=h.request(); req['identity']['libraryId']=self.service.library; req['binding']['libraryId']=self.service.library
        course.begin(req)
        self.app.claim(self.claim); self.ledger.begin(self.request)
        settings={**h.settings,'dailyRequestLimit':10,'dailyTokenLimit':100000,'concurrentLimit':1}
        self.ledger.reserve('q1',{'text':'step'},settings)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'): course.reserve(req,h.task,settings)
        self.ledger.finish_budget('q1')
        with self.assertRaisesRegex(ValueError,'daily-budget'): course.reserve(req,h.task,{**settings,'dailyRequestLimit':1})
        course.reserve(req,h.task,settings)
        second={**self.request,'requestId':'math2'}; self.ledger.begin(second)
        with self.assertRaisesRegex(ValueError,'concurrent-budget'): self.ledger.reserve('math2',{},settings)
        with self.assertRaisesRegex(ValueError,'daily-budget'): self.ledger.reserve('math2',{}, {**settings,'dailyRequestLimit':2})
    def test_claim_commit_failure_is_rollback_and_exact_retry_is_recoverable(self):
        from unittest import mock
        connect=sqlite3.connect
        class FailCommit(sqlite3.Connection):
            def commit(self): raise sqlite3.OperationalError('simulated commit loss')
        with mock.patch('infrastructure.math_grade_ledger.sqlite3.connect',side_effect=lambda *a,**kw:connect(*a,**kw,factory=FailCommit)):
            with self.assertRaises(sqlite3.OperationalError): self.app.claim(self.claim)
        self.assertIsNone(self.ledger.read_attempt('a1'))
        self.assertTrue(self.app.claim(self.claim)['durable'])
    def test_actual_http_math_source_claim_and_evaluate_with_real_adapter(self):
        import io
        import types
        from server_route_fixture import load_route_methods
        namespace={'json':json,'normalize_request_path':lambda path:path,'authenticate_session':lambda token:OWNER if token=='paired' else None,
            'allowed_origin':lambda origin:origin=='https://site.example','MAX_UPLOAD_BYTES':1500000,
            'source_path':lambda name:self.vault,'LOCAL_DATABASE_PATH':self.db,'effective_gateway':self.loader}
        post=load_route_methods(namespace)['do_POST']
        def send(path,payload):
            body=json.dumps(payload).encode(); response=[]
            req=types.SimpleNamespace(path=path,headers={'Origin':'https://site.example','X-Study-Loop-Session':'paired','Content-Length':str(len(body))},rfile=io.BytesIO(body),send_json=lambda status,data:response.append((status,data)))
            post(req); self.assertEqual(response[0][0],200,response)
            return response[0][1]
        source=send('/v1/math/source/capture',{'schemaVersion':1,'identity':self.capture['identity']})
        self.assertEqual(source['capture'],self.capture)
        send('/v1/math/claim',self.claim)
        evaluated=send('/v1/math/evaluate',self.request)
        self.assertEqual(evaluated['final']['status'],'correct')
        recovered=send('/v1/math/read',{'schemaVersion':1,'attemptId':'a1','requestId':'q1'})
        self.assertEqual(recovered['results'],[evaluated])
    def test_source_missing_reference_word_mode_ambiguity_and_ownership_are_rejected(self):
        from unittest import mock
        captured=self.capture
        other=NativeMathSources(self.vault,'2'*64,self.loader,self.db)
        with self.assertRaisesRegex(ValueError,'not-found'): other.read(captured['identity'],captured['captureId'])
        self.source(answer='')
        with self.assertRaisesRegex(ValueError,'math-reference'): self.service.capture(self.identity())
        self.source()
        identity=self.identity()
        load=self.service.catalog_loader
        def conflicting(vault,**kw):
            catalog=load(vault,**kw)
            catalog['subjects'][0]['items'].append(copy.deepcopy(catalog['subjects'][0]['items'][0]))
            return catalog
        self.service.catalog_loader=conflicting
        with self.assertRaisesRegex(ValueError,'source-not-found'): self.service.capture(identity)
        self.service.catalog_loader=load
        for mutation in ('word','mode'):
            def invalid(vault,**kw):
                catalog=load(vault,**kw)
                item=catalog['subjects'][0]['items'][0]
                if mutation=='word': item['word']='forged word'
                else: item['pluginType']='recall'
                return catalog
            self.service.catalog_loader=invalid
            with self.assertRaises(ValueError): self.service.capture(identity)
        self.service.catalog_loader=load
        (self.vault/'courses/lesson.md').unlink()
        self.assertEqual(self.service.read(captured['identity'],captured['captureId']),captured)

    def test_variant_descriptor_without_approved_port_is_saved_unavailable(self):
        claim=copy.deepcopy(self.claim)
        claim['variant']={'schemaVersion':1,'mappingId':'mapping1','parentItemKey':claim['identity']['itemKey'],'parentContentHash':claim['identity']['contentHash'],'hashKind':'content','templateVersion':1,'templateId':'sqrt-sign','seed':1,'parameters':{'x':-2},'variantHash':'d'*64}
        claim['attempt']['answer']='{"answerKind":"number","answer":"2"}'
        claim['attempt']['submitted']['answer']=claim['attempt']['answer']
        with self.assertRaisesRegex(ValueError,'remediation-required'): self.app.claim(claim)
        self.app.claim(self.claim)
        claim['attempt']['attemptId']='variant-child'
        claim['attempt']['parentAttemptId']='a1'
        claim['attempt']['checkpoint']['purpose']='remediation'
        self.app.claim(claim)
        result=self.app.evaluate({**self.request,'attemptId':'variant-child'})
        self.assertEqual(result['final']['status'],'undetermined'); self.assertEqual(result['capability']['variant'],'unavailable')
        self.assertEqual(self.ledger.read_attempt('variant-child')['claim']['attempt']['submitted']['answer'],claim['attempt']['answer'])
        bad=copy.deepcopy(claim); bad['variant']['answer']='forged reference'
        with self.assertRaises(ValueError): self.app.claim(bad)

    def test_parallel_math_course_reservations_admit_one_shared_owner_slot(self):
        from test_native_course_service import Harness
        from infrastructure.course_grade_ledger import CourseGradeLedger
        h=Harness(); self.addCleanup(h.close)
        self.ledger.clock=lambda:h.now
        course=CourseGradeLedger(self.db,OWNER,self.service.library,self.vault,clock=lambda:h.now)
        req=h.request(); req['identity']['libraryId']=self.service.library; req['binding']['libraryId']=self.service.library
        course.begin(req); self.app.claim(self.claim); self.ledger.begin(self.request)
        settings={**h.settings,'dailyRequestLimit':10,'dailyTokenLimit':100000,'concurrentLimit':1}
        def reserve(kind):
            try:
                return self.ledger.reserve('q1',{},settings) if kind=='math' else course.reserve(req,h.task,settings)
            except ValueError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(reserve,['math','course']))
        self.assertEqual(sum(type(result) is int for result in results),1,results)
        self.assertTrue(any(type(result) is str and 'concurrent-budget' in result for result in results),results)

    def test_configured_semantic_ai_only_runs_for_explicit_step_request(self):
        from unittest import mock
        from types import SimpleNamespace
        self.support['step']['mode']='semantic'
        self.source()
        self.capture=self.service.capture(self.identity())
        self.claim['identity']=self.capture['identity']
        self.claim['captureId']=self.capture['captureId']
        self.claim['attempt']['binding']['contentHash']=self.capture['identity']['contentHash']
        self.request['sourceVersion']=self.capture['identity']['contentHash']
        settings={'enabled':True,'configured':True,'provider':'deepseek','model':'test-model',
                  'baseUrl':'https://api.deepseek.com','maxOutputTokens':100,
                  'dailyRequestLimit':10,'dailyTokenLimit':20000,'concurrentLimit':1}
        store=SimpleNamespace(snapshot=mock.Mock(return_value=(settings,'synthetic-key')))
        services=SimpleNamespace(LOCAL_DATABASE_PATH=self.db,source_path=lambda name:self.vault,
                                 effective_gateway=self.loader,ai_store=lambda db:store)
        app=create_native_math_application(services,OWNER)
        app.claim(self.claim)
        def evaluate(settings,key,data,reservation):
            diagnostic={**{name:data[name] for name in ('answerRevision','stepRevision','stepId','sourceVersion')},
                        'status':'correct','source':'model','explanation':'Reference aligned'}
            return diagnostic,20
        with mock.patch('infrastructure.math_step_provider.evaluate_semantic',side_effect=evaluate) as provider:
            final=app.evaluate(self.request)
            self.assertEqual(provider.call_count,0)
            store.snapshot.assert_not_called()
            self.assertEqual(final['final']['status'],'correct')
            self.assertEqual(final['step']['status'],'undetermined')
            self.assertEqual(final['step']['source'],'none')
            self.assertEqual(final['capability']['reason'],'explicit-step-request-required')
            with closing(sqlite3.connect(self.db)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM native_math_budget').fetchone()[0],0)
            self.assertEqual(app.read({'schemaVersion':1,'attemptId':'a1'})['claim']['stepInput'],self.claim['stepInput'])
            step_request={**self.request,'requestId':'explicit-step','mode':'step','stepRevision':1}
            diagnosed=app.evaluate(step_request)
            self.assertEqual(provider.call_count,1)
            self.assertEqual(diagnosed['step']['source'],'model')
            self.assertNotIn('final',diagnosed)
            self.assertEqual(app.evaluate(step_request),diagnosed)
            self.assertEqual(provider.call_count,1)
            self.assertEqual(app.evaluate(self.request)['final'],final['final'])

if __name__ == '__main__': unittest.main()
