"""Credentials, configuration locks and provider transport stay in this adapter."""
from __future__ import annotations
import study_ai_provider
from application.ai import AiApplication, AiPorts, LocalChat


def create_ai_application(services) -> AiApplication:
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
        with study_ai_provider.SETTINGS_LOCK:
            with services.local_database() as database:
                selected, key = services.ai_store(database).snapshot(owner, library)
        if not key or not selected['enabled']:
            raise ValueError('ai-unconfigured')
        # Validation completes before the boundary commits SSE headers.
        study_ai_provider.chat_body(selected, request)
        return LocalChat(study_ai_provider.stream_chat(selected, key, request))

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
    ))
