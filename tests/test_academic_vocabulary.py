import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import academic_vocabulary as av

class AcademicVocabularyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.vault = Path(self.temp.name).resolve()
        self.target = self.vault / av.TARGET
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(('\ufeff---\r\ntype: vocabulary-database\r\nstatus: active\r\n---\r\n'+av.HEADER.replace('\n','\r\n')+'\r\n| old | 原有 | 来源 | original sentence | 2026-01-01 |\r\n').encode())
        (self.vault/'paper.md').write_text('source paper',encoding='utf-8')
        self.catalog = {'active':True,'references':[{'subjectId':'academic','contentRef':f'[[{av.TARGET}]]','format':'vocabulary'}], 'planningDefinitions':[{'id':'academic','contentRoot':av.AREA}], 'subjects':[{'id':'academic','pluginType':'three-stage','items':[{'word':'old','meaning':'原有'}]}], 'bindings':{}}
        self.service=av.VocabularyWriter(self.vault,self.vault/'journal.db','owner','local',lambda:self.catalog)
    def tearDown(self): self.temp.cleanup()
    def payload(self,term='gradient descent',meaning='梯度下降'):
        return {'requestId':'request-123','localLibraryId':'local','expectedRevision':self.service.target('paper.md')['revision'],'entries':[{'id':'p:0:16','term':term,'meaning':meaning,'context':'We use gradient descent to train.', 'sourceNote':'paper.md','paperTitle':'Paper','section':'Methods','page':3}]}
    def test_backup_bom_newline_and_replay(self):
        before=self.target.read_bytes();p=self.payload();result=self.service.append(p)
        self.assertEqual(result['results'][0]['status'],'added')
        self.assertEqual((self.vault/result['backupRelative']).read_bytes(),before)
        self.assertTrue(self.target.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertIn(b'\r\nupdated:',self.target.read_bytes())
        self.assertEqual(self.service.append(p),result)
        self.assertEqual(len(list((self.vault/av.BACKUPS).glob('*.md'))),1)
    def test_stale_revision_and_request_collision_do_not_write(self):
        p=self.payload();self.target.write_bytes(self.target.read_bytes()+b'\r\nexternal edit')
        with self.assertRaisesRegex(ValueError,'stale'):self.service.append(p)
        p=self.payload();self.service.append(p);p['entries'][0]['meaning']='different'
        with self.assertRaisesRegex(ValueError,'request'):self.service.append(p)
    def test_existing_and_all_same_word_conflicts(self):
        p=self.payload();p['entries']*=2;p['entries'][1]={**p['entries'][1],'id':'other','meaning':'另一义'}
        r=self.service.append(p);self.assertEqual([x['status'] for x in r['results']],['conflict','conflict'])
        self.assertNotIn('gradient descent',self.target.read_text(encoding='utf-8-sig'))
    def test_registration_source_and_library_fail_closed(self):
        p=self.payload();p['localLibraryId']='wrong'
        with self.assertRaises(ValueError):self.service.append(p)
        p=self.payload();p['entries'][0]['sourceNote']='../paper.md'
        with self.assertRaises(ValueError):self.service.append(p)
        self.catalog['references']=[]
        with self.assertRaisesRegex(ValueError,'registered'):self.service.target('paper.md')
    def test_term_must_be_whole_occurrence(self):
        p=self.payload('radient')
        with self.assertRaisesRegex(ValueError,'context'):self.service.append(p)
    def test_non_pdf_material_uses_an_explicit_locator_without_fake_page(self):
        p=self.payload();p['entries'][0]['page']=0;p['entries'][0]['locator']='阅读微段 1'
        self.assertEqual(self.service.append(p)['results'][0]['status'],'added')
        body=self.target.read_text(encoding='utf-8-sig');self.assertIn('阅读微段 1',body);self.assertNotIn('PDF 第 0 页',body)
    def test_malformed_table_is_not_rewritten(self):
        self.target.write_bytes(self.target.read_bytes()+b'| broken | row |\r\n')
        with self.assertRaisesRegex(ValueError,'table'):self.service.target('paper.md')
    def test_uncertain_receipt_recovers_without_second_write(self):
        from unittest.mock import patch
        p=self.payload()
        with patch.object(self.service,'_complete',side_effect=OSError('lost receipt')):
            with self.assertRaises(OSError): self.service.append(p)
        after=self.target.read_bytes();result=self.service.append(p)
        self.assertEqual(result['results'][0]['status'],'added');self.assertEqual(after,self.target.read_bytes())
    def test_real_gateway_recognizes_new_card_and_preserves_old_signature(self):
        gateway=av.index_gateway
        entry=self.vault/gateway.GATEWAY_ROOT
        (entry/'subjects').mkdir(parents=True)
        (entry/'index.md').write_text('---\ntype: zhixue-gateway\nschema_version: 1\n---\n# Gateway\n',encoding='utf-8')
        (entry/'subjects/academic.md').write_text(f'---\ntype: zhixue-subject-index\nschema_version: 1\nsubject_id: academic\nname: Academic\ndomain: academic-english\nplugin: three-stage\ncontent_root: "{av.AREA}"\nprogress_ref: "[[{av.AREA}/state]]"\nrecords_root: "{av.AREA}/records"\nidentity: legacy\nauto: true\n---\n',encoding='utf-8')
        (self.target.parent/'state.md').write_text('---\ntype: zhixue-practice-state\n---\n',encoding='utf-8')
        self.service.catalog_loader=lambda:gateway.load_gateway(self.vault,refresh=False)
        before=self.service.catalog_loader();old=next(b for b in before['bindings'].values() if b['wordKey']=='old')
        p=self.payload(meaning='A & B');p['entries'][0]['context']='We use gradient descent & momentum.'
        result=self.service.append(p);self.assertTrue(result['gatewayRecognized'])
        after=self.service.catalog_loader();word=next(i for s in after['subjects'] for i in s['items'] if i.get('word')=='gradient descent')
        self.assertEqual(word['meaning'],'A & B');self.assertEqual(word['context'],'We use gradient descent & momentum.')
        self.assertEqual(next(b for b in after['bindings'].values() if b['wordKey']=='old'),old)
    def test_saved_request_before_replace_resumes_once(self):
        from unittest.mock import patch
        p=self.payload();before=self.target.read_bytes()
        with patch.object(av,'_atomic',side_effect=OSError('process stopped before replace')):
            with self.assertRaises(OSError):self.service.append(p)
        self.assertEqual(before,self.target.read_bytes())
        result=self.service.append(p)
        self.assertEqual(result['results'][0]['status'],'added')
        self.assertEqual(len(list((self.vault/av.BACKUPS).glob('*.md'))),1)
    def test_existing_updated_preserves_crlf(self):
        raw=self.target.read_bytes().replace(b'status: active\r\n',b'updated: 2020-01-01\r\nstatus: active\r\n');self.target.write_bytes(raw)
        self.service.append(self.payload());after=self.target.read_bytes()
        self.assertNotIn(b'\n',after.replace(b'\r\n',b''));self.assertIn(b'| old |',after)
    def test_two_processes_cannot_overwrite_the_same_revision(self):
        import json
        import subprocess
        # Isolate write serialization from conservative first-use directory checks.
        with av.process_lock(self.vault/'_System/Locks/academic-vocabulary.db',self.vault): pass
        p=self.payload();other={**p,'requestId':'request-456'}
        script='''import json,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nimport academic_vocabulary as av\nx=json.loads(sys.stdin.read());root=Path(x['root']);w=av.VocabularyWriter(root,root/x['db'],'owner','local',lambda:x['catalog'])\ntry: print(json.dumps(w.append(x['payload'])))\nexcept ValueError as e: print(json.dumps({'error':str(e)}))\n'''
        children=[]
        for i,payload in enumerate((p,other)):
            child=subprocess.Popen([sys.executable,'-c',script,str(Path(av.__file__).parent)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
            child.stdin.write(json.dumps({'root':str(self.vault),'db':f'journal-{i}.db','catalog':self.catalog,'payload':payload}));child.stdin.close();child.stdin=None;children.append(child)
        results=[]
        for child in children:
            out,err=child.communicate(timeout=30);self.assertEqual(child.returncode,0,err);results.append(json.loads(out))
        self.assertEqual(sum('results' in r for r in results),1)
        self.assertIn('vocabulary-stale-revision',[r.get('error') for r in results])
        self.assertEqual(self.target.read_text(encoding='utf-8-sig').count('| gradient descent |'),1)
