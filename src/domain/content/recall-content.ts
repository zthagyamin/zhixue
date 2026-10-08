/** Offline prompts and a read-only compatibility adapter for old recall items.
 * Keep buildRecallPrompt aligned with companion/practice_engine.py.
 * No generated knowledge, content writes, fingerprint changes or fuzzy matching.
 */
export type RecallContent = {
    prompt?: string;
    explanation?: string;
    reviewPoint?: string;
    answer?: string | number;
    sourceLabel?: string;
};
const terminal = /[。.!！?？；;]+$/u;
const taskStart = /^(?:请)?(?:区分|比较|对比|解释|说明|描述|简述|概述|写出|列出|推导|证明|分析|判断|计算|回忆|回答|为什么|为何|如何|什么|怎样)(?!了)/u;
const wrapper = /^(?:换个角度回忆|请闭卷解释|请闭卷回答|请闭卷回忆)\s*[:：]\s*/u;
const legacyPrefix = /^请闭卷解释\s*[:：]\s*/u;
const variantPrefix = /^换个角度回忆\s*[:：]\s*/u;
function key(text: string): string {
    // Preserve case, powers and operators: x² != x2, x+1 != x-1, X != x.
    return text.normalize('NFC').replace(/\s+/gu, ' ').trim().replace(terminal, '');
}
function firstClause(text: string): string {
    const closing: Record<string, string> = { '(': ')', '（': '）', '[': ']', '【': '】', '{': '}' };
    const stack: string[] = [];
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (closing[char])
            stack.push(closing[char]);
        else if (stack.length && char === stack[stack.length - 1])
            stack.pop();
        else if (!stack.length && '；;\n?？'.includes(char))
            return text.slice(0, index + ('？?'.includes(char) ? 1 : 0)).trim();
    }
    return text.trim();
}
function legacyTaskPrompt(point: string): string | null {
    const task=firstClause(point.trim());
    return task && [...task].length<=240 && (taskStart.test(task)||/[?？]$/u.test(task))
        ? `请闭卷回答：${/[?？]$/u.test(task)?task:task.replace(terminal,'')+'。'}` : null;
}
/** Learning-result notes describe abilities, not an authored question/answer pair. */
export function buildRecallPrompt(reviewPoint: string, sourceLabel = ''): string {
    const point=reviewPoint.trim(), task=firstClause(point), label=sourceLabel.trim();
    const safeLabel=label && [...label].length<=60 && !/[\n\r:：；;。.!！?？]/u.test(label) && ![key(point),key(task)].includes(key(label));
    return `阅读材料：${safeLabel?label:'复习记录'}（待补具体问题）`;
}
function generatedPoint(data: RecallContent): string | null {
    let prompt=typeof data.prompt==='string'?data.prompt.trim():'';
    while(variantPrefix.test(prompt))prompt=prompt.replace(variantPrefix,'');
    const point=typeof data.reviewPoint==='string'&&data.reviewPoint.trim()?data.reviewPoint.trim():legacyPrefix.test(prompt)?prompt.replace(legacyPrefix,'').trim():'';
    if(!point)return null;
    const references=[data.explanation,data.answer===undefined?undefined:String(data.answer)].filter(value=>typeof value==='string'&&value.trim());
    const copied=references.length>0&&references.every(value=>typeof value==='string'&&(key(value)===key(point)||['；',';','\n'].some(separator=>value.trim().startsWith(point+separator))));
    if(!copied)return null;
    const old=legacyTaskPrompt(point);
    return (legacyPrefix.test(prompt)&&key(prompt.replace(legacyPrefix,''))===key(point))
        || (old!==null&&key(prompt)===key(old))
        || /^阅读材料：[\s\S]*（待补具体问题）$/u.test(prompt) ? point : null;
}
/** Migration recognition only: never infer useful questions from instructional verbs. */
export function needsConcreteRecallQuestion(data: RecallContent): boolean {
    const prompt=recallPrompt(data).trim().replace(/^(?:换个角度回忆\s*[:：]\s*)+/u,'');
    return generatedPoint(data)!==null || /^阅读材料：[\s\S]*（待补具体问题）$/u.test(prompt)
        || /^请闭卷回忆(?:「[^」]*」|这条复习记录)的核心要点，并说明相关概念、依据或适用条件[。.!！?？]*$/u.test(prompt);
}
/** Stored content and history are unchanged; known generated objectives become reading material. */
export function recallPrompt(data: RecallContent): string {
    const original=typeof data.prompt==='string'?data.prompt:'', point=generatedPoint(data);
    return point===null?original:`${variantPrefix.test(original.trim())?'换个角度回忆：':''}${buildRecallPrompt(point,typeof data.sourceLabel==='string'?data.sourceLabel:'')}`;
}
/** Retain echo filtering against the old question, not the new reading-material label. */
export function recallReferencePrompt(data: RecallContent): string {
    const point=generatedPoint(data);
    return point!==null?legacyTaskPrompt(point)??recallPrompt(data):recallPrompt(data);
}
function withoutWrapper(text: string): string {
    let value = text.trim();
    while (wrapper.test(value))
        value = value.replace(wrapper, '');
    return value.replace(/^(?:参考答案|参考要点|答案|解析)\s*[:：]\s*/u, '');
}
/** Exact normalized echoes are not answers; additional explanatory content is. */
export function isRecallEcho(reference: string, prompt: string): boolean {
    const question = key(withoutWrapper(prompt));
    return Boolean(question) && key(withoutWrapper(reference)) === question;
}
