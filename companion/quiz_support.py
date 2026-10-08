"""Closed source option IDs, with one authoritative correct-ID set."""
import copy
import re
TRAPS={'concept_substitution','reverse_causality','overgeneralization','out_of_scope','superficial_similarity'}
def parse_quiz_support(raw):
    if type(raw) is dict and type(raw.get('schemaVersion')) in (int,float) and raw['schemaVersion']==2:
        from course_task_support import parse_quiz_support_v2
        return parse_quiz_support_v2(raw)
    def closed(value,keys):
        if type(value) is not dict or set(value)-set(keys):raise ValueError('invalid-quiz-support')
        return value
    def text(value,limit):
        from account_sync_schema import JS_WHITESPACE
        if type(value) is not str or not value.strip(JS_WHITESPACE) or len(value.encode('utf-16-le'))//2>limit or re.search(r'[\x00-\x1f\x7f-\x9f]',value):raise ValueError('invalid-quiz-text')
        return value
    value=closed(raw,['schemaVersion','type','selection','options','correctOptionIds'])
    if type(value.get('schemaVersion')) is not int or value['schemaVersion']!=1 or value.get('type')!='quiz' or value.get('selection') not in ('single','multiple'):raise ValueError('unsupported-quiz-support')
    options=value.get('options')
    if type(options) is not list or not 2<=len(options)<=32:raise ValueError('invalid-quiz-options')
    ids=set()
    for raw_option in options:
        option=closed(raw_option,['optionId','text','trapType','trapExplanation']);ident=text(option.get('optionId'),64)
        if not re.fullmatch(r'[a-zA-Z0-9:_.-]+',ident) or ident in ids:raise ValueError('invalid-quiz-option-id')
        ids.add(ident);text(option.get('text'),8000)
        if 'trapType' in option and (type(option['trapType']) is not str or option['trapType'] not in TRAPS):raise ValueError('invalid-quiz-trap')
        if 'trapExplanation' in option:text(option['trapExplanation'],2000)
    answers=value.get('correctOptionIds')
    if type(answers) is not list or not 1<=len(answers)<=32 or any(type(i) is not str or i not in ids for i in answers) or len(set(answers))!=len(answers) or value['selection']=='single' and len(answers)!=1:raise ValueError('invalid-quiz-answer-ids')
    return copy.deepcopy(value)
