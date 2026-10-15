# Account action contract / 账号动作契约

This is a source contract for `/api/account-study`, not an execution report. The declared dispatcher has **17 GET + 43 POST = 60 actions**. Behavior tests read this table so newly exposed actions require an explicit contract update.

- **B / D / P** mean authenticated browser, active device and pending device. 可 permits entry subject to validation; 拒 denies that role. Permission is not a promise of successful persistence.
- **S** is the authenticated owner/library scope from `src/application/account-study/context.ts`. A browser selects its current profile library; a device is bound to its grant. Client fields cannot select another owner. `expectedUserId` is only an assertion.
- Browser POST requires an Origin equal to the request origin, including rejecting an absent Origin. Bearer-device POST uses device authorization. Mixed account identities are rejected; invalid Authorization does not fall back to a browser session.
- POST requires JSON and a 2,200,000-byte limit. After reading a device request body, the handler revalidates its secret, user, library and grant state. Stores enforce additional write conditions.
- GET accepts only the global query allowlist in `src/infrastructure/account-study/http-values.ts` and rejects duplicate keys. It does not have a separate exact allowlist per action. Default pagination is 20, bounded 1–20 unless stated otherwise below.
- **A/** means `src/application/account-study/`; **D/** means `src/domain/`. Parser references are authoritative for nested payloads.

The matrix describes roles, inputs and effects. It does not claim that every valid business payload, hosted identity, platform transaction or two-device combination has been executed. Tests use synthetic content and isolated stores; provider acquisition is blocked in permission rejection fixtures. No table entry establishes learning outcomes.

## GET：17 个独立动作

action缺省bootstrap。分页queryCount：limit默认20、范围1–20；after默认0；through可选；均非负十进制整数。items的position默认0。除grant-info外，device进入read分派先要求active。输入基本校验在A/request-values.ts，query白名单在src/infrastructure/account-study/http-values.ts。

| 编号 / action | 必需 / 可选输入与验证 | B / D / P | owner、library与读取资产 / 数据影响 | 源码定位 |
| --- | --- | --- | --- | --- |
| G01 grant-info | 必无；选expectedUserId；其他白名单query不选择grant | 拒 / 可 / 可 | 认证device principal的grant/user/library/state/expiry；不查S，不写库 | A/read.ts |
| G02 bootstrap | 必无；选expectedUserId；libraryId query不选择库 | 可 / 可 / 拒 | principal.userId的 **profile当前库**、snapshot及read/assistance fences；D另要求profile.libraryId=grant.libraryId；无库返回null投影 | A/read.ts |
| G03 planning-catalog | 必snapshotId→id(snapshot)；选libraryId/expectedUserId | 可 / 可 / 拒 | S内按snapshot读目录，未知404 | A/read.ts |
| G04 planning-catalog-hash | 必catalogHash→路由id(catalog-hash)再store digest(64hex)；选libraryId/expectedUserId | 可 / 可 / 拒 | S内按hash读目录，store再次核digest；未知404 | A/read.ts |
| G05 planning-facts | 必snapshotId→id(snapshot)；选libraryId/expectedUserId | 可 / 可 / 拒 | S内按snapshot读事实，未知404 | A/read.ts |
| G06 plan-state | 必day→id(plan-day)，实际日期规则在store；选libraryId/expectedUserId | 可 / 可 / 拒 | S内读当天当前/批准计划、revision/decision | A/read.ts |
| G07 long-term-plan | 必无；选libraryId/expectedUserId | 可 / 可 / 拒 | S内读长期计划；store缺失503；独立于正式证据 | A/read.ts |
| G08 ai-settings | 必无；选libraryId/expectedUserId | 可 / 可 / 拒 | S内非秘密设置/serverAvailable；getSettings **可INSERT默认设置行**，不返回providerKey明文 | A/read.ts、db/account-study-ai-store.ts::getSettings |
| G09 plan-operations | 必无；选libraryId/expectedUserId/limit/after/through | 可 / 可 / 拒 | S内按序列/封闭fence读计划操作 | A/read.ts |
| G10 plan-executions | 必无；选libraryId/expectedUserId/limit/after/through | 可 / 可 / 拒 | S内分页读设备执行回执，不执行计划 | A/read.ts |
| G11 content-decisions | 必无；选libraryId/expectedUserId/limit/after/through | 可 / 可 / 拒 | S内分页读内容决定/状态，不直接读原文件 | A/read.ts |
| G12 assistance | 必无；选libraryId/expectedUserId/limit/after/through | 可 / 可 / 拒 | S内辅助摘要；能力不支持409；不能替代正式证据 | A/read.ts |
| G13 assistance-receipts | 必无；选libraryId/expectedUserId/limit/after/through | 可 / 可 / 拒 | S内辅助写回回执；能力不支持409 | A/read.ts |
| G14 manifest | 必无；选snapshotId→id(snapshot)/libraryId/expectedUserId | 可 / 可 / 拒 | S内指定或当前snapshot，未知404；请求userId不能换owner | A/read.ts |
| G15 items | 必snapshotId→id(snapshot)；选position/limit/libraryId/expectedUserId | 可 / 可 / 拒 | S内按snapshot/position读版本条目及必要来源投影 | A/read.ts |
| G16 records | 必无；选after/through/limit/libraryId/expectedUserId | 可 / 可 / 拒 | S内封闭窗口读正式记录，不追加事件 | A/read.ts |
| G17 receipts | 必无；选after/through/limit/libraryId/expectedUserId | 可 / 可 / 拒 | S内正式记录机器写回回执；cloud ack与本机应用分开 | A/read.ts |

## POST：43 个独立动作

外层action与expectedUserId共同规则见上；每行“选libraryId”之外也可选expectedUserId。嵌套分支字段见下一节。

| 编号 / action | 外层必需 / 可选；嵌套权威parser | B / D / P | owner/library与读写资产、影响 | 源码定位 |
| --- | --- | --- | --- | --- |
| P01 register-grant | 必grantId/libraryId/tokenHash/label/expectedProfileRevision/replaceLibrary；选expectedUserId；db/account-study-access-store.ts::registration | 可 / 拒 / 拒 | principal.userId登记pending grant及account/profile/library行；libraryId是拟授权库，不走S；revision/显式replaceLibrary控制换库；只收token hash | A/access-actions.ts |
| P02 activate-grant | 必无；选expectedUserId；fields仅action；secret来自Bearer；不接libraryId/grantId | 拒 / 可 / 可 | 激活认证grant，CAS更新其user的profile当前库/revision并撤其他active grants；active重试返回principal | A/access-actions.ts、db/account-study-access-store.ts::activate |
| P03 revoke-grant | 必grantId→id(grant)；选expectedUserId；不接libraryId | 可 / 拒 / 拒 | principal.userId限定撤自己的grant，不删除学习记录 | A/access-actions.ts |
| P04 begin-snapshot | 必snapshot；选libraryId；app/account-study-content.ts::parseStudySnapshot（注入parseSnapshot） | 拒 / 可 / 拒 | S=snapshot.libraryId，grant writer创建/验证暂存快照，不立即完成发布 | A/record-actions.ts |
| P05 stage-items | 必snapshotId/entries[1..20]，entry必position/item；选libraryId；app/account-study-content.ts::parseStudyItem（注入parseItem） | 拒 / 可 / 拒 | S+snapshot暂存版本条目/position，grant资格与content hash/成员约束 | A/record-actions.ts |
| P06 complete-snapshot | 必snapshotId/expectedRevision(≥0)；选libraryId；A/request-values.ts::id,count，store核bundle | 拒 / 可 / 拒 | S内CAS完成snapshot/当前投影，核齐全/完整性及grant writer | A/record-actions.ts |
| P07 append-records | 必records[1..5]；选libraryId；D/sync/account-record.ts::parseStudyRecord→V3/task parser | 可 / 可 / 拒 | S=record.libraryId；核snapshot/成员/parent/round/attempt/plan后追加正式事件，逐条durable cloud ack；D writer另核资格 | A/record-actions.ts |
| P08 append-assistance | 必records[1..20]；选libraryId；D/sync/assistance-record.ts::parseAccountAssistance→parseAssistanceSummary | 可 / 拒 / 拒 | S=record.libraryId，store核parent/envelope/summary关联后存辅助摘要，不改正式事件/成绩 | A/assistance-actions.ts |
| P09 assistance-receipt | 必receipt；选libraryId；D/sync/assistance-record.ts::parseAssistanceReceipt | 拒 / 可 / 拒 | S内summary/association绑定，grant写辅助回执；applied需proof | A/assistance-actions.ts |
| P10 writeback-receipt | 必receipt；选libraryId；D/sync/machine-writeback.ts::parseWritebackReceipt | 拒 / 可 / 拒 | S内event/envelope绑定，grant写本机写回回执；applied需proof，不生成作答 | A/assistance-actions.ts |
| P11 publish-planning-catalog | 必catalog；选libraryId；app/account-study-planning.ts::parseCloudPlanningCatalog（store） | 拒 / 可 / 拒 | S内catalog.snapshotId须已有published snapshot，library/source/content/hash绑定；写计划目录 | A/planning-actions.ts |
| P12 publish-planning-facts | 必facts；选libraryId；app/account-study-planning.ts::parseCloudPlanningFacts（store） | 拒 / 可 / 拒 | S=facts.libraryId，catalog/snapshot/hash约束；写事实投影，非成绩 | A/planning-actions.ts |
| P13 mutate-plan | 必mutation；选libraryId；db/account-study-plan-store.ts::mutate；app/account-study-planning.ts::parseCloudTaskPlan | 可 / 拒 / 拒 | S内save/approve/reject/cancel/restore计划/操作；CAS、facts/fences/predecessor绑定；批准不等于设备执行 | A/planning-actions.ts |
| P14 mutate-long-term-plan | 必mutation；选libraryId；D/planning/long-term-plan-state.ts::parseLongTermPlanMutation→parseLongTermPlanSnapshot | 可 / 拒 / 拒 | S内长期计划CAS、防重/冻结历史，不迁移正式学习记录 | A/planning-actions.ts |
| P15 plan-execution-receipt | 必receipt；选libraryId；app/account-study-plan-execution.ts::parsePlanExecutionReceipt | 拒 / 可 / 拒 | S内operation/plan/claim writer绑定，写执行回执/claim状态，applied需proof | A/planning-actions.ts |
| P16 claim-plan-operation | 必operationId→id(operation)；选libraryId | 拒 / 可 / 拒 | S内grant认领批准操作，约束predecessor/执行状态；写claim，不是读取 | A/planning-actions.ts |
| P17 decide-content | 必decision；选libraryId；db/account-study-content-decision-store.ts::decide内studyObject | 可 / 拒 / 拒 | S内facts/candidate/content绑定，写approved/rejected/later及final；应用另需设备回执 | A/planning-actions.ts |
| P18 content-decision-receipt | 必receipt；选libraryId；app/account-study-content-decision.ts::parseContentDecisionReceipt | 拒 / 可 / 拒 | S内operation/candidate/content/decision绑定；grant写applied/blocked回执并更新状态/必要final解锁 | A/planning-actions.ts |
| P19 configure-plan-ai | 必settings；选libraryId；db/account-study-ai-store.ts::configure内studyObject | 可 / 拒 / 拒 | S内provider/预算/revision/加密key更新；启用需confirmCosts；server不可用拒新key/启用，仍可清key；不记成绩 | A/ai-actions.ts |
| P20 recommend-plan-ai | 必requestId/day/request；选libraryId；D/ai/plan-request.ts::parsePlanAiRequest | 可 / 拒 / 拒 | S内当前plan/catalog核候选/optional/planHash；写AI预算reservation/result/failure，可调用模型，不自动批准计划 | A/ai-actions.ts |
| P21 ai-models | 必selection；选libraryId；A/ai-actions.ts内studyObject→D/ai/endpoint.ts::providerEndpoint | 可 / 拒 / 拒 | S内settings revision绑定，以已存/临时key请求模型列表；getSettings可建默认行；不存临时key或成绩 | A/ai-actions.ts |
| P22 ai-chat | 必request；选libraryId；D/ai/chat-request.ts::parseChatRequest | 可 / 拒 / 拒 | S内provider/model/revision绑定；有限客户端上下文；写AI预算/request，SSE/取消，不写正式成绩 | A/ai-actions.ts、A/chat-execution.ts |
| P23 question-ai | 必requestId/request；选libraryId；D/ai/question-request.ts::parseQuestionAiRequest | 可 / 拒 / 拒 | S内snapshot/item/content绑定，attemptId由kind/source/input哈希重建；读权威item、写AI预算/request，可模型调用，不直接append正式事件 | A/ai-actions.ts |
| P24 attempt-read | 必attemptId→D/learning-attempt/parse.ts::attemptId；选libraryId | 可 / 可 / 拒 | S内读已存attempt(可null)，store不支持409；POST读取仍受B Origin约束 | A/attempt-actions.ts |
| P25 attempt-list | 必无；选libraryId/groupId→attemptId；不接cursor/limit | 可 / 可 / 拒 | S内列attempt，可group过滤 | A/attempt-actions.ts |
| P26 attempt-mutate | 必mutation；选libraryId；D/learning-attempt/parse.ts::parseAttemptMutation | 可 / 可 / 拒 | S=mutation.binding.ownerId/libraryId；答案/checkpoint/提交/评价/正式关联CAS；来源/服务证明另核，普通mutate不授可信模型权威 | A/attempt-actions.ts |
| P27 attempt-reference | 必attemptId→attemptId；选libraryId | 可 / 可 / 拒 | S内按attempt.binding读item与snapshot，核content及manifest成员；不存在404/错配409 | A/attempt-actions.ts |
| P28 course-evidence-read | 必attemptId→attemptId；选libraryId | 可 / 可 / 拒 | S内课程证据(可null)，支持检查409，不评分 | src/application/course-study/account-actions.ts |
| P29 course-evidence-mutate | 必mutation；选libraryId；D/course-study/evidence.ts::parseCourseEvidenceMutation | 可 / 可 / 拒 | S=mutation.binding.owner/library；任务绑定/诊断，store核原作答/来源/评价authority，D另核writer | src/application/course-study/account-actions.ts |
| P30 course-grade | 必requestId/request；选libraryId；D/course-ai/request.ts::parseCourseGradeRequest | 可 / 拒 / 拒 | S内已提交答案/task/evidence revision；quiz确定性或受控AI预算；保存诊断/待核对，不直接写正式grade/event | src/application/course-study/account-evaluation.ts |
| P31 practice-evidence-read | 必attemptId→attemptId；选libraryId | 可 / 可 / 拒 | S内计算/代码证据(可null)，不判题 | src/application/practice-evidence/account-actions.ts |
| P32 practice-evidence-list | 必无；选libraryId/cursor→attemptId/limit(整数1–200) | 可 / 可 / 拒 | S内分页练习证据；不同于GET after/through/20规则 | src/application/practice-evidence/account-actions.ts |
| P33 practice-evidence-mutate | 必mutation；选libraryId；D/practice-evidence/parse.ts::parsePracticeEvidenceMutation | 可 / 可 / 拒 | S=mutation.binding.owner/library；执行pointer/report/步骤/变式/受控hint/diagnostic；store核authority/original，模型字段不是客户端权威 | src/application/practice-evidence/account-actions.ts |
| P34 math-evaluate | 必requestId/request；选libraryId；src/application/math-study/evaluator.ts::parseMathStudyRequest | 可 / 拒 / 拒 | S内已存calculation答案/source/步骤，可写诊断与受控AI预算；final/step条件不同，不直接append正式事件 | src/application/math-study/account-actions.ts |
| P35 math-variant | 必attemptId→studyId/seed(整数0..0xffffffff)；选libraryId | 可 / 拒 / 拒 | S内保存attempt与批准mapping重建变式，返回descriptor/mapping或unavailable；此分支不调模型、不写变式记录 | src/application/math-study/account-actions.ts |
| P36 math-mapping-publish | 必preparation；选libraryId；D/guided-math/preparation.ts::parseMathMappingPreparation→parseMathVariantMapping | 拒 / 可 / 拒 | S内snapshot/item/full content/review绑定，写mapping及originGrantId/publishedAt；技术核验不证明教学审定 | src/application/math-study/mapping-actions.ts |
| P37 math-mapping-read | 必attemptId→studyId；选libraryId | 可 / 拒 / 拒 | S内只读保存calculation attempt所绑定mapping；缺能力/记录返回unavailable，不接客户端mapping | src/application/math-study/mapping-actions.ts |
| P38 code-hint | 必requestId/request；选libraryId；src/application/code-study/index.ts::parseCodeHintRequest | 可 / 拒 / 拒 | S内代码答案/answer/source/run/case及权威tests/latest report绑定；受控AI预算/hint写回，再核当前输入；不执行代码/正式评价 | src/application/code-study/index.ts::executeCodeHintAction |
| P39 list-paper-reading | 必无；选libraryId/cursor/limit(默认20、整数1–50)；D/paper-reading/discovery.ts::paperReadingDiscoveryQuery，返回parsePaperReadingDiscoveryPage | 可 / 拒 / 拒 | S转account:userId/account:libraryId，分页论文工作区摘要，不调模型 | src/application/paper-reading/account-actions.ts |
| P40 read-paper-reading | 必unitId(非空≤200)；选libraryId | 可 / 拒 / 拒 | account前缀scope读unit工作区(可null)，不自动开始任务/模型 | src/application/paper-reading/account-actions.ts |
| P41 mutate-paper-reading | 必mutation；选libraryId；D/paper-reading/workspace.ts::parsePaperReadingMutation | 可 / 拒 / 拒 | account前缀scope注册来源/草稿/提交/重试/参考/暂停；task/feedback是service-only；CAS/unit/source核验 | src/application/paper-reading/account-actions.ts |
| P42 prepare-paper-reading | 必unitId/requestId(各非空≤200)；选libraryId/preparedTask→D/paper-reading/evidence.ts::paperReadingTask且origin=prepared | 可 / 拒 / 拒 | account前缀scope已注册unit；service.begin存/复用任务、可受控AI；预制也核source/unit，不写成绩 | src/application/paper-reading/account-actions.ts、src/application/paper-reading/service.ts::begin |
| P43 evaluate-paper-reading | 必unitId/attemptId/requestId(各非空≤200)；选libraryId | 可 / 拒 / 拒 | account前缀scope取提交/task revision；service.evaluate受控AI及非评分feedback/待核对，保留答案，不接reference/rating | src/application/paper-reading/account-actions.ts、src/application/paper-reading/service.ts::evaluate |

## 嵌套输入与权威parser账本

| 对象 / 动作 | 真实必需、可选及条件输入；权威文件 |
| --- | --- |
| grant / P01 | 全部必grantId/libraryId/tokenHash(64hex)/label(≤80)/expectedProfileRevision(非负)/replaceLibrary(boolean)，无token/secret字段。db/account-study-access-store.ts::registration。 |
| snapshot / P04 | 必schemaVersion=1/libraryId/snapshotId/revision≥1/generatedAt/sourceHash/eventCursor/taskCursor/items及有效snapshotHash；member必itemKey/contentHash。初始字段检查将hash列optional，后续digest/重算使其实际必需。app/account-study-content.ts::parseSnapshotBody/parseStudySnapshot。 |
| item / P05 | 必schemaVersion/kind/itemKey/eventKind/subjectId/title/sourceHash/completionRule及有效contentHash。word/language/recommendedPlugin/practice/learningSupport按kind/schema分支；schema2必learningSupport、schema1禁止。app/account-study-content.ts::parseItemBody/parseStudyItem，学习支持→D/content/learning-support.ts等。 |
| record / P07 | 公共必schemaVersion=1/libraryId/snapshotId/originDeviceId/provenanceMode/event/envelopeHash；task另必planHash/assignmentId/completionKey→D/planning/task-event-v1.ts::validateTaskEvent；verified-round另必contentHash/practiceMode/attemptId/parentEventId/roundId；legacy-continuation替roundId为resumeId/resumeStateHash/legacyStage/legacyAnchorEventId。event→D/evidence/study-event-v3.ts::parseCloudStudyEventV3；portable记录禁止clientStateAfter。D/sync/account-record.ts::parseBody/parseStudyRecord重算hash。 |
| assistance / P08 | 必schemaVersion=1/libraryId/attemptEnvelopeHash/summary/associationHash；summary→D/sync/assistance-summary.ts::parseAssistanceSummary；D/sync/assistance-record.ts::parseAccountAssistance/validateAccountAssistance核parent/hash。 |
| assistance receipt / P09 | 必schemaVersion/receiptId/summaryId/summaryHash/associationHash/status；applied必proof{attemptCoreHash,proofHash,targetCount=2}；blocked必枚举reason；其他状态禁proof/reason。D/sync/assistance-record.ts::parseAssistanceReceipt/checkAssistanceReceipt。 |
| writeback receipt / P10 | 必schemaVersion/receiptId/eventId/envelopeHash/status；applied必proof{coreHash,proofHash,targetCount=1..16}；blocked必枚举reason；其他状态禁proof/reason。D/sync/machine-writeback.ts::parseWritebackReceipt。 |
| catalog / P11 | 必schemaVersion/libraryId/snapshotId/sourceHash/subjects/practiceSources/diagnostics/contentRefs及有效catalogHash；subject必subjectId/name/priority/words/units/goals，选lastProgressAt/planningStatus；unit/goal/action/contentRef条件字段/成员→app/account-study-planning.ts::planningCatalogBody/parseCloudPlanningCatalog，重算hash。 |
| facts / P12 | 必schemaVersion/libraryId/snapshotId/catalogHash/observedAt/nativePlanRevision/sourceReviews/captureReviews/legacyEvents/legacyTaskEvents/contentCandidates/historyComplete及有效factsHash；candidate必candidateId/kind/label/contentHash，选oldLabel。app/account-study-planning.ts::planningFactsBody/parseCloudPlanningFacts及其子parser。 |
| plan mutation / P13 | 公共必action/operationId/expectedRevision；save必plan；approve必day/planHash/predecessorOperationId(可null)；reject必day/planHash；cancel必day/targetOperationId；restore必day/targetOperationId/predecessorOperationId。最终studyObject分支禁额外字段。db/account-study-plan-store.ts::mutate，plan→app/account-study-planning.ts::parseCloudTaskPlan。 |
| long-term mutation / P14 | 必operationId/expectedRevision/enabled/snapshot，无选字段。D/planning/long-term-plan-state.ts::parseLongTermPlanMutation→D/planning/long-term-plan-types.ts::parseLongTermPlanSnapshot；snapshot必schemaVersion/spec/totalInventoryCount/estimatedTotalDays/schedule/lastRebalancedAt/activeDriftDays/asOfDate/inventory/backlog/excludedItemIds/learningCompletedItemIds/remainingRequiredRounds/warnings/adjustmentProposals/forecastAssumptions，子结构依该parser。 |
| execution receipt / P15 | 必schemaVersion/receiptId/operationId/cloudPlanHash/status；applied必proof{cloudPlanHash,nativePlanHash,localRevision≥1,proofHash,targetCount=1}、禁reason；blocked必枚举reason、禁proof。app/account-study-plan-execution.ts::parsePlanExecutionReceipt。 |
| decision / P17 | 全部必operationId/factsHash/candidateId/contentHash/decision(approved/rejected/later)，无选字段。db/account-study-content-decision-store.ts::decide。 |
| decision receipt / P18 | 必schemaVersion/receiptId/operationId/candidateId/contentHash/decision/status；applied必proofHash、禁reason；blocked必reason≤200、禁proofHash。app/account-study-content-decision.ts::parseContentDecisionReceipt。 |
| AI settings / P19 | 必enabled/dailyRequestLimit/maxOutputTokens/expectedRevision/confirmCosts；选unlimitedDailyUsage/dailyTokenLimit/concurrentLimit/providerKey/clearProviderKey/provider/model/baseUrl。启用需confirmCosts=true和key；上限request10、day tokens20000、concurrency2、output2000；key与clear不能同时启用；providerEndpoint核provider/URL。db/account-study-ai-store.ts::configure。 |
| plan AI request / P20 | 必planHash/intent(standard/less/more/reorder)/confirmed=true/candidates≤100/currentOptionalTaskIds；candidate必unitId/subjectId/label/priority1..5。D/ai/plan-request.ts::parsePlanAiRequest；应用从当前目录另核身份。 |
| selection / P21 | 必provider(chatgpt/deepseek)/baseUrl≤500/expectedRevision；选providerKey8..512。A/ai-actions.ts::executeAiAction内studyObject与D/ai/endpoint.ts::providerEndpoint。 |
| chat request / P22 | 必requestId/provider/model/settingsRevision/context/messages1..30；context必id/title，选question/learnerAnswer/code/errors/pageText/selection/pageKind/truncated；message必role(user/assistant)/content；总JSON≤50000字符。D/ai/chat-request.ts::parseChatRequest。 |
| question request / P23 | 必kind(hint/tutor/recall-grade)/snapshotId/itemKey/contentHash/attemptId/input≤4000（hint允许空，其他非空）。D/ai/question-request.ts::parseQuestionAiRequest。 |
| attempt binding / P26/P29/P33 | 全部必ownerId/libraryId/snapshotId/itemKey/contentHash/groupId/roundId。D/learning-attempt/parse.ts::parseAttemptBinding；binding不自行授authority。 |
| attempt mutation / P26 | 公共必schemaVersion=1/operationId/attemptId/binding/expectedRevision/updatedAt/kind。checkpoint另必answer/checkpoint/parentAttemptId(可null)；submit另必answerRevision/assistance，选maxPreHintLevel/answerRevealed；evaluate另必answerRevision/evaluation；claim-formal另必eventId/occurredAt/evaluationHash/rating；link-formal另必eventId/coreHash。D/learning-attempt/parse.ts::parseAttemptMutation/checkpoint/parseAttemptEvaluation。 |
| course mutation / P29 | 公共必schemaVersion=1/kind/attemptId/binding/operationId/expectedRevision/updatedAt；bind另必taskId/taskHash/parentAttemptId/parentEvidenceHash；diagnose另必answerRevision/diagnostic/trace/diagnosticHash/attemptEvaluationHash。D/course-study/evidence.ts::parseCourseEvidenceMutation，diagnostic/trace→D/course-study/diagnostic.ts；store另核模型authority。 |
| grade request / P30 | 全部必schemaVersion=1/attemptId/taskId/taskHash/answerRevision/evidenceRevision≥1；无answer/reference字段。D/course-ai/request.ts::parseCourseGradeRequest。 |
| practice mutation / P33 | 公共必schemaVersion=1/operationId/attemptId/binding/expectedRevision/updatedAt/kind；execution-pointer另必prepared；code-report另必report，选output；code-hint另必hint；step-input另必text；step-diagnostic另必diagnostic；variant另必variant。D/practice-evidence/parse.ts::parsePracticeEvidenceMutation及其嵌套parser。 |
| math request / P34 | 必schemaVersion=1/attemptId/answerRevision/sourceVersion64hex/mode(final/step)；选stepRevision≥1，实际step另核保存revision。src/application/math-study/evaluator.ts::parseMathStudyRequest；不接客户端答案/参考。 |
| preparation / P36 | 必schemaVersion=1/snapshotId/mapping/review；review必sourceQuote≤1000/rationale≤2000；mapping须content hashKind并经D/guided-math/mapping.ts::parseMathVariantMapping。D/guided-math/preparation.ts::parseMathMappingPreparation/validateMathMappingPreparation。 |
| code hint request / P38 | 必schemaVersion=1/attemptId/answerRevision/sourceVersion64hex/runId≥1；选caseId。src/application/code-study/index.ts::parseCodeHintRequest；原代码/tests/report从S内读。 |
| discovery query / P39 | cursor/limit可选；cursor允许null或绑定scope的cursor；limit默认20、整数1–50，由D/paper-reading/discovery.ts::paperReadingDiscoveryQuery校验，返回页同样按scope/query解析。 |
| paper mutation / P41 | 公共必schemaVersion=1/operationId/unitId/expectedRevision/kind；register另必unit；task另必task；draft另必answer/referenceSeen；submit另必answer/submittedAt/referenceSeen；retry另必attemptId/purpose(assisted/remediation)；reference无额外；feedback另必attemptId/answerRevision/taskRevision/evaluation；pause另必paused/activeSeconds。无任意选字段。D/paper-reading/workspace.ts::parsePaperReadingMutation/applyPaperReadingMutation；public task/feedback拒绝service-only。 |
| paper unit / P41 register | 必schemaVersion=1/unitId/title/goal/source；source完整owner/library/material/版本/段落→D/paper-reading/evidence.ts::parsePaperReadingSource，原文合计≤8000字符。D/paper-reading/workspace.ts::paperReadingUnit；store再核account前缀scope。 |
| preparedTask / P42 | 有效输入含taskId/revision/source/origin/goal/ability/question/reference，origin必须prepared；schemaVersion/status/reason/evidenceMode可传但由paperReadingTask重建，不能按静态PaperReadingTaskV1类型推断它们全为必需。D/paper-reading/evidence.ts::paperReadingTask；source字段同paper source，reference每项point/paragraphId/quote；不可靠任务成为needs-improvement。unit/source/task约束还由src/application/paper-reading/service.ts::begin与store核验。 |
