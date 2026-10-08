# 今日学习与学科目标接入契约

开发协议：gateway schema 1、TaskPlanV2、Companion capability `task-planning-v1`。这是隔离开发结果，不代表已发布或已迁移真实学习库。

## 日常规则

- 每天全局20个**新词**；到期/逾期复习另列必做，不挤占20词。昨日未完成的新词优先续学，仍占今天20词，不累加成40词。
- 单词用明确语言与 NFKC/去首尾空格归一；英语忽略大小写，不猜测词干。缺语言、缺历史或来源矛盾会显示待确认，不冒充新词。
- 明确学科指标按 daily/weekly/deadline 与对应完成证据安排。没有指标时，显式生成默认请求AI建议，最多3项、每学科最多1项；“多安排一点”再扩展最多3项。
- AI只能选择目录中的已有单元，不能编造课程。未配置Key或服务失败明确降级，必做层仍可用；时长仅参考，不要求每天固定分钟数。
- 手动添加、换词、排序及已开始/已完成任务会保留。“少安排一点”只移除尚未开始的可选建议。自由学习始终可用。
- 任务完成、自报与练习证据都不自动改成正式掌握。一天按 Asia/Shanghai 划分。

## 固定索引与学科所有权

总入口：`_System/Integrations/Study Loop/gateway/index.md`；学科索引：该目录的 `subjects/<subject_id>.md`。原文、目标表、正式状态和练习记录仍在各自学科下；索引使用引用，不复制原始资料。

在学科索引 frontmatter 添加（合并字段，不覆盖原索引）：

```yaml
language: en
planning_ref: "[[subjects/english/目标与单元]]"
```

`language` 是词库明确语言，不是界面语言；仅在确认后填写。新增学科可通过现有 `gateway_cli.py --vault <vault> add-subject ... --language en` 显式登记。未知语言不根据字母外观推断。

已登记目录中，已有支持格式的合规内容自动收录；新增学科登记一次即可。**不是任意格式都自动适配**：全新练习插件、协议或完成规则仍需升级。首次使用本协议需要升级Companion；以后正常添加学科/内容/指标通常只改知识库数据。

## 最小目标与单元示例

在学科内创建 `subjects/english/目标与单元.md`，先确保示例的来源路径真实存在：

```markdown
---
planning_schema_version: 1
---
# 阅读目标与学习单元

| goal_id | title | target_kind | target_count | unit_ids | start_on | due_on | priority | required | completion_basis |
|---|---|---|---|---|---|---|---|---|---|
| reading-daily | 每天阅读一个单元 | daily | 1 | reading-1,reading-2 | 2026-08-31 | | 3 | true | self-report |

| unit_id | title | content_ref | state_ref | ability_id | order | prerequisites | action | completion_rule |
|---|---|---|---|---|---|---|---|---|
| reading-1 | 阅读第一节 | [[subjects/english/阅读/第一节]] | | | 1 | | open-note | self-report |
| reading-2 | 阅读第二节 | [[subjects/english/阅读/第二节]] | | | 2 | reading-1 | open-note | self-report |
```

此处名称仅示例，不自动生成学习指标或原始内容。自然语言“每天多学一点”不会转换为硬指标。没有目标表时，兼容目录单元仍可作为AI候选。

`goal_id/unit_id` 在学科内稳定；跨学科依赖用 `subject_id:unit_id`。同一表字段齐全，`unit_ids/prerequisites` 以英文逗号分隔。允许只有跨学科目标而没有本地单元，但所有引用与前置关系必须有效、无环。

`target_kind` 支持 `daily/weekly/deadline`，`target_count` 为正整数，`priority` 为1–5，`required` 为 `true/false`。`start_on` 必填，deadline 还需 `due_on`。停用、归档、缺失或歧义来源会给出诊断，不偷偷按无指标处理。引用支持库内明确路径、wikilink及Markdown链接；不会扫描未登记的全库目录。

| completion_rule | action | 证据边界 |
|---|---|---|
| self-report | open-note | 独立 TaskEventV1 自报，不写正式掌握 |
| three-stage | practice | 三阶段词汇事件；不能用于题目 |
| graded-practice | practice | 题目/练习事件；不能用于词汇 |
| formal-mastered | open-note 或兼容 practice | `state_ref` 指向 learning-state/review 的 `mastery: mastered` |
| formal-done | open-note 或兼容 practice | `state_ref` 指向 project/paper-note 的 `status: done` |
| formal-completed-reference | open-note 或兼容 practice | `state_ref` 指向 course/course-home 的 `status: completed-reference` |

目标的 `completion_basis` 独立支持 `practice-round/self-report/formal-state`。正式规则必须显式引用正式状态；网站勾选不能替代它。practice 单元必须解析到已登记的具体题目/词汇，不允许用任意原文冒充可练习题目。

单元 `title` 是简短规划标签，可能发送给AI；不要把答案、整段材料或隐私写进去。AI接收受限标签/短ID/数量/进度摘要，不读取原始资料正文、路径或密钥。

## 预览、应用与恢复

提案JSON为数组，每学科最多一条；字段严格限定：

```json
[
  {"subjectId":"english","language":"en"},
  {"subjectId":"course","planningPath":"subjects/course/目标与单元.md","planningContent":"这里放上面两张目标/单元表的完整Markdown"}
]
```

示例占位正文不是有效提案；必须替换为有真实引用的完整表。`planningPath/planningContent` 必须成对；language可单独迁移，不创建学习指标。

```powershell
python -X utf8 -B scripts/prepare-task-planning.py --vault <vault> --proposals <proposals.json> --manifest <new-preview.json>
# 检查 manifest 内精确 targets/content/beforeHash/afterHash/sourceHashes 后，单独批准：
python -X utf8 -B scripts/prepare-task-planning.py --vault <vault> --apply --manifest <preview.json> --backup-root <outside-vault-backups>
# 用 apply 返回的具体 backupRoot 恢复，不是父目录：
python -X utf8 -B scripts/prepare-task-planning.py --vault <vault> --rollback --backup-root <returned-backupRoot>
```

预览manifest必须在Vault外且是新文件；预览本身不改Vault。应用校验提案、原始字节与引用快照，修改过就重新预览，不强制覆盖。仅改批准的学科索引字段及目标托管块，不改论文正文、进度或记录目录；也不能破坏其他学科已有依赖。

备份保存原始字节和回执。写入中断后，可用同一回执继续安全恢复：已是原字节的项跳过，仍为本次写入的项恢复，后来的用户编辑报冲突并保留。磁盘持续故障不保证即时完成回滚；须保留备份，修复I/O后重试，不手工删除回执。

## 草稿与离线

学习事件、当天草稿、知识库批准版本分开。保存知识库使用来源与修订比较；冲突必须选版本，覆盖前保留本机备份。离线仅在已有完整可信缓存时继续，显示上次同步时间；AI与知识库保存禁用。损坏/不完整历史不能当空历史。来源变化的已锁任务先阻塞，需明确采用新来源。

## 开发包验证

```powershell
npm run package:companion -- -OutputDirectory <temporary-output>
```

默认仍输出 `public/downloads`，开发验收必须指定临时目录。PowerShell7负责打包；只有EXE编译调用既有Windows PowerShell5.1/.NET Framework。测试对新临时包做完整27模块字节比对、EXE载荷验证、沙盒安装和隔离server导入；公开旧包按其自身清单验证，不能拿旧包当新功能已发布的证据。
