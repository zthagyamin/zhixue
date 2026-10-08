import sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import vault_topology as vt
import source_area

class MappingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name) / 'vault'; self.root.mkdir()
        self.db = Path(self.temp.name) / 'mapping.db'
    def tearDown(self): self.temp.cleanup()
    def write(self, path, text):
        p=self.root/path; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text,encoding='utf-8'); return p
    def rule(self, **kw):
        return dict(pathGlob='**/*.md',subjectId='mapped:concepts',subjectLabel='Concepts',contentKind='quiz',splitMode='heading',headingLevel=2,**kw)
    def test_inference_shapes_and_bound(self):
        self.write('Areas/Python/a.md','---\nsubject: Python\n---\n## Recall\nAnswer')
        result=vt.inspect(self.root)
        self.assertIn('para',result['shapes']); self.assertIn('metadata',result['shapes'])
        self.assertTrue(result['ambiguous']); self.assertFalse(result['active'])
        for n in range(60): self.write(f'more/{n}.md','## Q\nA')
        self.assertEqual(vt.inspect(self.root)['sampledFiles'],50)
    def test_heading_ids_hashes_and_matching(self):
        p=self.write('Course/note.md','## Same\nFirst\n## Same\nSecond')
        rule=self.rule(); a=vt.extract(self.root,[rule]); self.assertEqual(len(a),2)
        self.assertNotEqual(a[0]['id'],a[1]['id'])
        p.write_text('## Same\nChanged\n## Same\nSecond',encoding='utf-8')
        b=vt.extract(self.root,[rule]); self.assertEqual(a[0]['id'],b[0]['id']); self.assertNotEqual(a[0]['contentHash'],b[0]['contentHash'])
        rule['pathGlob']='Other/*.md'; self.assertEqual(vt.extract(self.root,[rule]),[])
    def test_distinct_tables_do_not_create_header_items(self):
        self.write('table.md','| word | meaning |\n|---|---|\n| retrieve | recall |\n\n| word | meaning |\n|---|---|\n| retain | keep |')
        rule=self.rule(); rule.update(splitMode='table',contentKind='vocabulary')
        self.assertEqual([item['word'] for item in vt.extract(self.root,[rule])],['retrieve','retain'])

    def test_table_callout(self):
        self.write('table.md','| word | meaning |\n|---|---|\n| retrieve | recall |')
        rule=self.rule(); rule.update(splitMode='table',contentKind='vocabulary')
        self.assertEqual(vt.extract(self.root,[rule])[0]['word'],'retrieve')
        self.write('callout.md','> [!question] Why?\n> Because.\n\n> [!question] Again?\n> Yes.')
        rule.update(splitMode='callout',contentKind='quiz'); self.assertEqual(len(vt.extract(self.root,[rule])),2)
    def test_traversal_and_symlink(self):
        rule=self.rule(); rule['pathGlob']='../*.md'
        with self.assertRaises(ValueError): vt.extract(self.root,[rule])
        outside=Path(self.temp.name)/'outside'; outside.mkdir(); (outside/'secret.md').write_text('## Secret\nPrivate')
        try: (self.root/'escape').symlink_to(outside,target_is_directory=True)
        except OSError: self.skipTest('symlink privilege unavailable')
        self.assertEqual(vt.extract(self.root,[self.rule()]),[])
    def test_revision_and_actual_reader(self):
        self.write('Course/note.md','## Recall\nAnswer')
        self.assertEqual(vt.load(self.db,self.root,'owner')['rules'],[])
        vt.save(self.db,self.root,'owner',[self.rule()],0)
        with self.assertRaises(ValueError): vt.save(self.db,self.root,'owner',[],0)
        import server
        with patch.object(server,'LOCAL_DATABASE_PATH',self.db.with_name('study.db')),patch.object(server,'installation_owner_hash',return_value='owner'):
            # server uses vault-mappings.db sibling, as production does
            vt.save(self.db.with_name('vault-mappings.db'),self.root,'owner',[self.rule()],0)
            payload=server.merge_source_area({'subjects':[]},self.root,[])
            self.assertEqual(payload['subjects'][0]['items'][0]['prompt'],'Recall')
    def test_folder_flat_and_stable_root_independence(self):
        self.write('Course/note.md','## Question\nAnswer')
        first=vt.inspect(self.root)
        other=Path(self.temp.name)/'renamed'; self.root.rename(other); self.root=other
        self.assertEqual(first['suggestions'],vt.inspect(other)['suggestions'])
        self.assertTrue(vt._matches('Course/note.md','Course/**/*.md'))
        self.assertTrue(vt._matches('Course/unit/note.md','Course/**/*.md'))
        self.assertFalse(vt._matches('Other/note.md','Course/**/*.md'))
        self.assertFalse(vt._matches('Course/unit/note.md','Course/*.md'))

    def test_windows_junction_escape(self):
        import os, subprocess
        if os.name!='nt': self.skipTest('Windows junction test')
        outside=Path(self.temp.name)/'outside'; outside.mkdir(); (outside/'secret.md').write_text('## Secret\nPrivate')
        link=self.root/'escape'
        env={**os.environ,'MAPPING_TEST_LINK':str(link),'MAPPING_TEST_TARGET':str(outside)}
        result=subprocess.run(['pwsh.exe','-NoProfile','-Command','New-Item -ItemType Junction -Path $env:MAPPING_TEST_LINK -Target $env:MAPPING_TEST_TARGET | Out-Null'],env=env,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        try:
            self.assertEqual(vt.extract(self.root,[self.rule()]),[])
            self.assertEqual(vt.inspect(self.root)['sampledFiles'],0)
        finally: os.rmdir(link)
        self.assertTrue((outside/'secret.md').exists())

    def test_preview_owner_and_request_fields(self):
        import server
        self.write('Course/note.md','## Recall\nAnswer')
        with patch.object(server,'LOCAL_DATABASE_PATH',self.db),patch.object(server,'installation_owner_hash',return_value='owner'),patch.object(server,'source_path',return_value=self.root):
            with self.assertRaisesRegex(ValueError,'mapping-owner-required'): server.vault_mapping_request('other')
            with self.assertRaisesRegex(ValueError,'invalid-mapping-request'): server.vault_mapping_request('owner',{'rules':[],'action':'confirm','root':'C:/private'})
            preview=server.vault_mapping_request('owner',{'action':'preview','rules':[self.rule()]})
            self.assertEqual(preview['itemCount'],1)
            self.assertEqual(server.vault_mapping_request('owner')['rules'],[])

    def test_actual_indexed_reader_preserves_registered_items(self):
        import server
        entry='_System/Integrations/Study Loop/gateway'
        self.write(entry+'/index.md','---\ntype: zhixue-gateway\nschema_version: 1\n---\n# Gateway\n')
        self.write(entry+'/subjects/registered.md', '\n'.join(['---','type: zhixue-subject-index','schema_version: 1','subject_id: registered','name: Registered','domain: astronomy','plugin: quiz','content_root: subjects/registered','progress_ref: "[[subjects/registered/state]]"','records_root: subjects/registered/records','identity: scoped','enabled: true','auto: true','---','']))
        self.write('subjects/registered/state.md','---\ntype: zhixue-practice-state\n---\n# Practice state')
        self.write('subjects/registered/lesson.md','---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: quiz\nstatus: ready\n---\n# Lesson\n| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q1 | Registered question | Answer;Other | Answer | Example |')
        self.write('Course/note.md','## Recall\nAnswer')
        self.write('Course/unreadable.md','').write_bytes(b'\xff')
        rule=self.rule();rule['pathGlob']='Course/**/*.md'
        vt.save(self.db.with_name('vault-mappings.db'),self.root,'owner',[rule],0)
        with patch.object(server,'LOCAL_DATABASE_PATH',self.db),patch.object(server,'installation_owner_hash',return_value='owner'):
            data=server.indexed_study_payload(self.root,None)
        subjects={row['id']:row for row in data['subjects']}
        self.assertEqual(set(subjects),{'registered','mapped:concepts'})
        self.assertEqual(subjects['registered']['items'][0]['stateRef'],'subjects/registered/state.md')
        self.assertIn('stateRef',subjects['mapped:concepts']['items'][0])
        self.assertTrue(subjects['mapped:concepts']['items'][0]['stateRef'].startswith('_System/Integrations/Study Loop/mapped/'))
        self.assertEqual(data['gateway']['itemCount'],2)
        self.assertEqual(data['gateway']['diagnostics'][0]['code'],'mapping-invalid-encoding')

    def test_http_auth_origin_preview_save_and_stale(self):
        import server, threading, http.client, json
        from http.server import ThreadingHTTPServer
        self.write('Course/note.md','## Recall\nAnswer')
        http_server=ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=http_server.serve_forever,daemon=True);thread.start()
        def request(method,body=None,token='paired',origin='http://approved.local'):
            connection=http.client.HTTPConnection(*http_server.server_address)
            headers={'Origin':origin,'X-Study-Loop-Session':token}
            data=json.dumps(body) if body is not None else None
            if data:headers['Content-Type']='application/json'
            connection.request(method,'/v1/vault-mapping',body=data,headers=headers)
            response=connection.getresponse();value=json.loads(response.read());status=response.status;connection.close();return status,value
        try:
            with patch.object(server,'LOCAL_DATABASE_PATH',self.db),patch.object(server,'installation_owner_hash',return_value='owner'),patch.object(server,'source_path',return_value=self.root),patch.object(server,'authenticate_session',side_effect=lambda token:'owner' if token=='paired' else None),patch.object(server,'allowed_origin',side_effect=lambda origin:origin if origin=='http://approved.local' else None):
                self.assertEqual(request('GET',token='missing')[0],401)
                self.assertEqual(request('GET',origin='http://unapproved.local')[0],403)
                self.assertEqual(request('POST',{'action':'preview','rules':[]},origin='http://unapproved.local')[0],403)
                self.assertEqual(request('GET')[1]['rules'],[])
                self.assertEqual(request('POST',{'action':'preview','rules':[self.rule()]})[1]['itemCount'],1)
                body={'action':'confirm','rules':[self.rule()],'revision':0}
                self.assertEqual(request('POST',body)[0],200)
                self.assertEqual(request('POST',body)[0],409)
        finally: http_server.shutdown();http_server.server_close();thread.join()

    def test_scaffold_roundtrip(self):
        kit=Path(__file__).resolve().parents[1]/'public/knowledge-starter-kit'
        for name,kind in [('vocabulary.md','vocabulary'),('python.md','code'),('concepts.md','quiz')]:
            items=source_area.parse_source_file(kit/name); self.assertEqual(len(items),1,name); self.assertEqual(items[0]['kind'],kind)
            if kind=='code': self.assertIn('\n',items[0]['initialCode'])

if __name__=='__main__': unittest.main()


