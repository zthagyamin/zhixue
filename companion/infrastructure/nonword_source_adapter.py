"""Compose source admission using authenticated scope and existing source readers."""
from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import date, datetime
from pathlib import Path

import change_detect
import assessment_material
import learning_result
import practice_engine
import source_area
from account_sync_export import source_fingerprint
import index_gateway
from study_day import study_day
from vault_identity import local_vault_library_id
from infrastructure.nonword_source_resolver import RegisteredExerciseResolver
from infrastructure.nonword_source_store import SourceAdmissionStore
from application.source_choice import grade_source_choice
from quiz_support import parse_quiz_support
from infrastructure.code_review_adapter import create_code_review
from infrastructure.nonword_code_reports import review_current
from infrastructure.source_recall_review_adapter import create_source_recall_review
from infrastructure.source_code_hint_adapter import create_source_code_hint


def _approved_entries(services, root, database=None):
    """Read saved approvals without schema creation/backfill or a cached display pool."""
    path = Path(services.LOCAL_DATABASE_PATH)
    documents = []
    def read_documents(db):
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_change_state'").fetchone()
        return db.execute('SELECT path,content_hash,approved_content FROM source_change_state').fetchall() if exists else []
    if database is not None:
        # Reuse the receiver's already authorized transaction. Opening a second
        # read-only WAL connection can create SHM sidecars on a rejected event.
        documents = read_documents(database)
    elif path.is_file():
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            documents = read_documents(db)
    entries = []
    for ref, expected, content in documents:
        if content is None or change_detect.content_hash(content) != expected:
            continue
        relative = change_detect._stored_source_path(ref, change_detect.source_root(root))
        source = change_detect.source_root(root) / relative
        # A pending original edit cannot silently become the authority for the
        # saved approval. Machine-owned projections do not change that source.
        if source.suffix.lower() != '.md':
            continue
        checked = index_gateway._path(root, source.relative_to(root).as_posix())
        if source_fingerprint(checked.read_bytes()) != source_fingerprint(content.encode('utf-8')):
            continue
        # Routing comes from an approved parsed item, not caller-supplied paths.
        for item in source_area.parse_source_text(content, source):
            context = {key: item[key] for key in ('sourceNote', 'stateRef', 'abilityId') if item.get(key)}
            route = {'mode': 'legacy', 'binding': None, 'context': context,
                     'reviewCardPath': None, 'reviewEntryName': ''}
            entries.append((item, route, [source.relative_to(root).as_posix()]))
    # Eligibility to grade an already captured source does not disappear when
    # this very event changes its next review date. Read all dated source tasks.
    legacy = services.due_review_items(date.max)
    cards = learning_result.parse_result_cards(root)
    all_items = practice_engine.practice_items(root, legacy_items=legacy)
    known = {item['itemId'] for item in all_items}
    for card in cards:
        if card['itemId'] in known:
            continue
        parsed = assessment_material.parse_assessment(root, str(card.get('stateRef', '')))
        materials = assessment_material.material_for_review_point(parsed, str((card.get('reviewPoints') or [''])[0]), 0)
        item = practice_engine.build_base_item(card, materials)
        for field in ('sourceNote', 'stateRef'):
            ref = str(item.get(field) or '')
            item[field] = ref if not ref or ref.lower().endswith('.md') else ref + '.md'
        all_items.append(item)
    for item in all_items:
        card = next((card for card in cards if card['itemId'] == item['itemId']), None)
        context = {key: item[key] for key in ('sourceNote', 'stateRef', 'abilityId') if item.get(key)}
        route = {'mode': 'legacy', 'binding': None, 'context': context,
                 'reviewCardPath': card['path'] if card else None,
                 'reviewEntryName': str(item.get('reviewPoint') or '')}
        refs = [item.get('sourceNote'), item.get('stateRef')]
        if card:
            refs.append(card['path'])
        entries.append((item, route, refs))
    return entries


def create_source_resolver(services, owner, root=None):
    root = Path(root if root is not None else services.source_path('learning_vault_root'))
    return RegisteredExerciseResolver(root, owner, services.effective_gateway,
                                      lambda: _approved_entries(services, root))


def create_source_admission(services, owner, root=None):
    root = Path(root if root is not None else services.source_path('learning_vault_root'))
    library = local_vault_library_id(root)
    if not library:
        raise ValueError('source-unverified')
    def grade(item, answer):
        if item.get('questionType') == 'quiz':
            return grade_source_choice(item, answer, parse_support=parse_quiz_support)
        return practice_engine.grade_answer(item, answer, ai_available=bool(services.deepseek_key()),
                                            recall_grader=services.grade_recall_deepseek)
    store = SourceAdmissionStore(Path(services.LOCAL_DATABASE_PATH).with_name('nonword-source.db'),
                                owner, library, root, create_source_resolver(services, owner, root),
                                grade,
                                lambda: datetime.now(services.LOCAL_TZ),
                                code_review=lambda attempt, request_id: review.evaluate(attempt,request_id),
                                recall_review=lambda attempt, request_id: recall.evaluate(attempt,request_id))
    def current(attempt, request_id):
        return (Path(services.source_path('learning_vault_root')).resolve()==root.resolve()
                and local_vault_library_id(root)==library and review_current(store,attempt,request_id))
    review = create_code_review(services,owner,library,root,current)
    recall = create_source_recall_review(services,owner,library,root,current)
    return store


def create_code_hint_admission(services, owner, store):
    return create_source_code_hint(services, owner, store.library, store.root_reference, store)
