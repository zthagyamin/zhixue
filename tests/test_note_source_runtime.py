import copy
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from external_sources import ExternalSources
from note_source_runtime import SourceRuntime,has_history,setup_status
from source_results import read_results
from note_source_api import dispatch
import companion_setup
from test_external_sources import Keys,OWNER,OTHER
from test_notion_writeback import FakeNotion

FIXTURE=json.loads((Path(__file__).parent/'fixtures/account-study-v1.json').read_text(encoding='utf-8'))

class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.data=self.root/'data';self.data.mkdir();self.vault=self.root/'vault';self.vault.mkdir()
    def test_rotating_scan_is_owner_scoped_and_does_not_skip_equal_library_sequences(self):
        practice=next(r for r in FIXTURE['records'] if r['event'].get('eventType')=='practice-attempt')
        with closing(sqlite3.connect(self.data/'account-study.db')) as db, db:
            db.execute('CREATE TABLE account_inbox_records(account_id,sequence,record_json,status)')
            for owner,status in [(OWNER,'pending'),(OWNER,'applied'),(OTHER,'applied')]:db.execute('INSERT INTO account_inbox_records VALUES(?,?,?,?)',(owner,1,json.dumps(practice),status))
        rows,cursor=read_results(self.data,OWNER,lambda v:v,limit=1);self.assertEqual(rows,[])
        rows,cursor=read_results(self.data,OWNER,lambda v:v,cursor,limit=1);self.assertEqual(len(rows),1)
        rows,cursor=read_results(self.data,OWNER,lambda v:v,cursor,limit=1);self.assertEqual(rows,[]);self.assertEqual(cursor['account'],0)
        with closing(sqlite3.connect(self.data/'account-study.db')) as db, db:db.execute("UPDATE account_inbox_records SET status='applied' WHERE rowid=1")
        rows,_=read_results(self.data,OWNER,lambda v:v,cursor,limit=1);self.assertEqual(len(rows),1)
    def test_api_to_background_to_notion_receipt_survives_restart(self):
        class Client(FakeNotion):
            def read_page(self,page):return {'key':page,'title':'学习笔记','markdown':'## Topic\nOriginal concept.','url':'https://www.notion.so/'+page}
            def request(self,*args):return {}
        client=Client();keys=Keys()
        def store():return ExternalSources(self.data,lambda:self.vault,keys,verify_owner=lambda o:o==OWNER,client_factory=lambda key:client)
        service=store();runtime=SourceRuntime(service,lambda v:v)
        status,body=dispatch(service,OWNER,'POST',{'action':'preview','selection':{'kind':'notion','label':'Notion','pages':['1'*32],'token':'temporary-test-only','writeEnabled':True,'writePage':'2'*32}})
        self.assertEqual(status,200)
        status,body=dispatch(service,OWNER,'POST',{'action':'commit','previewId':body['preview']['previewId'],'confirmed':True});self.assertEqual(status,200)
        source=body['source']['sourceId'];manifest=json.loads(service._row(OWNER,source)['manifest_json']);item=next(iter(manifest['items']))
        event=copy.deepcopy(next(r['event'] for r in FIXTURE['records'] if r['event'].get('eventType')=='practice-attempt'));event['item']['key']='practice:'+item
        # The scanner validator is injected here; schema integrity is independently
        # covered by the account fixture and native event contract suites.
        with closing(sqlite3.connect(self.data/'study-loop.db')) as db, db:
            db.execute('CREATE TABLE study_events_v3(account_id,event_json,local_context_json)');db.execute('CREATE TABLE study_event_projections(account_id,event_id,status)')
            db.execute('INSERT INTO study_events_v3 VALUES(?,?,?)',(OWNER,json.dumps(event),'{}'));db.execute('INSERT INTO study_event_projections VALUES(?,?,?)',(OWNER,event['eventId'],'pending'))
        runtime.tick(OWNER);self.assertEqual(client.appends,0)
        with closing(sqlite3.connect(self.data/'study-loop.db')) as db, db:db.execute("UPDATE study_event_projections SET status='applied'")
        runtime.tick(OWNER);self.assertEqual(client.appends,1);self.assertEqual(service.list(OWNER)[0]['writeback']['written'],1)
        SourceRuntime(store(),lambda v:v).tick(OWNER);self.assertEqual(client.appends,1)
        # Updating a source must not erase ownership of already saved attempts.
        client.read_page=lambda page:{'key':page,'title':'学习笔记','markdown':'## Changed topic\nReplacement concept.','url':'https://www.notion.so/'+page}
        service.sync(OWNER,source)
        event['eventId']='history-retained-attempt';event['coreHash']='d'*64
        service.deliver_results(OWNER,source,[{'event':event}]);self.assertEqual(client.appends,2)
        selection={'sourceId':source,'expectedRevision':1,'kind':'notion','label':'Notion','pages':['1'*32],'writeEnabled':True,'writePage':'3'*32}
        prepared=service.preview(OWNER,selection)
        service.outbox.enqueue(OWNER,source,'2'*32,'arrived-after-preview','e'*64,'2026-09-08','Saved actual practice fixture')
        with self.assertRaisesRegex(ValueError,'source-parent-change-pending'):service.commit(OWNER,prepared['previewId'])
        self.assertEqual(dispatch(service,OTHER,'GET')[0],403)
    def test_setup_blocks_existing_library_and_keeps_configuration(self):
        (self.root/'config.json').write_text('{"port":43121}',encoding='utf-8');companion_setup.initialize(self.root)
        status=setup_status(self.root);before=(self.root/'config.local.json').read_bytes()
        with closing(sqlite3.connect(self.data/'account-study.db')) as db, db:db.execute('CREATE TABLE account_sync_libraries(id)');db.execute("INSERT INTO account_sync_libraries VALUES('existing')")
        with self.assertRaisesRegex(ValueError,'setup-workspace-has-history'):companion_setup.configure_workspace(self.root,{'mode':'existing','path':str(self.vault),'expectedRevision':status['revision'],'confirmed':True},has_history=lambda:has_history(self.data))
        self.assertEqual((self.root/'config.local.json').read_bytes(),before)
    def test_scanner_error_is_visible_and_does_not_advance_cursor(self):
        service=ExternalSources(self.data,lambda:self.vault,Keys(),verify_owner=lambda o:o==OWNER);runtime=SourceRuntime(service,lambda v:v)
        with patch('note_source_runtime.source_results.read_results',side_effect=ValueError('source-local-history-invalid')):runtime.deliver(OWNER,'source-one')
        with service.db() as db:row=db.execute('SELECT cursor_json,error FROM source_scan_cursor').fetchone()
        self.assertEqual(tuple(row),('{}','source-local-history-invalid'))

if __name__=='__main__':unittest.main()
