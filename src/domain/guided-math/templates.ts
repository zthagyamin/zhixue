export type TemplateId = 'cancel-domain' | 'sqrt-sign' | 'context-linear' | 'inverse-linear';
export type AnswerKind = 'number' | 'none' | 'all' | 'allowed' | 'not-allowed';
export type Choice = {id:string;label:string};
export type MathDefinition = {
    prompt:string;domain:string;answerKind:AnswerKind;answer:string;reference:string;
    methodsAccepted:string[];condition:string;transformation:string;transformationPrompt:string;variables:string[];
    methods:Choice[];conditions:Choice[];
};
export const MATH_TEMPLATES = [
    {id:'cancel-domain',familyKey:'zero-and-division',title:'换条件：什么时候能约去 x？',purpose:'判断变形所需的非零条件'},
    {id:'sqrt-sign',familyKey:'principal-root',title:'找反例：平方根与正负号',purpose:'用明确取值区分 x 与 |x|'},
    {id:'context-linear',familyKey:'affine-equations',title:'新情境：从记录反求时间',purpose:'从背景值和变化率建立线性关系'},
    {id:'inverse-linear',familyKey:'affine-equations',title:'逆向题：由函数值反求系数',purpose:'区分唯一解、无解与系数不唯一'},
] as const;
const choice=(id:string,label:string):Choice=>({id,label});
const value=(parameters:Record<string,number>,name:string,min:number,max:number)=>{
    const number=parameters[name];
    if(!Number.isSafeInteger(number)||number<min||number>max)throw Error('invalid-template-parameters');
    return number;
};

/** Seed is an explicit reproducibility input, never ambient randomness or time. */
export function seededParameters(id:TemplateId,seed:number):Record<string,number>{
    let state=seed>>>0;
    const take=(min:number,max:number)=>{
        state=(Math.imul(state,1664525)+1013904223)>>>0;
        return min+state%(max-min+1);
    };
    if(id==='cancel-domain')return {k:take(-8,8),nonzero:take(0,1)};
    if(id==='sqrt-sign')return {x:take(-9,9)};
    if(id==='context-linear')return {rate:take(1,8),baseline:take(0,12),target:take(12,40)};
    return {x:take(-8,8),b:take(-12,12),y:take(-20,20)};
}

/** Closed, bounded definitions. Every changed parameter is part of the stated problem. */
export function defineMath(id:TemplateId,p:Record<string,number>):MathDefinition{
    const keys=id==='cancel-domain'?['k','nonzero']:id==='sqrt-sign'?['x']:id==='context-linear'?['rate','baseline','target']:['x','b','y'];
    if(Object.keys(p).length!==keys.length||Object.keys(p).some(key=>!keys.includes(key)))throw Error('invalid-template-parameters');
    if(id==='cancel-domain'){
        const k=value(p,'k',-8,8),nonzero=value(p,'nonzero',0,1)===1;
        return {
            prompt:`已知 x 是实数${nonzero?'且 x ≠ 0':''}。对等式 x × (x − (${k})) = 0，是否允许不另作分类，直接把两边同除以 x？`,
            domain:nonzero?'x ∈ R，且 x ≠ 0':'x ∈ R（包含 0）',
            answerKind:nonzero?'allowed':'not-allowed',answer:'',
            reference:nonzero?'题目已排除 x = 0，允许两边同除以非零数。变形合法不等于原等式一定有解。':'x = 0 也在定义域中，不能直接除以 x。应先区分 x = 0 与 x ≠ 0，再处理各分支。',
            methodsAccepted:nonzero?['divide','split-zero']:['split-zero'],condition:nonzero?'nonzero':'includes-zero',
            transformation:`x^2-(${k})*x`,transformationPrompt:'先不做除法，只写原等式左侧展开后的多项式。',variables:['x'],
            methods:[choice('divide','直接同除以 x'),choice('split-zero','先区分零与非零两种情况')],
            conditions:[choice('nonzero','题目已保证 x ≠ 0'),choice('includes-zero','题目允许 x = 0')],
        };
    }
    if(id==='sqrt-sign'){
        const x=value(p,'x',-9,9),negative=x<0;
        return {
            prompt:`x = ${x}。求主平方根 sqrt(x²) 的值。能否在所有实数范围内都直接把 sqrt(x²) 写成 x？先给出本题的数值结果。`,
            domain:`x 是实数，本题 x = ${x}`,answerKind:'number',answer:String(Math.abs(x)),
            reference:`主平方根非负，sqrt(x²) = |x|。本题 x ${negative?'< 0，因此等于 −x':'≥ 0，因此等于 x'}，结果为 ${Math.abs(x)}。这不是对任意变量根式的自动证明。`,
            methodsAccepted:['principal-root'],condition:negative?'negative':'nonnegative',transformation:negative?'-x':'x',
            transformationPrompt:`现在从本题取值推广到整个符号区间：写出对所有${negative?'负实数':'非负实数'} x 都成立的 sqrt(x²) 等价表达式，不要只代入刚才那个数。`,variables:['x'],
            methods:[choice('principal-root','先取绝对值，保持主平方根非负'),choice('drop-root','对任意实数都直接去掉平方和根号')],
            conditions:[choice('negative','本题 x < 0'),choice('nonnegative','本题 x ≥ 0')],
        };
    }
    if(id==='context-linear'){
        const rate=value(p,'rate',1,8),baseline=value(p,'baseline',0,12),target=value(p,'target',12,40);
        if(target<baseline)throw Error('invalid-template-parameters');
        const answer=`(${target}-${baseline})/${rate}`;
        return {
            prompt:`在理想化记录模型中，开始时读数是 ${baseline}，之后每分钟净增加 ${rate}。变化率保持不变，读数达到 ${target} 时经过多少分钟？时间允许是分数。`,
            domain:'时间 t ≥ 0；恒定变化率为正',answerKind:'number',answer,
            reference:`读数 = 初始值 + 变化率 × 时间，因此 ${target} = ${baseline} + ${rate}t；t = ${answer} 分钟。这里只讨论题目明确给定的理想模型。`,
            methodsAccepted:baseline===0?['linear-model','divide-total']:['linear-model'],condition:'positive-rate',transformation:answer,
            transformationPrompt:'写出先扣除初始值、再除以变化率的结果表达式。',variables:[],
            methods:[choice('linear-model','先扣除初始值，再除以变化率'),choice('divide-total','直接用最终读数除以变化率')],
            conditions:[choice('positive-rate','恒定变化率为正且目标不小于初始值'),choice('unrestricted','无需核对变化率或目标范围')],
        };
    }
    const x=value(p,'x',-8,8),b=value(p,'b',-12,12),y=value(p,'y',-20,20),difference=y-b;
    const answerKind:AnswerKind=x===0?(difference===0?'all':'none'):'number';
    return {
        prompt:`函数关系 f(t) = a × t + (${b})，其中 a 为实数。已知 f(${x}) = ${y}，反求 a。若条件矛盾或不能唯一确定 a，请明确选择对应结论。`,
        domain:'a ∈ R；代入点与常数均按题目给定',answerKind,answer:answerKind==='number'?`(${difference})/(${x})`:'',
        reference:x===0?(difference===0?'代入后为 0 × a = 0，任意实数 a 都符合条件，不能唯一确定。':'代入后为 0 × a 等于非零数，条件矛盾，无解。'):`代入并移去常数项得到 ${x}a = ${difference}。系数 ${x} 非零，所以 a = (${difference})/(${x})。`,
        methodsAccepted:x===0?['inspect-zero']:['subtract-divide'],condition:x===0?'zero-coefficient':'nonzero-coefficient',
        transformation:String(difference),transformationPrompt:'移去常数项后，等式右侧是多少？可以输入等价的数值表达式。',variables:[],
        methods:[choice('subtract-divide','移去常数项，确认非零后除以系数'),choice('inspect-zero','系数为零，核对剩余条件是否矛盾')],
        conditions:[choice('nonzero-coefficient','未知量系数非零'),choice('zero-coefficient','未知量系数为零')],
    };
}
