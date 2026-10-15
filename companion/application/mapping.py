"""Preview-bound mapping use case; metadata and source access use explicit ports."""
from dataclasses import dataclass
from typing import Callable
import re


@dataclass(frozen=True)
class MappingPorts:
    context: Callable[[str], str]
    inspect: Callable[[str], dict]
    validate: Callable[[list], list]
    preview: Callable[[str, str, list], dict]
    confirm: Callable[[str, str, str, list, int], dict]


class MappingApplication:
    def __init__(self, ports: MappingPorts):
        self.ports = ports

    def request(self, owner, payload=None):
        context = self.ports.context(owner)
        capability = {'schemaVersion': 2, 'contextId': context}
        if payload is None:
            return {**self.ports.inspect(owner), **capability}
        if not isinstance(payload, dict) or set(payload) - {'action', 'rules', 'revision', 'schemaVersion', 'contextId', 'previewId'}:
            raise ValueError('invalid-mapping-request')
        action = payload.get('action')
        if action not in ('preview', 'confirm'):
            raise ValueError('invalid-mapping-action')
        # Old clients may inspect, but cannot silently use an unbound write contract.
        if type(payload.get('schemaVersion')) is not int or payload['schemaVersion'] != 2 or not isinstance(payload.get('contextId'), str):
            raise ValueError('mapping-preview-required')
        if payload['contextId'] != context:
            raise ValueError('mapping-context-changed')
        rules = self.ports.validate(payload.get('rules'))
        if action == 'preview':
            return {**self.ports.preview(owner, context, rules), **capability}
        identity = payload.get('previewId')
        if not isinstance(identity, str) or not re.fullmatch('[0-9a-f]{32}', identity):
            raise ValueError('mapping-preview-required')
        revision = payload.get('revision')
        if type(revision) is not int or revision < 0:
            raise ValueError('invalid-mapping-revision')
        return {**self.ports.confirm(owner, context, identity, rules, revision), **capability}
