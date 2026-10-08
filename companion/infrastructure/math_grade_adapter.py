"""Compose native math authority from authenticated services and configured root."""
from application.native_math import NativeMathApplication
from native_math_schema import native_math_rules
import index_gateway as gateway
from infrastructure.math_source_capture import NativeMathSources
from infrastructure.math_grade_ledger import MathGradeLedger
from infrastructure.math_step_provider import configured_semantic_provider
from infrastructure.math_mapping_store import MathMappingStore


def create_native_math_application(services, authenticated_owner):
    root=services.source_path('learning_vault_root')
    sources=NativeMathSources(root,authenticated_owner,services.effective_gateway,services.LOCAL_DATABASE_PATH)
    ledger=MathGradeLedger(services.LOCAL_DATABASE_PATH,authenticated_owner,sources.library,root)
    mappings=MathMappingStore(services.LOCAL_DATABASE_PATH,sources,ledger)
    def admit_claim(row):
        with gateway.LOCK:
            sources.read(row['identity'],row['captureId'])
            sources.verify_current(row['identity'],row['captureId'])
            return ledger.claim(row)
    return NativeMathApplication(sources,ledger,native_math_rules(),admit_claim=admit_claim,
        semantic_step=getattr(services,'native_math_step_provider',None) or configured_semantic_provider(services,authenticated_owner,sources.library,ledger),
        variant_mapping=mappings.grade,mapping_service=mappings)
