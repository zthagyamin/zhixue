"""Injected semantic port validates source versions and abstains on any failure."""
import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from infrastructure.math_step_provider import diagnose_semantic_step, evaluate_semantic, configured_semantic_provider
import io
import json
from unittest import mock
from types import SimpleNamespace


class NativeMathProviderTests(unittest.TestCase):
    def setUp(self):
        self.request={'requestId':'r1','attemptId':'a1','answerRevision':2,'sourceVersion':'a'*64}
        self.claim={'stepInput':{'text':'Because the coefficient is two','revision':1}}
        self.capture={'captureId':'b'*64,'item':{'practice':{'prompt':'Question'},
            'learningSupport':{'step':{'stepId':'s1','prompt':'Explain the coefficient','reference':'It is doubled'}}}}
    def test_missing_and_unavailable_provider_keep_pending(self):
        for provider in (None,lambda data: (_ for _ in ()).throw(TimeoutError())):
            result,cap=diagnose_semantic_step(provider,self.request,self.claim,self.capture)
            self.assertEqual(result['status'],'undetermined')
            self.assertEqual(result['source'],'none')
            self.assertEqual(cap['semanticStep'],'pending')
    def test_mock_port_exact_binding_and_no_provider_owned_final(self):
        def provider(data):
            self.assertEqual(data['requestId'],'r1')
            self.assertEqual(data['reference'],'It is doubled')
            return {**{k:data[k] for k in ('answerRevision','stepRevision','stepId','sourceVersion')},
                    'status':'correct','source':'model','explanation':'Aligned with reference.'}
        result,cap=diagnose_semantic_step(provider,self.request,self.claim,self.capture)
        self.assertEqual(result['status'],'correct'); self.assertEqual(cap['semanticStep'],'available')
        def bad(data): return {**provider(data),'sourceVersion':'f'*64}
        self.assertEqual(diagnose_semantic_step(bad,self.request,self.claim,self.capture)[0]['status'],'undetermined')

    def test_production_transport_requires_verbatim_evidence_and_usage_limit(self):
        data={**self.request,'captureId':'b'*64,'stepRevision':1,'stepId':'s1','text':'It doubles the input','reference':'Double the input','prompt':'Why?','question':'Question'}
        settings={'provider':'chatgpt','model':'test-model','baseUrl':'https://api.openai.com/v1','maxOutputTokens':100}
        diagnostic={'status':'correct','source':'model','explanation':'Matched source.','sourceQuote':'Double','answerQuote':'doubles'}
        def transport(request,timeout):
            self.assertEqual(request.get_header('Idempotency-key'),'native-math-r1')
            body=json.loads(request.data)
            self.assertEqual(body['max_completion_tokens'],100)
            return io.BytesIO(json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps(diagnostic)}}],'usage':{'total_tokens':20}}).encode())
        result,usage=evaluate_semantic(settings,'synthetic-key',data,200,transport)
        self.assertEqual(result['status'],'correct'); self.assertEqual(usage,20)
        diagnostic['sourceQuote']='invented source quote'
        with self.assertRaisesRegex(ValueError,'evidence-conflict'): evaluate_semantic(settings,'synthetic-key',data,200,transport)
    def test_configured_adapter_uses_scope_budget_and_mock_transport_only(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            settings={'enabled':True,'configured':True,'provider':'deepseek','model':'test-model','baseUrl':'https://api.deepseek.com','maxOutputTokens':100}
            store=SimpleNamespace(snapshot=mock.Mock(return_value=(settings,'synthetic-key')))
            services=SimpleNamespace(LOCAL_DATABASE_PATH=Path(directory)/'db',ai_store=lambda db:store)
            ledger=SimpleNamespace(reserve=mock.Mock(return_value=1000),finish_budget=mock.Mock())
            provider=configured_semantic_provider(services,'a'*64,'library1',ledger)
            with mock.patch('infrastructure.math_step_provider.evaluate_semantic',return_value=({'status':'correct'},20)) as evaluate:
                self.assertEqual(provider({'requestId':'r1'}),{'status':'correct'})
            for call in store.snapshot.call_args_list: self.assertEqual(call.args,('a'*64,'library1'))
            ledger.reserve.assert_called_once(); ledger.finish_budget.assert_called_once_with('r1',20)
            settings['configured']=False
            with self.assertRaisesRegex(ValueError,'ai-unconfigured'): provider({'requestId':'r2'})
            self.assertEqual(evaluate.call_count,1)

if __name__=='__main__': unittest.main()
