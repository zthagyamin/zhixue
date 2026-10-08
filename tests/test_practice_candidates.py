import copy
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from note_imports import SourceError, learning_items, read_local_documents
from practice_candidates import parse_candidate_document


def document():
    quote = '😀 x < 1 & y > 0 | z\nNext line'
    return {
        'documentType': 'zhixue-practice-candidates', 'schemaVersion': 1,
        'status': 'reviewed-candidates',
        'parent': {'key': 'paper-one', 'sourceVersion': 'v1', 'versionKind': 'paper-origin', 'kind': 'paper', 'title': 'Synthetic paper'},
        'items': [{'id': 'q1', 'question': 'Explain the condition', 'reference': quote,
                   'keyPoints': 'Check the boundary', 'category': 'limitation',
                   'fragmentId': 'p1', 'quote': quote,
                   'citation': {'fragmentId': 'p1', 'label': 'Paragraph one', 'start': 3,
                                'end': 3 + len(quote.encode('utf-16-le')) // 2, 'page': 2}}],
    }


class PracticeCandidateTests(unittest.TestCase):
    def test_file_folder_zip_select_only_the_dedicated_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = json.dumps(document(), ensure_ascii=False).encode('utf-8')
            candidate = root / 'approved.zhixue-candidates.json'
            candidate.write_bytes(raw)
            (root / 'config.json').write_text('{"not-a-learning-file":true}', encoding='utf-8')
            direct = read_local_documents(candidate)
            self.assertEqual(read_local_documents(root), direct)
            with zipfile.ZipFile(root / 'notes.zip', 'w') as archive:
                archive.writestr('notes/approved.zhixue-candidates.json', raw)
                archive.writestr('config.json', '{}')
            self.assertEqual(read_local_documents(root / 'notes.zip'), direct)
            self.assertEqual(candidate.read_bytes(), raw)
            with self.assertRaisesRegex(SourceError, 'source-unsupported-format'):
                read_local_documents(root / 'config.json')

    def test_invalid_and_future_documents_fail_closed(self):
        mutations = [
            lambda d: d.update(schemaVersion=2),
            lambda d: d.update(schemaVersion=True),
            lambda d: d.update(status='draft'),
            lambda d: d.update(rating='good'),
            lambda d: d['items'][0].update(category='fact'),
            lambda d: d['items'][0].update(keyPoints=''),
            lambda d: d['items'][0]['citation'].update(end=0),
            lambda d: d['items'][0]['citation'].update(page=True),
            lambda d: d['items'][0]['citation'].update(page=5001),
            lambda d: d['items'][0].update(reference='a' * 7001),
            lambda d: d['items'].append(copy.deepcopy(d['items'][0])),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                value = document()
                mutate(value)
                with self.assertRaises(ValueError):
                    parse_candidate_document(json.dumps(value))
        raw = json.dumps(document()).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')
        with self.assertRaisesRegex(ValueError, 'duplicate-field'):
            parse_candidate_document(raw)

    def test_import_is_readonly_stable_source_material_without_formal_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'paper.zhixue-candidates.json'
            value = document()
            path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            before = path.read_bytes()
            docs = read_local_documents(path)
            first = learning_items(docs, 'synthetic-library')
            self.assertEqual(first, learning_items(read_local_documents(path), 'synthetic-library'))
            self.assertEqual(first[0]['answer'], value['items'][0]['reference'] + '\n核对要点：Check the boundary')
            self.assertIn('paper-one', first[0]['material'])
            self.assertIn('"category": "limitation"', first[0]['material'])
            self.assertTrue({'rating', 'mastery', 'schedule', 'event'}.isdisjoint(first[0]))
            self.assertEqual(path.read_bytes(), before)
            self.assertNotEqual(first[0]['identity'], learning_items(docs, 'another-library')[0]['identity'])
            value['items'][0]['reference'] += '\nRevised'
            path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
            self.assertNotEqual(first[0]['identity'], learning_items(read_local_documents(path), 'synthetic-library')[0]['identity'])

    def test_bad_candidate_file_is_not_silently_imported_as_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.zhixue-candidates.json'
            path.write_text('{"schemaVersion":99}', encoding='utf-8')
            with self.assertRaisesRegex(SourceError, 'source-candidate-invalid'):
                read_local_documents(path)


if __name__ == '__main__':
    unittest.main()
