/** Preserve the existing source-update copy while the original question remains bound. */
export function sourceUpdateNotice(account: boolean, phase: string, localPending: boolean | undefined) {
    if (account && phase === 'library-changed')
        return '账号学习库已变更；当前题目保留旧版本，作答先保留本机。返回今日确认学习库。';
    if (!account && localPending)
        return '本机资料有更新；当前练习保留原内容，返回今日后应用。';
    return undefined;
}

/** Keep protocol diagnostics in evidence; show the learner the useful state. */
export function sourceCodeHintNotice(error:unknown):string{
    const code=error instanceof Error?error.message:'';
    if(/unsupported/u.test(code))return '当前 Companion 尚不支持此提示。';
    if(/unconfigured/u.test(code))return '请先配置 AI 服务。';
    if(/daily-budget/u.test(code))return '当前 AI 额度已用完，请稍后再试。';
    if(/concurrent-budget|call-inflight/u.test(code))return '已有请求正在处理，请稍后再试。';
    if(/receipt-unknown|timeout|receipt-unavailable/u.test(code))return '提示结果尚未收到，代码已保存。';
    if(/source-changed|source-unconfirmed|binding|report|stale/u.test(code))return '来源或运行结果已变化，请重新核对。';
    return '提示暂不可用，原代码和运行记录已保留。';
}
