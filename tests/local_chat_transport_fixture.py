"""Explicit in-process synthetic provider port; production defaults remain bounded."""
import study_ai_provider
from application.ai import ChatTransport


def inline_chat_transport(_ledger,_ticket,settings,key,request):
    return ChatTransport(lambda:study_ai_provider.stream_chat(settings,key,request))
