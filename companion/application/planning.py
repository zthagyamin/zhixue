"""Plan reads and explicit mutations through storage/provider ports."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, ContextManager
import re
from application.failures import CompanionFailure


@dataclass(frozen=True)
class PlanningPorts:
    vault_available: Callable[[], bool]
    gateway: Callable[[], dict]
    catalog: Callable[[dict], dict]
    verify_catalog: Callable[[dict, dict], None]
    revision: Callable[[], int]
    task_page: Callable[..., dict]
    evidence_page: Callable[..., dict]
    context: Callable[[dict, str], dict]
    current_plan: Callable[[], dict]
    default_constraints: Callable[[], dict]
    constraints: Callable[..., dict]
    append_task: Callable[..., dict]
    parse_suggestion: Callable[[Any], dict]
    suggest: Callable[[dict, dict], dict]
    reorder: Callable[[list], list]
    validate_plan: Callable[[dict], dict]
    plan_lock: Callable[[], ContextManager]
    evidence_lock: Callable[[], ContextManager]
    constraint_lock: Callable[[], ContextManager]
    apply: Callable[..., int]
    reject: Callable[..., dict]
    restore: Callable[..., int]
    write_constraints: Callable[[dict, datetime], None]
    now: Callable[[], datetime]


def fail(status: int, message: str):
    raise CompanionFailure(status, {'message': message})


class PlanningApplication:
    def __init__(self, ports: PlanningPorts):
        self.ports = ports

    def task_events(self, owner: str, read_query: Callable[[], dict]) -> dict:
        try:
            catalog = self.ports.gateway()
            if not catalog['active']:
                fail(409, '任务记录需要启用学习知识库固定索引。')
            values = read_query().get('after', [])
            if len(values) > 1:
                raise ValueError('invalid-task-cursor')
            return self.ports.task_page(catalog, owner, values[0] if values else None)
        except (ValueError, OSError) as error:
            code = str(error)
            status = 409 if code == 'task-history-changed' else 400 if code == 'invalid-task-cursor' else 503
            fail(status, code if status != 503 else '任务记录读取不完整，请检查学习知识库后重试。')

    def evidence(self, owner: str, read_query: Callable[[], dict]) -> dict:
        try:
            query = read_query()
            if any(len(value) != 1 for value in query.values()) or not re.fullmatch(r'[a-f0-9]{64}', query.get('sourceHash', [''])[0]) or not query.get('planRevision', [''])[0].isdigit():
                raise ValueError('invalid-planning-request')
            with self.ports.evidence_lock():
                gateway = self.ports.gateway()
                if not gateway['active']:
                    raise ValueError('planning-history-changed')
                catalog = self.ports.catalog(gateway)
                self.ports.verify_catalog(gateway, catalog)
                revision = self.ports.revision()
                if catalog['sourceHash'] != query['sourceHash'][0] or revision != int(query['planRevision'][0]):
                    raise ValueError('planning-history-changed')
                return self.ports.evidence_page(gateway, owner, catalog['sourceHash'], revision, query.get('after', [None])[0])
        except (ValueError, OSError) as error:
            code = str(error)
            status = 409 if code in ('planning-history-changed', 'stale-plan-revision') else 400 if code in ('invalid-planning-request', 'invalid-planning-cursor') else 503
            fail(status, code if status != 503 else '学习证据读取不完整，请检查学科记录后重试。')

    def context(self, owner: str) -> dict:
        try:
            catalog = self.ports.gateway()
            if not catalog['active']:
                fail(409, '任务型计划需要先启用学习知识库固定索引。')
            return self.ports.context(catalog, owner)
        except (OSError, ValueError):
            fail(503, '学科目标目录暂时无法读取，请检查固定索引。')

    def current(self) -> dict:
        if not self.ports.vault_available():
            return {'revision': 0, 'candidate': None, 'history': []}
        try:
            return self.ports.current_plan()
        except ValueError:
            fail(409, '权威计划与修订记录不一致，已停止覆盖，请核对学习知识库的计划与历史记录。')

    def constraints(self, owner: str) -> dict:
        return self.ports.constraints(owner) if self.ports.vault_available() else self.ports.default_constraints()

    def append_task(self, owner: str, payload: Any) -> dict:
        catalog = self.ports.gateway()
        if not catalog['active']:
            fail(409, '任务记录需要启用学习知识库固定索引。')
        try:
            result = self.ports.append_task(catalog, owner, payload.get('event') if isinstance(payload, dict) else None)
            return {**result, 'durable': True}
        except ValueError as error:
            fail(409 if str(error) == 'task-event-conflict' else 400, str(error))
        except OSError:
            fail(503, '任务记录暂时无法写入学习知识库，请保留本地记录后重试。')

    def suggest(self, owner: str, payload: Any) -> dict:
        request = self.ports.parse_suggestion(payload)
        gateway = self.ports.gateway()
        if not gateway['active']:
            fail(409, '任务型计划需要先启用学习知识库固定索引。')
        catalog = self.ports.context(gateway, owner)['catalog']
        if request['sourceHash'] != catalog['sourceHash']:
            fail(409, '学习来源已变更，请刷新目录后再生成建议。')
        return self.ports.suggest(catalog, request)

    def reorder(self, payload: Any) -> dict:
        items = payload.get('items')
        if not isinstance(items, list) or not items:
            fail(400, '缺少计划条目。')
        try:
            return {'items': self.ports.reorder(items)}
        except RuntimeError as error:
            fail(503, str(error))
        except Exception:
            fail(502, 'AI 编排暂时不可用，请稍后再试或使用确定性调度。')

    def apply(self, owner: str, payload: Any) -> dict:
        candidate = payload.get('candidate') if isinstance(payload, dict) else None
        operator = str(payload.get('operator', '')).strip() if isinstance(payload, dict) else ''
        if not isinstance(candidate, dict) or not candidate.get('planHash'):
            raise ValueError('无效的计划候选。')
        expected = payload.get('expectedRevision') if isinstance(payload, dict) else None
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ValueError('expectedRevision 必须是非负整数。')
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        with self.ports.plan_lock():
            if 'schemaVersion' in candidate:
                candidate = self.ports.validate_plan(candidate)
                gateway = self.ports.gateway()
                if not gateway['active']:
                    fail(409, '任务型计划需要先启用学习知识库固定索引。')
                if candidate['sourceHash'] != self.ports.catalog(gateway)['sourceHash']:
                    fail(409, '学习来源已变更，请刷新并核对草稿后再保存。')
            revision = self.ports.apply(candidate, operator or owner, expected)
        return {'revision': revision}

    def reject(self, owner: str, payload: Any) -> dict:
        candidate = str(payload.get('candidateHash', '')).strip() if isinstance(payload, dict) else ''
        reason = str(payload.get('reason', '')).strip() if isinstance(payload, dict) else ''
        operator = str(payload.get('operator', '')).strip() if isinstance(payload, dict) else ''
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        return {'decision': self.ports.reject(candidate, operator or owner, reason)}

    def restore(self, owner: str, payload: Any) -> dict:
        target = payload.get('target') if isinstance(payload, dict) else None
        expected = payload.get('expectedRevision') if isinstance(payload, dict) else None
        operator = str(payload.get('operator', '')).strip() if isinstance(payload, dict) else ''
        if not isinstance(target, int) or isinstance(target, bool) or target < 1:
            raise ValueError('target 必须是正整数。')
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ValueError('expectedRevision 必须是非负整数。')
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        return {'revision': self.ports.restore(target, operator or owner, expected)}

    def write_constraints(self, owner: str, payload: Any) -> dict:
        document = payload.get('constraints') if isinstance(payload, dict) else None
        if not isinstance(document, dict):
            raise ValueError('无效的学习约束。')
        if not self.ports.vault_available():
            raise ValueError('尚未配置 Obsidian 学习库（learning_vault_root）。')
        now = self.ports.now()
        with self.ports.constraint_lock():
            self.ports.write_constraints(document, now)
            return self.ports.constraints(owner, now)
