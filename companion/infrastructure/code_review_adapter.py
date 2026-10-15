"""Configured owner/library ports; no separate keys, model settings or execution runtime."""
from contextlib import closing
import sqlite3
import time
from urllib.error import HTTPError
import study_ai_provider
from application.code_review_application import CodeReviewApplication,CodeReviewRejected
from application.code_review import prepare_code_review
from learning_support import parse_code_learning_support_v1
from application.source_admission import canonical_json
from infrastructure.code_review_ledger import CodeReviewLedger
from infrastructure.code_review_provider import evaluate_code


def create_code_review(services, owner, library, root, current, *, clock=time.time, transport=None):
    ledger = CodeReviewLedger(services.LOCAL_DATABASE_PATH,owner,library,root,clock=clock)
    def snapshot():
        with study_ai_provider.SETTINGS_LOCK:
            with closing(sqlite3.connect(services.LOCAL_DATABASE_PATH,timeout=10)) as db,db:
                return services.ai_store(db).snapshot(owner,library)
    def provider(frozen,key,data,job_id,amount,dispatch):
        with study_ai_provider.SETTINGS_LOCK:
            latest,latest_key = snapshot()
            if canonical_json(latest)!=canonical_json(frozen) or latest_key!=key:
                raise ValueError('code-review-settings-changed')
            try:
                return evaluate_code(latest,latest_key,data,job_id,amount,transport=transport,before_transport=dispatch)
            except HTTPError as error:
                if error.code in (400,401,402,403,404,429): raise CodeReviewRejected() from None
                raise
    return CodeReviewApplication(ledger,snapshot,provider,current,
        prepare=lambda attempt:prepare_code_review(attempt,parse_support=parse_code_learning_support_v1))
