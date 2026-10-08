import json, sys, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion'))
import vault_topology as vt

class MappingReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'vault';self.root.mkdir();self.db=Path(self.temp.name)/'mapping.db'
    def tearDown(self): self.temp.cleanup()
    def write(self,name,body):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(body,encoding='utf-8');return path
    def rule(self,mode='heading',kind='quiz'):
        return dict(pathGlob='**/*.md',subjectId='mapped:'+kind,subjectLabel='Examples',contentKind=kind,splitMode=mode,headingLevel=2)
    def test_all_recall_shapes_supply_renderer_reference(self):
        for mode,body in [('heading','## Question\nGrounded answer'),('callout','> [!question] Question\n> Grounded answer'),('table','| prompt | answer |\n|---|---|\n| Question | Grounded answer |')]:
            with self.subTest(mode=mode):
                self.write('note.md',body);item=vt.extract(self.root,[self.rule(mode)])[0]
                self.assertEqual(item.get('explanation') or item.get('reviewPoint'),'Grounded answer')
    def test_literal_heading_hashes_and_actual_closing_markers(self):
        self.write('note.md','## C#\nLanguage C sharp\n## C\nLanguage C\n## F#\nLanguage F sharp\n## Escaped \\#\nLiteral escaped hash\n## Title ##\nClosed title')
        items=vt.extract(self.root,[self.rule()])
        self.assertEqual([item['prompt'] for item in items],['C#','C','F#',r'Escaped \#','Title'])
        self.assertEqual(len({item['itemId'] for item in items}),5)
        c_identity=next(item['itemId'] for item in items if item['prompt']=='C')
        self.write('note.md','## C\nLanguage C')
        self.assertEqual(vt.extract(self.root,[self.rule()])[0]['itemId'],c_identity)

    def test_heading_boundaries_and_code_fences(self):
        self.write('note.md','## Q\nA\n### Detail\nUseful detail\n```md\n# Code heading\n```\n# Unrelated topic\nUnrelated body\n## Q2\nA2')
        items=vt.extract(self.root,[self.rule()])
        self.assertEqual([item['prompt'] for item in items],['Q','Q2'])
        self.assertEqual(items[0]['answer'],'A\n### Detail\nUseful detail\n```md\n# Code heading\n```')
        self.assertEqual(items[1]['answer'],'A2')
    def test_bad_documents_are_diagnosed_without_losing_registered_subjects(self):
        self.write('valid.md','## Good\nKnown answer');self.write('bad.md','').write_bytes(b'\xff\xfeinvalid')
        vt.save(self.db,self.root,'owner',[self.rule()],0)
        original={'subjects':[{'id':'registered','items':[{'id':'old','stateHandle':'preserved'}]}],'diagnostics':[]}
        merged=vt.merge(original,self.root,self.db,'owner')
        self.assertEqual(merged['subjects'][0],original['subjects'][0])
        self.assertEqual(merged['subjects'][1]['items'][0]['prompt'],'Good')
        self.assertEqual(merged['mappingDiagnostics'][0]['path'],'bad.md')
        scan=vt.inspect(self.root);self.assertEqual(len(scan['suggestions']),1);self.assertEqual(scan['diagnostics'][0]['code'],'mapping-invalid-encoding')
        import server
        with patch.object(server,'LOCAL_DATABASE_PATH',self.db),patch.object(server,'installation_owner_hash',return_value='owner'),patch.object(server,'source_path',return_value=self.root):
            preview=server.vault_mapping_request('owner',{'action':'preview','rules':[self.rule()]})
        self.assertEqual(preview['itemCount'],1);self.assertEqual(preview['diagnostics'][0]['path'],'bad.md')
    def test_read_permission_failure_is_isolated_and_sampling_stays_bounded(self):
        bad=self.write('bad.md','## Bad\nNo read');self.write('good.md','## Good\nAnswer')
        original=Path.read_text
        def read(path,*args,**kwargs):
            if path==bad: raise PermissionError('test unreadable')
            return original(path,*args,**kwargs)
        with patch.object(Path,'read_text',read):
            diagnostics=[];items=vt.extract(self.root,[self.rule()],diagnostics=diagnostics)
            self.assertEqual(len(items),1);self.assertEqual(diagnostics[0]['code'],'mapping-unreadable-file')
            self.assertEqual(len(vt.inspect(self.root)['suggestions']),1)
        for i in range(60):self.write(f'{i:02}.md','').write_bytes(b'\xff')
        scan=vt.inspect(self.root);self.assertEqual(scan['sampledFiles'],50);self.assertEqual(len(scan['diagnostics']),50)
    def test_domains_are_explicit_for_actual_event_router(self):
        for kind,body,mode,domain in [('quiz','## Q\nA','heading','course'),('vocabulary','| word | meaning |\n|---|---|\n| retrieve | recall |','table','ielts')]:
            with self.subTest(kind=kind):
                self.write('note.md',body);current=vt.load(self.db,self.root,'owner');vt.save(self.db,self.root,'owner',[self.rule(mode,kind)],current['revision'])
                self.assertEqual(vt.merge({'subjects':[]},self.root,self.db,'owner')['subjects'][0]['domain'],domain)
    def test_starter_documented_indexed_route_and_zip_are_usable(self):
        kit=ROOT/'public/knowledge-starter-kit';readme=(kit/'README.md').read_text(encoding='utf-8')
        self.assertIn('fixed-index',readme);self.assertIn('Starter/materials/',readme)
        self.write('_System/Integrations/Study Loop/gateway/index.md','---\ntype: zhixue-gateway\nschema_version: 1\n---\n')
        rules=[]
        with zipfile.ZipFile(kit/'structure.zip') as archive:
            for name in ['vocabulary.md','python.md','concepts.md','README.md']:
                self.assertEqual(archive.read('knowledge-starter-kit/'+name).replace(b'\r\n',b'\n'),(kit/name).read_bytes().replace(b'\r\n',b'\n'))
        for name,kind in [('vocabulary.md','vocabulary'),('python.md','code'),('concepts.md','quiz')]:
            self.write('Starter/materials/'+name,(kit/name).read_text(encoding='utf-8'));rule=self.rule('table',kind);rule['pathGlob']='Starter/materials/'+name;rules.append(rule)
        import server
        vt.save(self.db.with_name('vault-mappings.db'),self.root,'owner',rules,0)
        with patch.object(server,'LOCAL_DATABASE_PATH',self.db),patch.object(server,'installation_owner_hash',return_value='owner'):
            payload=server.indexed_study_payload(self.root,None)
        self.assertEqual(sum(len(row['items']) for row in payload['subjects']),3)

if __name__=='__main__':unittest.main()
