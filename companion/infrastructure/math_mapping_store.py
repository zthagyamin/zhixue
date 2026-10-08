"""Historical reviewed native content mappings; authenticated immutable SQLite authority."""
import copy
import json
import sqlite3
from contextlib import closing
from account_sync_schema import canonical_json, study_hash
from native_math_schema import parse_mapping_request, parse_preparation, parse_variant_request
from learning_support import _normalized_calculation_text
from infrastructure.math_variant_rules import create_variant, grade_variant_final

SCHEMA='''CREATE TABLE IF NOT EXISTS native_math_mappings(
    owner TEXT, library TEXT, root TEXT, capture_id TEXT, item_key TEXT, content_hash TEXT,
    mapping_id TEXT, payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
    PRIMARY KEY(owner,library,root,capture_id,item_key,content_hash,mapping_id))'''


class MathMappingStore:
    def __init__(self,path,sources,ledger):
        self.path,self.sources,self.ledger=path,sources,ledger

    def _key(self,identity,capture_id,mapping_id):
        return (*self.ledger.scope,capture_id,identity['itemKey'],identity['contentHash'],mapping_id)

    def _validate(self,capture,preparation):
        preparation=parse_preparation(preparation)
        mapping=preparation['mapping'];identity=capture['identity']
        support=capture['item'].get('learningSupport') or {}
        conditions=support.get('conditions')
        if (support.get('schemaVersion')!=2 or support.get('variantMappingId')!=mapping['mappingId']
                or not conditions or not mapping['sourceConditions']
                or sorted(_normalized_calculation_text(x) for x in conditions)!=sorted(_normalized_calculation_text(x) for x in mapping['sourceConditions'])):
            raise ValueError('native-math-mapping-source-conditions-conflict')
        if (mapping['parentItemKey']!=identity['itemKey'] or mapping['parentContentHash']!=identity['contentHash']
                or mapping['hashKind']!='content'):
            raise ValueError('native-math-mapping-parent-conflict')
        if preparation['review']['sourceQuote'] not in capture['item']['practice']['prompt']:
            raise ValueError('native-math-mapping-review-source-conflict')
        return preparation

    def _verified(self,raw,capture):
        try:
            record=json.loads(raw[0]);body={k:v for k,v in record.items() if k!='receiptHash'}
            if (set(record)!={'schemaVersion','identity','captureId','preparation','receiptHash'}
                    or type(record['schemaVersion']) is not int or record['schemaVersion']!=1 or study_hash(record)!=raw[1]
                    or record['receiptHash']!=study_hash(body) or record['identity']!=capture['identity']
                    or record['captureId']!=capture['captureId']):
                raise ValueError('native-math-mapping-integrity')
            self._validate(capture,record['preparation'])
            return record
        except (ValueError,KeyError,TypeError) as error:
            raise ValueError('native-math-mapping-integrity') from error

    def read_record(self,capture):
        mapping_id=(capture['item'].get('learningSupport') or {}).get('variantMappingId')
        if not mapping_id or not self.sources.store_path.exists():
            return None
        with closing(sqlite3.connect(self.sources.store_path.resolve().as_uri()+'?mode=ro',uri=True,timeout=10)) as db:
            try:
                raw=db.execute('SELECT payload,payload_hash FROM native_math_mappings WHERE owner=? AND library=? AND root=? AND capture_id=? AND item_key=? AND content_hash=? AND mapping_id=?',self._key(capture['identity'],capture['captureId'],mapping_id)).fetchone()
            except sqlite3.OperationalError:
                return None
        return copy.deepcopy(self._verified(raw,capture)) if raw else None

    def mapping(self,action,payload):
        row=parse_mapping_request(payload,action)
        capture=self.sources.read(row['identity'],row['captureId'])
        if action=='read':
            record=self.read_record(capture)
            return {'schemaVersion':1,'durable':True,'status':'available','record':record} if record else {'schemaVersion':1,'durable':True,'status':'unavailable','reason':'missing-approved-mapping'}
        preparation=self._validate(capture,row['preparation'])
        body={'schemaVersion':1,'identity':capture['identity'],'captureId':capture['captureId'],'preparation':preparation}
        record={**body,'receiptHash':study_hash(body)}
        key=self._key(capture['identity'],capture['captureId'],preparation['mapping']['mappingId'])
        self.sources.store_path.parent.mkdir(parents=True,exist_ok=True)
        with closing(sqlite3.connect(self.path,timeout=10)) as db:
            try:
                db.execute('BEGIN IMMEDIATE');db.execute(SCHEMA)
                raw=db.execute('SELECT payload,payload_hash FROM native_math_mappings WHERE owner=? AND library=? AND root=? AND capture_id=? AND item_key=? AND content_hash=? AND mapping_id=?',key).fetchone()
                if raw:
                    old=self._verified(raw,capture)
                    status='duplicate' if old==record else 'conflict'
                    record=old
                else:
                    db.execute('INSERT INTO native_math_mappings VALUES (?,?,?,?,?,?,?,?,?)',(*key,canonical_json(record),study_hash(record)))
                    status='accepted'
                db.commit()
            except BaseException:
                db.rollback();raise
        return {'schemaVersion':1,'durable':True,'status':status,'record':copy.deepcopy(record)}

    def _parent(self,claim):
        a=claim['attempt']
        if not a['parentAttemptId'] or a['checkpoint'].get('purpose')!='remediation':
            raise ValueError('native-math-variant-remediation-required')
        parent=self.ledger.read_attempt(a['parentAttemptId'])
        if (not parent or 'variant' in parent['claim']
                or any(parent['claim'][key]!=claim[key] for key in ('identity','captureId'))
                or parent['claim']['attempt']['binding']!=a['binding']):
            raise ValueError('native-math-variant-parent-conflict')
        return parent['claim']

    def resolve(self,capture,descriptor):
        record=self.read_record(capture)
        if not record:
            return None
        mapping=record['preparation']['mapping']
        variant=create_variant({key:mapping[key] for key in ('parentItemKey','parentContentHash','hashKind')},mapping['templateId'],descriptor['seed'],mapping['parameters'])
        expected=self.descriptor(mapping,variant)
        if descriptor!=expected:
            raise ValueError('native-math-variant-mapping-conflict')
        return variant

    def validate_claim(self,claim):
        self._parent(claim)
        capture=self.sources.read(claim['identity'],claim['captureId'])
        # Missing approved mapping keeps the durable answer pending; it cannot
        # bypass the actual-parent/remediation check or grade the parent answer.
        return self.resolve(capture,claim['variant'])

    @staticmethod
    def descriptor(mapping,variant):
        return {'schemaVersion':1,**{k:mapping[k] for k in ('mappingId','parentItemKey','parentContentHash','hashKind','templateVersion','templateId')},
            **{k:variant[k] for k in ('seed','parameters','variantHash')}}

    def variant(self,payload):
        row=parse_variant_request(payload)
        capture=self.sources.read(row['identity'],row['captureId'])
        saved=self.ledger.read_attempt(row['attemptId'])
        if (not saved or 'variant' in saved['claim'] or saved['claim']['identity']!=row['identity']
                or saved['claim']['captureId']!=row['captureId']):
            return {'schemaVersion':1,'status':'unavailable','reason':'submitted-parent-unavailable'}
        record=self.read_record(capture)
        if not record:
            return {'schemaVersion':1,'status':'unavailable','reason':'missing-approved-mapping'}
        mapping=record['preparation']['mapping']
        variant=create_variant({k:mapping[k] for k in ('parentItemKey','parentContentHash','hashKind')},mapping['templateId'],row['seed'],mapping['parameters'])
        return {'schemaVersion':1,'status':'available','variant':variant,'descriptor':self.descriptor(mapping,variant),'mapping':copy.deepcopy(mapping)}

    def grade(self,capture,descriptor,answer):
        variant=self.resolve(capture,descriptor)
        if variant is None:
            raise ValueError('native-math-variant-mapping-unavailable')
        return grade_variant_final(variant,answer)
