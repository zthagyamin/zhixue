"""Versioned source-file reader. Never writes grades, schedules or original source files."""
from __future__ import annotations
import json
import re

SUFFIX = '.zhixue-candidates.json'


def _object(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('candidate-invalid-fields')
    return value


def _text(value, maximum, optional=False):
    if not isinstance(value, str) or len(value) > maximum or (not optional and not value.strip()) or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value):
        raise ValueError('candidate-invalid-text')
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('candidate-duplicate-field')
        result[key] = value
    return result


def parse_candidate_document(text):
    if len(text.encode('utf-8')) > 512000:
        raise ValueError('candidate-too-large')
    raw = json.loads(text, object_pairs_hook=_unique_object)
    version = raw.get('schemaVersion') if isinstance(raw, dict) else None
    value = _object(raw, ['documentType', 'schemaVersion', 'status', 'parent', 'items'] + (['readingContext'] if type(version) is int and version == 2 else []))
    if value['documentType'] != 'zhixue-practice-candidates' or type(value['schemaVersion']) is not int or value['schemaVersion'] not in (1, 2) or value['status'] != 'reviewed-candidates':
        raise ValueError('candidate-unsupported-version-or-status')
    parent = _object(value['parent'], ['key', 'sourceVersion', 'versionKind', 'kind', 'title'])
    for key, limit in [('key', 500), ('sourceVersion', 500), ('title', 1000)]:
        _text(parent[key], limit)
    if parent['kind'] not in ('card', 'paper') or parent['versionKind'] not in ('item-content', 'paper-origin', 'visible-snapshot'):
        raise ValueError('candidate-invalid-parent')
    if version == 2:
        context = _object(value['readingContext'], ['schemaVersion', 'paperId', 'sourceNote', 'materialFingerprint', 'sourceVersion',
            'unitId', 'taskId', 'taskRevision', 'abilityType', 'abilityId', 'mappingStatus', 'sectionId', 'paragraphs'])
        if parent['kind'] != 'paper' or type(context['schemaVersion']) is not int or context['schemaVersion'] != 1 or context['mappingStatus'] != 'candidate':
            raise ValueError('candidate-invalid-reading-context')
        for key in ('paperId', 'unitId', 'taskId', 'abilityId', 'sectionId'):
            _text(context[key], 400 if key == 'sectionId' else 200)
        if context['sourceNote'] is not None:
            _text(context['sourceNote'], 1000)
        for key in ('materialFingerprint', 'sourceVersion'):
            _text(context[key], 64)
            if not re.fullmatch(r'[a-f0-9]{64}', context[key]):
                raise ValueError('candidate-invalid-reading-version')
        if context['sourceVersion'] != parent['sourceVersion'] or type(context['taskRevision']) is not int or context['taskRevision'] < 1:
            raise ValueError('candidate-invalid-reading-version')
        if context['abilityType'] not in ('definition', 'mechanism', 'comparison', 'condition', 'application') or not re.fullmatch(r'paper-ability:[a-f0-9]{64}', context['abilityId']):
            raise ValueError('candidate-invalid-reading-ability')
        if not isinstance(context['paragraphs'], list) or not context['paragraphs']:
            raise ValueError('candidate-invalid-reading-source')
        paragraph_ids = set()
        for paragraph in context['paragraphs']:
            _object(paragraph, ['id', 'rawEn'] + (['pageNumber'] if isinstance(paragraph, dict) and 'pageNumber' in paragraph else []))
            _text(paragraph['id'], 400)
            _text(paragraph['rawEn'], 8000)
            if paragraph['id'] in paragraph_ids:
                raise ValueError('candidate-invalid-reading-source')
            paragraph_ids.add(paragraph['id'])
            if 'pageNumber' in paragraph and (type(paragraph['pageNumber']) is not int or not 1 <= paragraph['pageNumber'] <= 200):
                raise ValueError('candidate-invalid-reading-page')
        if len('\n\n'.join(p['rawEn'] for p in context['paragraphs']).encode('utf-16-le')) // 2 > 8000:
            raise ValueError('candidate-invalid-reading-source')
    if not isinstance(value['items'], list) or not 1 <= len(value['items']) <= 6:
        raise ValueError('candidate-invalid-items')
    ids = set()
    for item in value['items']:
        _object(item, ['id', 'question', 'reference', 'keyPoints', 'category', 'fragmentId', 'quote', 'citation'])
        for key, limit in [('id', 160), ('question', 1000), ('reference', 7000), ('fragmentId', 160), ('quote', 12000)]:
            _text(item[key], limit)
        _text(item['keyPoints'], 1000, optional=parent['kind'] == 'card')
        if item['id'] in ids or len(item['reference']) + len(item['keyPoints']) > 7900:
            raise ValueError('candidate-duplicate-or-large-item')
        ids.add(item['id'])
        if item['category'] not in (('claim', 'observation', 'inference', 'limitation') if parent['kind'] == 'paper' else ('recall',)):
            raise ValueError('candidate-invalid-category')
        citation = item['citation']
        _object(citation, ['fragmentId', 'label', 'start', 'end'] + (['page'] if isinstance(citation, dict) and 'page' in citation else []))
        _text(citation['label'], 1000)
        if citation['fragmentId'] != item['fragmentId'] or any(type(citation[key]) is not int for key in ('start', 'end')) or citation['start'] < 0 or citation['end'] - citation['start'] != len(item['quote'].encode('utf-16-le')) // 2:
            raise ValueError('candidate-invalid-citation')
        if 'page' in citation and (type(citation['page']) is not int or not 1 <= citation['page'] <= 5000):
            raise ValueError('candidate-invalid-page')
        if version == 2:
            match = re.fullmatch(r'reading-p-([1-9][0-9]*)', item['fragmentId'])
            index = int(match[1]) - 1 if match else -1
            paragraphs = value['readingContext']['paragraphs']
            if index < 0 or index >= len(paragraphs) or item['quote'] not in paragraphs[index]['rawEn']:
                raise ValueError('candidate-reading-quote-mismatch')
            paragraph = paragraphs[index]
            start = len(paragraph['rawEn'][:paragraph['rawEn'].index(item['quote'])].encode('utf-16-le')) // 2
            if citation['start'] != start or citation.get('page') != paragraph.get('pageNumber'):
                raise ValueError('candidate-reading-citation-mismatch')
    return value


def candidate_learning_rows(artifact):
    for item in artifact['items']:
        answer = item['reference'] + ('\n核对要点：' + item['keyPoints'] if item['keyPoints'] else '')
        provenance = json.dumps({'parent': artifact['parent'], 'category': item['category'], 'citation': item['citation'], 'quote': item['quote'],
            **({'readingContext': artifact['readingContext']} if artifact['schemaVersion'] == 2 else {})}, ensure_ascii=False, indent=2)
        material = '# ' + item['question'] + '\n\n' + answer + '\n\n## 用户提供的候选来源声明\n\n不代表已认证原文件仍为该版本；原材料更新时请重新核对。\n\n```json\n' + provenance.replace('`', '\\u0060') + '\n```\n'
        yield item['id'], {'kind': 'quiz', 'pluginType': 'recall', 'prompt': item['question'], 'answer': answer, 'topic': item['question'][:160],
            **({'abilityId': artifact['readingContext']['abilityId'], 'sourceLabel': artifact['parent']['title']} if artifact['schemaVersion'] == 2 else {})}, material
