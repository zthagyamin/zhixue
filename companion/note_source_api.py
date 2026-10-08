"""Small native API boundary shared by browser controls and isolated tests."""
from external_sources import CAPABILITY, ERRORS, safe_error


def dispatch(service,owner,method,payload=None,*,deliver=None):
    try:
        if method=='GET':return 200,{'capability':CAPABILITY,'sources':service.list(owner)}
        if method!='POST' or not isinstance(payload,dict):raise ValueError('source-invalid-request')
        action=payload.get('action')
        if action=='preview' and set(payload)=={'action','selection'}:
            return 200,{'preview':service.preview(owner,payload['selection'])}
        if action=='commit' and set(payload)=={'action','previewId','confirmed'} and payload['confirmed'] is True:
            return 200,{'source':service.commit(owner,payload['previewId'])}
        if action=='enabled' and set(payload)=={'action','sourceId','expectedRevision','enabled'}:
            return 200,{'source':service.set_enabled(owner,payload['sourceId'],payload['expectedRevision'],payload['enabled'])}
        if action=='sync' and set(payload)=={'action','sourceId','expectedRevision'}:
            row=service._row(owner,payload['sourceId'])
            if row['revision']!=payload['expectedRevision']:raise ValueError('source-stale')
            result=service.sync(owner,payload['sourceId'])
            if deliver:deliver(owner,payload['sourceId'])
            return 200,{'source':service._public(service._row(owner,payload['sourceId'])),'readSucceeded':not result['error']}
        raise ValueError('source-invalid-request')
    except (ValueError,OSError) as error:
        code=str(error)
        if code=='source-owner-required':return 403,{'error':code,'message':'此来源属于另一账号，请切回原账号或使用独立安装。'}
        if code=='source-invalid-request':return 400,{'error':code,'message':'来源设置不完整，请检查后重试。'}
        safe=safe_error(error)
        return (409 if code in ('source-stale','source-preview-stale') else 400),{'error':safe,'message':ERRORS[safe]}
