"""Math source/answer authority, independent step diagnosis, no formal event writes."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class NativeMathRules:
    parse_claim: Callable
    parse_evaluate: Callable
    parse_source: Callable
    parse_read: Callable
    grade_final: Callable
    grade_step: Callable
    semantic_step: Callable
    has_text: Callable


class NativeMathApplication:
    def __init__(self, sources, ledger, rules, semantic_step=None, variant_mapping=None, admit_claim=None, mapping_service=None):
        self.sources, self.ledger, self.rules = sources, ledger, rules
        self.admit_claim = admit_claim
        self.mapping_service = mapping_service
        self.semantic_step, self.variant_mapping = semantic_step, variant_mapping

    def source(self, action, payload):
        row = self.rules.parse_source(payload, action)
        capture = self.sources.read(row['identity'],row['captureId']) if action=='read' else self.sources.capture(row['identity'])
        return {'schemaVersion':1,'durable':True,'capture':capture}

    def claim(self, payload):
        if type(payload) is dict and payload.get('action')=='formal':
            return self.ledger.formal(payload)
        row = self.rules.parse_claim(payload)
        saved = self.ledger.read_attempt(row['attempt']['attemptId'])
        # A retry returns the immutable old admission even after the source changed.
        if saved:
            return self.ledger.claim(row)
        if 'variant' in row:
            if self.mapping_service:
                self.mapping_service.validate_claim(row)
            return self.ledger.claim(row)
        if self.admit_claim:
            return self.admit_claim(row)
        self.sources.read(row['identity'],row['captureId'])
        self.sources.verify_current(row['identity'],row['captureId'])
        return self.ledger.claim(row)

    def evaluate(self, payload):
        request = self.rules.parse_evaluate(payload)
        if request['mode']=='step':
            attempt=self.ledger.read_attempt(request['attemptId'])
            if attempt and 'variant' in attempt['claim']:
                raise ValueError('native-math-variant-step-unavailable')
        began = self.ledger.begin(request)
        if began['kind']=='receipt':
            return began['result']
        if began['kind']=='prepared':
            return self.ledger.finish(request)
        saved = self.ledger.read_attempt(request['attemptId'])['claim']
        capture = self.sources.read(saved['identity'],saved['captureId'])
        result = {'schemaVersion':1,'durable':True,**{key:request[key] for key in ('requestId','attemptId','answerRevision','sourceVersion')}}
        if began['kind']=='orphan':
            # Unknown transport outcomes are not permission to invoke a paid provider again.
            if request['mode']=='final':
                result['final']={'status':'undetermined','source':'deterministic','explanation':'此前评价回执未知，原答案保留待核对。'}
            result['capability']={'semanticStep':'pending','reason':'previous-request-outcome-unknown'}
        else:
            item = capture['item']
            support = item.get('learningSupport')
            if 'variant' in saved:
                if request['mode']=='step':
                    raise ValueError('native-math-variant-step-unavailable')
                descriptor=saved['variant']
                mapped=self.mapping_service.validate_claim(saved) if self.mapping_service else None
                if (not callable(self.variant_mapping) or not support or support.get('variantMappingId')!=descriptor['mappingId']
                        or (self.mapping_service and mapped is None)):
                    result['final']={'status':'undetermined','source':'deterministic','explanation':'此变式尚无批准的来源映射，原答案保留待核对。'}
                    result['capability']={'variant':'unavailable','reason':'missing-approved-mapping'}
                else:
                    result['final']=self.variant_mapping(capture,descriptor,saved['attempt']['submitted']['answer'])
                    checked=result['final']
                    if set(checked)!= {'status','source','explanation'} or checked['status'] not in ('correct','incorrect','undetermined') or checked['source']!='deterministic':
                        raise ValueError('native-math-variant-result-invalid')
                    result['capability']={'variant':'available'}
                self.ledger.prepare(request,result)
                return self.ledger.finish(request)
            if request['mode']=='final':
                reference = {'answer':item['practice']['answer']}
                if support is not None:
                    reference['learningSupport']=support
                final = self.rules.grade_final(reference,saved['attempt']['submitted']['answer'])
                result['final']={'status':{'correct':'correct','wrong':'incorrect','unknown':'undetermined'}[final['verdict']],
                                 'source':'deterministic','explanation':final['explanation']}
            step = saved.get('stepInput')
            authored = support.get('step') if support else None
            if step and self.rules.has_text(step['text']) and authored:
                if authored['mode']=='semantic':
                    if request['mode']=='step':
                        diagnostic, capability = self.rules.semantic_step(self.semantic_step, request, saved, capture)
                    else:
                        # Saving a semantic step is not permission to call AI.
                        diagnostic={'status':'undetermined','source':'none',
                                    'explanation':'此步骤已保存，明确请求步骤诊断后再调用 AI。'}
                        capability={'semanticStep':'pending','reason':'explicit-step-request-required'}
                    result['capability']=capability
                else:
                    diagnostic = self.rules.grade_step(step['text'],support)
                result['step']={**diagnostic,'answerRevision':request['answerRevision'],'stepRevision':step['revision'],
                                'stepId':authored['stepId'],'sourceVersion':request['sourceVersion']}
            elif request['mode']=='step':
                raise ValueError('native-math-step-source-unavailable')
        self.ledger.prepare(request,result)
        return self.ledger.finish(request)

    def mapping(self, action, payload):
        if not self.mapping_service:
            raise ValueError('native-math-mapping-unavailable')
        return self.mapping_service.mapping(action,payload)

    def variant(self, payload):
        if not self.mapping_service:
            raise ValueError('native-math-variant-unavailable')
        return self.mapping_service.variant(payload)

    def read(self, payload):
        row=self.rules.parse_read(payload)
        return self.ledger.read(row['attemptId'],row.get('requestId'))
