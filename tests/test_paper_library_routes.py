import ast
import io
import json
import sqlite3
import threading
import types
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import paper_library
from server_route_fixture import load_route_methods, server_tree

class PaperLibraryRoutes(unittest.TestCase):
    def setUp(self):
        self.tree=server_tree();self.calls=[]
        def service(owner,action,payload=None,query=''):self.calls.append((owner,action,payload,query));return {'ok':True}
        self.ns={'json':json,'sqlite3':sqlite3,'normalize_request_path':lambda p:urlsplit(p).path,'authenticate_session':lambda t:'owner' if t=='paired' else None,'allowed_origin':lambda o:o=='http://localhost:3002','MAX_UPLOAD_BYTES':1500000,'paper_library_request':service}
        load_route_methods(self.ns)
    def request(self,method,path,body=None,token='paired',origin='http://localhost:3002'):
        raw=json.dumps(body).encode() if body is not None else b'';responses=[];request=types.SimpleNamespace(path=path,headers={'Origin':origin,'X-Study-Loop-Session':token,'Content-Length':str(len(raw))},rfile=io.BytesIO(raw),send_json=lambda status,value:responses.append((status,value)))
        self.ns['do_'+method](request);return responses[-1]
    def test_source_queries_and_save_envelopes_reach_correct_routes(self):
        self.assertEqual(self.request('GET','/v1/papers?query=machine+learning')[0],200)
        self.assertEqual(self.calls[-1],('owner','catalog',None,'machine learning'))
        for action in ('read','material','save'):
            self.assertEqual(self.request('POST','/v1/papers/'+action,{'localLibraryId':'local'})[0],200);self.assertEqual(self.calls[-1],('owner',action,{'localLibraryId':'local'},''))
    def test_unpaired_untrusted_and_unknown_save_are_not_success(self):
        self.assertEqual(self.request('GET','/v1/papers',token='')[0],401);self.assertEqual(self.request('POST','/v1/papers/save',{},origin='https://other.example')[0],403);self.assertEqual(self.calls,[])
        def failure(*args,**kwargs):raise paper_library.PaperOperationError('paper-source-changed',True)
        self.ns['paper_library_request']=failure;self.assertEqual(self.request('POST','/v1/papers/save',{})[1],{'message':'paper-source-changed','noWrite':True})
    def test_production_factory_checks_library_before_reading_source(self):
        node=next(n for n in self.tree.body if isinstance(n,ast.FunctionDef) and n.name=='paper_library_request')
        root=Path(__file__).resolve().parents[1];ns={'installation_owner_hash':lambda:'owner','NOTE_SOURCE_LOCK':threading.RLock(),'source_path':lambda k:root,'LOCAL_DATABASE_PATH':root/'.superpowers/unused-fixture.db','local_vault_library_id':lambda v:'local','get_note_source_runtime':lambda:types.SimpleNamespace(service=None)}
        exec(compile(ast.Module(body=[node],type_ignores=[]),'paper-factory','exec'),ns)
        with patch.object(paper_library.PaperLibrary,'read',return_value={'ok':True}) as read:
            with self.assertRaisesRegex(ValueError,'library-changed'):ns['paper_library_request']('owner','read',{'localLibraryId':'other','source':{}})
            read.assert_not_called();self.assertEqual(ns['paper_library_request']('owner','read',{'localLibraryId':'local','source':{}}),{'ok':True})
