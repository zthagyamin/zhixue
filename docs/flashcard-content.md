# 双向闪卡与图片遮挡

需要 v1.29.0 或更新版本的网站与 Companion。旧闪卡不需要迁移；新增配置放在 `zhixue_format: flashcard` 表格的 `学习配置` 列。配置只生产题目，不生产学习成绩。

## 双向回忆

```markdown
---
type: zhixue-content
zhixue: true
zhixue_id: biology-cards
zhixue_format: flashcard
status: ready
---
| ID | 正面 | 背面 | 学习配置 |
|---|---|---|---|
| mitochondria | 细胞内主要进行有氧呼吸的细胞器是什么？ | 线粒体 | {"schemaVersion":1,"type":"flashcard","mode":"bidirectional"} |
```

Companion 在建立题目绑定之前展开：正向卡保留原题目和能力 ID；反向卡交换正反面，并得到稳定的独立题目及能力 ID。两者分别排程，重新同步不会增生副本。原卡 ID 不要改名；开启配置会产生新的内容版本，旧事件仍保留原来的内容与身份。

## 图片遮挡

先按 [图表资产规范](authoring/paper-figures.md) 为来源登记 PNG/JPEG。此版本的遮挡卡使用整张图片；不接收任意图片 URL、SVG 或 PDF 遮挡。

`sourceKey` 是学习库内来源文件的正斜杠相对路径经过 UTF-8 / SHA-256 得到的小写十六进制值。例如路径为 `课程/生物.md`，不得使用绝对路径、URI 或 JSON 引号。`sourceVersion` 是来源文件内容的 SHA-256；`assetId`、`assetVersion` 对应 `.figures.json` 中已登记的资产。

把以下 JSON 压为一行填入学习配置；将示例哈希替换为真实值：

```json
{
  "schemaVersion": 1,
  "type": "flashcard",
  "mode": "occlusion",
  "sourceKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sourceVersion": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "assetId": "cell-diagram",
  "assetVersion": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "masks": [
    {"id":"mitochondria","x":"10","y":"20","width":"25.5","height":"12","answer":"线粒体"},
    {"id":"nucleus","x":"60","y":"40","width":"20","height":"15","answer":"细胞核"}
  ]
}
```

坐标是整图百分比的十进制字符串，最多两位小数，区域必须完整位于图片内。每组最多 24 个区域；每个区域 ID 固定、唯一，每个答案最多 2000 个 UTF-16 码元。区域重排不会改变子卡身份；修改区域 ID 会创建新卡。当前问号区域翻面后揭示，其余区域继续不透明遮挡；只有当前答案文字进入可见页面。

图片需要连接原资料库的 Companion；来源或资产版本变化、读取失败时停用揭示与评级，可重试或检查连接。已下载的原图可以被浏览器开发工具检查，因此本功能用于自测，不提供客户端防查看保证。

空格揭示答案，揭示后可用 1–4 对应忘记、困难、良好、极易。输入框、按钮焦点、输入法组合、修饰键或打开的对话框会阻止全局快捷键。

## 内容兼容

展开后的 `parentId`、`direction` 或 `activeMaskId` 由 Companion 生成，不要在来源配置中手工填写。账号快照只接收已展开的 v2 内容；不支持的旧端会拒绝新内容并要求更新，不会静默移除遮挡配置。反向与各区域共用来源追溯，但不共用能力 ID；不会把同一张图一次记熟后自动当作所有区域掌握。
