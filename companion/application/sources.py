"""Source decisions and recovery operations without HTTP, SQL or filesystem access."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable
from application.failures import CompanionFailure, SourceStorageFailure


@dataclass(frozen=True)
class SourcePorts:
    vault_available: Callable[[], bool]
    gateway_exists: Callable[[], bool]
    indexed: Callable[[str], dict | None]
    projection: Callable[[], dict]
    scan: Callable[[], dict]
    pending: Callable[[], list]
    audit: Callable[[], dict]
    papers: Callable[..., dict]
    vocabulary: Callable[..., dict]
    read_notes: Callable[[str], tuple]
    write_notes: Callable[[str, Any], tuple]
    workspace_status: Callable[[], dict]
    configure_workspace: Callable[[Any], dict]
    mapping: Callable[..., dict]
    valid_decision: Callable[[str], bool]
    decide: Callable[[str, str, str], Any]
    archive: Callable[[int, int], list]
    now: Callable[[], Any]
    summary: Callable[[int, int], str]
    initialize: Callable[[], dict]
    route_capture: Callable[[dict], dict]
    capture_evidence: Callable[[dict], dict]


class SourceApplication:
    def __init__(self, ports: SourcePorts):
        self.ports = ports

    def papers(self, owner: str, action: str, payload=None, read_query=None) -> dict:
        try:
            if action == 'catalog':
                return self.ports.papers(owner, action, query=read_query().get('query', [''])[0])
            return self.ports.papers(owner, action, payload)
        except (ValueError, OSError, SourceStorageFailure) as error:
            body = {'message': str(error)}
            if action != 'catalog':
                body['noWrite'] = getattr(error, 'no_write', False)
            raise CompanionFailure(409, body) from error

    def vocabulary(self, owner: str, payload=None, read_query=None) -> dict:
        if read_query is not None:
            try:
                return self.ports.vocabulary(owner, source=read_query().get('sourceNote', [''])[0])
            except (ValueError, OSError) as error:
                raise CompanionFailure(409, {'message': str(error)}) from error
        try:
            return self.ports.vocabulary(owner, payload=payload)
        except (ValueError, OSError, SourceStorageFailure) as error:
            raise CompanionFailure(409, {'message': str(error)}) from error

    def read_notes(self, owner: str):
        return self.ports.read_notes(owner)

    def write_notes(self, owner: str, payload: Any):
        return self.ports.write_notes(owner, payload)

    def workspace_status(self) -> dict:
        try:
            return self.ports.workspace_status()
        except (ValueError, OSError) as error:
            raise CompanionFailure(400, {'message': '学习空间设置无法读取，请重新运行安装程序。'}) from error

    def configure_workspace(self, payload: Any) -> dict:
        return self.ports.configure_workspace(payload)

    def mapping(self, owner: str, payload=None, *, write=False) -> dict:
        try:
            return self.ports.mapping(owner, payload) if write else self.ports.mapping(owner)
        except (ValueError, OSError) as error:
            status = 409 if write and str(error) == 'stale-mapping' else 400
            raise CompanionFailure(status, {'message': str(error)}) from error

    def changes(self, owner: str) -> dict:
        indexed = self.ports.indexed(owner)
        if indexed is not None:
            return {'changes': [], 'scanInitialized': True, 'mode': 'indexed', 'diagnostics': indexed['gateway']['diagnostics']}
        if not self.ports.vault_available():
            return {'changes': [], 'scanInitialized': False}
        projection = self.ports.projection()
        if projection.get('scannedAt') is None:
            self.ports.scan()
            projection = self.ports.projection()
        return {**projection, 'scanInitialized': projection.get('scannedAt') is not None}

    def capture_list(self) -> dict:
        return {'pendingCaptures': self.ports.pending()}

    def audit(self) -> dict:
        if not self.ports.vault_available():
            return {'sourcesFiles': 0, 'derivedFiles': 0, 'eventFiles': 0, 'eventBytes': 0, 'archivedEventFiles': 0, 'overgrown': False}
        return self.ports.audit()

    def scan(self) -> dict:
        status = self.ports.scan()
        projection = self.ports.projection() if self.ports.vault_available() and status.get('mode') != 'indexed' else {'changes': []}
        return {**projection, **status}

    def decide(self, owner: str, payload: Any) -> dict:
        if self.ports.gateway_exists():
            raise ValueError('固定索引模式不使用旧资料发现审批；请在学科索引中启用或停用内容。')
        change_id = str(payload.get('changeId', '')).strip() if isinstance(payload, dict) else ''
        decision = str(payload.get('decision', '')).strip() if isinstance(payload, dict) else ''
        operator = str(payload.get('operator', '')).strip() if isinstance(payload, dict) else ''
        if not change_id or not self.ports.valid_decision(decision):
            raise ValueError('无效的变更决策。')
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        log = self.ports.decide(change_id, decision, operator or owner)
        return {'changeId': change_id, 'decision': decision, 'log': log}

    def archive(self, payload: Any) -> dict:
        year = int(payload.get('beforeYear', 0) or 0)
        month = int(payload.get('beforeMonth', 0) or 0)
        if year <= 0 or month <= 0:
            raise ValueError('无效的归档月份。')
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        archived = self.ports.archive(year, month)
        today = self.ports.now()
        return {'archived': len(archived), 'summary': self.ports.summary(today.year, today.month)}

    def initialize(self) -> dict:
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        return self.ports.initialize()

    def capture(self, payload: Any) -> dict:
        capture = payload if isinstance(payload, dict) else None
        if not isinstance(capture, dict) or not capture.get('captureId'):
            raise ValueError('无效的捕获记录（缺少 captureId）。')
        routed = self.ports.route_capture(capture)
        return {'captureId': capture['captureId'], 'evidence': self.ports.capture_evidence(capture), 'status': routed['status'], 'revision': routed.get('revision')}
