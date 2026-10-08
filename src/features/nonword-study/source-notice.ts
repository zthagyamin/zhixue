/** Preserve the existing source-update copy while the original question remains bound. */
export function sourceUpdateNotice(account: boolean, phase: string, localPending: boolean | undefined) {
    if (account && phase === 'library-changed')
        return '账号学习库已变更；当前题目保留旧版本，作答先保留本机。返回今日确认学习库。';
    if (!account && localPending)
        return '本机资料有更新；当前练习保留原内容，返回今日后应用。';
    return undefined;
}
