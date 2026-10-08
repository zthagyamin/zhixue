"""Source-provided grapheme/phoneme mapping, without heuristic generation."""
import copy
import re

def parse_spelling_support(raw):
    from account_sync_schema import JS_WHITESPACE
    def closed(value, keys):
        if type(value) is not dict or set(value)-set(keys):raise ValueError('invalid-spelling-support')
        return value
    value=closed(raw,['schemaVersion','type','word','segments'])
    if type(value.get('schemaVersion')) is not int or value['schemaVersion']!=1 or value.get('type')!='spelling':raise ValueError('unsupported-spelling-support')
    word=value.get('word')
    if type(word) is not str or not 1<=len(word)<=100 or not re.fullmatch(r"[a-zA-Z' -]+",word) or word.strip()!=word:raise ValueError('invalid-spelling-word')
    segments=value.get('segments')
    if type(segments) is not list or not 1<=len(segments)<=100:raise ValueError('invalid-spelling-segments')
    for raw_segment in segments:
        segment=closed(raw_segment,['letters','phoneme','isTricky'])
        if type(segment.get('letters')) is not str or not segment['letters'] or type(segment.get('phoneme')) is not str or not segment['phoneme'].strip(JS_WHITESPACE) or len(segment['phoneme'].encode('utf-16-le'))//2>80 or re.search(r'[\x00-\x1f\x7f-\x9f]',segment['phoneme']) or 'isTricky' in segment and type(segment['isTricky']) is not bool:raise ValueError('invalid-spelling-segment')
    if ''.join(s['letters'] for s in segments)!=word:raise ValueError('spelling-mapping-mismatch')
    return copy.deepcopy(value)
