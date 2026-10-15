"""Authenticated temporary answer/source operations, with no direct formal writes."""
from __future__ import annotations

import re

from application.source_admission import fields
from infrastructure.nonword_source_adapter import create_source_admission, create_code_hint_admission


def post_nonword_source(request, services, request_path, owner, payload=None):
    try:
        envelope = fields(payload, ('schemaVersion', 'action', 'request'))
        if type(envelope['schemaVersion']) is not int or envelope['schemaVersion'] != 1:
            raise ValueError('source-admission-version')
        store = create_source_admission(services, owner)
        action, body = envelope['action'], envelope['request']
        if action == 'capture':
            result = store.capture(body)
        elif action == 'submit':
            result = store.submit(body)
        elif action == 'code-report':
            result = store.record_code_report(body)
        elif action == 'code-hint':
            result = create_code_hint_admission(services, owner, store).request(body)
        elif action == 'self-assess':
            result = store.self_assess(body)
        elif action == 'confirm':
            result = store.confirm(body)
        elif action == 'evaluate':
            result = store.evaluate(body)
        elif action == 'claim':
            result = store.claim(body)
        elif action == 'read':
            body = fields(body, ('attemptId',))
            attempt = store.read_attempt(body['attemptId'])
            if attempt is None:
                raise ValueError('source-admission-submission-required')
            # The captured routing/descriptor remains private to the receiver.
            result = {name: attempt[name] for name in (
                'submission', 'binding', 'sourceBinding', 'evaluation', 'receipt')}
            result.update(schemaVersion=1, status='saved', durable=True)
            result['activeRequestId'] = attempt.get('evaluationRequest')
            result['selfAssessment'] = attempt.get('selfAssessment')
            result['codeReports'] = attempt.get('codeReports', [])
        else:
            raise ValueError('source-admission-action')
    except ValueError as error:
        code = str(error)
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,100}', code):
            code = 'source-admission-unavailable'
        request.send_json(409, {'error': code})
        return
    except Exception:
        request.send_json(503, {'error': 'source-admission-storage-unavailable'})
        return
    request.send_json(200, result)
