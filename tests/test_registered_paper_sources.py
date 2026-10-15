"""Synthetic sourceKey cache behavior and existing per-read safety boundaries."""
import ast
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "companion"))
import academic_vocabulary
import paper_library
import routes_sources
from infrastructure.registered_paper_sources import RegisteredPaperSources

IMAGE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=")
IMAGE_HASH = hashlib.sha256(IMAGE).hexdigest()


class RegisteredPaperSourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / "vault"
        self.root.mkdir()
        self.now = [0.0]
        self.lookup = RegisteredPaperSources(clock=lambda: self.now[0])
        self.payload = self.register("paper/a.md")

    def register(self, rel, root=None):
        root = root or self.root
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = ("# Synthetic " + rel + "\nFigure 1.\n").encode()
        path.write_bytes(raw)
        image = path.with_suffix(".png")
        image.write_bytes(IMAGE)
        figure = {"assetId": "fig1", "label": "Figure 1", "title": "Synthetic",
                  "caption": "Synthetic only", "kind": "image",
                  "path": image.relative_to(root).as_posix(), "assetVersion": IMAGE_HASH}
        version = hashlib.sha256(raw).hexdigest()
        (root / (rel + ".figures.json")).write_text(json.dumps({
            "schemaVersion": 1, "sourceVersion": version, "figures": [figure],
        }), encoding="utf-8")
        return {"localLibraryId": "local", "sourceKey": hashlib.sha256(rel.encode()).hexdigest(),
                "sourceVersion": version, "assetId": "fig1", "assetVersion": IMAGE_HASH}

    def service(self, root=None, owner="owner", local="local", account=None):
        return paper_library.PaperLibrary(root or self.root, self.base / "unused.db", owner,
                                          local, account_library=account, source_lookup=self.lookup)

    def figure(self, payload=None, **scope):
        return self.service(**scope).figure(payload or self.payload)

    def unavailable(self, key):
        with self.assertRaisesRegex(ValueError, "paper-source-unavailable"):
            self.figure({**self.payload, "sourceKey": key})

    def test_new_request_instances_reuse_first_hit_then_only_one_full_miss_scan(self):
        with patch.object(paper_library.os, "walk", wraps=os.walk) as walk:
            for _ in range(4):
                self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.assertEqual(walk.call_count, 1)
            for key in ("0" * 64, "1" * 64, "2" * 64):
                self.unavailable(key)
            self.assertEqual(walk.call_count, 2)
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.assertEqual(walk.call_count, 2)

    def test_initial_miss_builds_once_for_many_distinct_keys(self):
        with patch.object(paper_library.os, "walk", wraps=os.walk) as walk:
            for key in ("0" * 64, "1" * 64, "2" * 64):
                self.unavailable(key)
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.assertEqual(walk.call_count, 1)

    def test_ttl_is_not_sliding_and_new_registry_is_discovered_after_expiry(self):
        self.unavailable("0" * 64)
        added = self.register("paper/new.md")
        self.now[0] = 4.0
        self.unavailable(added["sourceKey"])
        self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
        self.now[0] = 4.99
        self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
        self.now[0] = 5.0
        self.assertEqual(self.figure(added)["assetVersion"], IMAGE_HASH)

    def test_partial_completion_does_not_extend_original_ttl(self):
        self.figure()
        self.now[0] = 4.0
        self.unavailable("0" * 64)
        added = self.register("paper/new.md")
        self.now[0] = 5.0
        self.assertEqual(self.figure(added)["assetVersion"], IMAGE_HASH)

    def test_expired_snapshot_is_built_once_for_concurrent_hits_and_misses(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                self.lookup.clear()
                self.figure()
                self.now[0] += 5.0
                gate = threading.Barrier(8)

                def call(index):
                    gate.wait()
                    if missing:
                        self.unavailable(f"{index:064x}")
                        return "missing"
                    return self.figure()["assetVersion"]

                with patch.object(paper_library.os, "walk", wraps=os.walk) as walk:
                    with ThreadPoolExecutor(max_workers=8) as pool:
                        results = list(pool.map(call, range(8)))
                    self.assertEqual(walk.call_count, 1)
                    self.assertEqual(len(results), 8)

    def test_capacity_evicts_scope_and_does_not_build_unbounded_negative_keys(self):
        calls = []

        def scan():
            calls.append(True)
            yield "known", "paper/a.md"

        for scope in range(5):
            self.assertEqual(self.lookup.resolve(scope, "known", scan), "paper/a.md")
        self.assertEqual(len(calls), 5)
        self.assertEqual(self.lookup.resolve(4, "known", scan), "paper/a.md")
        self.assertEqual(len(calls), 5)
        self.assertEqual(self.lookup.resolve(0, "known", scan), "paper/a.md")
        self.assertEqual(len(calls), 6)
        for number in range(100):
            with self.assertRaisesRegex(ValueError, "paper-source-unavailable"):
                self.lookup.resolve(0, f"missing-{number}", scan)
        self.assertEqual(len(calls), 7)

    def test_entry_capacity_preserves_early_mapping_and_bounds_generator(self):
        self.lookup = RegisteredPaperSources(max_entries=2, clock=lambda: self.now[0])
        yielded = []

        def scan():
            for index in range(10):
                yielded.append(index)
                yield str(index), f"{index}.md"

        self.assertEqual(self.lookup.resolve("scope", "0", scan), "0.md")
        with self.assertRaisesRegex(ValueError, "paper-source-unavailable"):
            self.lookup.resolve("scope", "9", scan)
        self.assertEqual(self.lookup.resolve("scope", "0", scan), "0.md")
        self.assertEqual(yielded, [0, 0, 1])

    def test_early_target_survives_original_name_budget_and_later_missing_key(self):
        late = self.register("paper/z.md")
        names = ["a.md.figures.json"] + [f"n{index:05}.txt" for index in range(14999)] + ["z.md.figures.json"]

        def scan(*_args, **_kwargs):
            yield str(self.root / "paper"), [], names

        with patch.object(paper_library.os, "walk", side_effect=scan) as walk:
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.unavailable(late["sourceKey"])
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.unavailable("0" * 64)
            self.assertEqual(walk.call_count, 2)

    def test_exact_last_name_within_budget_remains_available(self):
        names = [f"0{index:05}.txt" for index in range(14999)] + ["a.md.figures.json"]
        with patch.object(paper_library.os, "walk", return_value=iter([(str(self.root / "paper"), [], names)])):
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)

    def test_later_directory_error_keeps_safe_prefix_and_missing_failure_is_cooled(self):
        def scan(*_args, **_kwargs):
            yield str(self.root / "paper"), [], ["a.md.figures.json"]
            raise OSError("synthetic later directory error")

        with patch.object(paper_library.os, "walk", side_effect=scan) as walk:
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.unavailable("0" * 64)
            self.unavailable("1" * 64)
            self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
            self.assertEqual(walk.call_count, 2)

    def test_directory_budget_stops_many_empty_yields_and_cools_missing_keys(self):
        yielded, closed = [], []

        def scan(*_args, **_kwargs):
            try:
                for number in range(15001):
                    yielded.append(number)
                    yield str(self.root), [], []
                yielded.append("source")
                yield str(self.root / "paper"), [], ["a.md.figures.json"]
            finally:
                closed.append(True)

        with patch.object(paper_library.os, "walk", side_effect=scan) as walk:
            self.unavailable(self.payload["sourceKey"])
            self.unavailable("0" * 64)
            self.assertEqual(walk.call_count, 1)
        self.assertEqual(len(yielded), 15000)
        self.assertEqual(closed, [True])

    def test_directory_budget_bounds_child_checks_but_keeps_early_root_source(self):
        payload = self.register("root-paper.md")
        dirs = [f"directory-{number:05}" for number in range(15001)]
        checked, closed = [], []
        original_safe = paper_library._safe

        def safe(vault, path):
            if Path(path).name.startswith("directory-"):
                checked.append(path)
                return path
            return original_safe(vault, path)

        def scan(*_args, **_kwargs):
            try:
                yield str(self.root), dirs, ["root-paper.md.figures.json"]
            finally:
                closed.append(True)

        with patch.object(paper_library.os, "walk", side_effect=scan), \
                patch.object(paper_library, "_safe", side_effect=safe):
            self.assertEqual(self.figure(payload)["assetVersion"], IMAGE_HASH)
        self.assertEqual(len(checked), 14999)  # One unit was used by the root yield.
        self.assertEqual(dirs, [])
        self.assertEqual(closed, [True])

    def test_directory_budget_exact_yield_boundary_and_retained_iterator_close(self):
        for position, available in ((15000, True), (15001, False)):
            with self.subTest(position=position):
                self.lookup.clear()
                yielded, closed = [], []

                def scan():
                    try:
                        for number in range(position - 1):
                            yielded.append(number)
                            yield str(self.root), [], []
                        yielded.append("source")
                        yield str(self.root / "paper"), [], ["a.md.figures.json"]
                    finally:
                        closed.append(True)

                iterator = scan()  # Keep a reference: closure cannot depend on GC.
                with patch.object(paper_library.os, "walk", return_value=iterator):
                    if available:
                        self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
                    else:
                        self.unavailable(self.payload["sourceKey"])
                self.assertEqual(len(yielded), 15000)
                self.assertEqual(closed, [True])

    def test_directory_budget_combines_child_candidates_with_yielded_directories(self):
        original_safe = paper_library._safe
        for child_count, available in ((14998, True), (14999, False)):
            with self.subTest(child_count=child_count):
                self.lookup.clear()
                dirs = [f"directory-{number:05}" for number in range(child_count - 1)] + ["paper"]
                yielded = []

                def safe(vault, path):
                    return path if Path(path).name.startswith("directory-") else original_safe(vault, path)

                def scan(*_args, **_kwargs):
                    yielded.append("root")
                    yield str(self.root), dirs, []
                    if "paper" in dirs:
                        yielded.append("source")
                        yield str(self.root / "paper"), [], ["a.md.figures.json"]

                with patch.object(paper_library.os, "walk", side_effect=scan), \
                        patch.object(paper_library, "_safe", side_effect=safe):
                    if available:
                        self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)
                    else:
                        self.unavailable(self.payload["sourceKey"])
                self.assertEqual(len(yielded), 2 if available else 1)

    def test_directory_budget_counts_even_excluded_child_candidates(self):
        yielded = []

        def scan(*_args, **_kwargs):
            yielded.append("root")
            yield str(self.root), [f".hidden-{number}" for number in range(15001)], []
            yielded.append("source")
            yield str(self.root / "paper"), [], ["a.md.figures.json"]

        with patch.object(paper_library.os, "walk", side_effect=scan):
            self.unavailable(self.payload["sourceKey"])
        self.assertEqual(yielded, ["root"])

    def test_scope_isolates_root_owner_local_library_and_account_library(self):
        other = self.base / "other"
        other.mkdir()
        other_payload = self.register("paper/a.md", other)
        with patch.object(paper_library.os, "walk", wraps=os.walk) as walk:
            self.figure()
            self.figure(owner="other-owner")
            self.figure({**self.payload, "localLibraryId": "other"}, local="other")
            self.figure({**self.payload, "accountLibraryId": "account"}, account="account")
            self.figure(other_payload, root=other)
            self.assertEqual(walk.call_count, 5)

    def test_failed_scan_is_shared_by_distinct_missing_keys_until_expiry(self):
        for error_type in (OSError, ValueError, UnicodeError):
            with self.subTest(error_type=error_type.__name__):
                self.lookup.clear()
                calls = []

                def scan():
                    calls.append(True)
                    yield "known", "paper/a.md"
                    raise error_type("synthetic invalid later entry")

                for key in ("missing-one", "missing-two"):
                    with self.assertRaisesRegex(ValueError, "paper-source-unavailable"):
                        self.lookup.resolve("scope", key, scan)
                self.assertEqual(self.lookup.resolve("scope", "known", scan), "paper/a.md")
                self.assertEqual(len(calls), 1)
                self.now[0] += 5.0
                with self.assertRaisesRegex(ValueError, "paper-source-unavailable"):
                    self.lookup.resolve("scope", "missing-three", scan)
                self.assertEqual(len(calls), 2)

    def test_root_replacement_at_same_path_does_not_reuse_snapshot(self):
        self.unavailable("0" * 64)
        moved = self.base / "old-vault"
        self.assertTrue(self.root.resolve().is_relative_to(self.base))
        self.assertTrue(moved.resolve().is_relative_to(self.base))
        self.root.rename(moved)
        self.root.mkdir()
        added = self.register("paper/new.md")
        self.assertEqual(self.figure(added)["assetVersion"], IMAGE_HASH)

    def test_source_registry_and_asset_are_read_on_every_cached_request(self):
        self.figure()
        source = self.root / "paper/a.md"
        registry = self.root / "paper/a.md.figures.json"
        asset = self.root / "paper/a.png"
        for path in (source, registry, asset):
            with self.subTest(path=path.name):
                raw, before = path.read_bytes(), path.stat()
                path.write_bytes(b"changed bytes")
                os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
                with self.assertRaises((ValueError, OSError)):
                    self.figure()
                path.write_bytes(raw)
                self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)

    def test_removed_or_renamed_source_and_registry_never_use_stale_content(self):
        self.figure()
        source = self.root / "paper/a.md"
        registry = self.root / "paper/a.md.figures.json"
        for path in (source, registry):
            with self.subTest(path=path.name):
                renamed = path.with_name(path.name + ".renamed")
                path.rename(renamed)
                with self.assertRaises((ValueError, OSError)):
                    self.figure()
                renamed.rename(path)
                self.assertEqual(self.figure()["assetVersion"], IMAGE_HASH)

    def test_cached_reparse_root_ancestor_source_registry_or_asset_is_rejected(self):
        self.figure()
        original = Path.lstat
        for target in (self.root, self.root / "paper", self.root / "paper/a.md",
                       self.root / "paper/a.md.figures.json", self.root / "paper/a.png"):
            with self.subTest(path=str(target.relative_to(self.root))):
                def lstat(path, *args, **kwargs):
                    if path == target:
                        return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0x400)
                    return original(path, *args, **kwargs)

                with patch.object(Path, "lstat", lstat):
                    with self.assertRaisesRegex(ValueError, "reparse"):
                        self.figure()

    def test_ordinary_source_never_calls_lookup(self):
        direct = {key: value for key, value in self.payload.items() if key not in ("sourceKey", "sourceVersion")}
        direct["source"] = {"kind": "vault", "path": "paper/a.md", "version": self.payload["sourceVersion"]}
        with patch.object(self.lookup, "resolve", side_effect=AssertionError("ordinary source reached cache")):
            self.assertEqual(self.figure(direct)["assetVersion"], IMAGE_HASH)

    def test_actual_redirected_directory_is_rejected_after_warm_lookup(self):
        self.figure()
        folder = self.root / "paper"
        moved = self.base / "moved-paper"
        self.assertTrue(folder.resolve().is_relative_to(self.base))
        self.assertTrue(moved.resolve().is_relative_to(self.base))
        folder.rename(moved)
        try:
            try:
                folder.symlink_to(moved, target_is_directory=True)
            except OSError as error:
                if os.name != "nt":
                    self.skipTest(f"OS cannot create synthetic directory link: {error}")
                result = subprocess.run(["cmd", "/c", "mklink", "/J", str(folder), str(moved)],
                                        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                if result.returncode:
                    self.skipTest("OS cannot create synthetic junction")
            with self.assertRaisesRegex(ValueError, "reparse"):
                self.figure()
        finally:
            if folder.is_symlink():
                folder.unlink()
            elif folder.exists():
                folder.rmdir()  # Remove only our junction, never its target tree.
            moved.rename(folder)

    def test_wrong_payload_scope_is_rejected_before_lookup(self):
        with patch.object(self.lookup, "resolve", side_effect=AssertionError("invalid scope reached cache")):
            for change in ({"localLibraryId": "other"}, {"accountLibraryId": "other"}):
                with self.assertRaisesRegex(ValueError, "paper-library-changed"):
                    self.figure({**self.payload, **change})

    def test_frontend_catalog_then_figure_uses_shared_runtime_without_invalidation(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "companion/server.py").read_text(encoding="utf-8"))
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "paper_library_request")
        runtime = SimpleNamespace(service=None, paper_source_lookup=self.lookup)
        namespace = {
            "installation_owner_hash": lambda: "owner", "NOTE_SOURCE_LOCK": threading.RLock(),
            "source_path": lambda _: self.root, "LOCAL_DATABASE_PATH": self.base / "unused.db",
            "local_vault_library_id": lambda _: "local", "get_note_source_runtime": lambda: runtime,
        }
        exec(compile(ast.Module(body=[node], type_ignores=[]), "synthetic-paper-factory", "exec"), namespace)
        services = SimpleNamespace(paper_library_request=namespace["paper_library_request"],
                                   allowed_origin=lambda _: True)
        responses = []
        handler = SimpleNamespace(path="/v1/papers?query=paper", headers={"Origin": "https://synthetic.test"},
                                  send_json=lambda status, body: responses.append((status, body)))
        with patch.object(academic_vocabulary, "account_library_for_root", return_value=None), \
                patch.object(paper_library.os, "walk", wraps=os.walk) as walk:
            for _ in range(4):
                routes_sources.get_papers(handler, services, "/v1/papers", "owner")
                routes_sources.post_papers_read(handler, services, "/v1/papers/figure", "owner", self.payload)
            self.assertEqual([status for status, _ in responses], [200] * 8)
            self.assertEqual(walk.call_count, 5)  # Four catalog scans and one sourceKey lookup.


if __name__ == "__main__":
    unittest.main()
