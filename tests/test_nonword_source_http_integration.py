"""Real copied Companion HTTP, source parsing and persistence; external AI disabled."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class NonwordSourceHttpIntegrationTests(unittest.TestCase):
    def run_source_scenario(self, scenario):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(prefix='zhixue-source-http-result-') as temp:
            output = Path(temp) / 'result.json'
            result = subprocess.run(
                [sys.executable, '-I', '-X', 'utf8', '-B',
                 str(root / 'scripts/nonword-source-http-fixture.py'), '--out', str(output),
                 '--scenario', scenario],
                capture_output=True, text=True, encoding='utf-8', timeout=90,
            )
            self.assertEqual(result.returncode, 0, result.stdout[-2000:] + result.stderr[-2000:])
            proof = json.loads(output.read_text(encoding='utf-8'))
            self.assertTrue(proof['complete'])
            self.assertTrue(proof['businessComplete'])
            self.assertTrue(proof['cleanupCompleted'])
            self.assertTrue(proof['httpThreadStopped'])
            self.assertEqual(proof['httpTransport'], 'CompanionHTTPServer')
            self.assertEqual(proof['modelsAttempted'], 0)
            self.assertEqual(proof['productionWrites'], 0)
            self.assertEqual(proof['actions'], sorted([
                'capture', 'submit', 'read', 'confirm', 'evaluate', 'claim',
                'self-assess', 'code-report', 'code-hint',
            ]))
            self.assertEqual(proof['hintStatus'], 'pending')
            self.assertEqual(proof['codeStatus'], 'pending')
            self.assertEqual(proof['formalRecords'], 2)
            self.assertEqual(proof['quiz']['first']['event']['attempt']['rating'], 'good')
            self.assertEqual(proof['flashcard']['first']['event']['attempt']['rating'], 'again')
            self.assertFalse(proof['flashcard']['first']['event']['attempt']['correct'])
            for row in [proof['quiz'], proof['flashcard']]:
                self.assertEqual(row['first']['status'], 'accepted')
                self.assertEqual(row['duplicate']['status'], 'duplicate')
                self.assertEqual(row['first']['event'], row['duplicate']['event'])
                self.assertTrue(row['first']['companionReceipt']['durable'])
                self.assertTrue(row['duplicate']['companionReceipt']['durable'])
            return proof

    def test_original_pending_confirmation_self_assessment_and_code_declaration_through_actual_http(self):
        self.run_source_scenario('lifecycle')

    def test_current_library_switch_keeps_same_identity_answers_separate(self):
        proof = self.run_source_scenario('library-switch')
        self.assertEqual(proof['scenario'], 'library-switch')
        switch = proof['librarySwitch']
        for field in ['controlledConfig', 'sameLogicalAttempt', 'sameContentHash',
                      'distinctLibrary', 'originalAUnchanged', 'newBUngraded',
                      'formalRecordsUnchanged', 'sameOwner']:
            self.assertTrue(switch[field], field)

    def test_source_revision_keeps_original_answer_and_formal_result_separate_from_new_reference(self):
        proof = self.run_source_scenario('source-update')
        self.assertEqual(proof['scenario'], 'source-update')
        update = proof['sourceUpdate']
        for field in ['sameItemDistinctVersion', 'oldPresentationPending',
                      'oldEvaluationNotCurrent', 'unclaimedOldGradeCannotClaim',
                      'newReferenceCannotBindOldAnswer', 'newVersionOldAnswerIncorrect',
                      'oldFormalUnchanged', 'oldFormalReplayDuplicate',
                      'restoredExactSourceRecoversOriginalEvaluation', 'formalRecordsUnchanged']:
            self.assertTrue(update[field], field)

    def test_source_change_during_actual_grade_keeps_pending_and_recovers_original_answer(self):
        proof = self.run_source_scenario('source-inflight')
        self.assertEqual(proof['scenario'], 'source-inflight')
        inflight = proof['sourceInflight']
        for field in ['actualGradeEntry', 'actualMaterialVersionChange', 'immutableOriginalInput',
                      'competingRequestsWait', 'staleGradePending', 'originalAnswerSaved',
                      'noSelfAssessmentFallback', 'pendingCannotClaim', 'pendingRequestImmutable',
                      'exactRestoreExplicitRecovery', 'originalFormalUnchanged', 'formalRecordsUnchanged']:
            self.assertTrue(inflight[field], field)
        self.assertEqual(inflight['deterministicGradeCalls'], 2)


if __name__ == '__main__':
    unittest.main()
