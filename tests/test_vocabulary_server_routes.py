"""Exercise production route bodies without importing user installation state."""
import ast
import io
import json
import sqlite3
import types
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from server_route_fixture import load_route_methods

class VocabularyServerRoutes(unittest.TestCase):
    def setUp(self):
        self.calls=[]
        def request(owner,source=None,payload=None):self.calls.append((owner,source,payload));return {'ok':True}
        self.namespace={'json':json,'sqlite3':sqlite3,'normalize_request_path':lambda p:urlsplit(p).path,'authenticate_session':lambda t:'owner' if t=='paired' else None,'allowed_origin':lambda o:o=='https://site.example','MAX_UPLOAD_BYTES':1500000,'paper_vocabulary_request':request}
        load_route_methods(self.namespace)
    def request(self,method,path,paired=True,origin='https://site.example',payload=None):
        raw=json.dumps(payload).encode() if payload is not None else b'';responses=[]
        r=types.SimpleNamespace(path=path,headers={'Origin':origin,'X-Study-Loop-Session':'paired' if paired else '', 'Content-Length':str(len(raw))},rfile=io.BytesIO(raw),send_json=lambda status,body:responses.append((status,body)))
        self.namespace['do_'+method](r);return responses[-1]
    def test_get_uses_paired_origin_and_decoded_source(self):
        self.assertEqual(self.request('GET','/v1/vocabulary/target?sourceNote=paper%20one.md')[0],200)
        self.assertEqual(self.calls,[('owner','paper one.md',None)])
    def test_unpaired_and_untrusted_requests_cannot_reach_writer(self):
        for method,path,payload in [('GET','/v1/vocabulary/target',None),('POST','/v1/vocabulary/append',{'entries':[]})]:
            self.assertEqual(self.request(method,path,paired=False,payload=payload)[0],401)
            self.assertEqual(self.request(method,path,origin='https://other.example',payload=payload)[0],403)
        self.assertEqual(self.calls,[])
    def test_post_preserves_request_envelope_and_rejects_stale(self):
        payload={'requestId':'request-123','localLibraryId':'local','entries':[]}
        self.assertEqual(self.request('POST','/v1/vocabulary/append',payload=payload)[0],200)
        self.assertEqual(self.calls,[('owner',None,payload)])
        def stale(*args,**kwargs):raise ValueError('vocabulary-stale-revision')
        self.namespace['paper_vocabulary_request']=stale
        self.assertEqual(self.request('POST','/v1/vocabulary/append',payload=payload),(409,{'message':'vocabulary-stale-revision'}))
