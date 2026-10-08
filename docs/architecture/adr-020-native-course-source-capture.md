# ADR-020：原生课程来源捕获与恢复

状态：来源捕获、原生判题账本、网页接入、待核对恢复及正式证据联锁已本地实现。部署、安装、真实模型与用户验收尚未完成。承接ADR019，保留Obsidian原文、网站答案/导航/正式提交协调及Companion来源/模型职责。

## 依据

Companion effective_gateway(root,owner=hashed_user)覆盖现有登记来源，并核对所有者；index_gateway.lookup_binding按稳定key找到当前绑定，完整题目从catalog.subjects.items核对。原生contentHash是Python条目签名，不是StudyItem portable hash。local库身份取配置根规范化摘要，snapshot为local，网页owner另有workspace身份。

account_sync_export.capture_catalog已有索引锁、双读和文件围栏；assistance_binding.binding_hash覆盖根/路由/来源指纹。账号Inbox保存历史portable正文及私有绑定，但不是原生命名空间。原生writer冻结的路由不足以恢复旧课程参考。

## 采用

- 新增配对/Origin授权后的原生course source capture/read/grade V1端口。HTTP只解析、调用、返回；应用拿命名来源、ledger和供应商端口；文件、SQLite、配置、模型留基础设施，禁止导入server/routes或反射整个服务。
- 来源身份明确localLibraryId/itemKey/nativeContentHash/localBindingHash；捕获时经effective_gateway和来源围栏验证当前条目，原生签名原样保留。只移除解析器生成的空answer/explanation等占位，非空重复参考拒绝。
- Companion存不可变原生题目/来源/补练映射与私有路由副本（不是新的权威原文），按hashed owner、本机库、原生身份与任务hash隔离；历史read不借用当前新参考，不猜测账号ID。
- 网页发送身份、taskId/taskHash、作答/请求身份及不可信原答案，不发送评分参考。子任务由已保存可信父诊断选择。请求/结果有持久幂等与原配置预算，不把重试接到无账本旧grade。
- 网页的诊断存储显式区分native验证与portable验证，原hash不得换成view/portable hash。原生缓存必须来自认证捕获并复核身份/捕获hash；旧原生pending没有旧捕获且当前来源已变时保留未知，不迁移或补造旧参考。

## 验证、兼容与回退

### 当前接口与存储

`POST /v1/course/source/capture`仅接收`{schemaVersion:1,identity}`；历史读取`POST /v1/course/source/read`另接收`captureId`。沿用Handler已有配对和Origin授权，owner来自认证会话，不接受客户端指定owner、题目正文或评分参考。返回`{schemaVersion:1,durable:true,capture}`；capture为`{schemaVersion:1,captureId,identity,item,taskHash}`，不包含本机文件路径或私有路由。存储失败不返回成功回执，HTTP错误不泄露原始文件/数据库异常。

`captureId`是`{schemaVersion:1,identity,item,taskHash}`的跨运行时规范哈希；item的`contentHash`仍是原生签名，不是portable内容哈希。`native_course_sources`加法SQLite表位于既有Companion数据库，以认证owner、库、规范化根和captureId隔离。保存原始路由与注册文档用于历史核验；原始Obsidian文件不改动。重复捕获核对公共内容、路由与语义来源指纹，返回原回执及原文档，不因机器管理的索引/状态变化覆盖旧副本。

来源基础设施在索引锁下读取owner-aware effective gateway，核对注册/碰撞、原生签名、本机绑定、来源及状态文档、目录与文件双读围栏；历史读取只核对保存文档，不借用当前题库。应用用例另检查当前配置库，HTTP层只装配与返回。共享`course_study_domain.py`承载任务/诊断/补练规则，使用同一JSON夹具核对TypeScript/Python哈希和边界。

`native-course-v1`能力标记控制网页接入。旧Companion没有该能力时，网站仍可可靠保存原答并保留待核对，但不能借旧判题服务产生V2诊断或正式成绩。来源捕获、原答保存、评价回执、正式认领与正式成绩写入分别验证，不互相冒充。

### 判题、正式联锁与网页恢复

`POST /v1/course/grade`接收独立V1封闭请求：原生身份、捕获ID、完整原作答绑定、作答身份、答案修订、任务hash及不可变提交。支持evaluate和用户明确触发的self-assess；AI弃权不自动切换自评。服务读取认证所有者的不可变来源，按现有模型配置和预算运行；选择题按核验后的正确集合确定性核对。来源围栏在模型运行前后核对。来源变更、未知、取消或异常保留原答，不生成正式结果。

SQLite新增native_course_attempts/requests/request_inputs/formal_slots/claims表，不迁移历史。作答原答与请求动作指纹在运行前持久保存；回执只在事务提交并回读验证后返回。相同请求复用原回执；过期运行保留未知，不猜测执行完成。已可靠诊断不能被迟到pending降级。浏览器身份不等同认证所有者，不能据客户端owner绕过库隔离。

`POST /v1/course/claim`校验已保存的首轮诊断、冻结答案与辅助等级、评级和发生时间，再原子占用该所有者/库/来源/组/回合的首轮位置。guided/remediation不能认领首轮。正式V3 writer在投影前和事务提交前复核来源、可信认领、评级及日期；来源中途变化回滚本次事件与管理块，不回滚协作者的独立资料修改。已有V3重复与冲突沿用旧writer计数规则，不改变StudyEventV3含义或调度。

网页原生来源缓存保存经过认证获取和哈希核验的最小NativeCourseItem，明确不同于portable StudyItemVersion。按owner/library与完整原作答绑定持久关联capture；pending恢复只读对应旧捕获，不套用新参考，不伪造stateRef或可发布资料。诊断侧车复核该原生关联；native数据不能进入账号portable证据同步端口。

共享宿主只在匹配的课程诊断已持久保存后允许正式评级，不能用旧回忆自评意图补造课程结果。原始answer字段沿用作答V1契约。课程补练与引导尝试独立保存，首轮代码/答案和正式结果保持；取消后的迟到响应不主动改变网页反馈，显式恢复沿用同一请求身份。回退需保留新增SQLite/IndexedDB表与回执，不删除原答；旧代码对新课程能力显示限制。

管理投影的兼容修复：无H1而有YAML的状态文档，管理块插入frontmatter之后，保持原LF/CRLF、BOM和块外字节，避免正常投影使来源下一次失去登记身份。它不改变词汇题型、正式分数或资料正文。

先Node/Python共享任务/诊断/hash夹具，验证中英/整数JSON/引用/unknown；再原生现行捕获、来源切换围栏、旧版本read、两个用户/库隔离、请求/回执丢失、child固定任务、刷新/断网、旧程序unsupported。实际打包/安装门禁按单一program-files清单；源码不等于用户安装已升级。

新存储仅加法，不改原文件或旧记录/调度；回退代码保留捕获/答案/诊断。合并、部署、Companion发布与安装分别授权。没有真实模型/手机/用户试用时仍不能完成第二阶段验收。
