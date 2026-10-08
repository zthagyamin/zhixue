"""Actual server POST methods plus exact registry; synthetic paired HTTP only."""
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import routes_math
from server_route_fixture import load_route_methods


class NativeMathRouteTests(unittest.TestCase):
    def setUp(self):
        self.owner='a'*64
        self.namespace={'json':json,'normalize_request_path':lambda path:path,
            'authenticate_session':lambda token:self.owner if token=='paired' else None,
            'allowed_origin':lambda origin:origin=='https://site.example','MAX_UPLOAD_BYTES':1500000}
        self.methods=load_route_methods(self.namespace)
    def request(self,path,payload=None,token='paired',origin='https://site.example',raw=None):
        body=raw if raw is not None else json.dumps(payload or {}).encode()
        headers={'X-Study-Loop-Session':token,'Content-Length':str(len(body))}
        if origin is not None: headers['Origin']=origin
        responses=[]
        req=types.SimpleNamespace(path=path,headers=headers,rfile=io.BytesIO(body),send_json=lambda status,value:responses.append((status,value)))
        self.methods['do_POST'](req)
        self.assertEqual(len(responses),1)
        return responses[0]
    def test_every_math_route_requires_exact_origin_and_paired_header(self):
        with mock.patch.object(routes_math,'create_native_math_application') as factory:
            for route in ('source/capture','source/read','claim','evaluate','read'):
                for token in ('','expired','unpaired'):
                    self.assertEqual(self.request('/v1/math/'+route,token=token)[0],401)
                for origin in (None,'null','http://site.example','https://other.example'):
                    self.assertEqual(self.request('/v1/math/'+route,origin=origin)[0],403)
            factory.assert_not_called()
    def test_dispatch_calls_exact_application_with_authenticated_owner(self):
        app=types.SimpleNamespace(source=mock.Mock(return_value={'capture':{}}),claim=mock.Mock(return_value={'durable':True}),
            evaluate=mock.Mock(return_value={'final':{}}),read=mock.Mock(return_value={'claim':{}}))
        payload={'schemaVersion':1,'ownerId':'forged-owner'}
        with mock.patch.object(routes_math,'create_native_math_application',return_value=app) as factory:
            for action in ('source/capture','source/read','claim','evaluate','read'):
                self.assertEqual(self.request('/v1/math/'+action,payload)[0],200)
            for call in factory.call_args_list: self.assertEqual(call.args[1],self.owner)
        self.assertEqual(app.source.call_args_list,[mock.call('capture',payload),mock.call('read',payload)])
        app.evaluate.assert_called_once_with(payload)
    def test_near_paths_invalid_json_and_private_errors_do_not_leak(self):
        with mock.patch.object(routes_math,'create_native_math_application') as factory:
            for path in ('/v1/math/grade','/v1/math/evaluate/extra','/v1/math/source/read-extra'):
                self.assertEqual(self.request(path)[0],404)
            self.assertEqual(self.request('/v1/math/claim',raw=b'{broken')[0],400)
            factory.assert_not_called()
        for error,status in ((ValueError('native-math-attempt-conflict'),409),(ValueError('unknown-study-field'),400),
                             (OSError('C:/private/secret'),503),(ValueError('C:/private/token'),409)):
            with mock.patch.object(routes_math,'create_native_math_application',side_effect=error):
                result=self.request('/v1/math/evaluate')
                self.assertEqual(result[0],status)
                self.assertNotIn('private',json.dumps(result))
                self.assertNotIn('token',json.dumps(result))

if __name__=='__main__': unittest.main()
