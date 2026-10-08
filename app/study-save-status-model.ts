export function saveStatusPresentation(state: string): {label: string; attention: boolean} {
  switch (state) {
    case 'applied': return {label: '上次作答已存本机 · 详情', attention: false};
    case 'pending': case 'parent-pending': case 'account-received': case 'received':
      return {label: '上次作答已存本机 · 摘要待同步', attention: false};
    case 'not-saved': return {label: '上次作答已保存，辅助摘要未保存。', attention: true};
    case 'blocked': return {label: '上次作答的辅助摘要写回待处理，原作答仍保留。', attention: true};
    case 'binding-unknown': return {label: '上次作答已保存，摘要来源待核对。', attention: true};
    case 'unsupported': return {label: '上次作答已保存，摘要同步需更新连接服务。', attention: true};
    default: return {label: '上次作答已存本机 · 辅助状态待核对', attention: true};
  }
}
