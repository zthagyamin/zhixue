import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from external_sources import ExternalSources
from notion_connector import NotionError
import mapped_source_registry
import account_sync_export

OWNER='a'*64;OTHER='b'*64
class Keys:
    def __init__(self):self.values={}
    def get_password(self,service,key):return self.values.get((service,key))
    def set_password(self,service,key,value):self.values[service,key]=value

class ExternalSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.vault=self.root/'learning';self.vault.mkdir();self.notes=self.root/'original';self.notes.mkdir();self.keys=Keys()
        (self.notes/'topic.md').write_text('# Notes\n\n## Topic\nOriginal explanation.\n',encoding='utf-8')
        self.store=ExternalSources(self.root/'data',lambda:self.vault,self.keys,verify_owner=lambda owner:owner in (OWNER,OTHER))
    def catalog(self,owner):
        indexes,entry=self.store.catalog_refs(owner)
        return mapped_source_registry.load_catalog(self.vault,self.root/'mappings.db',owner,extra_indexes=indexes,extra_entry_ref=entry)
    def test_preview_then_commit_creates_usable_catalog_without_touching_originals(self):
        before=(self.notes/'topic.md').read_bytes();preview=self.store.preview(OWNER,{'kind':'folder','path':str(self.notes),'label':'My notes'})
        self.assertEqual(preview['itemCount'],1);self.assertEqual(self.store.list(OWNER),[])
        source=self.store.commit(OWNER,preview['previewId']);self.assertTrue(source['enabled']);self.assertEqual((self.notes/'topic.md').read_bytes(),before)
        cat=self.catalog(OWNER);self.assertEqual(len(cat['bindings']),1);self.assertEqual(cat['diagnostics'],[])
        captured,ids=account_sync_export.capture_catalog(self.vault,catalog_loader=lambda root,refresh=False:self.catalog(OWNER))
        bundle,_=account_sync_export.export_catalog(captured,ids,'library-test','snapshot-test',1,'2026-09-08T00:00:00.000Z');self.assertEqual(len(bundle['items']),1)
    def test_owner_isolation_and_pause_keep_history_and_originals(self):
        preview=self.store.preview(OWNER,{'kind':'folder','path':str(self.notes),'label':'Notes'})
        with self.assertRaises(ValueError):self.store.commit(OTHER,preview['previewId'])
        source=self.store.commit(OWNER,preview['previewId']);self.assertEqual(self.store.list(OTHER),[])
        self.store.set_enabled(OWNER,source['sourceId'],source['revision'],False)
        self.assertEqual(self.catalog(OWNER)['bindings'],{});self.assertTrue((self.notes/'topic.md').exists())
    def test_changed_preview_is_rejected_and_unrelated_additions_keep_existing_item_binding(self):
        selection={'kind':'folder','path':str(self.notes),'label':'Notes'};preview=self.store.preview(OWNER,selection)
        (self.notes/'topic.md').write_text('# Notes\n\n## Topic\nChanged before confirmation.\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'source-preview-stale'):self.store.commit(OWNER,preview['previewId'])
        source=self.store.commit(OWNER,self.store.preview(OWNER,selection)['previewId']);before=self.catalog(OWNER)['bindings']
        (self.notes/'second.md').write_text('## Another\nA new independent paragraph.\n',encoding='utf-8');self.store.sync(OWNER,source['sourceId'])
        after=self.catalog(OWNER)['bindings'];self.assertEqual(len(after),2)
        for key,binding in before.items():self.assertEqual(after[key],binding)
    def test_notion_key_stays_out_of_saved_config_and_incomplete_reads_preserve_last_version(self):
        class Client:
            fail=False
            def read_page(self,p):
                if self.fail:raise NotionError('notion-incomplete-page')
                return {'key':p,'title':'Notion notes','markdown':'## Topic\nComplete content.','url':'https://www.notion.so/'+p,'version':'v1'}
            def request(self,*args):return {'properties':{}}
        client=Client();self.store.client_factory=lambda token:client
        preview=self.store.preview(OWNER,{'kind':'notion','pages':['1'*32],'label':'Notion','token':'never-store-in-json','writeEnabled':True,'writePage':'2'*32})
        source=self.store.commit(OWNER,preview['previewId']);self.assertNotIn('never-store-in-json',json.dumps(source));self.assertNotIn('never-store-in-json',self.store.path.read_bytes().decode('latin1'))
        before=self.catalog(OWNER)['bindings'];client.fail=True;self.store.sync(OWNER,source['sourceId']);self.assertEqual(self.catalog(OWNER)['bindings'],before)
        self.assertEqual(self.store.list(OWNER)[0]['error'],'notion-incomplete-page')

    def test_starter_python_imports_as_executable_practice_without_state_placeholders(self):
        kit=Path(__file__).resolve().parents[1]/'public/knowledge-starter-kit/python.md'
        preview=self.store.preview(OWNER,{'kind':'file','path':str(kit),'label':'Python 入门'})
        self.store.commit(OWNER,preview['previewId']);catalog=self.catalog(OWNER)
        subject=next(s for s in catalog['subjects'] if s['items'])
        self.assertEqual(subject['pluginType'],'code')
        self.assertIn('def add',subject['items'][0]['initialCode'])
        captured,ids=account_sync_export.capture_catalog(self.vault,catalog_loader=lambda root,refresh=False:self.catalog(OWNER))
        bundle,_=account_sync_export.export_catalog(captured,ids,'library-test','snapshot-test',1,'2026-09-08T00:00:00.000Z')
        self.assertEqual(bundle['items'][0]['practice']['questionType'],'code')

if __name__=='__main__':unittest.main()
