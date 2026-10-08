# Agent 写回协议（Learning Result Card Write-back Protocol）

> 适用对象：所有学习型 agent（Codex、DeepSeek Harness/DSH 等，不限于某一种）。
> 本协议是"学习结果卡"自动化闭环的起点：**agent 学习会话收尾时写/更新学习结果卡，网站据此自动出题**（`GET /v1/practice`），无需手动导入。
> 规范出处：`docs/superpowers/specs/2026-08-26-unified-practice-engine-design.md` §4.1、§4.4。

## 一、学习会话收尾三步（必须全部执行，缺一步自动化即断链）

1. **写回权威状态**：把本次学习结果写回权威状态文件（learning-state / 掌握检测），沿用既有流程（含证据、错因、复习要点更新），Companion 侧不做覆盖。
2. **写/更新学习结果卡**：为每个**需复习或已暴露薄弱的能力点**，在 `01 学习/学习结果/` 下写或更新一张学习结果卡（格式见下方 §二）。字段：`type`/`domain`/`item_id`/`ability_id`/`status`/`review_date`/`review_enabled`/`source_note`/`state_ref`，正文只放 `## 复习要点`（≤5 条）。
3. **不在卡内复制正文**：复习要点是**从原笔记提炼的结论**（非粘贴），能力检查点表、检测记录、讲解长文等叙述内容一律留在原文件，学习结果卡只登记"调度字段 + 复习要点"，防冗余。

> 写卡即自动触发：网站练习引擎按 `review_date <= 今天` 且 `review_enabled = true` 出题；判题后 Companion 自动写回 `review_date` 与卡内队列托管块（`%% ZHIXUE:REVIEW-QUEUE:BEGIN %%` … `END %%`），**agent 不要手改托管块**，只维护正文与 frontmatter。

## 二、学习结果卡格式（完整模板）

新目录 `01 学习/学习结果/*.md`，**一卡一个能力点**（item_id + ability_id 唯一）：

```markdown
---
type: learning-result
domain: course                 # course | ielts | python | paper | project | 自定义
item_id: cs231n-l6-norm        # 稳定唯一标识，见 FAQ
ability_id: norm-purpose       # 该卡对应的具体能力点
status: active                 # active | paused（可选，默认 active）
review_date: 2026-08-18        # YYYY-MM-DD，下一次复习日，见 FAQ
review_enabled: true           # true | false；false = 暂停出题
plugin_hint: recall            # 建议题型 quiz|recall|calculation|code（可选，规则可覆盖）
source_note: "[[01 学习/专项课程/Stanford CS231n/课程笔记/第06讲 CNN架构与训练]]"
state_ref: "[[01 学习/专项课程/Stanford CS231n/学习记录/第06讲 学习状态]]"
---

# L6 · 归一化作用

复习要点：
- 归一化解决每层信号失控→梯度不稳；γ 缩放、β 平移
- 常见错误：误答为"治过拟合"
```

### 硬性规则

| 规则 | 说明 |
|---|---|
| 位置 | 必须位于 `01 学习/学习结果/*.md`，解析器只扫该目录的 `*.md` |
| `type` | 必须为 `learning-result`，否则该卡不参与出题 |
| 复习要点 ≤5 条 | 每条是一个可独立出题的能力结论；全部为 `- ` 无序列表，紧跟 `复习要点：` 标题（支持 `#`/`##` 前缀） |
| 双向链接 | `source_note` / `state_ref` 必须用 `[[...]]` 指向**实际存在的**原始资料笔记（课程笔记、论文、资料库条目等），Obsidian 据此形成 Backlink；Companion 校验链接目标文件存在，链接断了写回会失败 |
| 不复制正文 | 复习要点提炼而非粘贴；检查点表、检测记录、长讲解留在原文件 |
| 命名稳定 | `item_id` 与 `ability_id` 一经建立不要随意改名（卡匹配、队列去重、状态句柄都依赖它） |

## 三、FAQ

**Q1：`domain` 取值有哪些？**
`course`（专项课程）｜`ielts`（英语）｜`python`（编程）｜`paper`（论文阅读）｜`project`（项目）｜自定义任意学科名。
domain 由**学习结果卡自己声明**，调度器使用条目自带 domain、**不做前缀猜测**；新学科接入 = 写一张声明了 domain 的学习结果卡，无需改代码。

**Q2：`item_id` 怎么命名？**
稳定、唯一、可读，建议格式 `<来源>-<单元>-<能力>`，如 `cs231n-l6-norm`（课程 + 第 6 讲 + 归一化）。网站侧练习条目的标识为 `practice:{itemId}`（如 `practice:cs231n-l6-norm`），写回时自动归一化匹配，无需一致格式，但**命名后不要随意变更**。

**Q3：`review_date` 的语义？**
下一次复习日期（`YYYY-MM-DD`，本地日期）。出题条件：`review_date <= 今天` 且 `review_enabled = true`。
判题写回时由 Companion 调度器自动推进（again +1 天 / hard +3 天 / good +7 天 / easy +14 天），并同步更新卡内队列托管块。新卡建议 `review_date` 设为今天（立即进入复习）或首个计划复习日；`review_enabled: false` 可暂停出题（队列清空时写回会自动置 false）。

**Q4：旧 learning-state / assessment 怎么办？（迁移）**
双读兼容按**能力点合并**：网站先读取学习结果卡，再补入仍未迁移的旧 learning-state（v1.0.2 解析）/assessment 复习项；不会因为目录里出现第一张卡就隐藏其余旧队列。同一能力按 `item_id`、`ability_id`，或标准化后的 `state_ref + 复习点` 去重，以学习结果卡为准，旧文件中的匹配条目视为"已迁移"。迁移已存在的条目时，应优先沿用旧条目的稳定 `item_id` / `ability_id`。
迁移策略：**渐进迁移，不做一次性批量**——agent 在后续学习会话中把活跃复习项陆续迁移成学习结果卡（提炼复习要点），迁移一项清一项，旧条目归档 `_Archive`（归档 ≠ 删除，任何情况下都不得删除文件）；迁移期间网站持续双读，不中断。

**Q5：一个会话有多个能力点怎么办？**
一个能力点一张卡，全部写在同一目录下；每个需要复习或暴露薄弱的能力点都走"三步收尾"，缺一不可。

**Q6：判题/写回之后我还要做什么？**
什么都不用做。判题事件（v3 `practice-attempt`）经 Companion 路由后自动更新卡内 `review_date`、`review_enabled` 与 `%% ZHIXUE:REVIEW-QUEUE %%` 托管块。agent 只负责：写权威状态、写/更新学习结果卡（frontmatter + 复习要点 + 双向链接）、不复制正文。
