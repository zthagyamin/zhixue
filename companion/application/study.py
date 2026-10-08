"""Authenticated study operations independent of HTTP and local storage mechanisms."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


class StudyEventConflict(ValueError):
    def __init__(self, event_id: str):
        super().__init__('event-conflict')
        self.event_id = event_id


@dataclass(frozen=True)
class StudyPorts:
    indexed: Callable[[str, bool], dict | None]
    cached: Callable[[], dict]
    attach_handles: Callable[[dict, str], dict]
    library_id: Callable[[], str]
    vault_available: Callable[[], bool]
    approved_documents: Callable[[], list]
    merge_sources: Callable[[dict, list], dict]
    normalize: Callable[[dict], dict]
    practice: Callable[[], list]
    decorate: Callable[[dict], dict]
    legacy_dashboard: Callable[[], dict]
    refresh_legacy: Callable[[], None]
    set_cached: Callable[[dict], None]
    schema_version: Callable[[], int]
    accept_native: Callable[[str, Any], dict]
    accept_legacy: Callable[[Any], dict]
    store_activity: Callable[[str, Any], None]
    assistance: Callable[[str, Any], dict]
    diagnostics: Callable[[str], dict]
    grade: Callable[[dict, Any], dict]
    variant: Callable[[dict, int], dict]


class StudyApplication:
    def __init__(self, ports: StudyPorts):
        self.ports = ports

    def read(self, owner: str) -> dict:
        ports = self.ports
        indexed = ports.indexed(owner, False)
        if indexed is not None:
            return {**ports.attach_handles(indexed, owner), 'localLibraryId': ports.library_id()}
        enriched = ports.attach_handles(ports.cached(), owner)
        enriched['localLibraryId'] = ports.library_id()
        if ports.vault_available():
            documents = ports.approved_documents()
            was_demo = enriched.get('contentMode') == 'demo' or (
                not enriched.get('contentMode') and not enriched.get('syncedAt')
                and 'AlexNet' in str(enriched.get('source', {}).get('title', ''))
            )
            base = {**enriched, 'subjects': []} if was_demo else enriched
            personal = ports.normalize(ports.merge_sources(base, documents))
            personal['practiceItems'] = ports.practice()
            if not was_demo or personal.get('subjects') or personal['practiceItems']:
                enriched = {**personal, 'contentMode': 'personal'}
                if was_demo:
                    enriched['source'] = {'title': '学习库已批准资料与到期复习', 'scope': '本机授权学习库'}
        return ports.decorate(enriched)

    def dashboard(self, owner: str) -> dict:
        indexed = self.ports.indexed(owner, False)
        return indexed['dashboard'] if indexed else self.ports.legacy_dashboard()

    def practice(self, owner: str) -> dict:
        indexed = self.ports.indexed(owner, False)
        if indexed is not None:
            return {'items': indexed['practiceItems'], 'gateway': indexed['gateway']}
        return {'items': self.ports.practice() if self.ports.vault_available() else []}

    def diagnostics(self, owner: str) -> dict:
        return self.ports.diagnostics(owner)

    def assistance(self, owner: str, payload: Any) -> dict:
        return self.ports.assistance(owner, payload)

    def activity(self, owner: str, payload: Any) -> dict:
        event = payload.get('event') if isinstance(payload, dict) else None
        if isinstance(event, dict) and event.get('schemaVersion') == self.ports.schema_version():
            try:
                return self.ports.accept_native(owner, payload)
            except ValueError as error:
                if str(error) == 'event-conflict':
                    raise StudyEventConflict(str(event.get('eventId', ''))) from error
                raise
        result = self.ports.accept_legacy(payload)
        self.ports.store_activity(owner, result.get('event', payload))
        return result

    def refresh(self, owner: str) -> dict:
        ports = self.ports
        indexed = ports.indexed(owner, True)
        if indexed is not None:
            ports.set_cached(indexed)
            return ports.attach_handles(indexed, owner)
        ports.refresh_legacy()
        refreshed = ports.cached()
        if ports.vault_available():
            refreshed = ports.normalize(ports.merge_sources(refreshed, ports.approved_documents()))
        return ports.decorate(refreshed)

    def grade(self, payload: Any) -> dict:
        item = payload.get('item') if isinstance(payload, dict) else None
        answer = payload.get('answer') if isinstance(payload, dict) else None
        if not isinstance(item, dict) or not item.get('questionType'):
            raise ValueError('无效的练习条目。')
        return self.ports.grade(item, answer)

    def variant(self, payload: Any) -> dict:
        item = payload.get('item') if isinstance(payload, dict) else None
        attempt = int(payload.get('attempt', 1)) if isinstance(payload, dict) else 1
        if not isinstance(item, dict) or not item.get('questionType'):
            raise ValueError('无效的练习条目。')
        return {'item': self.ports.variant(item, attempt)}
