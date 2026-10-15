"""Controlled chat lifecycle. Ledger and provider are injected; no formal writer."""
from __future__ import annotations
from application.ai import LocalChat


def replay_chat(ticket, guard):
    def events():
        guard()
        if ticket['kind'] == 'done':
            result = ticket['result']
            if result['text']:
                yield {'type': 'delta', 'text': result['text']}
            guard()
            yield result['done']
        else:
            if ticket.get('text'):
                yield {'type': 'delta', 'text': ticket['text']}
            guard()
            yield {'type': 'error', 'error': 'ai-request-pending' if ticket['kind'] == 'wait'
                   else 'ai-request-indeterminate'}
    return LocalChat(events())


def execute_chat(ledger, ticket, provider, guard, executor=None):
    started = False

    def cancel_prepared():
        # HTTP can reject a prepared stream before the generator's finally exists.
        # Never cancel an iterator that has already entered its execution lifecycle.
        if started:
            return
        if executor is not None:
            executor.stop()
        ledger.abandon(ticket, unsent_only=True)

    def events():
        nonlocal started
        started = True
        with ledger.execution(ticket,executor):
            stream = None
            try:
                guard()
                ledger.dispatch(ticket)
                guard()
                stream = provider()
                completed = False
                for event in stream:
                    guard()
                    if completed or not isinstance(event, dict):
                        raise ValueError('ai-provider-error')
                    if event.get('type') == 'delta' and isinstance(event.get('text'), str):
                        ledger.append(ticket, event['text'])
                        guard()
                        yield {'type': 'delta', 'text': event['text']}
                    elif event.get('type') == 'done':
                        metadata = {key: event[key] for key in ('type', 'model', 'provider', 'usageTokens') if key in event}
                        completed = True
                    else:
                        raise ValueError('ai-provider-error')
                if not completed:
                    raise ValueError('ai-stream-incomplete')
                guard()
                ledger.complete(ticket, metadata)
                guard()
                yield metadata
            finally:
                try:
                    if stream is not None:
                        close = getattr(stream, 'close', None)
                        if close:
                            close()
                    if executor is not None:
                        executor.stop()
                    # Only confirmed provider termination releases concurrency.
                    # Done remains done if its final browser receipt is lost.
                    ledger.abandon(ticket)
                except BaseException:
                    # Uncertain stop must retain dispatched/inflight for recovery.
                    raise

    return LocalChat(events(),getattr(executor,"remaining",None),cancel_prepared)
