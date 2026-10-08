# 学习计划.base 派生视图定义（v1.0）

> `学习计划.base` 是可重建的**派生查询视图**，不是第二套计划。唯一计划权威始终是
> `01 学习/学习计划/00 学习计划总览.md` 的 ZHIXUE 托管区；本文件说明 Base 视图如何从权威数据重建。

## 1. 定位

- **不是权威**：Base 只读取、不写入计划。删除或修改 Base 文件不影响计划与调度。
- **可重建**：网站今日面板、数据库缓存、`学习计划.base` 均可由 `00 学习计划总览.md`
  托管区与获准快照重新生成。
- **托管区**：`%% ZHIXUE:CURRENT-PLAN:BEGIN %% … %% ZHIXUE:CURRENT-PLAN:END %%`
  之间的内容由 Companion 与获授权 Agent 独占管理；用户控制区与说明导航区不受影响。

## 2. 数据来源

| Base 视图 | 来源 |
|---|---|
| 当前学习计划 | 托管区"当前学习计划"（当日计划表格） |
| 知识缺口与到期复习 | 托管区"知识缺口与到期复习"条目（`- [ ]` + 字段行） |
| 已获准学习内容 | `sources/approved/*.json` 获准快照 |
| 待批准候选 | `sources/pending/*.json` 与资料变更候选（网站审批） |

## 3. 条目字段（与实现 schema 一致）

快照条目字段（`companion/snapshot_schema.py` 的 `REQUIRED_FIELDS`，camelCase）：

- `captureId` —— 与捕获事件共享的稳定 ID（端到端追溯）
- `itemId` —— 稳定学习项 ID（计划/快照/调度共用，去重键之一）
- `domain` —— 领域标签（ielts / python / course / project 等）
- `sourceNote` —— 来源笔记相对路径（只证明来源）
- `stateRef` —— 学习状态笔记相对路径（与 `abilityId` 一起定位正式状态）
- `abilityId` —— FSRS 能力 ID
- `contentFingerprint` —— 内容指纹（去重与变更检测）
- `approvedAt` —— 批准时间（ISO-8601 UTC）
- `pluginType` —— 捕获插件类型（three-stage / quiz / code 等）
- `planRevision` —— 所属计划修订号

## 4. 建议视图（在 Obsidian 中创建 `学习计划.base`）

- **到期复习视图**：来源=托管区复习条目，筛选 `due <= today`，按 `due` 升序。
- **获准内容视图**：来源=`sources/approved/`，展示 `itemId`、`domain`、`pluginType`、`approvedAt`。
- **候选视图**：来源=`sources/pending/`，展示待用户决策的推测项。

字段若与上方 schema 不一致，以 `companion/snapshot_schema.py` 与托管区实际渲染为准。
