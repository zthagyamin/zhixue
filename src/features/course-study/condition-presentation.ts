/** Display deduplication only. The complete captured conditions remain in the task and disclosure. */
export function conditionInPrompt(prompt: string, condition: string): boolean {
    if (/(?:不是|并非|不要|不能|不可|未满足|无法|不成立|\bnot\b)/iu.test(prompt)) return false;
    const text = condition.trim().replace(/[。.!！]$/u, '');
    if (!text) return false;
    if (prompt.startsWith(`在 ${text} 时`)) return true;
    // The authored consistency question expresses the pair as "one / another".
    // Remove only that repeated grammatical subject; every condition must still match literally.
    const prefix = '两条需求针对';
    return text.startsWith(prefix) && prompt.includes('一条需求') && prompt.includes('另一条')
        && prompt.startsWith(`${text.slice(prefix.length)}时，`);
}
