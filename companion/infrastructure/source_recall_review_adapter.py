"""Source-scoped recall grading using existing configuration and legacy semantics."""
from __future__ import annotations

import copy
import io
import json
import sqlite3
import time
from contextlib import closing
from urllib.error import HTTPError

import study_ai_provider
import practice_engine
from recall_quality import needs_concrete_recall_question,display_recall_prompt,recall_reference
from learning_support import parse_learning_support
from application.source_admission import canonical_json,normalize_evaluation
from application.source_recall_review import prepare_source_recall_review,validate_source_recall_reply
from application.code_review_application import ReviewApplication,ReviewRejected
from infrastructure.code_review_ledger import ReviewJobLedger
from infrastructure.code_review_provider import _parse
from infrastructure.legacy_ai import LegacyLearningProvider,LegacyModelPorts
from infrastructure.legacy_transport import BoundedProviderResponse


def recall_material(item):
    if needs_concrete_recall_question(item):
        raise ValueError('recall-review-concrete-task-required')
    support=parse_learning_support(item['learningSupport'],'recall') if item.get('learningSupport') else {}
    # Native V2 tasks use their own source/diagnostic port; never invent a task
    # review status or turn the older callback into its formal evidence.
    if support.get('schemaVersion')==2:
        raise ValueError('recall-review-native-task-required')
    hints=support.get('hints') or []
    reference=recall_reference(item,support.get('criteria'),hints[2] if len(hints)==3 else None)
    if reference is None:
        raise ValueError('recall-review-reference-required')
    grounded={**copy.deepcopy(item),'prompt':display_recall_prompt(item),'answer':reference,'explanation':reference}
    # Preserve the existing practice engine's reference repair semantics. The
    # complete original item is separately frozen in the private call input.
    grounded.pop('reviewPoint',None)
    return grounded


def create_source_recall_review(services,owner,library,root,current,*,clock=time.time,transport=None):
    ledger=ReviewJobLedger(services.LOCAL_DATABASE_PATH,owner,library,root,clock=clock,family='recall')

    def snapshot():
        with study_ai_provider.SETTINGS_LOCK:
            with closing(sqlite3.connect(services.LOCAL_DATABASE_PATH,timeout=10)) as db,db:
                return services.ai_store(db).snapshot(owner,library)

    def provider(frozen,key,data,job_id,amount,dispatch):
        usage=None
        with study_ai_provider.SETTINGS_LOCK:
            latest,latest_key=snapshot()
            if canonical_json(latest)!=canonical_json(frozen) or latest_key!=key:
                raise ValueError('recall-review-settings-changed')

            def opened(legacy_request,timeout):
                nonlocal usage
                body=json.loads(legacy_request.data)
                body['max_tokens']=min(body['max_tokens'],latest['maxOutputTokens'])
                request=study_ai_provider.build_request(latest,latest_key,body)
                request.add_header('Idempotency-Key',job_id)
                dispatch()
                opener=transport or study_ai_provider.open_request
                try:
                    with BoundedProviderResponse(opener(request,timeout=timeout)) as response:
                        raw=response.read(100001)
                except HTTPError as error:
                    if error.code in (400,401,402,403,404,429):raise ReviewRejected() from None
                    raise
                if len(raw)>100000:raise ValueError('recall-review-output-limit')
                envelope=_parse(raw)
                choices=envelope.get('choices') if type(envelope) is dict else None
                if type(choices) is not list or len(choices)!=1 or type(choices[0]) is not dict:
                    raise ValueError('recall-review-invalid-envelope')
                choice=choices[0];message=choice.get('message')
                if (choice.get('finish_reason')!='stop' or type(message) is not dict
                        or type(message.get('content')) is not str or message.get('tool_calls')
                        or message.get('refusal') or message.get('role','assistant')!='assistant'):
                    raise ValueError('recall-review-incomplete-response')
                if key in message['content']:raise ValueError('recall-review-secret-echo')
                validate_source_recall_reply(_parse(message['content']))
                billed=envelope.get('usage',{})
                if type(billed) is not dict:raise ValueError('recall-review-invalid-usage')
                usage=billed.get('total_tokens')
                if usage is not None and (type(usage) is not int or not 0<=usage<=amount):
                    raise ValueError('recall-review-invalid-usage')
                return io.BytesIO(raw)

            legacy=LegacyLearningProvider(LegacyModelPorts(key=lambda:key,model=lambda default:latest['model'],
                default_model=lambda:latest['model'],open=opened,validate=lambda *args:{}))
            try:
                result=legacy.grade_recall_deepseek(data['modelItem'],data['answer'])
            except RuntimeError as error:
                if isinstance(error.__cause__,ReviewRejected):raise error.__cause__
                raise
            outcome=normalize_evaluation(result,data['item'])
            trace={'provider':latest['provider'],'modelId':latest['model'],'requestId':job_id,
                   'promptVersion':'legacy-recall-full-input-v1','ruleVersion':'source-recall-receipt-v1',
                   'diagnostic':result}
            return outcome,usage,trace

    return ReviewApplication(ledger,snapshot,provider,current,
        lambda attempt:prepare_source_recall_review(attempt,material=recall_material),family='recall')
