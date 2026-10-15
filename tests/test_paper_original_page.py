import ast
import base64
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
import paper_library
from server_route_fixture import load_route_methods, server_tree


class PaperOriginalPageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / 'paper.pdf'
        writer = PdfWriter()
        writer.add_blank_page(width=400, height=500)
        second = writer.add_blank_page(width=800, height=600).rotate(90)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        second[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        content = DecodedStreamObject()
        content.set_data(b'BT /F1 12 Tf 10 100 Td (Original page two) Tj ET')
        second[NameObject('/Contents')] = writer._add_object(content)
        output = io.BytesIO()
        writer.write(output)
        self.raw = output.getvalue()
        self.source.write_bytes(self.raw)
        self.service = paper_library.PaperLibrary(self.root, self.root / 'unused.db', 'owner', 'local', account_library='account')
        self.payload = {'localLibraryId': 'local', 'accountLibraryId': 'account', 'source': {'kind': 'vault', 'path': 'paper.pdf', 'version': hashlib.sha256(self.raw).hexdigest()}, 'page': 2}

    def tearDown(self):
        self.tmp.cleanup()

    def test_returns_complete_single_physical_page_without_source_or_database_writes(self):
        before = [(p.relative_to(self.root), p.read_bytes()) for p in self.root.rglob('*') if p.is_file()]
        result = self.service.original_page(self.payload)
        self.assertEqual(set(result), {'sourceVersion', 'page', 'mime', 'data', 'assetVersion'})
        raw = base64.b64decode(result['data'], validate=True)
        reader = PdfReader(io.BytesIO(raw))
        self.assertEqual(len(reader.pages), 1)
        self.assertEqual(float(reader.pages[0].mediabox.width), 800)
        self.assertEqual(reader.pages[0].rotation, 90)
        self.assertEqual(reader.pages[0].extract_text(), 'Original page two')
        self.assertEqual(result['page'], 2)
        self.assertEqual(result['mime'], 'application/pdf')
        self.assertEqual(result['sourceVersion'], self.payload['source']['version'])
        self.assertEqual(result['assetVersion'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(before, [(p.relative_to(self.root), p.read_bytes()) for p in self.root.rglob('*') if p.is_file()])

    def test_rejects_wrong_library_unknown_fields_and_invalid_pages(self):
        changes = [{'localLibraryId': 'other'}, {'accountLibraryId': 'other'}, {'accountLibraryId': ''}, {'accountLibraryId': None}, {'url': 'https://other.example/paper.pdf'}]
        changes += [{'page': p} for p in [0, -1, 3, 201, True, 1.5, '1', None]]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.service.original_page({**self.payload, **change})

    def test_rejects_paths_urls_unavailable_and_unsupported_origins(self):
        for path in ['../outside.pdf', '/outside.pdf', 'C:/private.pdf', 'https://example.com/paper.pdf', '.hidden/paper.pdf', 'missing.pdf']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.service.original_page({**self.payload, 'source': {**self.payload['source'], 'path': path}})
        (self.root / 'paper.md').write_text('text')
        for source in [{'kind': 'upload', 'filename': 'paper.pdf', 'version': self.payload['source']['version']}, {'kind': 'notion', 'pageId': '1' * 32, 'version': self.payload['source']['version']}, {**self.payload['source'], 'path': 'paper.md'}]:
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'original-page-unavailable'):
                self.service.original_page({**self.payload, 'source': source})

    def test_rejects_symlink_even_when_target_is_in_library(self):
        link = self.root / 'link.pdf'
        try:
            link.symlink_to(self.source)
        except OSError as error:
            if os.name != 'nt':
                self.skipTest(f'OS cannot create test symlink: {error}')
            # Windows junctions exercise the same reparse guard without symlink privilege.
            junction = self.root / 'linked-directory'
            result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(self.root)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            try:
                with self.assertRaises(ValueError):
                    self.service.original_page({**self.payload, 'source': {**self.payload['source'], 'path': 'linked-directory/paper.pdf'}})
            finally:
                junction.rmdir()
            return
        with self.assertRaises(ValueError):
            self.service.original_page({**self.payload, 'source': {**self.payload['source'], 'path': 'link.pdf'}})

    def test_rejects_source_replaced_before_or_during_page_derivation(self):
        with self.assertRaisesRegex(ValueError, 'source-changed'):
            self.service.original_page({**self.payload, 'source': {**self.payload['source'], 'version': '0' * 64}})
        real_write = PdfWriter.write
        def changing_write(writer, stream):
            result = real_write(writer, stream)
            self.source.write_bytes(self.raw + b'\n% changed')
            return result
        with patch.object(PdfWriter, 'write', changing_write), self.assertRaisesRegex(ValueError, 'source-changed'):
            self.service.original_page(self.payload)

    def test_rejects_source_changed_during_initial_read(self):
        real_open = Path.open
        class ChangingRead:
            def __init__(stream):
                stream.handle = real_open(self.source, 'rb')
            def __enter__(stream):
                return stream
            def __exit__(stream, *args):
                stream.handle.close()
            def fileno(stream):
                return stream.handle.fileno()
            def read(stream, *args):
                result = stream.handle.read(*args)
                self.source.write_bytes(self.raw + b'\n% changed during read')
                return result
        def changing_open(path, *args, **kwargs):
            if path == self.source and args == ('rb',):
                return ChangingRead()
            return real_open(path, *args, **kwargs)
        with patch.object(Path, 'open', changing_open), self.assertRaisesRegex(ValueError, 'source-changed'):
            self.service.original_page(self.payload)

    def test_rejects_library_path_opened_as_real_outside_file_handle(self):
        # Keep every path safety/stat check real and valid while open returns a real
        # descriptor for the wrong file. The attacker's requested SHA matches it.
        with tempfile.TemporaryDirectory() as outside_directory:
            outside = Path(outside_directory).resolve() / 'outside.pdf'
            writer = PdfWriter()
            writer.add_blank_page(width=923, height=500)
            output = io.BytesIO()
            writer.write(output)
            outside.write_bytes(output.getvalue())
            payload = {**self.payload, 'page': 1, 'source': {**self.payload['source'], 'version': hashlib.sha256(output.getvalue()).hexdigest()}}
            real_open = Path.open
            def substitute_open(path, *args, **kwargs):
                if path == self.source and args == ('rb',):
                    return real_open(outside, 'rb')
                return real_open(path, *args, **kwargs)
            with patch.object(Path, 'open', substitute_open), self.assertRaisesRegex(ValueError, 'source-changed|source-unavailable'):
                self.service.original_page(payload)
            self.assertEqual(self.source.read_bytes(), self.raw)

    def test_rejects_stream_without_trustworthy_file_descriptor(self):
        real_open = Path.open
        def synthetic_open(path, *args, **kwargs):
            if path == self.source and args == ('rb',):
                return io.BytesIO(self.raw)
            return real_open(path, *args, **kwargs)
        with patch.object(Path, 'open', synthetic_open), self.assertRaisesRegex(ValueError, 'source-unavailable'):
            self.service.original_page(self.payload)

    @unittest.skipUnless(os.name == 'nt', 'Windows final handle path boundary')
    def test_rejects_outside_hardlink_handle_even_with_matching_inode_and_bytes(self):
        with tempfile.TemporaryDirectory() as outside_directory:
            outside = Path(outside_directory).resolve() / 'outside.pdf'
            os.link(self.source, outside)
            self.assertEqual(self.source.stat().st_ino, outside.stat().st_ino)
            real_open = Path.open
            def substitute_open(path, *args, **kwargs):
                if path == self.source and args == ('rb',):
                    return real_open(outside, 'rb')
                return real_open(path, *args, **kwargs)
            with patch.object(Path, 'open', substitute_open), self.assertRaisesRegex(ValueError, 'source-changed'):
                self.service.original_page(self.payload)

    @unittest.skipUnless(os.name == 'nt', 'Windows final handle path boundary')
    def test_rejects_when_os_cannot_resolve_actual_handle_path(self):
        import ctypes
        def unavailable(*args):
            return 0
        with patch.object(ctypes, 'WinDLL', return_value=types.SimpleNamespace(GetFinalPathNameByHandleW=unavailable)), self.assertRaisesRegex(ValueError, 'source-unavailable'):
            self.service.original_page(self.payload)

    def test_source_read_error_and_pdf_limits_are_reported(self):
        real_open = Path.open
        def denied(path, *args, **kwargs):
            if path == self.source:
                raise PermissionError('denied')
            return real_open(path, *args, **kwargs)
        with patch.object(Path, 'open', denied), self.assertRaisesRegex(ValueError, 'source-unavailable'):
            self.service.original_page(self.payload)
        for encrypted, page_count in [(True, 2), (False, 201)]:
            writer = PdfWriter()
            for _ in range(page_count):
                writer.add_blank_page(width=100, height=100)
            if encrypted:
                writer.encrypt('fixture-password')
            output = io.BytesIO()
            writer.write(output)
            self.source.write_bytes(output.getvalue())
            payload = {**self.payload, 'source': {**self.payload['source'], 'version': hashlib.sha256(output.getvalue()).hexdigest()}}
            with self.assertRaisesRegex(ValueError, 'pdf-unavailable'):
                self.service.original_page(payload)
        self.source.write_bytes(b'%PDF-invalid')
        with self.assertRaisesRegex(ValueError, 'pdf-unavailable'):
            self.service.original_page({**self.payload, 'source': {**self.payload['source'], 'version': hashlib.sha256(self.source.read_bytes()).hexdigest()}})
        with self.source.open('wb') as stream:
            stream.truncate(20_000_001)
        with self.assertRaisesRegex(ValueError, 'material-too-large'):
            self.service.original_page(self.payload)


class PaperOriginalPageRoutes(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def service(owner, action, payload=None, query=''):
            self.calls.append((owner, action, payload))
            return {'page': 1}
        self.ns = {'json': json, 'normalize_request_path': lambda p: urlsplit(p).path, 'authenticate_session': lambda t: 'owner' if t == 'paired' else None, 'allowed_origin': lambda o: o == 'http://localhost:3002', 'MAX_UPLOAD_BYTES': 1500000, 'paper_library_request': service}
        load_route_methods(self.ns)

    def request(self, token='paired', origin='http://localhost:3002'):
        raw = json.dumps({'localLibraryId': 'local', 'page': 1}).encode()
        responses = []
        request = types.SimpleNamespace(path='/v1/papers/page', headers={'Origin': origin, 'X-Study-Loop-Session': token, 'Content-Length': str(len(raw))}, rfile=io.BytesIO(raw), send_json=lambda status, value: responses.append((status, value)))
        self.ns['do_POST'](request)
        return responses[-1]

    def test_page_route_preserves_pairing_origin_and_owner_boundaries(self):
        self.assertEqual(self.request(token='')[0], 401)
        self.assertEqual(self.request(origin='https://other.example')[0], 403)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.request(), (200, {'page': 1}))
        self.assertEqual(self.calls, [('owner', 'page', {'localLibraryId': 'local', 'page': 1})])

    def test_factory_dispatches_page_and_rejects_foreign_owner(self):
        node = next(n for n in server_tree().body if isinstance(n, ast.FunctionDef) and n.name == 'paper_library_request')
        root = Path(__file__).resolve().parents[1]
        ns = {'installation_owner_hash': lambda: 'owner', 'NOTE_SOURCE_LOCK': threading.RLock(), 'source_path': lambda k: root, 'LOCAL_DATABASE_PATH': root / '.superpowers/unused-fixture.db', 'local_vault_library_id': lambda v: 'local', 'get_note_source_runtime': lambda: types.SimpleNamespace(service=None, paper_source_lookup=None)}
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'paper-factory', 'exec'), ns)
        with patch.object(paper_library.PaperLibrary, 'original_page', return_value={'page': 1}) as page:
            self.assertEqual(ns['paper_library_request']('owner', 'page', {'localLibraryId': 'local'}), {'page': 1})
            with self.assertRaisesRegex(ValueError, 'owner-mismatch'):
                ns['paper_library_request']('foreign', 'page', {'localLibraryId': 'local'})
            self.assertEqual(page.call_count, 1)
