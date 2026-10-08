"""CourseStudy V1 rules use the same immutable synthetic fixture as TypeScript."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from course_study_domain import (
    attempt_evaluation_for_diagnostic, choose_course_remediation,
    course_diagnostic_hash, course_diagnostic_outcome, course_task_hash,
    deterministic_course_diagnostic, parse_course_diagnostic,
    parse_course_evaluation_trace, resolve_course_support_v2,
    resolve_course_task, validate_course_diagnostic,
)

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/course-study-diagnostics-v1.json')
                     .read_text(encoding='utf-8'))


def item(support):
    return {'schemaVersion': 2, 'kind': 'practice', 'eventKind': 'due',
            'contentHash': 'a' * 64, 'learningSupport': copy.deepcopy(support),
            'practice': {'questionType': support['type'], 'prompt': support['task']['prompt'],
                         'domain': 'course'}}


def diagnostic(row):
    return copy.deepcopy({**FIXTURE['diagnosticBase'], **row['diagnosticOverrides']})


class CourseStudyDomainTests(unittest.TestCase):
    def test_shared_original_quote_and_partition_fixture(self):
        for row in FIXTURE['cases']:
            task = resolve_course_task(item(FIXTURE['supports'][row['supportId']]))
            value = diagnostic(row)
            before = copy.deepcopy((task, value))
            with self.subTest(case=row['id']):
                if row['valid']:
                    self.assertEqual(validate_course_diagnostic(value, task, row['answer']), value)
                else:
                    with self.assertRaises(ValueError):
                        validate_course_diagnostic(value, task, row['answer'])
                self.assertEqual((task, value), before)

    def test_task_resolution_identity_and_detachment(self):
        source = item(FIXTURE['supports']['definition'])
        parent = resolve_course_task(source)
        child_id = source['learningSupport']['task']['remediations'][0]['taskId']
        child = resolve_course_task(source, child_id)
        self.assertEqual(child['mode'], 'recall')
        self.assertEqual(child['answer'], source['learningSupport']['task']['remediations'][0]['answer'])
        self.assertEqual(child['sources'], parent['sources'])
        self.assertNotEqual(course_task_hash(parent), course_task_hash(child))
        old_hash = course_task_hash(parent)
        source['learningSupport']['task']['sources'][0]['version'] = 'b' * 64
        self.assertNotEqual(old_hash, course_task_hash(resolve_course_task(source)))
        self.assertEqual(old_hash, course_task_hash(parent))
        parsed = resolve_course_support_v2(source)
        parsed['task']['scope'] = 'Detached'
        self.assertNotEqual(parsed, source['learningSupport'])

    def test_original_envelope_and_child_readiness(self):
        original = item(FIXTURE['supports']['definition'])
        patches = [('schemaVersion', True), ('schemaVersion', 1), ('kind', 'word'),
                   ('eventKind', 'word')]
        for key, value in patches:
            source = copy.deepcopy(original)
            source[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                resolve_course_task(source)
        for key in ('answer', 'explanation', 'reviewPoint', 'options'):
            source = copy.deepcopy(original)
            source['practice'][key] = None
            with self.subTest(legacy=key), self.assertRaises(ValueError):
                resolve_course_task(source)
        for patch in ({'reviewStatus': 'candidate'}, {'prompt': 'Other question.'},
                      {'kind': 'application', 'conditions': []}):
            source = copy.deepcopy(original)
            source['learningSupport']['task'].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                resolve_course_task(source)
        source = copy.deepcopy(original)
        child = source['learningSupport']['task']['remediations'][0]
        child.update(kind='application', conditions=[])
        with self.assertRaises(ValueError):
            resolve_course_task(source, child['taskId'])
        with self.assertRaises(ValueError):
            resolve_course_task(original, 'unknown')

    def test_shared_quiz_selection_and_tamper_checks(self):
        task = resolve_course_task(item(FIXTURE['quizSupport']))
        for row in FIXTURE['quizCases']:
            with self.subTest(answer=row['answer']):
                if not row['valid']:
                    with self.assertRaises(ValueError):
                        deterministic_course_diagnostic(task, row['answer'])
                    continue
                value = deterministic_course_diagnostic(task, row['answer'])
                for key in ('status', 'wrongOptionIds', 'missingOptionIds'):
                    self.assertEqual(value[key], row[key])
                self.assertEqual(value['matchedPointIds'], [])
                self.assertEqual(validate_course_diagnostic(value, task, row['answer']), value)
                bad = {**value, 'wrongOptionIds': ['a']}
                with self.assertRaises(ValueError):
                    validate_course_diagnostic(bad, task, row['answer'])
        task['selection'] = 'single'
        with self.assertRaises(ValueError):
            deterministic_course_diagnostic(task, '["a","c"]')
        with self.assertRaises(ValueError):
            deterministic_course_diagnostic(task, '[NaN]')

    def test_closed_utf16_numeric_and_alignment_boundaries(self):
        base = copy.deepcopy(FIXTURE['diagnosticBase'])
        valid = {**base, 'schemaVersion': 1.0, 'feedback': '\U0001f600' * 2000}
        self.assertEqual(parse_course_diagnostic(valid), valid)
        bad_rows = [
            {**base, 'schemaVersion': True}, {**base, 'schemaVersion': 1.5},
            {**base, 'feedback': '\U0001f600' * 2001}, {**base, 'feedback': '\ufeff'},
            {**base, 'feedback': '\ud800'}, {**base, 'feedback': '\x7f'},
            {**base, 'rating': 'good'}, {**base, 'matchedPointIds': ['key\n']},
            {**base, 'missedPointIds': ['key']}, {**base, 'wrongOptionIds': ['a'], 'missingOptionIds': ['a']},
            {**base, 'reason': 'uncertain'}, {**base, 'pointEvidence': [base['pointEvidence'][0]] * 2},
        ]
        for value in bad_rows:
            with self.subTest(value=repr(value)[:100]), self.assertRaises(ValueError):
                parse_course_diagnostic(value)

    def test_self_assessment_pending_and_evaluation_mapping(self):
        empty = {**FIXTURE['diagnosticBase'], 'source': 'self-assess',
                 'matchedPointIds': [], 'pointEvidence': []}
        source = item(FIXTURE['supports']['definition'])
        task = resolve_course_task(source)
        for status, rating in (('correct', 'good'), ('partial', 'hard'), ('incorrect', 'again')):
            value = {**empty, 'status': status}
            self.assertEqual(validate_course_diagnostic(value, task, ''), value)
            self.assertIsNone(choose_course_remediation(source['learningSupport'], value))
            evaluation = attempt_evaluation_for_diagnostic(value, 'a' * 64)
            self.assertEqual(evaluation['rating'], rating)
            self.assertEqual(evaluation['evaluationHash'], '')
        reasons = {'offline': 'offline', 'source-insufficient': 'no-reference',
                   'source-conflict': 'no-reference', 'unavailable': 'invalid',
                   'cancelled': 'invalid', 'uncertain': 'invalid', 'invalid-result': 'invalid'}
        for reason, expected in reasons.items():
            value = {**empty, 'status': 'undetermined', 'source': 'none', 'reason': reason}
            self.assertEqual(validate_course_diagnostic(value, task, ''), value)
            self.assertNotIn('rating', course_diagnostic_outcome(value))
            self.assertEqual(attempt_evaluation_for_diagnostic(value, 'a' * 64)['reason'], expected)
            self.assertIsNone(choose_course_remediation(source['learningSupport'], value))
        with self.assertRaises(ValueError):
            attempt_evaluation_for_diagnostic(value, 'A' * 64)

    def test_remediation_priority_copy_and_authored_option_fallback(self):
        row = next(row for row in FIXTURE['cases'] if row['id'] == 'partial')
        support = copy.deepcopy(FIXTURE['supports'][row['supportId']])
        value = diagnostic(row)
        selected = choose_course_remediation(support, value)
        self.assertEqual(selected['taskId'], support['task']['remediations'][0]['taskId'])
        selected['scope'] = 'Detached'
        self.assertNotEqual(selected['scope'], support['task']['remediations'][0]['scope'])
        support['task']['reviewStatus'] = 'disputed'
        self.assertIsNone(choose_course_remediation(support, value))
        quiz = FIXTURE['quizSupport']
        wrong = deterministic_course_diagnostic(resolve_course_task(item(quiz)), '["b"]')
        self.assertEqual(choose_course_remediation(quiz, wrong), quiz['task']['remediations'][0])

    def test_mandatory_gaps_precede_errors_and_options_follow_author_order(self):
        support = copy.deepcopy(FIXTURE['supports']['partial'])
        mandatory = support['task']['remediations'][0]
        error = {**copy.deepcopy(mandatory), 'taskId': 'error-retry', 'targetPointIds': ['key']}
        support['task']['remediations'].insert(0, error)
        value = {**copy.deepcopy(FIXTURE['diagnosticBase']), 'status': 'incorrect',
                 'matchedPointIds': [], 'missedPointIds': ['extra'], 'errorPointIds': ['key']}
        self.assertEqual(choose_course_remediation(support, value)['taskId'], mandatory['taskId'])
        support['criteria'][1]['mandatory'] = False
        self.assertEqual(choose_course_remediation(support, value)['taskId'], error['taskId'])
        quiz = copy.deepcopy(FIXTURE['quizSupport'])
        missing = {**copy.deepcopy(quiz['task']['remediations'][0]), 'taskId': 'missing-retry',
                   'targetPointIds': [], 'wrongOptionIds': [], 'missingOptionIds': ['a']}
        quiz['task']['remediations'].append(missing)
        wrong = deterministic_course_diagnostic(resolve_course_task(item(quiz)), '["b"]')
        self.assertEqual(choose_course_remediation(quiz, wrong)['taskId'], 'missing-retry')

    def test_trace_closed_fields_hash_and_js_integer_canonicalization(self):
        trace = FIXTURE['trace']
        self.assertEqual(parse_course_evaluation_trace(trace), trace)
        self.assertIsNone(parse_course_evaluation_trace(None))
        for patch in ({'requestId': 'request\n'}, {'provider': ''}, {'extra': True}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                parse_course_evaluation_trace({**trace, **patch})
        value = FIXTURE['diagnosticBase']
        self.assertNotEqual(course_diagnostic_hash(value, trace),
                            course_diagnostic_hash(value, {**trace, 'requestId': 'other'}))
        task = resolve_course_task(item(FIXTURE['supports']['definition']))
        other = copy.deepcopy(task)
        other['schemaVersion'] = 1.0
        self.assertEqual(course_task_hash(task), course_task_hash(other))


if __name__ == '__main__':
    unittest.main()
