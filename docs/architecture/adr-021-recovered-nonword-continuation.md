# ADR-021：恢复原答后的显式续学回执

状态：已本地实现并完成定向回归与独立审查；完整工程与页面证据分别见本批验收。尚未发布或完成真实手机、用户验收。

## 已复现问题

完整 Dashboard 装配中，学科首题暂停后从主页待核对工作区恢复，可靠提交并选择保留待核对继续，再进入原二题组，仍显示原题及已练 0/2。原作答 checkpoint.traversed 已保存，但组游标未收到这一入口的继续动作。直接宿主测试没有覆盖这个跨入口问题。

仅在读取时按旧 traversed 标记跳过会破坏主动恢复：reopenNonWordPendingRound 明确清空 awaiting 并选择原题，原作答的旧标记却仍为 true。日期、position、visited 或评估版本都不能证明发生了新的继续动作；两设备时钟也不能作为动作顺序。

## 采用的方向

复用现有 V1 内部 checkpoint 封装，建立独立命名空间及版本化 notes 合约。现有 round anchor 已使用 mode=lesson、purpose=guided、空答案、未提交、pending/not-requested、无正式结果；新续学与重开元数据采用相同受控存储端口，不生成学习成绩或假冒用户引导尝试。不改变 StudyEventV3、原答案、正式评级、来源或调度。

- 显式继续回执绑定完整原 binding、固定首轮 attemptId、单调 sequence、冻结的重开边界及结果证明。相同边界和同一证明的重试返回原 sequence。
- 在本次操作开始时固定边界；迟到的旧操作不能读取新 ACK 后伪装成新操作。原答及回执未获得持久确认时不能离开。
- 主动重开保存 sourceHash、runId、按成员顺序的已确认 sequence，并关联实际游标 checkpoint 操作的 operationId/fingerprint。ACK 仅在锚点确认该操作后生效；半次写入或半次跨设备同步必须保守处理。
- 原组读取只派生当前运行、原所有者/库/成员/版本的回执，不修改原作答、游标或同步队列。pending 保持 awaiting；正式结果只依据已关联的 formal.rating/core/evaluation 证明，不能用补练或评价 good 覆盖正式 again。
- 明确 skipped、辅助尝试、词汇、旧运行和其他来源不被消费。旧记录缺少新回执时不猜测新的继续意图，不迁移或补造历史证据。
- 优先按确定性 ID 精确读取；不依赖无分组列表恢复全部数据，既有 D1 list 上限 500 且新增内部行会占额度。

## 实际封装与兼容

`continuation-storage.ts` 通过既有受控 AttemptRepository 保存内部空答案 lesson/guided 行，notes 使用独立 schemaVersion=1 和 kind。`nw-continue` ID 绑定完整原 binding，`nw-reopen` ID 绑定 owner/library/group/round；回执固定首轮身份、sequence、冻结边界、可选原组关联和 pending/formal 证明。正式证明包含原 answerRevision、evaluationHash、coreHash、eventId 及实际 formal.rating。写入必须使用准备内容时的 expectedRevision，未知回执只核对同一操作指纹，不能把旧内容套到新修订。

`continuation.ts` 负责关联、显式追加、原组只读派生、ACK 暂存及精确 ID 云端补齐。旧原答仅有 traversed 标志时不补造回执。相同边界/证明的重试返回原序号；先前视图的迟到动作在追加前后及真实游标 CAS 内核对边界。

具有原 RoundPort 的正常学科/内联入口继续沿用原游标的持久写入，回执关联和冻结边界仍保存，但不提前追加可行动的独立继续回执。因此游标写入失败时仍停在原题。没有原 RoundPort 的历史核对入口才追加独立回执，让原组下一次读取吸收已确认的继续动作。

原游标 notes JSON 仍为 V1。重开使用合法 checkpoint.view.instanceId 标记，并将实际 operationId 标为 `nw-reopen:<UUID>`；ACK 记录最新 staged、先前 active 和按成员排列的已确认 sequence。只有锚点 operations 中精确 operationId/fingerprint 才确认 ACK，且按现有 operation.revision 选最新重开操作。旧客户端省略 view 也不能回退到祖先 ACK；缺失新 ACK 时保守拒绝，不猜测。

跨设备初始化先加载原始锚点，再分批精确加载 ACK、当前成员继续回执及被引用的首答，之后公开投影。refresh 同样补齐；普通断网保留本机数据并显示设备状态，binding/conflict 错误失败关闭。公开 read 不改原答、游标或同步队列。首次初始化/显式 refresh 的缓存补齐与只读投影是不同证据。

不新增正式事件、模型调用或数据库迁移。旧未 opt-in 题组端口保持原行为；原内容、原正式评级及词汇入口不变。回退保留内部元数据行，新协议不能处理时保留原答并显示续学限制。

## 必须验证

1. 原答 pending 后继续推进原组；重新打开原题后旧动作重试不跳走，新动作才推进，冷恢复一致。
2. 原答已保存但回执失败禁止离开；重开 ACK 与游标各自只完成一半时不错误消费；读取零写入。
3. owner/library/source/run 隔离、辅助正确不覆盖首轮、冻结辅助后正式 again 优先于评价 good。

原失败复现 `tests/nonword-recovered-round-continuation.test.mjs` 现 10/10 通过；新增边界回归 14/14、真实隔离 HTTP/D1/两份 IndexedDB 云端回归 4/4。另有旧题组、内联及词汇行为回归；完整工程结果单独记录，不以这些数字代替页面或用户验收。

## 2026-10-07：初始化、保存回执与明确选题

真实浏览器复现表明，React StrictMode 的 effect 重放会并发构造首答和续学关联。首次 driver 初始化 Promise 只在当前宿主实例中按完整 bindingKey 复用；cleanup 不清它，来源变化创建新实例/Promise，失败可重试。guided/remediation 仍以各自 instanceId 区分。两层存储 CAS 与来源核验保持严格。

受控非词汇插件的 `onGrade` 可以返回异步持久回执。共享内容保护必须向其传回完整 Promise，不能在正式结果链接之前报告保存完成。词汇/旧交互仍保持此前同步返回方式。`continuationReceipt` 是受控宿主开启的进程内回调选项：旧视图拒绝推进必须返回 false，使当前已核验宿主可使用原成绩恢复续学。它不进入正式事件、提交命令或网络协议，默认不改变旧回调约定。

本组清单的明确选题先经串行 `selectItem` 回读当前锚点、核验 run 与成员，再保存当前位置，收到回执才切换页面。四类遍历列表、首答、正式成绩和调度保持原样，不把选题等同于已练或通过。迟到回执不切换新来源；失败仍留当前题。词汇保持原选择操作，原始材料和学科分类决定资格。

受控内联宿主已管理保存失败和恢复；此时不能靠强制 remount 重置它，否则旧 cleanup 保存与新 driver 可能相互制造冲突。传统入口保留原重置规则。可信原 core 的丢失回执恢复不再次调用正式 writer，未同步的发送队列仍保留。

没有新增数据库表或网络字段，不迁移历史学习记录。回退保留作答、游标、评价与正式事件；停用新 UI 后不删除任何证据。
