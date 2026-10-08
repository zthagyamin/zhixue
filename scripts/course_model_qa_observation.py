"""Minimal observations of authored QA replies, excluding requests and credentials."""
import hashlib
import json
import re


def observe_reply(raw):
    result = {'responseBytes': len(raw), 'responseSha256': hashlib.sha256(raw).hexdigest()}
    def save_text(name, value):
        safe = value.encode('utf-8', errors='backslashreplace').decode('utf-8')
        result[name] = safe
        if safe != value:
            result['textEscapedForObservation'] = True
    if len(raw) > 100000:
        return {**result, 'observationStatus': 'oversize'}
    try:
        envelope = json.loads(raw)
    except (ValueError, UnicodeError):
        return {**result, 'observationStatus': 'invalid-json'}
    if type(envelope) is not dict:
        return {**result, 'observationStatus': 'invalid-envelope'}
    model = envelope.get('model')
    if type(model) is str and len(model) <= 200:
        save_text('providerModel', model)
    usage = envelope.get('usage')
    if type(usage) is dict and type(usage.get('total_tokens')) is int and usage['total_tokens'] >= 0:
        result['usageTokens'] = usage['total_tokens']
    choices = envelope.get('choices')
    if type(choices) is not list or len(choices) != 1 or type(choices[0]) is not dict:
        return {**result, 'observationStatus': 'invalid-choice'}
    choice = choices[0]
    if type(choice.get('finish_reason')) is str and len(choice['finish_reason']) <= 100:
        save_text('finishReason', choice['finish_reason'])
    message = choice.get('message')
    if type(message) is dict and type(message.get('content')) is str:
        save_text('qaAssistantContent', message['content'])
    return {**result, 'observationStatus': 'captured-qa-reply'}


def safe_failure_code(error):
    text = str(error)
    return text if re.fullmatch(r'(?:course-|invalid-course-|frozen-|native-course-)[a-z0-9-]{1,80}', text) else 'detail-suppressed'
