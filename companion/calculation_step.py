"""Source-authored intermediate expression diagnosis; no process claim or rating."""
from calculation_grade import grade_calculation_reference
from learning_support import parse_learning_support, trim_contract_text
from symbolic_math import compare_expressions


def _diagnosis(status, explanation):
    return {'status': status, 'source': 'deterministic', 'explanation': explanation}


def grade_calculation_step(answer, support):
    try:
        parsed = parse_learning_support(support, 'calculation')
        if parsed['schemaVersion'] != 2 or 'step' not in parsed or type(answer) is not str or not trim_contract_text(answer):
            return _diagnosis('undetermined', '尚未作答可诊断的步骤。')
        step = parsed['step']
        if step['mode'] == 'semantic':
            return _diagnosis('undetermined', '此步骤需要受控服务按来源参考核对语义。')
        if step['mode'] == 'numeric':
            # Reuse exact decimal comparison; numeric mode does not launch a subprocess.
            base = {'schemaVersion': 1, 'type': 'calculation', 'mode': 'numeric', 'variables': [],
                    'domain': 'real', 'tolerance': parsed.get('tolerance', '0.000001')}
            item = {'answer': trim_contract_text(step['reference']), 'learningSupport': base}
            correct = grade_calculation_reference(item, trim_contract_text(answer))['correct']
            if correct is None:
                return _diagnosis('undetermined', '此步骤的数值格式超出当前内核支持范围。')
            return _diagnosis('correct' if correct else 'incorrect', '此步骤的数值与来源参考一致。' if correct else '此步骤的数值与来源参考不一致。')
        result = compare_expressions(answer, step['reference'], parsed['variables'])
        if result['verdict'] == 'wrong' and parsed.get('conditions'):
            return _diagnosis('undetermined', '当前内核不能核对这些附加条件下的表达式差异。')
        if result['verdict'] == 'unknown':
            return _diagnosis('undetermined', '暂不能判定。支持实数多项式、常数平方根和部分三角恒等式；请检查格式、变量与定义域。')
        status = {'unknown': 'undetermined', 'correct': 'correct', 'wrong': 'incorrect'}[result['verdict']]
        return _diagnosis(status, result['explanation'])
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return _diagnosis('undetermined', '此步骤缺少有效的来源参考或超出支持范围。')
