import type {MathDefinition,MathVariant} from '../../domain/guided-math';
// @ts-expect-error TS5097: standalone Node contracts.
import {defineMath,MATH_TEMPLATES} from '../../domain/guided-math/index.ts';

/** Presentation only: none of these strings are a grading reference or answer. */
export type VariantMathPresentation=Pick<MathDefinition,'prompt'|'domain'|'reference'>;
type Replacement=readonly [plain:string,latex:string];
const math=(latex:string)=>`\\(${latex}\\)`;
const replace=(text:string,pairs:readonly Replacement[])=>pairs.reduce((shown,[plain,latex])=>shown.split(plain).join(latex),text);

function canonical(variant:MathVariant):MathDefinition|null{
    if(variant.schemaVersion!==1||variant.templateVersion!==1||!MATH_TEMPLATES.some(template=>template.id===variant.templateId))return null;
    try{return defineMath(variant.templateId,variant.parameters);}catch{return null;}
}

function project(variant:MathVariant,source:MathDefinition):VariantMathPresentation{
    const p=variant.parameters;
    if(variant.templateId==='cancel-domain')return {
        prompt:replace(source.prompt,[
            [`x × (x − (${p.k})) = 0`,math(`x \\times (x - (${p.k})) = 0`)],
            ['x 是实数',`${math('x')} 是实数`],['x ≠ 0',math('x \\ne 0')],['同除以 x',`同除以 ${math('x')}`],
        ]),
        domain:replace(source.domain,[['x ∈ R',math('x \\in \\mathbb{R}')],['x ≠ 0',math('x \\ne 0')],['包含 0',`包含 ${math('0')}`]]),
        reference:replace(source.reference,[['x = 0',math('x = 0')],['x ≠ 0',math('x \\ne 0')],['除以 x',`除以 ${math('x')}`]]),
    };
    if(variant.templateId==='sqrt-sign')return {
        prompt:replace(source.prompt,[[`x = ${p.x}`,math(`x = ${p.x}`)],['sqrt(x²)',math('\\sqrt{x^{2}}')],['写成 x',`写成 ${math('x')}`]]),
        domain:replace(source.domain,[['x 是实数',`${math('x')} 是实数`],[`x = ${p.x}`,math(`x = ${p.x}`)]]),
        reference:replace(source.reference,[
            ['sqrt(x²) = |x|',math('\\sqrt{x^{2}} = \\lvert x\\rvert')],
            ['x < 0',math('x < 0')],['x ≥ 0',math('x \\ge 0')],
            ['等于 −x',`等于 ${math('-x')}`],['等于 x',`等于 ${math('x')}`],
            [`结果为 ${Math.abs(p.x)}`,`结果为 ${math(String(Math.abs(p.x)))}`],
        ]),
    };
    if(variant.templateId==='context-linear')return {
        prompt:replace(source.prompt,[
            [`开始时读数是 ${p.baseline}`,`开始时读数是 ${math(String(p.baseline))}`],
            [`每分钟净增加 ${p.rate}`,`每分钟净增加 ${math(String(p.rate))}`],
            [`读数达到 ${p.target}`,`读数达到 ${math(String(p.target))}`],
        ]),
        domain:replace(source.domain,[['t ≥ 0',math('t \\ge 0')]]),
        reference:replace(source.reference,[
            ['读数 = 初始值 + 变化率 × 时间',math('\\text{读数} = \\text{初始值} + \\text{变化率} \\times \\text{时间}')],
            [`${p.target} = ${p.baseline} + ${p.rate}t`,math(`${p.target} = ${p.baseline} + ${p.rate}t`)],
            [`t = (${p.target}-${p.baseline})/${p.rate}`,math(`t = \\frac{${p.target}-${p.baseline}}{${p.rate}}`)],
        ]),
    };
    return {
        prompt:replace(source.prompt,[
            [`f(t) = a × t + (${p.b})`,math(`f(t) = a \\times t + (${p.b})`)],
            ['a 为实数',`${math('a')} 为实数`],[`f(${p.x}) = ${p.y}`,math(`f(${p.x}) = ${p.y}`)],['反求 a',`反求 ${math('a')}`],
        ]),
        domain:replace(source.domain,[['a ∈ R',math('a \\in \\mathbb{R}')]]),
        reference:replace(source.reference,p.x===0?[
            ['0 × a = 0',math('0 \\times a = 0')],['0 × a',math('0 \\times a')],['任意实数 a',`任意实数 ${math('a')}`],
        ]:[
            [`${p.x}a = ${p.y-p.b}`,math(`${p.x}a = ${p.y-p.b}`)],
            [`系数 ${p.x}`,`系数 ${math(String(p.x))}`],
            [`a = (${p.y-p.b})/(${p.x})`,math(`a = \\frac{(${p.y-p.b})}{(${p.x})}`)],
        ]),
    };
}

/** Only exact fields of a known bounded template acquire display delimiters.
 * Customized source, older partial mocks and unknown versions remain verbatim. */
export function presentMathVariant(variant:MathVariant):VariantMathPresentation{
    const original={prompt:variant.definition.prompt,domain:variant.definition.domain,reference:variant.definition.reference};
    const source=canonical(variant);
    if(!source)return original;
    const shown=project(variant,source);
    return {
        prompt:original.prompt===source.prompt?shown.prompt:original.prompt,
        domain:original.domain===source.domain?shown.domain:original.domain,
        reference:original.reference===source.reference?shown.reference:original.reference,
    };
}

/** Complete known reference text only; never infer formulas from arbitrary feedback.
 * Code and existing mathematical markup are preserved, including open fences. */
export function formatVariantMathFeedback(variant:MathVariant,text:string,correct?:boolean|null):string{
    const rule=canonical(variant);
    if(correct===true&&text==='在声明的实数域内，两式等价。'&&rule?.answerKind==='number'
        &&variant.definition.answerKind===rule.answerKind&&variant.definition.answer===rule.answer){
        return '本题数值结果与参考一致。'+(variant.templateId==='sqrt-sign'?'这里只核对当前取值，未验证对所有实数成立的恒等关系。':'');
    }
    const reference=variant.definition.reference,shown=presentMathVariant(variant).reference;
    if(!reference||reference===shown)return text;
    const protectedSpans=/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|\$\$[\s\S]*?(?:\$\$|$)|\\\[[\s\S]*?(?:\\\]|$)|\\\([\s\S]*?(?:\\\)|$)|\$[^$\n]*(?:\$|(?=\n)|$)|`[^`\n]*(?:`|(?=\n)|$))/g;
    return text.split(protectedSpans).map((piece,index)=>index%2===0?piece.split(reference).join(shown):piece).join('');
}
