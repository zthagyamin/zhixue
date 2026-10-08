/** User-facing status only; actual persistence state is owned by the application use case. */
export function attemptFailureMessage(error:unknown,saved:boolean){
    if(saved)return '作答已保存在本机，界面更新未完成。请返回今日后重新进入。';
    if(error instanceof Error&&error.message==='study-attempt-policy-unready')return '提示记录尚未核对，请先恢复记录再提交。';
    if(error instanceof Error&&error.message==='study-attempt-retry-conflict')return '上次作答尚未确认，请恢复原评分和练习模式后重试；不会另记一条成绩。';
    return '作答尚未保存成功，输入已暂留。返回原题可重试，请勿关闭或刷新。';
}
