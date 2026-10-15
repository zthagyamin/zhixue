"""Serial provider admission; temporary diagnostics never write formal study events."""
from __future__ import annotations

from application.source_admission import canonical_json


def pending(reason):
    return {'status':'pending','reason':reason}


class ReviewApplication:
    def __init__(self, ledger, settings, provider, current, prepare, *, family='code'):
        if family not in ('code','recall','hint'):
            raise ValueError('unsupported-review-family')
        self.prefix=family+'-review-'
        self.ledger, self.settings, self.provider, self.current = ledger, settings, provider, current
        self.prepare = prepare

    def _pending(self, reason):
        return pending(self.prefix+reason)

    def evaluate(self, attempt, request_id):
        ticket = None; dispatched = False
        try:
            data = self.prepare(attempt)
            if not self.current(attempt,request_id): return self._pending('source-changed')
            frozen, key = self.settings()
            ticket = self.ledger.begin(request_id,data,frozen)
            if ticket['kind'] in ('prepared','done'):
                result=self.ledger.finish(ticket['jobId'])['outcome']
                return result if self.current(attempt,request_id) else self._pending('source-changed')
            if ticket['kind'] in ('wait','unknown'):
                return self._pending('call-inflight' if ticket['kind']=='wait' else 'receipt-unknown')
            if not frozen.get('enabled') or not frozen.get('configured') or not key:
                self.ledger.abort_preflight(ticket);return self._pending('unconfigured')
            amount = self.ledger.reserve(ticket)
            current, current_key = self.settings()
            if canonical_json(current)!=canonical_json(frozen) or current_key!=key:
                self.ledger.abort_preflight(ticket);return self._pending('settings-changed')
            if not self.current(attempt,request_id):
                self.ledger.abort_preflight(ticket);return self._pending('source-changed')
            # This durable transition precedes transport. A crash or lost reply
            # after it cannot silently authorize another paid request.
            def dispatch():
                nonlocal dispatched
                if not self.current(attempt,request_id): raise ValueError(self.prefix+'source-changed')
                self.ledger.dispatch(ticket);dispatched = True
            outcome,usage,trace = self.provider(current,current_key,data,ticket['jobId'],amount,dispatch)
            if not dispatched: raise ValueError(self.prefix+'dispatch-required')
            self.ledger.prepare(ticket,outcome,usage,trace)
            result = self.ledger.finish(ticket['jobId'])['outcome']
            return result if self.current(attempt,request_id) else self._pending('source-changed')
        except Exception as error:
            if ticket and ticket.get('kind')=='start':
                if dispatched:
                    # An explicit rejection response has known nonexecution;
                    # a timeout, transport loss or malformed reply is uncertain.
                    if isinstance(error,ReviewRejected):
                        result = self._pending('provider-rejected')
                        self.ledger.prepare(ticket,result,None,None)
                        self.ledger.finish(ticket['jobId'])
                        return result
                    self.ledger.uncertain(ticket)
                else:
                    self.ledger.abort_preflight(ticket)
            reason = str(error)
            return pending(reason if reason.startswith(self.prefix) and len(reason)<120 else self.prefix+'unavailable')


class ReviewRejected(Exception):
    """The transport received an explicit nonexecution rejection response."""


class CodeReviewApplication(ReviewApplication):
    """Compatibility entry retaining the original code-review family."""


class CodeReviewRejected(ReviewRejected):
    """Compatibility name for explicit code-provider rejection."""
