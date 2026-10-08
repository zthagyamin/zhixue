"""Learning AI intent and library binding without provider credentials or HTTP objects."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Iterator
from application.failures import CompanionFailure


@dataclass(frozen=True)
class LocalChat:
    events: Iterator[dict]


@dataclass(frozen=True)
class AiPorts:
    library_id: Callable[[], str]
    settings: Callable[[str, str], dict]
    configure: Callable[[str, str, Any], dict]
    models: Callable[[str, str, Any], list]
    prepare_chat: Callable[[str, str, Any], LocalChat]
    failure_code: Callable[[Exception], str]
    hint: Callable[[dict, str], str]
    correct: Callable[[dict, str], dict]
    generate: Callable[..., dict]
    set_cached: Callable[[dict], None]
    cached: Callable[[], dict]
    decorate: Callable[[dict], dict]
    save_legacy_settings: Callable[[str, Any], None]


class AiApplication:
    def __init__(self, ports: AiPorts):
        self.ports = ports

    def hint(self, payload: Any) -> dict:
        return {'hint': self.ports.hint(payload.get('question', {}), str(payload.get('wrongAnswer', '')))}

    def correct(self, payload: Any) -> dict:
        card = payload.get('card', {})
        instruction = str(payload.get('instruction', ''))
        if not instruction:
            raise ValueError('修改要求不能为空')
        return {'card': self.ports.correct(card, instruction)}

    def generate(self, payload: Any) -> dict:
        content = str(payload.get('content', ''))
        title = str(payload.get('title', '临时导入材料'))
        result = self.ports.generate(content, '', title, '用户临时导入')
        self.ports.set_cached(result)
        return self.ports.decorate(result)

    def configured(self, owner: str, action: str, payload: Any) -> dict | LocalChat:
        library = self.ports.library_id()
        if payload.get('libraryId') != library:
            raise CompanionFailure(409, {'error': 'ai-library-changed'})
        if action == 'models':
            try:
                return {'models': self.ports.models(owner, library, payload.get('selection'))}
            except Exception as error:
                raise CompanionFailure(502, {'error': self.ports.failure_code(error)}) from error
        if action == 'settings':
            return {'settings': self.ports.settings(owner, library), 'serverAvailable': True}
        if action == 'configure':
            return self.ports.configure(owner, library, payload.get('settings'))
        return self.ports.prepare_chat(owner, library, payload.get('request', {}))

    def save_legacy(self, owner: str, payload: Any) -> dict:
        self.ports.save_legacy_settings(owner, payload)
        self.ports.set_cached({**self.ports.cached(), 'status': 'offline', 'message': 'DeepSeek 密钥已保存到本机凭据库，等待刷新资料。'})
        return {'saved': True, 'provider': 'deepseek', 'storage': 'system-credential-store'}
