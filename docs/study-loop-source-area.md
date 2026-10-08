# 知学资料区使用说明

> 当前 Python 代码表格适配已加入工作树，尚未发布或替换正在运行的 Companion。
> 下文 v0.8～v1.0 段落保留历史参考；当前唯一计划在 `01 学习/学习计划/00 学习计划总览.md` 的托管块中。
> `sources/approved/` 的旧 Codex 捕获科目已停用，不应再用于新练习入池。

## Python 代码资料（未发布适配）

使用 `_System/Integrations/Study Loop/sources/` 中的 `type: study-loop-source` Markdown 文件；标题为 `Python 代码题`。
必需列为 `题干`、`初始代码`、`测试代码`、`能力ID`、`来源笔记`、`状态记录`；推荐提供唯一 `条目ID` 和 `主题`，可选 `参考代码` 与 `解析`。
代码换行在单个表格单元中写作字面 `\n`。来源和状态使用 Vault 内 wikilink。服务端不运行代码。

```markdown
---
type: study-loop-source
status: active
domain: python
---
## Python 代码题
| 条目ID | 主题 | 题干 | 初始代码 | 测试代码 | 能力ID | 来源笔记 | 状态记录 |
|---|---|---|---|---|---|---|---|
| python100:d001:add | 加法 | 实现 add | def add(a,b):\n    pass | assert add(1,2) == 3 | python-add | [[项目/Day001]] | [[项目/主页]] |
```

先更新 Companion，再把资料从 `inactive` 改为 `active`，通过“立即扫描 → 核对具体文件 → 批准 → 同步”进入 `Python 练习` 动态科目。
缺少必需字段的代码行直接跳过，不降级为 IELTS 选择题。审批前文件不进入学习池。
当前前端仍优先使用 `abilityId` 作为进度 key；因此同一天使用不同的精确能力 ID，避免两个不同任务共用进度。
代码题在网站执行；不要将部署验证的代答写成学习者的真实掌握证据。

> 让"你今天记的单词出现在知学网站"的最小配置。资料区是用户在 Obsidian 中
> 维护的、专门给知学提供学习资料的位置；你写什么，知学就学什么。

## 1. 配置 Companion（一次）

编辑 `companion/config.local.json`（没有就新建），加入：

```json
{
  "learning_vault_root": "<YOUR_HOME>/Documents/Obsidian Vault"
}
```

- `learning_vault_root` 指向你的 Obsidian 学习 Vault（知学只读取其中的资料区与集成区，不读取其他内容）。
- 重新启动 Companion（`start-companion.cmd`）或点击网站"立即同步"后生效。

## 2. 创建资料区文件

在 Vault 中创建目录与文件：

```
_System/Integrations/Study Loop/sources/知学资料.md
```

内容格式（与学习计划一致的 frontmatter + Markdown 表格）：

```markdown
---
type: study-loop-source
status: active
updated: 2026-08-25
---

# 知学资料

## 词汇

| 单词/词组 | 释义 | 原文语境 | 来源笔记 |
|---|---|---|---|
| pooling layer | 池化层 | Pooling layers in CNNs summarize ... | [[02 项目与研究/论文阅读与复现/起步路线/阅读会话/2026-08-22 AlexNet P2|P2]] |

## 选择题

| 主题 | 题干 | 选项 | 答案 | 解析 |
|---|---|---|---|---|
| CNN 池化 | 相邻池化单元的区域关系是？ | 重叠；不重叠；随机 | 不重叠 | 传统 pooling 相邻单元不重叠 |
```

- **词汇表**列：`单词/词组`、`释义`、`原文语境`、`来源笔记`（wikilink，可跳到论文原文）。
- **选择题表**列：`主题`、`题干`、`选项`（分号分隔）、`答案`、`解析`。
- 每次更新知识库时，把今天不会的单词/条目追加到对应表格即可；`updated` 日期随手更新。
- 重复行自动去重（按内容 hash）；不想要的文件把 `status` 改为 `inactive` 或移出 `sources/`。

## 3. 网站显示

配置并创建文件后，网站在"同步"后会显示"知学资料·词汇"与"知学资料·题目"两个学科，
词卡内容**原样来自你的表格**（不依赖 AI；未配置 DeepSeek Key 也可用）。
词卡带 `sourceNote`，可回到 Obsidian 原文。

## 4. 学习计划（v0.8 确定性调度）

- 确定性调度器 `generateDailyPlan` 依据到期复习、资料池与用户约束生成每日计划候选（纯函数、plan hash）。
- 网站"今日计划"卡：生成候选 → 查看与已批准计划的差异（新增/移除）→ 批准。
- 批准后的计划写入 `_System/Integrations/Study Loop/plan/调度状态/YYYY-MM-DD.md`，
  revision 记录在 `plan/revisions.jsonl`（append-only），不影响你的主学习计划 `01 学习/学习计划/`。
- "计划设置"卡：每日时间、负荷系数、周末节奏、截止日期（用户设置优先于系统估算）。

## 5. 资料变更审批（v0.9）

- 网站"资料变更"卡会检测 `sources/` 的新增/修改/删除/重命名（按内容 hash，重复扫描不产生重复记录）。
- 每条变更可**批准 / 拒绝 / 稍后**；决策记录在审计日志（`source_change_log`），批准后才进入学习流。
- 删除与重命名默认需要人工确认，不会自动删卡或改内容。

## 6. 学习记录与归档（v0.9）

- 复习记录持续写入 `_System/Integrations/Study Loop/events/`（v3 JSONL）与日报；"学习记录/YYYY-MM.md"为派生月度汇总。
- 月度归档：旧月份事件自动/手动归档到 `events/archive/YYYY-MM/`（移动而非删除），原始笔记与主计划不变。

## 7. 资源快照 sources/ 语义（v1.0）

Vault 根目录的 `sources/` 存放获准学习内容的可重建快照（resource snapshot），
与资料区 `_System/Integrations/Study Loop/sources/` 相互独立：

```text
sources/
├── approved/   # 已获准快照（schemaVersion/captureId/itemId/domain/sourceNote/
│               # stateRef/abilityId/contentFingerprint/approvedAt/pluginType/planRevision）
├── pending/    # Codex 推测候选（待用户批准，批准后转入 approved/）
└── rejected/   # 用户拒绝的候选（保留审计）
```

- 网站学习池由 `sources/approved/` 驱动；`current_source`/`next_source` 仅保留兼容读取。
- 每个快照携带与捕获事件相同的 `captureId`，可端到端追溯；同一 `itemId` 重复快照不重复建池。
- 显式负向证据（用户明确"不记得"/答错/依赖提示）直接进复习；推测项只进 `pending/`。

## 8. 边界与安全

- 知学只读取 `sources/`、`plan/` 与 `events/`；不读取你其他笔记，不改写原始课程笔记与主学习计划。
- 云端只收到词条的核心字段与不透明 `stateHandle`，不含本地路径与原文。
- 所有写回端点均要求本机 Companion 会话与已授权来源。
