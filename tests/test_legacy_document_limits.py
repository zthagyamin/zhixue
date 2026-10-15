import io
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
import sys
import os

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from infrastructure import vault_documents
import snapshot_schema
import json


def snapshot():
    return snapshot_schema.build_snapshot({'captureId':'ordinary','itemId':'i','domain':'course',
        'sourceNote':'note.md','stateRef':'state.md','abilityId':'a','contentFingerprint':'f','pluginType':'quiz','planRevision':0})


class LegacyDocumentLimitsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_text_prefix_is_read_without_materializing_the_tail(self):
        path = self.root / 'source.txt'
        text = '课程😀\r\n' * 20000
        path.write_bytes(b'\xef\xbb\xbf' + text.encode('utf-8'))
        original_open = Path.open
        sizes = []

        class Tracked:
            def __init__(self, stream): self.stream = stream
            def __getattr__(self, name): return getattr(self.stream, name)
            def __enter__(self): return self
            def __exit__(self, *args): return self.stream.__exit__(*args)
            def read(self, size=-1):
                sizes.append(size)
                if size < 0: raise AssertionError('legacy reader consumed the complete file')
                return self.stream.read(size)

        def tracked_open(target, *args, **kwargs):
            value = original_open(target, *args, **kwargs)
            return Tracked(value) if target == path else value

        with mock.patch.object(Path, 'open', tracked_open):
            actual = vault_documents.extract_text(path, selected_pages=lambda: None)
        self.assertEqual(actual, text.replace('\r\n', '\n')[:80000])
        self.assertTrue(sizes)
        self.assertLessEqual(max(sizes), 320003)

    def test_oversized_pdf_never_enters_the_parser(self):
        path = self.root / 'large.pdf'
        with path.open('wb') as stream:
            stream.seek(20_000_000)
            stream.write(b'x')
        reader = mock.Mock(return_value=types.SimpleNamespace(pages=[types.SimpleNamespace(extract_text=lambda: 'synthetic')]))
        with mock.patch.dict(sys.modules, {'pypdf': types.SimpleNamespace(PdfReader=reader)}):
            with self.assertRaisesRegex(ValueError, '过大|上限|too-large'):
                vault_documents.extract_text(path, selected_pages=lambda: None)
        reader.assert_not_called()

    def test_approved_reader_rejects_a_name_outside_its_owned_directory(self):
        snapshot = snapshot_schema.build_snapshot({'captureId':'ordinary','itemId':'i','domain':'course',
            'sourceNote':'note.md','stateRef':'state.md','abilityId':'a','contentFingerprint':'f','pluginType':'quiz','planRevision':0})
        import json
        directory = self.root / 'sources/approved'
        directory.mkdir(parents=True)
        outside = self.root / 'sources/other.json'
        outside.write_text(json.dumps(snapshot), encoding='utf-8')
        with self.assertRaises(ValueError):
            snapshot_schema.read_approved_snapshot(self.root, '../other.json')

    def test_oversized_metadata_is_not_returned_as_an_empty_success(self):
        path = self.root / 'large-state.md'
        with path.open('wb') as stream:
            stream.write(b'---\nstatus: active\n---\n')
            stream.seek(20_000_000)
            stream.write(b'x')
        with self.assertRaisesRegex(ValueError, '过大|上限|too-large'):
            vault_documents.read_frontmatter(path)

    def test_invalid_snapshot_identity_does_not_enter_the_learning_pool(self):
        directory = self.root / 'sources/approved'
        directory.mkdir(parents=True)
        path = directory / 'bad.json'
        for field in ('itemId', 'domain', 'abilityId', 'contentFingerprint', 'pluginType', 'approvedAt'):
            with self.subTest(field=field):
                value = snapshot()
                value[field] = []
                path.write_text(json.dumps(value), encoding='utf-8')
                self.assertEqual(snapshot_schema.approved_snapshots(self.root), [])

    def test_nested_invalid_json_is_a_clear_read_failure(self):
        directory = self.root / 'sources/approved'
        directory.mkdir(parents=True)
        (directory / 'nested.json').write_text('[' * 2000 + '0' + ']' * 2000, encoding='utf-8')
        with self.assertRaises(ValueError):
            snapshot_schema.read_approved_snapshot(self.root, 'nested.json')
        self.assertEqual(snapshot_schema.approved_snapshots(self.root), [])

    def reparse_lstat(self, blocked, tag=0xA000000C):
        original = Path.lstat
        def inspect(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path.absolute() != blocked.absolute(): return info
            values = {name:getattr(info, name) for name in dir(info) if name.startswith('st_')}
            values.update(st_file_attributes=0x400, st_reparse_tag=tag)
            return types.SimpleNamespace(**values)
        return mock.patch.object(Path, 'lstat', inspect)

    def test_selected_redirected_file_is_not_read(self):
        path = self.root / 'redirected.txt'
        path.write_text('synthetic only', encoding='utf-8')
        with self.reparse_lstat(path):
            with self.assertRaises(ValueError):
                vault_documents.extract_text(path, selected_pages=lambda: None)

    def test_discovery_skips_redirected_directory_and_file_but_keeps_normal_material(self):
        ordinary = self.root / 'ordinary.md'
        ordinary.write_text('# 普通资料', encoding='utf-8')
        directory = self.root / 'redirected'
        directory.mkdir()
        (directory / 'other.md').write_text('# Synthetic other', encoding='utf-8')
        linked = self.root / 'linked.md'
        linked.write_text('# Synthetic linked', encoding='utf-8')
        with self.reparse_lstat(directory):
            with self.reparse_lstat(linked):
                paths = vault_documents.supported_note_files(self.root, SUPPORTED_NOTE_SUFFIXES={'.md'})
        self.assertEqual(paths, [ordinary])

    def test_cloud_hydration_tag_is_not_confused_with_path_redirection(self):
        path = self.root / 'cloud.txt'
        path.write_text('synthetic hydrated content', encoding='utf-8')
        with self.reparse_lstat(path, 0x9000001A):
            self.assertEqual(vault_documents.extract_text(path, selected_pages=lambda: None), 'synthetic hydrated content')

    def test_approved_list_does_not_read_redirected_snapshot(self):
        directory = self.root / 'sources/approved'
        directory.mkdir(parents=True)
        path = directory / 'redirected.json'
        path.write_text(json.dumps(snapshot()), encoding='utf-8')
        with self.reparse_lstat(path):
            self.assertEqual(snapshot_schema.approved_snapshots(self.root), [])
            with self.assertRaises(ValueError): snapshot_schema.read_approved_snapshot(self.root, path.name)

    def test_selected_pdf_stops_after_the_existing_excerpt_is_full(self):
        path = self.root / 'synthetic.pdf'
        path.write_bytes(b'synthetic parser input')
        first = mock.Mock(return_value='x' * 80000)
        tail = mock.Mock(side_effect=AssertionError('unneeded page must not be parsed'))
        reader = types.SimpleNamespace(pages=[types.SimpleNamespace(extract_text=first), types.SimpleNamespace(extract_text=tail)])
        constructor = mock.Mock(return_value=reader)
        with mock.patch.dict(sys.modules, {'pypdf':types.SimpleNamespace(PdfReader=constructor)}):
            self.assertEqual(vault_documents.extract_text(path, selected_pages=lambda: None), 'x' * 80000)
        self.assertIsInstance(constructor.call_args.args[0], io.BytesIO)
        tail.assert_not_called()

    def test_normal_frontmatter_and_selected_page_join_keep_original_content(self):
        path = self.root / 'normal.md'
        path.write_bytes(b'\xef\xbb\xbf---\r\nstatus: active\r\npriority:\r\n  - course\r\n---\r\n# Title\r\nBody\r\n')
        properties, body = vault_documents.read_frontmatter(path)
        self.assertEqual(properties, {'status':'active','priority':['course']})
        self.assertEqual(body, '# Title\nBody')
        pdf = self.root / 'normal.pdf'
        pdf.write_bytes(b'synthetic input')
        pages = [types.SimpleNamespace(extract_text=lambda:'One'),types.SimpleNamespace(extract_text=lambda:''),types.SimpleNamespace(extract_text=lambda:'Three')]
        with mock.patch.dict(sys.modules, {'pypdf':types.SimpleNamespace(PdfReader=lambda _raw:types.SimpleNamespace(pages=pages))}):
            self.assertEqual(vault_documents.extract_text(pdf, selected_pages=lambda:[3,2,1]), 'Three\n\n\n\nOne')

    def test_selected_literal_environment_name_is_not_expanded_again(self):
        selected = self.root / '$ZHIXUE_LITERAL_SOURCE.md'
        other = self.root / 'ordinary.md'
        selected.write_text('---\nstatus: literal\n---\n# Literal source', encoding='utf-8')
        other.write_text('---\nstatus: other\n---\n# Different source', encoding='utf-8')
        with mock.patch.dict(os.environ, {'ZHIXUE_LITERAL_SOURCE':'ordinary'}):
            self.assertIn('Literal source', vault_documents.extract_text(selected, selected_pages=lambda: None))
            self.assertEqual(vault_documents.read_frontmatter(selected)[0]['status'], 'literal')
            self.assertEqual(vault_documents.supported_note_files(self.root, SUPPORTED_NOTE_SUFFIXES={'.md'}), [selected, other])

    def test_approved_literal_environment_name_keeps_the_same_selected_snapshot(self):
        directory = self.root / 'sources/approved'
        directory.mkdir(parents=True)
        (directory / '$ZHIXUE_LITERAL_SNAPSHOT.json').write_text(json.dumps({**snapshot(),'summary':'literal'}), encoding='utf-8')
        (directory / 'ordinary.json').write_text(json.dumps({**snapshot(),'summary':'different'}), encoding='utf-8')
        with mock.patch.dict(os.environ, {'ZHIXUE_LITERAL_SNAPSHOT':'ordinary'}):
            self.assertEqual(snapshot_schema.read_approved_snapshot(self.root, '$ZHIXUE_LITERAL_SNAPSHOT.json')['summary'], 'literal')


if __name__ == '__main__': unittest.main()
