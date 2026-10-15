"""Pure original code-report identity and captured case validation."""
from application.code_run_report import parse_code_run_report, code_json_equal
from application.source_admission import fields, identifier, instant, parse_binding


def parse_request(raw, scope):
    request = fields(raw, ('schemaVersion', 'attemptId', 'binding', 'answerRevision', 'submittedAt', 'report'))
    if type(request['schemaVersion']) is not int or request['schemaVersion'] != 1:
        raise ValueError('source-admission-version')
    identifier(request['attemptId'])
    parse_binding(request['binding'], scope[0], scope[1])
    if type(request['answerRevision']) is not int or request['answerRevision'] < 0:
        raise ValueError('source-admission-answer-revision')
    instant(request['submittedAt'], formal=True)
    parsed = parse_code_run_report(request['report'])
    identity = parsed.get('identity')
    if (not identity or identity['attemptId'] != request['attemptId']
            or identity['revision'] != request['answerRevision']
            or any(identity[field] != request['binding']['contentHash'] for field in ('sourceVersion', 'testVersion'))):
        raise ValueError('source-admission-code-report-identity')
    return request


def validate_source(request, capture, parse_support):
    if capture['status'] != 'confirmed':
        return
    item = capture['descriptor']['item']
    if item.get('questionType') != 'code':
        raise ValueError('source-admission-code-report-kind')
    failure = parse_code_run_report(request['report']).get('firstFailure')
    if failure:
        support = item.get('learningSupport')
        if not support or support.get('type') != 'code':
            raise ValueError('source-admission-code-report-source')
        source = parse_support(support)
        matches = [case for case in source['cases'] if case['id'] == failure['caseId']]
        if (len(matches) != 1 or any(not code_json_equal(matches[0][key], failure[key])
                for key in ('functionName', 'args', 'kwargs', 'expected'))):
            raise ValueError('source-admission-code-report-source')
