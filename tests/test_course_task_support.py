import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from learning_support import parse_learning_support


def criterion(ident='point'):
    return {'id': ident, 'text': 'Explain the distinction.', 'weight': 1,
            'mandatory': True, 'sourceIds': ['source']}


def task():
    return {'taskId': 'parent', 'kind': 'definition', 'prompt': 'Define the term.',
            'scope': 'One definition.', 'conditions': [],
            'sources': [{'sourceId': 'source', 'label': 'Course chapter',
                         'locator': 'Chapter 1, page 2', 'excerpt': 'The definition.',
                         'version': 'a' * 64}],
            'reviewStatus': 'verified', 'remediations': []}


def recall():
    return {'schemaVersion': 2, 'type': 'recall', 'criteria': [criterion()], 'task': task()}


def quiz():
    return {'schemaVersion': 2, 'type': 'quiz', 'selection': 'single',
            'options': [{'optionId': 'a', 'text': 'First', 'explanation': 'Correct because of the source.', 'sourceIds': ['source']},
                        {'optionId': 'b', 'text': 'Second', 'explanation': 'Wrong because of the source.', 'sourceIds': ['source'],
                         'trapType': 'concept_substitution', 'trapExplanation': 'A different concept.'}],
            'correctOptionIds': ['a'], 'criteria': [criterion()], 'task': task()}


def remediation():
    return {'taskId': 'remedy', 'kind': 'definition', 'prompt': 'Explain the distinction.',
            'scope': 'One distinction.', 'conditions': [], 'criteria': [criterion('remedy-point')],
            'answer': 'The distinction is in the source.', 'targetPointIds': ['point'],
            'wrongOptionIds': [], 'missingOptionIds': []}


class CourseTaskSupportTests(unittest.TestCase):
    def assert_invalid(self, support, mode='recall'):
        with self.assertRaises(ValueError):
            parse_learning_support(support, mode)

    def test_v2_recall_roundtrip_and_copy(self):
        support = recall()
        parsed = parse_learning_support(support, 'recall')
        self.assertEqual(parsed, support)
        parsed['task']['sources'][0]['excerpt'] = 'Changed'
        self.assertEqual(support['task']['sources'][0]['excerpt'], 'The definition.')

    def test_v2_quiz_roundtrip_retains_traps(self):
        self.assertEqual(parse_learning_support(quiz(), 'quiz'), quiz())

    def test_five_task_kinds_and_review_states_are_structural(self):
        for kind in ('definition', 'steps', 'comparison', 'conditions', 'application'):
            for state in ('candidate', 'verified', 'disputed'):
                support = recall()
                support['task'].update(kind=kind, reviewStatus=state, conditions=['Under the stated assumption.'])
                with self.subTest(kind=kind, state=state):
                    self.assertEqual(parse_learning_support(support, 'recall'), support)

    def test_closed_required_objects(self):
        for path in ((), ('task',), ('task', 'sources', 0), ('criteria', 0)):
            for action in ('extra', 'missing'):
                support = recall()
                obj = support
                for key in path:
                    obj = obj[key]
                if action == 'extra':
                    obj['unknown'] = 'x'
                else:
                    obj.pop(next(key for key in obj if key not in ('weight', 'mandatory')))
                with self.subTest(path=path, action=action):
                    self.assert_invalid(support)

    def test_bounded_text_and_utf16(self):
        for path, limit in ((('task', 'taskId'), 64), (('task', 'prompt'), 4000),
                            (('task', 'scope'), 1500), (('task', 'sources', 0, 'label'), 300),
                            (('task', 'sources', 0, 'locator'), 1000),
                            (('task', 'sources', 0, 'excerpt'), 16000), (('criteria', 0, 'text'), 1500)):
            for value in ('x' * (limit + 1), '\ufeff', '\x00'):
                support = recall()
                obj = support
                for key in path[:-1]:
                    obj = obj[key]
                obj[path[-1]] = value
                with self.subTest(path=path, value=repr(value[:4])):
                    self.assert_invalid(support)
        support = recall()
        support['task']['prompt'] = '\U0001f600' * 2000
        self.assertEqual(parse_learning_support(support, 'recall'), support)
        support['task']['prompt'] += '\U0001f600'
        self.assert_invalid(support)

    def test_ids_versions_and_numeric_types(self):
        for value in ('has space', '中文', 'x' * 65, ''):
            support = recall()
            support['task']['taskId'] = value
            self.assert_invalid(support)
        for value in ('A' * 64, 'a' * 63, 'g' * 64):
            support = recall()
            support['task']['sources'][0]['version'] = value
            self.assert_invalid(support)
        for value in (True, 1.5, 0, 1001):
            support = recall()
            support['criteria'][0]['weight'] = value
            self.assert_invalid(support)
        support = recall()
        support['criteria'][0]['mandatory'] = 1
        self.assert_invalid(support)

    def test_task_maximums_are_accepted(self):
        support = recall()
        support['task'].update(taskId='p' * 64, prompt='p' * 4000, scope='s' * 1500,
                               conditions=['c' * 1500] * 16)
        support['task']['sources'] = [
            {'sourceId': 's' + str(i), 'label': 'l' * 300, 'locator': 'l' * 1000,
             'excerpt': 'e' * 16000, 'version': 'a' * 64} for i in range(12)]
        source_ids = [source['sourceId'] for source in support['task']['sources']]
        support['criteria'] = [{**criterion('p' + str(i)), 'text': 't' * 1500,
                                'weight': 1000, 'sourceIds': source_ids} for i in range(24)]
        support['task']['remediations'] = [
            {**remediation(), 'taskId': 'r' + str(i), 'answer': 'a' * 8000,
             'targetPointIds': [point['id'] for point in support['criteria']],
             'criteria': [{**criterion(), 'sourceIds': source_ids}]} for i in range(12)]
        support['hints'] = ['h' * 2000] * 3
        self.assertEqual(parse_learning_support(support, 'recall'), support)

    def test_locator_rejects_absolute_local_paths_and_accepts_urls(self):
        for locator in ('C:\\Users\\private.md', 'D:/private.md', '\\\\server\\share\\file',
                        '/home/private.md', ' \ufeffC:\\Users\\private.md'):
            support = recall()
            support['task']['sources'][0]['locator'] = locator
            with self.subTest(locator=locator):
                self.assert_invalid(support)
        for locator in ('https://example.test/course#page2', 'Chapter 2 / page 3', 'notes/chapter.md'):
            support = recall()
            support['task']['sources'][0]['locator'] = locator
            self.assertEqual(parse_learning_support(support, 'recall'), support)

    def test_source_and_criterion_references_are_unique_known_nonempty(self):
        for value in ([], ['unknown'], ['source', 'source'], ['source'] * 13):
            support = recall()
            support['criteria'][0]['sourceIds'] = value
            self.assert_invalid(support)
        for key in ('sources',):
            support = recall()
            support['task'][key] *= 2
            self.assert_invalid(support)
        support = recall()
        support['criteria'] *= 2
        self.assert_invalid(support)

    def test_array_bounds(self):
        for key, value in (('sources', []), ('sources', [task()['sources'][0]] * 13),
                           ('conditions', ['x'] * 17), ('conditions', ['x' * 1501]),
                           ('remediations', [remediation()] * 13)):
            support = recall()
            support['task'][key] = value
            self.assert_invalid(support)
        for value in ([], [criterion()] * 25):
            support = recall()
            support['criteria'] = value
            self.assert_invalid(support)

    def test_remediation_triggers_and_identity(self):
        support = recall()
        support['task']['remediations'] = [remediation()]
        self.assertEqual(parse_learning_support(support, 'recall'), support)
        for patch in ({'taskId': 'parent'}, {'targetPointIds': []}, {'targetPointIds': ['unknown']},
                      {'targetPointIds': ['point', 'point']}, {'wrongOptionIds': ['a']},
                      {'missingOptionIds': ['a']}, {'answer': 'x' * 8001}):
            altered = copy.deepcopy(support)
            altered['task']['remediations'][0].update(patch)
            self.assert_invalid(altered)
        altered = copy.deepcopy(support)
        altered['task']['remediations'] *= 2
        self.assert_invalid(altered)

    def test_remediation_cannot_add_sources_or_recurse(self):
        for patch in ({'sources': task()['sources']}, {'task': task()}, {'reviewStatus': 'verified'},
                      {'remediations': []}, {'criteria': [{**criterion(), 'sourceIds': ['other']}]}):
            support = recall()
            support['task']['remediations'] = [{**remediation(), **patch}]
            self.assert_invalid(support)
        support = recall()
        support['task']['remediations'] = [remediation()]
        del support['task']['remediations'][0]['missingOptionIds']
        self.assert_invalid(support)

    def test_quiz_option_explanations_and_references_required(self):
        for patch in ({'explanation': ''}, {'explanation': 'x' * 2001}, {'sourceIds': []},
                      {'sourceIds': ['unknown']}, {'sourceIds': ['source', 'source']}, {'unknown': True}):
            support = quiz()
            support['options'][0].update(patch)
            self.assert_invalid(support, 'quiz')
        for key in ('explanation', 'sourceIds'):
            support = quiz()
            del support['options'][0][key]
            self.assert_invalid(support, 'quiz')

    def test_quiz_remediation_uses_parent_options(self):
        for key in ('wrongOptionIds', 'missingOptionIds'):
            support = quiz()
            support['task']['remediations'] = [{**remediation(), 'targetPointIds': [], key: ['b']}]
            self.assertEqual(parse_learning_support(support, 'quiz'), support)
            support['task']['remediations'][0][key] = ['invented']
            self.assert_invalid(support, 'quiz')

    def test_quiz_duplicate_text_normalizes_nfc_and_js_whitespace(self):
        for left, right in (('Café term', 'Cafe\u0301\ufeff\tterm'), ('x\u00a0y', 'x y'), (' one ', 'one')):
            support = quiz()
            support['options'][0]['text'] = left
            support['options'][1]['text'] = right
            self.assert_invalid(support, 'quiz')
        support = quiz()
        support['options'][0]['text'] = 'x\u0085y'
        support['options'][1]['text'] = 'x y'
        # U+0085 is not JS whitespace. Its separate control rejection remains valid.
        self.assert_invalid(support, 'quiz')

    def test_v1_preserves_duplicate_option_text_and_optional_recall(self):
        support = quiz()
        support['schemaVersion'] = 1
        del support['task'], support['criteria']
        for option in support['options']:
            del option['sourceIds'], option['explanation']
            option['text'] = 'Same'
        self.assertEqual(parse_learning_support(support, 'quiz'), support)
        hints = {'schemaVersion': 1, 'type': 'recall', 'hints': ['First', 'Second', 'Third']}
        self.assertEqual(parse_learning_support(hints, 'recall'), hints)

    def test_other_modes_cannot_accept_course_v2(self):
        for mode in ('spelling', 'flashcard', 'calculation', 'code'):
            self.assert_invalid(recall(), mode)

    def test_review_status_cannot_coerce_an_array(self):
        support = recall()
        support['task']['reviewStatus'] = ['verified']
        self.assert_invalid(support)

    def test_v2_accepts_integral_json_decimal_and_exponent_tokens(self):
        for mode, make_support in (('recall', recall), ('quiz', quiz)):
            for version in ('2.0', '2e0'):
                for weight in ('1.0', '1e0', '1000.0', '1e3'):
                    lexical = json.dumps(make_support()).replace('"schemaVersion": 2', '"schemaVersion": ' + version)
                    lexical = lexical.replace('"weight": 1', '"weight": ' + weight)
                    support = json.loads(lexical)
                    with self.subTest(mode=mode, version=version, weight=weight):
                        self.assertEqual(parse_learning_support(support, mode), support)

    def test_v2_json_numeric_bounds_and_v1_numeric_types_stay_strict(self):
        for field, token in (('schemaVersion', 'true'), ('schemaVersion', '2.5'),
                             ('schemaVersion', '1e309'), ('weight', 'true'),
                             ('weight', '1.5'), ('weight', '0.0'), ('weight', '1001e0'),
                             ('weight', '1e309'), ('weight', '-1e309')):
            lexical = json.dumps(recall()).replace('"' + field + '": ' + ('2' if field == 'schemaVersion' else '1'),
                                                   '"' + field + '": ' + token)
            with self.subTest(field=field, token=token):
                self.assert_invalid(json.loads(lexical))
        for lexical in ('{"schemaVersion":1.0,"type":"recall","hints":["a","b","c"]}',
                        '{"schemaVersion":1,"type":"recall","criteria":[{"id":"p","text":"point","weight":1e0}]}'):
            self.assert_invalid(json.loads(lexical))

    def test_v2_locator_rejects_local_file_urls(self):
        for locator in ('file:///C:/Users/private.md', 'FILE://server/share/file', '\ufeff File:///tmp/private.md'):
            support = recall()
            support['task']['sources'][0]['locator'] = locator
            with self.subTest(locator=locator):
                self.assert_invalid(support)

    def test_readiness_preserves_order_and_does_not_mutate_validated_task(self):
        from course_task_support import course_task_readiness

        support = recall()
        support['task'].update(reviewStatus='candidate', kind='conditions', prompt='阅读材料：章节（待补具体问题）')
        validated = parse_learning_support(support, 'recall')['task']
        before = copy.deepcopy(validated)
        self.assertEqual(course_task_readiness(validated, 'A different question.', word=True),
                         ['course-task-word', 'course-task-unreviewed', 'course-task-prompt-mismatch',
                          'course-task-missing-conditions', 'unfocused-recall-question'])
        self.assertEqual(validated, before)

    def test_readiness_exact_nfc_js_whitespace_and_conditions(self):
        from course_task_support import course_task_readiness

        support = recall()
        support['task']['prompt'] = 'Définir le terme.'
        validated = parse_learning_support(support, 'recall')['task']
        self.assertEqual(course_task_readiness(validated, ' \ufeffDe\u0301finir\u00a0le\tterme.\n'), [])
        self.assertEqual(course_task_readiness(validated, 'Définir le terme?'), ['course-task-prompt-mismatch'])
        self.assertEqual(course_task_readiness(validated, 'Définir\u0085le terme.'), ['course-task-prompt-mismatch'])
        for kind in ('conditions', 'application'):
            for state in ('candidate', 'disputed'):
                validated.update(kind=kind, reviewStatus=state)
                self.assertEqual(course_task_readiness(validated, validated['prompt']),
                                 ['course-task-unreviewed', 'course-task-missing-conditions'])
            validated.update(reviewStatus='verified', conditions=['Assume the source condition.'])
            self.assertEqual(course_task_readiness(validated, validated['prompt']), [])
            validated['conditions'] = []

    def test_readiness_reuses_known_generic_prompt_detection(self):
        from course_task_support import course_task_readiness

        for prompt in ('阅读材料：章节（待补具体问题）',
                       '请闭卷回忆「主题」的核心要点，并说明相关概念、依据或适用条件。',
                       '换个角度回忆：阅读材料：章节（待补具体问题）',
                       '\ufeff 阅读材料：章节（待补具体问题） \ufeff'):
            support = recall()
            support['task']['prompt'] = prompt
            validated = parse_learning_support(support, 'recall')['task']
            self.assertEqual(course_task_readiness(validated, prompt), ['unfocused-recall-question'])

    def test_sealed_word_rejects_course_v2_and_retains_recall_v1(self):
        from account_sync_schema import seal_item, validate_item

        vectors = json.loads((Path(__file__).parent / 'fixtures/account-study-v1.json').read_text(encoding='utf-8'))
        item = copy.deepcopy(next(item for item in vectors['bundle']['items'] if item['kind'] == 'word'))
        del item['contentHash']
        item.update(schemaVersion=2, completionRule='graded-practice', recommendedPlugin='recall',
                    learningSupport={'schemaVersion': 1, 'type': 'recall', 'hints': ['First', 'Second', 'Third']})
        sealed = seal_item(item)
        self.assertEqual(validate_item(sealed), sealed)
        item['learningSupport'] = recall()
        with self.assertRaisesRegex(ValueError, 'course-task-word'):
            seal_item(item)

    def test_shared_contract_fixture(self):
        cases = json.loads((Path(__file__).parent / 'fixtures/course-task-support-v2.json').read_text(encoding='utf-8'))['cases']
        for case in cases:
            with self.subTest(case=case['id']):
                if case['valid']:
                    self.assertEqual(parse_learning_support(case['support'], case['mode']), case['support'])
                else:
                    self.assert_invalid(case['support'], case['mode'])


if __name__ == '__main__':
    unittest.main()
