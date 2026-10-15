"""Credentials, configuration locks and provider transport stay in this adapter."""
from __future__ import annotations
import study_ai_provider
import companion_setup
import json
import os
from pathlib import Path
from application.ai import AiApplication, AiPorts, LocalChat
from application.failures import CompanionFailure
from application.local_chat import execute_chat, replay_chat
from application.source_admission import canonical_json
from infrastructure.local_chat_ledger import LocalChatLedger
from infrastructure.source_protocol_hash import fingerprint
from infrastructure.managed_chat import create_managed_chat_transport

_generation_versions = {}


def create_ai_application(services, authorize=None) -> AiApplication:
    def generation_scope():
        root = Path(services.source_path('learning_vault_root')).resolve()
        return (os.path.normcase(str(root)), services.local_vault_library_id(root),
                services.CONFIG.get('workspace_generation', 0))

    def begin_generation():
        if authorize:
            authorize()
        key = os.path.normcase(str(Path(services.LOCAL_DATABASE_PATH).resolve()))
        with services.DATA_LOCK, companion_setup.CONFIGURATION_LOCK:
            version = _generation_versions.get(key, 0) + 1
            _generation_versions[key] = version
            return key, version, generation_scope()

    def commit_generation(ticket, result):
        if authorize:
            authorize()
        key, version, scope = ticket

        def before_commit():
            if _generation_versions.get(key) != version or generation_scope() != scope:
                raise CompanionFailure(409, {'error': 'ai-generation-stale', 'message': '资料或生成任务已切换。'})

        # The cache setter invokes this fence while holding its existing lock.
        services.set_state(result, before_commit=before_commit, commit_lock=companion_setup.CONFIGURATION_LOCK)

    def settings(owner, library):
        with study_ai_provider.SETTINGS_LOCK:
            with services.local_database() as database:
                return services.ai_store(database).get(owner, library)

    def configure(owner, library, value):
        # The lock outlives commit, preventing another reader from mixing revisions.
        with study_ai_provider.SETTINGS_LOCK:
            with services.local_database() as database:
                return services.ai_store(database).configure(owner, library, value)

    def models(owner, library, value):
        with services.local_database() as database:
            selection = study_ai_provider.resolve_model_selection(services.ai_store(database), owner, library, value)
        return study_ai_provider.fetch_models(selection)

    def chat(owner, library, request):
        root = Path(services.source_path('learning_vault_root')).resolve()
        def guard():
            if authorize:
                authorize()
            current = Path(services.source_path('learning_vault_root')).resolve()
            if (os.path.normcase(str(current)) != os.path.normcase(str(root)) or
                    services.local_vault_library_id(current) != library):
                raise CompanionFailure(409, {'error': 'ai-library-changed'})
        guard()
        if (not isinstance(request, dict) or set(request)-{'requestId','provider','model','settingsRevision','context','messages'} or
                request.get('provider') not in study_ai_provider.DEFAULT_BASES or
                not isinstance(request.get('model'), str) or not 1 <= len(request['model']) <= 160 or
                type(request.get('settingsRevision')) is not int or request['settingsRevision'] < 0):
            raise ValueError('invalid-ai-chat')
        # Validate shape before replay, independent of a subsequently changed model selection.
        study_ai_provider.chat_body({'provider':request['provider'], 'model':request['model'],
            'revision':request['settingsRevision'], 'maxOutputTokens':1}, request)
        request = json.loads(canonical_json(request))
        transport_request = dict(request)
        request.setdefault('requestId', 'legacy-chat:'+fingerprint(request))
        if not isinstance(request['requestId'], str) or not 1 <= len(request['requestId']) <= 160:
            raise ValueError('invalid-ai-chat')
        ledger = LocalChatLedger(services.LOCAL_DATABASE_PATH, owner, library, root)
        try:
            prior = ledger.lookup(request)
            if prior:
                return replay_chat(prior, guard)
            with study_ai_provider.SETTINGS_LOCK:
                with services.local_database() as database:
                    selected, key = services.ai_store(database).snapshot(owner, library)
            if not key or not selected['enabled']:
                raise ValueError('ai-unconfigured')
            study_ai_provider.chat_body(selected, transport_request)
            guard()
            ticket = ledger.begin(request, selected)
            if ticket['kind'] != 'start':
                return replay_chat(ticket, guard)
            factory=services.local_chat_transport or create_managed_chat_transport
            try:
                transport=factory(ledger,ticket,selected,key,transport_request)
                return execute_chat(ledger,ticket,transport.provider,guard,executor=transport.executor)
            except BaseException:
                ledger.abandon(ticket, unsent_only=True)
                raise
        except (ValueError, CompanionFailure):
            raise
        except Exception as error:
            raise CompanionFailure(503, {'error': 'ai-chat-storage-unavailable'}) from error

    return AiApplication(AiPorts(
        library_id=lambda: services.local_vault_library_id(services.source_path('learning_vault_root')),
        settings=settings,
        configure=configure,
        models=models,
        prepare_chat=chat,
        failure_code=study_ai_provider.failure_code,
        hint=lambda question, answer: services.get_hint_deepseek(question, answer),
        correct=lambda card, instruction: services.correct_card_deepseek(card, instruction),
        generate=lambda *args: services.call_deepseek(*args),
        set_cached=lambda value: services.set_state(value),
        cached=lambda: services.STATE,
        decorate=lambda value: services.with_connections(value),
        save_legacy_settings=lambda owner, payload: services.save_deepseek_key(str(payload.get('apiKey', '')), owner),
        begin_generation=begin_generation,
        commit_generation=commit_generation,
    ))
