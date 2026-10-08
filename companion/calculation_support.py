"""Closed, versioned calculation metadata; decimal strings keep content hashes exact."""
import copy
import re
def obj(v,keys):
    if type(v) is not dict or set(v)-set(keys):raise ValueError('invalid-calculation-support')
    return v
def numeric(v):
    if type(v) is not str or not re.fullmatch(r'-?[0-9]{1,6}(?:\.[0-9]{1,6})?',v):raise ValueError('invalid-calculation-decimal')
    return float(v)
def parse_calculation_support(raw):
    v=obj(raw,['schemaVersion','type','mode','variables','domain','tolerance','exploration']);variables=v.get('variables')
    if type(v.get('schemaVersion')) is not int or v['schemaVersion']!=1 or v.get('type')!='calculation' or v.get('mode') not in ('numeric','symbolic') or v.get('domain')!='real' or type(variables) is not list or len(variables)>4 or any(type(x) is not str or not re.fullmatch('[a-zA-Z]',x) for x in variables) or len(set(variables))!=len(variables):raise ValueError('invalid-calculation-support')
    if 'tolerance' in v and not 0<=numeric(v['tolerance'])<=1:raise ValueError('invalid-calculation-tolerance')
    if 'exploration' in v:
        e=obj(v['exploration'],['expression','parameters']);expression=e.get('expression');parameters=e.get('parameters')
        if type(expression) is not str or not expression.strip() or len(expression.encode('utf-16-le'))//2>512 or type(parameters) is not list or not 1<=len(parameters)<=4:raise ValueError('invalid-calculation-exploration')
        ids=set()
        for raw_p in parameters:
            p=obj(raw_p,['id','label','min','max','step','defaultValue']);ident=p.get('id');label=p.get('label')
            if type(ident) is not str or ident not in variables or ident in ids or type(label) is not str or not label.strip() or len(label.encode('utf-16-le'))//2>80:raise ValueError('invalid-calculation-parameter')
            ids.add(ident);lo=numeric(p.get('min'));hi=numeric(p.get('max'));step=numeric(p.get('step'));default=numeric(p.get('defaultValue'))
            if lo>=hi or step<=0 or step>hi-lo or not lo<=default<=hi or (hi-lo)/step>10000:raise ValueError('invalid-calculation-range')
        if len(ids)!=len(variables):raise ValueError('missing-calculation-parameter')
    return copy.deepcopy(v)
