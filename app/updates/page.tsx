/* eslint-disable @next/next/no-html-link-for-pages -- Match the native navigation used by the public homepage; Vinext Link fails in the deployed runtime. */
import announcements from '../release-announcements.json';
import '../release-support.css';

const experienceUpdate = {
  version: '', date: '2026-09-14', title: '先试学，再找回材料继续练',
  changes: [
    '自己的笔记可直接试学三题，无需安装；新手教学提供直接入口。',
    '完成后按学科保存到本机待学材料，学科列表支持搜索和重新练习；仅保存在当前浏览器。',
    '试学可标记困难题并只练标记题，再练标记不计入正式成绩。',
    '手机论文阅读优先展示正文，更换和上传材料按需展开。',
    '公告和帮助页恢复首页跳转，帮助补充本机材料找回说明。',
  ],
};
const webUpdate = {
  version: '', date: '2026-10-25', title: '续学、进度与布局修复',
  changes: [
    '待核对队列中，未提交的草稿保留题干和续学入口，提交后可查看完整参考。',
    '进度卡显示具体任务；同一学科有多个任务时，可切换查看各自的完成情况。',
    '论文保留最后选读的材料、段落位置和连续阅读范围；续读位置保存在当前浏览器。',
    '学习清单遵循手动选择的页面布局；键盘进入和退出练习时，焦点接续到对应内容和入口。',
    '复习入口改为“准备复习候选”，更新历史按日期从新到旧排列。已有学习记录保留。',
  ],
};
const reliabilityUpdate = {
  version: '', date: '2026-10-27', title: '保存可重试，接入与按钮反馈更可靠',
  changes: [
    '论文保存失败后可在原页重试同一次操作；遇到版本冲突时分别保留已保存回答和本页未保存输入。',
    '多选题漏选但没有错选时记为部分正确，继续与补练沿用首轮的困难评级。',
    '配对期间保护正在进行的请求，重复点击不会打断已发送的配对；资料接入快捷入口正确打开连接区域。',
    'AI 状态与同步统计独立核对，配置入口统一；扫描的未连接、成功和失败状态在资料页面说明。',
    '选择题反馈接续键盘焦点，题内追问失败可被通知，论文来源页签支持方向键。已有答案与学习记录保留。',
  ],
};
const learningFlowUpdate = {
  version: '', date: '2026-10-28', title: '结束状态更准确，续学和同步更清楚',
  changes: [
    '提前结束、空题和题组恢复未完成分别说明；结束摘要保留待核对与跳过数量，不把本轮结束当作任务完成。',
    '今日与结束页可直接查看同步详情，区分账号接收和学习库写回；关闭详情后保留原练习和焦点。',
    '进行中任务显示对应学科与已核实进度；没有计划时，可从已核对的最近作答返回学科。',
    '计划草稿按实际执行显示生成阶段；自动准备的来源有据可查，AI 建议与确认生效分别说明。',
    '词库组、当前步骤和本组完成数分别显示；到期回忆核对不再伪装为逐步完成三个阶段。已有答案和学习记录保留。',
  ],
};
const history = [...announcements, experienceUpdate, webUpdate, reliabilityUpdate, learningFlowUpdate].sort((a, b) => b.date.localeCompare(a.date));

export default function UpdatesPage() {
  return <main className="support-page">
    <nav><a href="/">首页</a><a href="/study">学习工作台</a><a href="/help">帮助</a></nav>
    <h1>知学更新公告</h1>
    <p>每次更新的变化都留在这里，按时间从新到旧排列，方便随时回看。公告不会在公开页面自动弹出。首次进入学习页不自动弹出公告；已使用过的用户遇到新版本时，只会在空闲且没有其他弹窗时提示。你也可以在“设置 → 维护与公告 → 产品更新日志”主动查看本次公告。</p>
    {history.map(entry => <article className="release-history-entry" id={entry.version ? `v${entry.version}` : undefined} key={entry.version || entry.title}>
      <p>{entry.version ? `v${entry.version} · ` : '体验改进 · '}<time dateTime={entry.date}>{entry.date}</time></p>
      <h2>{entry.title}</h2>
      <ul>{entry.changes.map(change => <li key={change}>{change}</li>)}</ul>
    </article>)}
    <h2>更新前的小检查</h2>
    <p>请先确认当前作答已保存，再手动刷新。有待同步记录时保留浏览器数据；重要学习数据可从设置导出恢复包。</p>
  </main>;
}
