"""Auxiliary delivery is independent: no AI calls, score changes or core dispatch."""
from __future__ import annotations
import sqlite3
from account_sync_schema import study_count, study_object
from account_sync_writer import WritebackBlocked
from assistance_schema import validate_native_assistance, validate_assistance_receipt
from assistance_inbox import AssistanceInbox
from assistance_writer import AssistanceVaultWriter

CAPABILITY = 'assistance-summary-v1'


def process_pending(owner, library, inbox, apply, *, channel='account', rows=None):
    pending = rows if rows is not None else inbox.pending(owner, library, channel=channel)
    results = []
    for row in pending:
        summary_id = row['record']['summary']['summaryId']
        initial=inbox.set_result(owner,library,summary_id,'received',channel=channel,initial_only=True)
        if initial['status']=='applied':
            results.append(initial); continue
        try:
            proof=apply(row)
            receipt=inbox.set_result(owner,library,summary_id,'applied',channel=channel,proof=proof)
        except WritebackBlocked as error:
            receipt=inbox.set_result(owner,library,summary_id,'blocked',channel=channel,reason=error.reason)
        except (OSError,sqlite3.Error):
            receipt=inbox.set_result(owner,library,summary_id,'blocked',channel=channel,reason='storage-unavailable')
        except (ValueError,KeyError,TypeError):
            receipt=inbox.set_result(owner,library,summary_id,'blocked',channel=channel,reason='writeback-failed')
        results.append(receipt)
    return results


def receive_native(owner, vault, database_path, raw, parent, route):
    record=validate_native_assistance(raw); inbox=AssistanceInbox(database_path); writer=AssistanceVaultWriter(vault,owner,database_path)
    status=inbox.receive_native(owner,record,parent,route); summary_id=record['summary']['summaryId']
    row=inbox.get(owner,'native',summary_id,channel='local')
    process_pending(owner,'native',inbox,lambda row:writer.apply_native(row['record'],row['parent'],row['route']),channel='local',rows=[row])
    return dict(status=status,durable=True,summaryId=summary_id,summaryHash=record['summary']['summaryHash'],associationHash=record['associationHash'],receipt=inbox.latest_receipt(owner,'native',summary_id,channel='local'))


def run_account(owner, library, inbox, writer, core_writer, call, max_pages=3):
    study_count(max_pages,minimum=1)
    if max_pages>10: raise ValueError('invalid-assistance-page-budget')
    boot=call('GET','bootstrap'); capabilities=boot.get('capabilities',[])
    if type(capabilities) is not list or any(type(value) is not str for value in capabilities): raise ValueError('invalid-assistance-capabilities')
    if CAPABILITY not in capabilities: return {'status':'unsupported'}
    if boot.get('apiVersion')!=1 or boot.get('enabled') is not True or boot.get('profile',{}).get('libraryId')!=library: raise ValueError('assistance-bootstrap-binding')
    fences=study_object(boot.get('assistanceFences'),['summaries','receipts'])
    for value in fences.values(): study_count(value)
    for _ in range(max_pages):
        cursor=inbox.cursor(owner,library); through=cursor['through'] if cursor['through'] is not None else fences['summaries']
        if cursor['after']>through or through>fences['summaries']: raise ValueError('assistance-fence-regression')
        page=call('GET','assistance',params={'libraryId':library,'after':cursor['after'],'through':through,'limit':20})
        inbox.receive_page(owner,library,page,after=cursor['after'])
        if page['nextCursor'] is None: break
    cursor=inbox.cursor(owner,library)
    if cursor['through'] is None: process_pending(owner,library,inbox,lambda row:writer.apply_account(row['record'],core_writer))
    for receipt in inbox.pending_receipts(owner,library):
        reply=call('POST','assistance-receipt',payload={'libraryId':library,'receipt':receipt})
        if reply.get('status') not in ('accepted','duplicate'): raise ValueError('assistance-cloud-receipt-conflict')
        stored=study_object(reply.get('receipt'),['sequence','receipt'],['writerGrantId','receivedAt'])
        if validate_assistance_receipt(stored['receipt'])!=receipt: raise ValueError('assistance-cloud-receipt-binding')
        sequence=study_count(stored['sequence'],minimum=1);inbox.ack_receipt(owner,library,receipt['receiptId'],sequence)
    pending=bool(inbox.pending(owner,library,limit=1) or inbox.pending_receipts(owner,library,limit=1))
    return {'status':'downloading' if cursor['through'] is not None else 'pending' if pending else 'synced','completeThrough':cursor['completeThrough']}
