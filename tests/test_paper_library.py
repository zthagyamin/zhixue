import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import paper_library as library

class PaperLibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();(self.root/'论文').mkdir();(self.root/'论文/source.md').write_text('# A paper\n\nA grounded paragraph.',encoding='utf-8');self.service=library.PaperLibrary(self.root,self.root/'state.db','owner','local')
    def tearDown(self):self.tmp.cleanup()
    def payload(self):return {'requestId':'reading-request-001','localLibraryId':'local','destination':{'kind':'obsidian','directory':'阅读笔记'},'title':'My paper','markdown':'# Reading notes\n\nMy own reconstruction.','source':{'kind':'vault','path':'论文/source.md','version':self.service.read({'kind':'vault','path':'论文/source.md'})['version']}}
    def test_lists_and_reads_real_sources_without_writes(self):
        before=list(self.root.rglob('*'));result=self.service.catalog('source');self.assertEqual(result['documents'][0]['path'],'论文/source.md');doc=self.service.read(result['documents'][0]);self.assertEqual(doc['pages'][0]['text'],(self.root/'论文/source.md').read_bytes().decode());self.assertEqual(before,list(self.root.rglob('*')))
    def test_creates_separate_reading_note_and_replays_receipt(self):
        p=self.payload();result=self.service.save(p);self.assertEqual(result['status'],'written');self.assertEqual(self.service.save(p),result);self.assertEqual(len(list((self.root/'阅读笔记').glob('*.md'))),1);self.assertIn('My own reconstruction.',(self.root/result['path']).read_text(encoding='utf-8'));self.assertEqual((self.root/'论文/source.md').read_text(encoding='utf-8'),'# A paper\n\nA grounded paragraph.')
    def test_rejects_outside_root_wrong_scope_and_changed_source(self):
        with self.assertRaises(ValueError):self.service.read({'kind':'vault','path':'../outside.md'})
        p=self.payload();p['localLibraryId']='other'
        with self.assertRaises(ValueError):self.service.save(p)
        p=self.payload();p['destination']['directory']='../outside'
        with self.assertRaises(ValueError):self.service.save(p)
        p=self.payload();(self.root/'论文/source.md').write_text('changed',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'changed'):self.service.save(p)
    def test_generated_and_hidden_materials_are_not_candidates(self):
        (self.root/'论文/generated.md').write_text('---\ntype: paper-reading-note\n---\nnotes',encoding='utf-8');(self.root/'.private').mkdir();(self.root/'.private/source.md').write_text('not listed')
        paths=[d['path'] for d in self.service.catalog('')['documents']];self.assertEqual(paths,['论文/source.md'])
    def test_upload_material_snapshot_is_immutable_and_reusable(self):
        p={'localLibraryId':'local','paper':{'title':'Uploaded PDF','origin':{'kind':'upload','filename':'study.pdf','version':'abc'},'sections':[{'paragraphs':[{'rawEn':'A grounded sentence.'}]}]}}
        result=self.service.material(p);self.assertEqual(self.service.material(p),result);self.assertIn('A grounded sentence.',(self.root/result['sourceNote']).read_text(encoding='utf-8'));self.assertFalse(self.service.catalog('')['documents'][0]['path'].startswith('_System'))
    def test_windows_note_name_leaves_room_for_atomic_temporary_file(self):
        import os
        p=self.payload();p['title']='Long descriptive paper title '*8;p['destination']['directory']='notes/'+'x'*90
        result=self.service.save(p);self.assertTrue((self.root/result['path']).is_file())
        if os.name=='nt':self.assertLessEqual(len(str(self.root/result['path']).encode('utf-16-le'))//2+38,250)
    def test_not_written_error_can_be_corrected_but_unknown_write_cannot(self):
        p=self.payload();p['destination']['directory']='../invalid'
        with self.assertRaises(library.PaperOperationError) as result:self.service.save(p)
        self.assertTrue(result.exception.no_write)
    def test_notion_destination_receipt_reconciles_lost_creation_response(self):
        import json
        from notion_connector import NotionError
        class Client:
            created=False;calls=0;lost=True;content=''
            def find_child_page(self,parent,title):return '2'*32 if self.created else None
            def create_results_page(self,parent,title,marker,markdown=None):
                self.calls+=1;self.created=True;self.content=markdown
                if self.lost:self.lost=False;raise NotionError('notion-network',uncertain=True)
                return '2'*32
            def verify_results_page(self,page,marker,parent):return self.created
        client=Client()
        class External:
            def _row(self,owner,source):return {'kind':'notion','enabled':1,'revision':1,'selection_json':json.dumps({'pages':['1'*32],'writeEnabled':True,'writePage':'3'*32})}
            def _key(self,row):return 'fixture'
            def client_factory(self,key):return client
        self.service.external=External();p=self.payload();p.pop('source');p['destination']={'kind':'notion','sourceId':'s','sourceRevision':1}
        with self.assertRaises(library.PaperOperationError) as error:self.service.save(p)
        self.assertFalse(error.exception.no_write)
        result=self.service.save(p);self.assertEqual(result['status'],'written');self.assertEqual(client.calls,1);self.assertEqual(client.content,p['markdown']);self.assertEqual(self.service.save(p),result)
    def test_retry_before_actual_write_checks_changed_source(self):
        from unittest.mock import patch
        p=self.payload()
        with patch.object(library,'_atomic',side_effect=OSError('disk-full')):
            with self.assertRaises(library.PaperOperationError):self.service.save(p)
        (self.root/'论文/source.md').write_text('changed source',encoding='utf-8')
        with self.assertRaises(library.PaperOperationError) as result:self.service.save(p)
        self.assertTrue(result.exception.no_write);self.assertIn('changed',str(result.exception));self.assertFalse((self.root/'阅读笔记').exists())
    def test_retry_after_file_written_can_recover_receipt_despite_source_edit(self):
        from unittest.mock import patch
        p=self.payload();atomic=library._atomic
        def lost(*args):atomic(*args);raise OSError('lost receipt')
        with patch.object(library,'_atomic',side_effect=lost):
            with self.assertRaises(library.PaperOperationError):self.service.save(p)
        (self.root/'论文/source.md').write_text('changed source',encoding='utf-8')
        self.assertEqual(self.service.save(p)['status'],'written');self.assertEqual(len(list((self.root/'阅读笔记').glob('*.md'))),1)
    def test_notion_is_revalidated_immediately_before_creation(self):
        import json
        import threading
        class External:
            lock=threading.RLock();enabled=True;revision=1
            def _row(self,owner,source):return {'kind':'notion','enabled':self.enabled,'revision':self.revision,'selection_json':json.dumps({'pages':['1'*32],'writeEnabled':True,'writePage':'3'*32})}
            def _key(self,row):return 'fixture'
            def client_factory(self,key):return client
        external=External()
        class Client:
            calls=0
            def find_child_page(self,parent,title):external.enabled=False;external.revision=2;return None
            def create_results_page(self,*args,**kwargs):self.calls+=1;raise AssertionError('must not write')
        client=Client();self.service.external=external;p=self.payload();p.pop('source');p['destination']={'kind':'notion','sourceId':'s','sourceRevision':1}
        with self.assertRaises(library.PaperOperationError):self.service.save(p)
        self.assertEqual(client.calls,0)
