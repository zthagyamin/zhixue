"""Synthetic behavioral summaries must not change the original learning evidence."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
if importlib.util.find_spec('assistance_schema'):
    import assistance_schema as schema
else:
    schema = None
VECTORS = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))


class AssistanceSchemaTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(schema, 'Pure assistance schema must exist')
        self.parent = copy.deepcopy(VECTORS['records'][0])
        self.body = dict(schemaVersion=1, attemptEventId=self.parent['event']['eventId'],
                         attemptCoreHash=self.parent['event']['coreHash'], practiceMode=self.parent['practiceMode'],
                         observationScope='current-page-attempt', preSubmitAssistance=[dict(action='meaning-check', count=1)], postSubmitFeedback=[])

    def test_typescript_golden_vector(self):
        golden = json.loads((Path(__file__).parent / 'fixtures/assistance-summary-v1.json').read_text(encoding='utf-8'))
        self.assertEqual(schema.seal_summary(self.body), golden)
        self.assertEqual(schema.validate_summary(golden), golden)

    def test_seal_validate_and_parent_are_nonmutating(self):
        summary = schema.seal_summary(self.body)
        self.assertEqual(schema.validate_summary(summary), summary)
        schema.validate_parent(summary, self.parent['event'], self.parent['practiceMode'])
        self.body['preSubmitAssistance'][0]['count'] = 2
        self.assertEqual(summary['preSubmitAssistance'][0]['count'], 1)
        with self.assertRaisesRegex(ValueError, 'parent'):
            schema.validate_parent(summary, VECTORS['records'][1]['event'], self.parent['practiceMode'])
        with self.assertRaisesRegex(ValueError, 'mode'):
            schema.validate_parent(summary, self.parent['event'], 'spelling')
        summary['preSubmitAssistance'] = []
        with self.assertRaisesRegex(ValueError, 'integrity'):
            schema.validate_summary(summary)

    def test_counts_fields_and_phase_are_strict(self):
        for count in (0, -1, 1.5, True, '1', 10001):
            body = copy.deepcopy(self.body); body['preSubmitAssistance'][0]['count'] = count
            with self.assertRaises(ValueError): schema.seal_summary(body)
        for key in ('answer', 'prompt', 'chat', 'localPath', 'sourceNote', 'stage'):
            body = dict(self.body, **{key: 'excluded'})
            with self.assertRaisesRegex(ValueError, 'field'): schema.seal_summary(body)
        body = copy.deepcopy(self.body); body['preSubmitAssistance'][0]['action'] = 'answer-feedback'
        with self.assertRaisesRegex(ValueError, 'action'): schema.seal_summary(body)
        body['postSubmitFeedback'] = body['preSubmitAssistance']; body['preSubmitAssistance'] = []
        schema.seal_summary(body)
        for version in (True, '1', 2):
            with self.assertRaises(ValueError): schema.seal_summary(dict(self.body, schemaVersion=version))

    def test_order_is_canonical_and_duplicates_are_rejected(self):
        self.body['preSubmitAssistance'].append(dict(action='ai-hint', count=1))
        summary = schema.seal_summary(self.body); self.body['preSubmitAssistance'].reverse()
        self.assertEqual(schema.seal_summary(self.body), summary)
        self.body['preSubmitAssistance'].append(dict(action='ai-hint', count=1))
        with self.assertRaisesRegex(ValueError, 'duplicate'): schema.seal_summary(self.body)

    def test_account_association_matches_typescript_and_requires_original_envelope(self):
        self.assertTrue(hasattr(schema, 'seal_account_assistance'))
        summary = schema.seal_summary(self.body); record = schema.seal_account_assistance(self.parent, summary)
        self.assertEqual(record['associationHash'], 'c3cc9a128285e7affebc34128930dbfa11e5b05efd2e116fe071cd8abe52306c')
        self.assertEqual(schema.validate_account_assistance(record, self.parent), record)
        with self.assertRaisesRegex(ValueError, 'binding'): schema.validate_account_assistance(record, VECTORS['records'][1])
        changed = dict(record, libraryId='other')
        with self.assertRaisesRegex(ValueError, 'integrity'): schema.validate_account_assistance(changed)

    def test_native_association_is_strict_and_separate_from_account_envelopes(self):
        self.assertTrue(hasattr(schema, 'seal_native_assistance'))
        summary = schema.seal_summary(self.body)
        binding = dict(schemaVersion=1, eventId=summary['attemptEventId'], coreHash=summary['attemptCoreHash'], contentHash='a'*64, localBindingHash='b'*64, practiceMode='three-stage')
        record = schema.seal_native_assistance(binding, summary)
        self.assertEqual(schema.validate_native_assistance(record), record)
        with self.assertRaisesRegex(ValueError, 'binding'): schema.seal_native_assistance(dict(binding, coreHash='c'*64), summary)
        with self.assertRaisesRegex(ValueError, 'field'): schema.validate_native_binding(dict(binding, sourceNote='private'))
        with self.assertRaises(ValueError): schema.validate_account_assistance(record)

    def test_separate_receipts_require_proof_and_exact_auxiliary_association(self):
        self.assertTrue(hasattr(schema, 'validate_assistance_receipt'))
        summary = schema.seal_summary(self.body); record = schema.seal_account_assistance(self.parent, summary)
        receipt = dict(schemaVersion=1, receiptId='receipt-one', summaryId=summary['summaryId'], summaryHash=summary['summaryHash'], associationHash=record['associationHash'], status='received')
        self.assertEqual(schema.check_assistance_receipt(record, receipt), receipt)
        with self.assertRaisesRegex(ValueError, 'proof'): schema.validate_assistance_receipt(dict(receipt, status='applied'))
        applied = dict(receipt, status='applied', proof=dict(attemptCoreHash=summary['attemptCoreHash'], proofHash='b'*64, targetCount=2))
        self.assertEqual(schema.check_assistance_receipt(record, applied), applied)
        with self.assertRaisesRegex(ValueError, 'binding'): schema.check_assistance_receipt(record, dict(applied, summaryHash='c'*64))
        with self.assertRaises(ValueError): schema.validate_assistance_receipt(dict(applied, proof=dict(applied['proof'], targetCount=True)))
        with self.assertRaisesRegex(ValueError, 'field'): schema.validate_assistance_receipt(dict(receipt, eventId='event-one'))
