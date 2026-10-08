"""Closed request schemas reject references and ambiguous native identities."""
import copy
import unittest
from test_native_course_service import Harness
from native_course_schema import parse_grade_request, parse_claim_request


class NativeCourseSchemaTests(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)

    def test_closed_request_action_parent_revision_and_reference_fields(self):
        good = self.h.request()
        self.assertEqual(parse_grade_request(good), good)
        patches = ({'reference': 'client reference'}, {'schemaVersion': True},
                   {'selfStatus': 'correct'}, {'parentDiagnosticHash': 'a' * 64},
                   {'parentAttemptId': 'parent', 'parentDiagnosticHash': 'a' * 64},
                   {'action': 'self-assess'}, {'captureId': 'A' * 64})
        for patch in patches:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                parse_grade_request({**good, **patch})
        for patch in ({'answerRevision': True}, {'answerRevision': -1}, {'answerRevealed': 1},
                      {'submittedAt': '2026-10-06'}, {'submittedAt': '2026-02-30T01:00:00Z'},
                      {'maxPreHintLevel': 4}, {'reference': 'client'}):
            bad = copy.deepcopy(good)
            bad['submission'].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                parse_grade_request(bad)

    def test_browser_owner_is_namespace_but_identity_matches_library_item_native_hash(self):
        good = self.h.request()
        self.assertEqual(parse_grade_request(good)['binding']['ownerId'], 'browser-workspace')
        for patch in ({'libraryId': 'other'}, {'snapshotId': 'remote'},
                      {'contentHash': 'b' * 64}, {'itemKey': 'practice:other'}):
            bad = copy.deepcopy(good)
            bad['binding'].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                parse_grade_request(bad)
        good['identity']['ownerId'] = 'client-owner'
        with self.assertRaises(ValueError):
            parse_grade_request(good)

    def test_claim_structure_is_closed_and_pending_hash_cannot_pass(self):
        request = self.h.request()
        receipt = self.h.app.grade(request)
        claim = self.h.claim(request, receipt)
        self.assertEqual(parse_claim_request(claim), claim)
        for patch in ({'rating': 'unknown'}, {'attemptEvaluationHash': None},
                      {'parentDiagnostic': {}}, {'occurredAt': 'tomorrow'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                parse_claim_request({**claim, **patch})

    def test_shared_json_integral_numbers_normalize_but_bool_fraction_unsafe_rejected(self):
        request = self.h.request(schemaVersion=1.0)
        request['identity']['schemaVersion'] = 1.0
        request['submission'].update(answerRevision=1.0, maxPreHintLevel=2.0)
        normalized = parse_grade_request(request)
        self.assertIs(type(normalized['schemaVersion']), int)
        self.assertIs(type(normalized['identity']['schemaVersion']), int)
        self.assertIs(type(normalized['submission']['answerRevision']), int)
        self.assertIs(type(normalized['submission']['maxPreHintLevel']), int)
        for value in (True, 1.5, 9007199254740992, float('inf'), float('nan')):
            bad = self.h.request()
            bad['submission']['answerRevision'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_grade_request(bad)
        request = self.h.request()
        request['submission']['answerRevision'] = 9007199254740991
        self.assertEqual(parse_grade_request(request)['submission']['answerRevision'], 9007199254740991)


if __name__ == '__main__':
    unittest.main()
