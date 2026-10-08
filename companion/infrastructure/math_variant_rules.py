"""Exact templateVersion 1 port of the four closed browser math templates.

Identity JSON uses insertion order and ECMAScript JSON serialization. No CAS,
caller definition, arbitrary expected answer or general template inference.
"""
import hashlib
import json
from learning_support import _json_stringify, trim_contract_text
from symbolic_math import compare_expressions

FAMILIES={'cancel-domain':'zero-and-division','sqrt-sign':'principal-root',
          'context-linear':'affine-equations','inverse-linear':'affine-equations'}
RANGES={'cancel-domain':{'k':(-8,8),'nonzero':(0,1)},'sqrt-sign':{'x':(-9,9)},
        'context-linear':{'rate':(1,8),'baseline':(0,12),'target':(12,40)},
        'inverse-linear':{'x':(-8,8),'b':(-12,12),'y':(-20,20)}}


def fingerprint(value):
    return hashlib.sha256(_json_stringify(value).encode('utf-8')).hexdigest()


def parameters(template_id, raw):
    limits=RANGES.get(template_id)
    if not limits or type(raw) is not dict or set(raw)!=set(limits):
        raise ValueError('native-math-variant-parameters-invalid')
    for name,(lo,hi) in limits.items():
        if type(raw[name]) not in (int,float) or raw[name] != int(raw[name]) or not lo <= raw[name] <= hi:
            raise ValueError('native-math-variant-parameters-invalid')
    result={key:int(raw[key]) for key in sorted(raw)}
    if template_id=='context-linear' and result['target']<result['baseline']:
        raise ValueError('native-math-variant-parameters-invalid')
    return result


def seeded_parameters(template_id,seed):
    if type(seed) not in (int,float) or not 0 <= seed <= 4294967295 or seed!=int(seed) or template_id not in RANGES:
        raise ValueError('native-math-variant-template-unavailable')
    state=int(seed)
    def take(lo,hi):
        nonlocal state
        state=(state*1664525+1013904223)&0xffffffff
        return lo+state%(hi-lo+1)
    return {name:take(lo,hi) for name,(lo,hi) in RANGES[template_id].items()}


def choice(ident,label):
    return {'id':ident,'label':label}


def define_math(template_id,raw):
    p=parameters(template_id,raw)
    if template_id=='cancel-domain':
        k=p['k']; nonzero=p['nonzero']==1
        return {
            'prompt':f"已知 x 是实数{'且 x ≠ 0' if nonzero else ''}。对等式 x × (x − ({k})) = 0，是否允许不另作分类，直接把两边同除以 x？",
            'domain':'x ∈ R，且 x ≠ 0' if nonzero else 'x ∈ R（包含 0）',
            'answerKind':'allowed' if nonzero else 'not-allowed','answer':'',
            'reference':'题目已排除 x = 0，允许两边同除以非零数。变形合法不等于原等式一定有解。' if nonzero else 'x = 0 也在定义域中，不能直接除以 x。应先区分 x = 0 与 x ≠ 0，再处理各分支。',
            'methodsAccepted':['divide','split-zero'] if nonzero else ['split-zero'],
            'condition':'nonzero' if nonzero else 'includes-zero',
            'transformation':f'x^2-({k})*x','transformationPrompt':'先不做除法，只写原等式左侧展开后的多项式。','variables':['x'],
            'methods':[choice('divide','直接同除以 x'),choice('split-zero','先区分零与非零两种情况')],
            'conditions':[choice('nonzero','题目已保证 x ≠ 0'),choice('includes-zero','题目允许 x = 0')],
        }
    if template_id=='sqrt-sign':
        x=p['x'];negative=x<0
        return {
            'prompt':f'x = {x}。求主平方根 sqrt(x²) 的值。能否在所有实数范围内都直接把 sqrt(x²) 写成 x？先给出本题的数值结果。',
            'domain':f'x 是实数，本题 x = {x}','answerKind':'number','answer':str(abs(x)),
            'reference':f"主平方根非负，sqrt(x²) = |x|。本题 x {'< 0，因此等于 −x' if negative else '≥ 0，因此等于 x'}，结果为 {abs(x)}。这不是对任意变量根式的自动证明。",
            'methodsAccepted':['principal-root'],'condition':'negative' if negative else 'nonnegative',
            'transformation':'-x' if negative else 'x',
            'transformationPrompt':f"现在从本题取值推广到整个符号区间：写出对所有{'负实数' if negative else '非负实数'} x 都成立的 sqrt(x²) 等价表达式，不要只代入刚才那个数。",'variables':['x'],
            'methods':[choice('principal-root','先取绝对值，保持主平方根非负'),choice('drop-root','对任意实数都直接去掉平方和根号')],
            'conditions':[choice('negative','本题 x < 0'),choice('nonnegative','本题 x ≥ 0')],
        }
    if template_id=='context-linear':
        rate=p['rate'];baseline=p['baseline'];target=p['target'];answer=f'({target}-{baseline})/{rate}'
        return {
            'prompt':f'在理想化记录模型中，开始时读数是 {baseline}，之后每分钟净增加 {rate}。变化率保持不变，读数达到 {target} 时经过多少分钟？时间允许是分数。',
            'domain':'时间 t ≥ 0；恒定变化率为正','answerKind':'number','answer':answer,
            'reference':f'读数 = 初始值 + 变化率 × 时间，因此 {target} = {baseline} + {rate}t；t = {answer} 分钟。这里只讨论题目明确给定的理想模型。',
            'methodsAccepted':['linear-model','divide-total'] if baseline==0 else ['linear-model'],
            'condition':'positive-rate','transformation':answer,
            'transformationPrompt':'写出先扣除初始值、再除以变化率的结果表达式。','variables':[],
            'methods':[choice('linear-model','先扣除初始值，再除以变化率'),choice('divide-total','直接用最终读数除以变化率')],
            'conditions':[choice('positive-rate','恒定变化率为正且目标不小于初始值'),choice('unrestricted','无需核对变化率或目标范围')],
        }
    x=p['x'];b=p['b'];y=p['y'];difference=y-b
    answer_kind=('all' if difference==0 else 'none') if x==0 else 'number'
    return {
        'prompt':f'函数关系 f(t) = a × t + ({b})，其中 a 为实数。已知 f({x}) = {y}，反求 a。若条件矛盾或不能唯一确定 a，请明确选择对应结论。',
        'domain':'a ∈ R；代入点与常数均按题目给定','answerKind':answer_kind,
        'answer':f'({difference})/({x})' if answer_kind=='number' else '',
        'reference':('代入后为 0 × a = 0，任意实数 a 都符合条件，不能唯一确定。' if difference==0 else '代入后为 0 × a 等于非零数，条件矛盾，无解。') if x==0 else f'代入并移去常数项得到 {x}a = {difference}。系数 {x} 非零，所以 a = ({difference})/({x})。',
        'methodsAccepted':['inspect-zero'] if x==0 else ['subtract-divide'],
        'condition':'zero-coefficient' if x==0 else 'nonzero-coefficient',
        'transformation':str(difference),'transformationPrompt':'移去常数项后，等式右侧是多少？可以输入等价的数值表达式。','variables':[],
        'methods':[choice('subtract-divide','移去常数项，确认非零后除以系数'),choice('inspect-zero','系数为零，核对剩余条件是否矛盾')],
        'conditions':[choice('nonzero-coefficient','未知量系数非零'),choice('zero-coefficient','未知量系数为零')],
    }


def create_variant(parent,template_id,seed,raw=None):
    seeded=seeded_parameters(template_id,seed)
    parent={key:parent[key] for key in ('parentItemKey','parentContentHash','hashKind')}
    p=parameters(template_id,seeded if raw is None else raw)
    problem={'schemaVersion':1,'templateVersion':1,'templateId':template_id,
        'familyKey':FAMILIES[template_id],'parent':parent,'parameters':p,'definition':define_math(template_id,p)}
    identity={**problem,'seed':seed}
    return {**identity,'variantHash':fingerprint(identity),'exposureKey':fingerprint(problem)}


def grade_variant_final(variant,answer):
    try:
        value=json.loads(answer)
        if type(value) is not dict or set(value)!= {'answerKind','answer'} or type(value['answerKind']) is not str or type(value['answer']) is not str or len(value['answer'])>32000:
            raise ValueError('native-math-variant-input-invalid')
    except (ValueError,TypeError):
        return {'status':'undetermined','source':'deterministic','explanation':'请按本题结论类型提交数值或结论。'}
    rule=define_math(variant['templateId'],variant['parameters'])
    if value['answerKind'] not in ('number','none','all','allowed','not-allowed'):
        final={'verdict':'unknown','explanation':'请先选择结论类型。'}
    elif value['answerKind']!=rule['answerKind']:
        final={'verdict':'wrong','explanation':'结论类型与本题条件不一致，请核对是否有唯一数值结果。'}
    elif rule['answerKind']=='number':
        final=compare_expressions(trim_contract_text(value['answer']),rule['answer'],[])
        if final['verdict']=='unknown':
            final['explanation']='暂不能判定。支持实数多项式、常数平方根和部分三角恒等式；请检查格式、变量与定义域。'
    else:
        final={'verdict':'correct','explanation':'该结论与本题声明的条件一致。'}
    return {'status':{'correct':'correct','wrong':'incorrect','unknown':'undetermined'}[final['verdict']],
        'source':'deterministic','explanation':final['explanation']}
