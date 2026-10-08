"""Reviewed synthetic mappings and actual Node/Python bounded-template parity."""
import copy
import json
import sqlite3
import sys
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import test_native_math_service as fixtures
from contextlib import closing
OWNER=fixtures.OWNER
from infrastructure.math_mapping_store import MathMappingStore
from infrastructure.math_variant_rules import create_variant, seeded_parameters, grade_variant_final


class NativeMathMappingTests(fixtures.NativeMathServiceTests):
    def source(self, **kw):
        super().source(**kw)
        if hasattr(self, "prompt"):
            path=self.vault/"courses/lesson.md"
            self.write("courses/lesson.md",path.read_text(encoding="utf-8").replace("Compute 2+2",self.prompt))

    def setUp(self):
        super().setUp()
        self.prompt='For nonnegative real x = 2, compute sqrt(x^2).'
        self.support['conditions'] = ['Real x, x is nonnegative']
        self.support['variantMappingId'] = 'reviewed.sqrt'
        self.source()
        self.capture = self.service.capture(self.identity())
        self.claim['identity'] = self.capture['identity']
        self.claim['captureId'] = self.capture['captureId']
        self.claim['attempt']['binding']['contentHash'] = self.capture['identity']['contentHash']
        self.request['sourceVersion'] = self.capture['identity']['contentHash']
        self.store = MathMappingStore(self.db, self.service, self.ledger)
        self.app.mapping_service = self.store
        self.app.variant_mapping = self.store.grade
        self.mapping = {'schemaVersion':1,'mappingId':'reviewed.sqrt',
            'parentItemKey':self.capture['identity']['itemKey'],
            'parentContentHash':self.capture['identity']['contentHash'],'hashKind':'content',
            'templateVersion':1,'templateId':'sqrt-sign','parameters':{'x':2},
            'sourceConditions':['Real x, x is nonnegative']}
        self.preparation = {'schemaVersion':1,'snapshotId':'local','mapping':self.mapping,
            'review':{'sourceQuote':self.prompt,
                'rationale':'Reviewed synthetic nonnegative real input: numerical root variant tests the stated sign condition.'}}
        self.refs = {'schemaVersion':1,'identity':self.capture['identity'],'captureId':self.capture['captureId']}
        self.publish = {**self.refs,'preparation':self.preparation}

    def test_node_python_four_templates_hash_and_definitions(self):
        fixture = json.loads((Path(__file__).parent/'fixtures/stage3-math-variant-parity.json').read_text(encoding='utf-8'))
        self.assertEqual({r['templateId'] for r in fixture}, {'cancel-domain','sqrt-sign','context-linear','inverse-linear'})
        for row in fixture:
            with self.subTest(template=row['templateId'], seed=row['seed'], parameters=row.get('parameters')):
                self.assertEqual(seeded_parameters(row['templateId'],row['seed']), row['seededParameters'])
                self.assertEqual(create_variant(row['parent'],row['templateId'],row['seed'],row.get('parameters')), row['variant'])
                for actual, expected in row['grades']:
                    self.assertEqual(grade_variant_final(row['variant'],json.dumps(actual)),expected)

    def test_publish_read_immutable_duplicate_conflict_race(self):
        self.assertEqual(self.app.mapping('read',self.refs)['status'],'unavailable')
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts=list(pool.map(lambda _:self.app.mapping('publish',copy.deepcopy(self.publish)),range(2)))
        self.assertEqual(sorted(r['status'] for r in receipts),['accepted','duplicate'])
        available=self.app.mapping('read',self.refs)
        self.assertEqual(available['record']['preparation'],self.preparation)
        conflicting=copy.deepcopy(self.publish); conflicting['preparation']['mapping']['parameters']['x']=3
        self.assertEqual(self.app.mapping('publish',conflicting)['status'],'conflict')
        self.assertEqual(self.app.mapping('read',self.refs),available)
        self.assertEqual(self.app.mapping('publish',self.publish)['status'],'duplicate')

    def test_shared_review_quote_boundaries_preserve_source_prompt_limit(self):
        contract=json.loads((Path(__file__).parent/'fixtures/native-math-mapping-boundaries-v1.json').read_text(encoding='utf-8'))
        for row in contract['cases']:
            with self.subTest(case=row['name']):
                self.prompt='q'*row.get('promptLength',min(contract['nativePromptMaximum'],row['quoteLength']))
                self.source();capture=self.service.capture(self.identity())
                self.assertEqual(len(capture['item']['practice']['prompt']),len(self.prompt))
                publish=copy.deepcopy(self.publish)
                publish['identity']=capture['identity'];publish['captureId']=capture['captureId']
                publish['preparation']['mapping']['parentContentHash']=capture['identity']['contentHash']
                publish['preparation']['review']['sourceQuote']='q'*row['quoteLength']
                if row['accepted']:
                    self.assertEqual(self.app.mapping('publish',publish)['status'],'accepted')
                else:
                    with self.assertRaisesRegex(ValueError,'too-long-math-source-quote'):
                        self.app.mapping('publish',publish)

    def test_two_source_conditions_are_normalized_unordered_with_duplicates_rejected(self):
        self.support['conditions']=['Real x','x is nonnegative']
        self.source();capture=self.service.capture(self.identity())
        publish=copy.deepcopy(self.publish)
        publish['identity']=capture['identity'];publish['captureId']=capture['captureId']
        publish['preparation']['mapping']['parentContentHash']=capture['identity']['contentHash']
        publish['preparation']['mapping']['sourceConditions']=[' X  is nonnegative ',' REAL x ']
        self.assertEqual(self.app.mapping('publish',publish)['status'],'accepted')
        duplicate=copy.deepcopy(publish)
        duplicate['preparation']['mapping']['sourceConditions']=['x is nonnegative','X   is nonnegative']
        with self.assertRaisesRegex(ValueError,'conditions-invalid'):
            self.app.mapping('publish',duplicate)
        mismatch=copy.deepcopy(publish)
        mismatch['preparation']['mapping']['sourceConditions']=['Real x','x is negative']
        with self.assertRaisesRegex(ValueError,'source-conditions-conflict'):
            self.app.mapping('publish',mismatch)

    def test_preparation_closed_review_conditions_and_parent(self):
        for mutation in ('review','quote','rationale','conditions','empty','mapping-id','hash-kind','parent','extra'):
            bad=copy.deepcopy(self.publish)
            if mutation=='review': bad['preparation'].pop('review')
            if mutation=='quote': bad['preparation']['review']['sourceQuote']='Uncaptured question'
            if mutation=='rationale': bad['preparation']['review']['rationale']='ok'
            if mutation=='conditions': bad['preparation']['mapping']['sourceConditions']=['Unrelated x condition']
            if mutation=='empty': bad['preparation']['mapping']['sourceConditions']=[]
            if mutation=='mapping-id': bad['preparation']['mapping']['mappingId']='other'
            if mutation=='hash-kind': bad['preparation']['mapping']['hashKind']='visible-snapshot'
            if mutation=='parent': bad['preparation']['mapping']['parentContentHash']='f'*64
            if mutation=='extra': bad['preparation']['approved']=True
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.app.mapping('publish',bad)
        bad=copy.deepcopy(self.publish);bad['captureId']='f'*64
        with self.assertRaises(ValueError): self.app.mapping('publish',bad)

    def test_actual_parent_variant_and_historical_source_no_formal_grade(self):
        self.app.mapping('publish',self.publish)
        request={**self.refs,'attemptId':'a1','seed':4294967295}
        self.assertEqual(self.app.variant(request)['status'],'unavailable')
        self.app.claim(self.claim)
        result=self.app.variant(request)
        self.assertEqual(result['status'],'available')
        self.source(answer='5')
        self.assertEqual(self.app.variant(request),result)
        self.assertEqual(self.app.mapping('read',self.refs)['status'],'available')
        child=copy.deepcopy(self.claim);child.pop('stepInput')
        child['attempt']['attemptId']='child'; child['attempt']['parentAttemptId']='a1'
        child['attempt']['checkpoint']['purpose']='remediation'
        child['variant']=result['descriptor']
        answer=json.dumps({'answerKind':'number','answer':'2'})
        child['attempt']['answer']=answer;child['attempt']['submitted']['answer']=answer
        self.app.claim(child)
        graded=self.app.evaluate({**self.request,'attemptId':'child','requestId':'variant-final'})
        self.assertEqual(graded['final']['status'],'correct');self.assertNotIn('step',graded)
        self.assertEqual(self.app.evaluate({**self.request,'attemptId':'child','requestId':'variant-final'}),graded)
        with self.assertRaisesRegex(ValueError,'variant-step-unavailable'):
            self.app.evaluate({**self.request,'attemptId':'child','requestId':'variant-step','mode':'step'})
        with self.assertRaisesRegex(ValueError,'formal-ineligible'):
            self.app.claim({'schemaVersion':1,'action':'formal','attemptId':'child','answerRevision':1,
                'sourceVersion':self.request['sourceVersion'],'eventId':'e1','evaluationHash':'c'*64,
                'occurredAt':'2026-10-08T00:00:00.000Z'})
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM native_math_formal').fetchone()[0],0)
            self.assertEqual(db.execute("SELECT count(*) FROM native_math_requests WHERE request_id='variant-step'").fetchone()[0],0)

    def test_reviewed_four_captured_source_fixtures_and_kind_grades(self):
        from infrastructure.math_variant_rules import define_math
        fixtures_data=[
            ('cancel-domain',{'k':2,'nonzero':0},['Real x may equal 0'],'Cancel only after splitting zero from nonzero real inputs.'),
            ('sqrt-sign',{'x':-2},['x is a negative real number'],'Principal square root is nonnegative; negative input requires absolute value.'),
            ('context-linear',{'rate':2,'baseline':3,'target':13},['Constant positive rate; target is at least baseline'],'Affine time model must subtract its baseline before dividing by a positive rate.'),
            ('inverse-linear',{'x':0,'b':3,'y':3},['a is real; sample coefficient is zero'],'A zero sample coefficient with consistent constant leaves every real coefficient possible.'),
        ]
        for template,params,conditions,reason in fixtures_data:
            with self.subTest(template=template):
                definition=define_math(template,params)
                self.prompt=definition['prompt']
                self.support={'schemaVersion':2,'type':'calculation','mode':'numeric','variables':[],
                    'domain':'real','conditions':conditions,'variantMappingId':'reviewed.'+template}
                answer=definition['answer'] or definition['answerKind']
                self.source(answer=answer)
                captured=self.service.capture(self.identity())
                refs={'schemaVersion':1,'identity':captured['identity'],'captureId':captured['captureId']}
                mapping={**self.mapping,'mappingId':self.support['variantMappingId'],'templateId':template,
                    'parameters':params,'sourceConditions':conditions,
                    'parentItemKey':captured['identity']['itemKey'],'parentContentHash':captured['identity']['contentHash']}
                prepared={'schemaVersion':1,'snapshotId':'local','mapping':mapping,
                    'review':{'sourceQuote':self.prompt,'rationale':'Reviewed synthetic fixture: '+reason}}
                before={str(path):path.read_bytes() for path in self.vault.rglob('*.md')}
                self.assertEqual(self.app.mapping('publish',{**refs,'preparation':prepared})['status'],'accepted')
                parent=copy.deepcopy(self.claim);parent.pop('stepInput')
                parent['identity']=captured['identity'];parent['captureId']=captured['captureId']
                parent['attempt']['binding']['contentHash']=captured['identity']['contentHash']
                parent['attempt']['attemptId']='original-'+template
                parent['attempt']['answer']=answer;parent['attempt']['submitted']['answer']=answer
                # Guided and temporary originals remain legitimate submitted parents.
                parent['attempt']['checkpoint']['purpose']='guided'
                self.app.claim(parent)
                generated=self.app.variant({**refs,'attemptId':parent['attempt']['attemptId'],'seed':7})
                child=copy.deepcopy(parent);child['variant']=generated['descriptor']
                child['attempt']['attemptId']='child-'+template;child['attempt']['parentAttemptId']=parent['attempt']['attemptId']
                child['attempt']['checkpoint']['purpose']='remediation'
                value=json.dumps({'answerKind':definition['answerKind'],'answer':definition['answer']})
                child['attempt']['answer']=value;child['attempt']['submitted']['answer']=value
                self.app.claim(child)
                request={**self.request,'requestId':'result-'+template,'attemptId':child['attempt']['attemptId'],
                    'sourceVersion':captured['identity']['contentHash']}
                graded=self.app.evaluate(request)
                self.assertEqual(graded['final']['status'],'correct');self.assertNotIn('step',graded)
                self.assertEqual(before,{str(path):path.read_bytes() for path in self.vault.rglob('*.md')})

    def test_scope_conditions_normalization_integrity_and_missing_source(self):
        normalized=copy.deepcopy(self.publish)
        normalized['preparation']['mapping']['sourceConditions']=['  REAL x,  x is nonnegative  ']
        self.assertEqual(self.app.mapping('publish',normalized)['status'],'accepted')
        from infrastructure.math_source_capture import NativeMathSources
        from infrastructure.math_grade_ledger import MathGradeLedger
        other_source=NativeMathSources(self.vault,'2'*64,self.loader,self.db)
        other_ledger=MathGradeLedger(self.db,'2'*64,other_source.library,self.vault)
        other=MathMappingStore(self.db,other_source,other_ledger)
        with self.assertRaisesRegex(ValueError,'not-found'): other.mapping('read',self.refs)
        for identity_key in ('libraryId','itemKey','contentHash','localBindingHash'):
            bad=copy.deepcopy(self.refs)
            bad['identity'][identity_key]='local-vault:other' if identity_key=='libraryId' else 'practice:foreign' if identity_key=='itemKey' else 'f'*64
            with self.subTest(field=identity_key),self.assertRaises(ValueError): self.app.mapping('read',bad)
        # A separate configured root with identical source bytes still has no access.
        import tempfile
        with tempfile.TemporaryDirectory() as another:
            foreign=MathGradeLedger(self.db,OWNER,self.service.library,another)
            self.assertIsNone(MathMappingStore(self.db,self.service,foreign).read_record(self.capture))
        with closing(sqlite3.connect(self.db)) as db,db:
            db.execute("UPDATE native_math_mappings SET payload_hash=?",('f'*64,))
        with self.assertRaisesRegex(ValueError,'integrity'): self.app.mapping('read',self.refs)
        with closing(sqlite3.connect(self.db)) as db,db:
            db.execute('DELETE FROM native_math_sources')
        with self.assertRaisesRegex(ValueError,'not-found'): self.app.mapping('read',self.refs)

    def test_commit_loss_and_response_loss_retry_do_not_republish(self):
        from unittest import mock
        connect=sqlite3.connect
        class FailCommit(sqlite3.Connection):
            def commit(self): raise sqlite3.OperationalError('simulated receipt loss')
        with mock.patch('infrastructure.math_mapping_store.sqlite3.connect',side_effect=lambda *a,**kw:connect(*a,**kw,factory=FailCommit)):
            with self.assertRaises(sqlite3.OperationalError): self.app.mapping('publish',self.publish)
        self.assertEqual(self.app.mapping('read',self.refs)['status'],'unavailable')
        accepted=self.app.mapping('publish',self.publish)
        retried=self.app.mapping('publish',copy.deepcopy(self.publish))
        self.assertEqual(retried['status'],'duplicate');self.assertEqual(retried['record'],accepted['record'])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM native_math_mappings').fetchone()[0],1)

    def test_source_without_authored_conditions_cannot_receive_mapping(self):
        for conditions in (None,[]):
            self.support.pop('conditions',None)
            if conditions is not None: self.support['conditions']=conditions
            self.source();capture=self.service.capture(self.identity())
            bad=copy.deepcopy(self.publish);bad['identity']=capture['identity'];bad['captureId']=capture['captureId']
            bad['preparation']['mapping']['parentContentHash']=capture['identity']['contentHash']
            with self.subTest(conditions=conditions),self.assertRaisesRegex(ValueError,'source-conditions-conflict'):
                self.app.mapping('publish',bad)

    def test_real_handler_protected_mapping_and_variant_paths(self):
        import io
        import types
        from unittest import mock
        import routes_math
        from server_route_fixture import load_route_methods
        namespace={'json':json,'normalize_request_path':lambda path:path,'authenticate_session':lambda token:OWNER if token=='paired' else None,
            'allowed_origin':lambda origin:origin=='https://site.example','MAX_UPLOAD_BYTES':1500000,
            'source_path':lambda name:self.vault,'LOCAL_DATABASE_PATH':self.db,'effective_gateway':self.loader}
        post=load_route_methods(namespace)['do_POST']
        def send(path,payload,token='paired',origin='https://site.example'):
            body=json.dumps(payload).encode();responses=[]
            headers={'X-Study-Loop-Session':token,'Content-Length':str(len(body))}
            if origin is not None: headers['Origin']=origin
            req=types.SimpleNamespace(path=path,headers=headers,rfile=io.BytesIO(body),send_json=lambda status,data:responses.append((status,data)))
            post(req);return responses[0]
        for suffix in ('mapping/publish','mapping/read','variant'):
            for token in ('','expired'):
                self.assertEqual(send('/v1/math/'+suffix,{},token=token)[0],401)
            for origin in (None,'null','https://other.example'):
                self.assertEqual(send('/v1/math/'+suffix,{},origin=origin)[0],403)
        self.assertEqual(send('/v1/math/mapping/read',self.refs)[1]['status'],'unavailable')
        published=send('/v1/math/mapping/publish',self.publish)
        self.assertEqual(published[0],200,published);self.assertEqual(published[1]['status'],'accepted')
        self.assertEqual(send('/v1/math/mapping/read',self.refs)[1]['status'],'available')
        self.app.claim(self.claim)
        result=send('/v1/math/variant',{**self.refs,'attemptId':'a1','seed':7})
        self.assertEqual(result[0],200,result);self.assertEqual(result[1]['status'],'available')
        # Caller definition, reference or snapshot binding are closed-protocol errors.
        for addition in ('definition','expectedAnswer','binding','ownerId'):
            bad={**self.refs,'attemptId':'a1','seed':7,addition:{}}
            self.assertEqual(send('/v1/math/variant',bad)[0],400)
        self.assertEqual(send('/v1/math/mapping/publish-extra',self.publish)[0],404)

    def test_missing_mapping_stays_pending_and_variant_requires_first_parent(self):
        self.app.claim(self.claim)
        variant=create_variant({'parentItemKey':self.mapping['parentItemKey'],'parentContentHash':self.mapping['parentContentHash'],'hashKind':'content'},'sqrt-sign',1,{'x':2})
        child=copy.deepcopy(self.claim); child.pop('stepInput')
        descriptor={k:variant[k] for k in ('schemaVersion','templateVersion','templateId','seed','parameters','variantHash')}
        descriptor.update({k:self.mapping[k] for k in ('mappingId','parentItemKey','parentContentHash','hashKind')})
        child['variant']=descriptor
        for parent,purpose in ((None,'first'),(None,'remediation'),('missing','remediation'),('a1','guided')):
            bad=copy.deepcopy(child);bad['attempt']['attemptId']='bad'
            bad['attempt']['parentAttemptId']=parent;bad['attempt']['checkpoint']['purpose']=purpose
            with self.subTest(parent=parent,purpose=purpose), self.assertRaises(ValueError): self.app.claim(bad)
        child['attempt']['attemptId']='child';child['attempt']['parentAttemptId']='a1';child['attempt']['checkpoint']['purpose']='remediation'
        self.app.claim(child)
        result=self.app.evaluate({**self.request,'attemptId':'child','requestId':'pending'})
        self.assertEqual(result['final']['status'],'undetermined');self.assertEqual(result['capability']['variant'],'unavailable')
        self.app.mapping('publish',self.publish)
        bad=copy.deepcopy(child);bad['attempt']['attemptId']='hash-change';bad['variant']['variantHash']='f'*64
        with self.assertRaises(ValueError): self.app.claim(bad)
        for field in ('ownerId','groupId','roundId'):
            bad=copy.deepcopy(child);bad['attempt']['attemptId']='foreign-'+field;bad['attempt']['binding'][field]='other'
            with self.subTest(field=field),self.assertRaises(ValueError): self.app.claim(bad)
        self.assertEqual(self.app.variant({**self.refs,'attemptId':'child','seed':1})['status'],'unavailable')

# Reuse setup, not inherited service assertions.
for name in dir(fixtures.NativeMathServiceTests):
    if name.startswith('test_') and name not in NativeMathMappingTests.__dict__:
        setattr(NativeMathMappingTests,name,None)

if __name__=='__main__': unittest.main()
