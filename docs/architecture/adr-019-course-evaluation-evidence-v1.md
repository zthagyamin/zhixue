# ADR-019：来源绑定的课程评价与诊断侧车 V1

状态：2B实施中；本文件不是已经上线或验收的声明。

## 决定与保留边界

课程V2使用独立任务评价服务。普通单词、旧recall-grade、旧StudyEventV3、FSRS和学习作答V1含义不变；不把诊断塞入旧事件/任意草稿字段。来源来自原发布快照或经原资料层核对的本机来源；客户端只传身份、作答修订与请求身份，不能提供评分答案。第一版仅使用已核验补练映射，不运行时生成变式。

Task定义从CourseSupportV2解析；父任务参考只用criteria，子任务使用自己的prompt/criteria/answer和父来源。taskHash对完整解析任务定义（包含来源片段/版本、任务条件与参考）确定性计算。候选/争议、父题不匹配、子题条件不足和已知泛化问题阻断评分。

## 诊断契约

CourseDiagnosticV1：schemaVersion=1，status(correct/partial/incorrect/undetermined)，source(model/deterministic/self-assess/none)，feedback，matchedPointIds，missedPointIds，errorPointIds，wrongOptionIds，missingOptionIds，pointEvidence；undetermined另有reason(unavailable/offline/cancelled/source-insufficient/source-conflict/uncertain/invalid-result)。不由模型给出正式成绩或置信度。

- 模型只核对明确任务及参考，正确转述有效。所有criterion ID由原题提供；matched/missed/error严格分区，不接受虚构ID。correct不能有实质错误或漏必答项；partial需既有覆盖又有待补项；incorrect必须有失败依据。评级从语义状态导出good/hard/again，再沿用原提示上限。
- pointEvidence包含pointId/sourceId/sourceQuote/answerQuote/reason。模型的匹配/错误要点必须有证据；引用只能指向该要点绑定的来源，sourceQuote须存在于原来源片段，answerQuote须存在于提交的原答案。引用存在不证明语义正确，真实模型评测另验。
- 未确定诊断无评分、无对齐集合，不自动自评。显式忘记/自评单独标source，不冒充模型诊断；没有可信逐项证据时原题重试，不猜遗漏。
- 选择题从原提交的稳定ID集合确定性核对错选/漏选；不把选项命中数伪装成回忆要点语义覆盖。错选/漏选解释只用原材料。

## 诊断记录与操作

新增CourseEvidenceV1，独立于LearningAttemptV1：schemaVersion，attemptId，binding(原AttemptBinding)，taskId，taskHash，parentAttemptId/null，parentEvidenceHash/null，revision，answerRevision/null，diagnostic/null，diagnosticHash/null，attemptEvaluationHash/null，createdAt，updatedAt，operations[{operationId,fingerprint}]。不重复保存原答案；原答案仍在LearningAttemptV1。

诊断另存trace/null：provider?、modelId、promptVersion、ruleVersion、requestId。模型诊断必须有trace；diagnosticHash对{diagnostic,trace}确定性计算，不保存模型隐藏推理。attemptEvaluationHash对转换后的既有AttemptEvaluation计算（原evaluationFingerprint规则，不改V1含义）；undetermined为null。

CourseEvidenceMutationV1共用schemaVersion=1/attemptId/binding/operationId/expectedRevision/updatedAt；

- bind：taskId/taskHash/parentAttemptId/parentEvidenceHash；只能新建或幂等重试，不能换已有任务。原作答必须存在且绑定一致。子任务来源和选择须由父诊断核对。
- diagnose：answerRevision/diagnostic/trace/diagnosticHash/attemptEvaluationHash。必须对应已提交原作答修订。undetermined可以以后恢复核对；resolved诊断不可覆盖。操作指纹、CAS及绑定必须一致，冲突保留原记录。

独立CourseEvidenceReceiptV1：status(accepted/duplicate/conflict)、durable、operationId、revision、evidence/null。只有实际持久回执才可声明保存成功。云端模型诊断由课程评价应用用例写入，公开mutate不能冒充模型；确定性诊断在云端由原选项/原答案重算核对，显式自评不标为模型。

新增D1课程侧车表及独立IndexedDB课程侧车数据库，scope隔离、原子本机记录/出站操作、回执核对、CAS与未同步本机优先沿用既有原则。旧服务明确unsupported并保留本机记录，不把本机回执说成跨设备已恢复。

本机模式只保存本机，不生成账号出站操作。账号模式的模型诊断只接收服务器已持久化的原记录，不能以本机model标签上传冒充服务评价；账号绑定/确定性/明确自评/未知记录可按受控操作同步。切模式不自动改scope或上传历史本机诊断。

## 顺序与恢复

1. 可靠保存/提交原答案；课程绑定与任务定义固定后才开始评价。
2. 评价诊断先有持久回执，再应用LearningAttemptV1评价。两者的answerRevision、taskHash、diagnosticHash和attemptEvaluationHash匹配后才展示可行动反馈。中途失败保留原答，恢复同一诊断，不重复调用模型。
3. 正式认领/写入仍经原事件层。课程V2必须有匹配诊断与原作答评价；引导/补练不能认领正式成绩，已有正式结果冲突不能覆盖。
4. 补练默认选一个可信关键问题（必答遗漏优先，其次实质错误，保留作者顺序），只选已经绑定的映射。没有映射明确提示原题重试。新子作答固定自己的任务hash和父诊断hash，刷新按该身份恢复，不重新选题。
5. account课程评价使用原账号模型配置、预算与请求幂等账本。AI异常/取消/迟到/参考不足进入待核对。恢复用同一原答；需要重新评价时可以新建评价请求，但不能新建学习成绩身份或覆盖已有resolved结果。

## 实施与验收

领域只做解析、来源解析、诊断验证、确定性选择核对、补练选择和纯状态转换。应用端口管理顺序与受控模型；基础设施负责D1/IndexedDB/模型/认证请求；插件只展示与提交意图。现有宿主通过窄的课程扩展接入，不另写一套成绩/调度控制器。

先共享夹具/失败复现，再实现：虚构点与引用、矛盾状态、不同答案修订/来源/用户/库、并发/重复/回执丢失、先诊断后评价失败、暂停/刷新/补练固定身份、未知与恢复、词汇回归。公共边界与持久化独立审查；完整npm/Python、桌面/390浅深真实组件、真实材料、用户试用分开报告。

新增存储为加法结构，无历史迁移或删除。回退匹配代码，保留新表/本机答案与诊断；停用新课程来源，旧客户端保留旧能力并明确限制。合并、部署、Companion发布和安装分别授权；本轮无付费模型或真实学习记录操作。
