# 版本化单选与多选

旧选择题仍使用选项文本和原答案，保留错后重输流程。新协议放在表格 `学习配置` 列，使用已有 StudyItem schemaVersion 2，不同时提供旧的 `选项` / `答案` 列值。

```json
{"schemaVersion":1,"type":"quiz","selection":"multiple","options":[{"optionId":"A","text":"第一项"},{"optionId":"B","text":"第二项"},{"optionId":"C","text":"第三项","trapType":"out_of_scope","trapExplanation":"原文没有提供该结论。"}],"correctOptionIds":["A","B"]}
```

`selection` 为 `single` 或 `multiple`。选项 2–32 个，每个 `optionId` 为 1–64 个 ASCII 字母、数字、冒号、下划线、点或连字符，且互不重复。文本最长 8000 个 UTF-16 单元。相同显示文本可以有不同 ID。正确 ID 集合必须非空、唯一且引用已有选项；单选只允许一个正确 ID。`isCorrect`、文本答案等第二套答案字段会被拒绝。

可选 `trapType`：`concept_substitution`（偷换概念）、`reverse_causality`（因果倒置）、`overgeneralization`（以偏概全）、`out_of_scope`（过度推论）、`superficial_similarity`（字面相似）。`trapExplanation` 为最多 2000 个 UTF-16 单元的来源解释。文本不可为空或包含控制字符。标签只在选中错误项并提交后展示，不自动推测个人认知习惯。

示例来源表格需使用已有 `zhixue-content` / `zhixue_format: quiz` 与稳定 `zhixue_id`，包含 `ID`、`题干`、`学习配置`，可另加 `解析`。本机索引、账号导出和网页均只使用该配置的选项与答案，旧版本遇到不支持的配置应提示更新，而非忽略字段。

新题先选择再提交；单选可换选，多选按 ID 集合严格比较，少选或多选均为需复习。排除会取消该项选择，重新选择会取消排除。提交冻结答案，查看反馈后只记录一次 good/again。提示请求绑定当时的选择，改选会清除可见旧提示并丢弃迟到回包；已实际展示的辅助记录保留。

题干划选高亮按文本位置保存，可点击或键盘移除，也可全部清除。选择、排除、高亮及提交状态保留在页面内临时草稿，不进入正式学习事件；刷新或关闭不是持久恢复。选项重排按 ID 保持选择。桌面和390px浏览器、实际拖选与键盘操作使用隔离题目验证，未代替用户真实学习或手机硬件验收。
