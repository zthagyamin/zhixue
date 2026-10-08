# M5 后端接口与修改规则

本阶段从 M4 `de01c116a146f3619112cd230c56374e09af17c7` 继续，决策见 [ADR-008](adr-008-backend-boundaries.md)。保留 HTTP、事件、内容身份和数据库协议；不修改 FSRS 或真实学习成绩。候选代码、网站部署与 Companion 发布/安装分别验收。

## 账号与同步后端

| 边界 | 责任 | 新增功能的位置 |
| --- | --- | --- |
| `domain/ai`、`domain/account-study`、`domain/sync` | 数据契约、严格请求解析、错误/身份规则 | 纯输入输出，不读设置、凭证或网络 |
| `application/account-study` | 账号范围、读取、计划、记录、辅助请求与 AI 生命周期 | 从具体用例文件进入；依赖 `ports.ts` 的窄仓储/供应商接口 |
| `infrastructure/account-study` | 授权顺序、HTTP 解码/错误/SSE 编码、供应商配置装配 | 保持浏览器与机器身份、来源校验、限制和响应头 |
| `infrastructure/ai` | 提供商请求、模型列表与流解析 | 原有地址及密钥限制继续成立，不能把浏览器传入地址与旧密钥任意组合 |
| `application/sync`、`infrastructure/sync-server` | 逐事件回执与 legacy/native 同步持久适配 | 服务端 D1 不从浏览器同步模块重导出 |
| `infrastructure/database` 与旧 `db` 实现 | 表定义、连接创建、现有 D1 仓储 | 旧实现结构性满足端口；兼容路径保留同一表对象，不复制写入口 |

旧 `app/account-study-api.ts`、`app/sync-v3-api.ts`、AI 文件和 `db/schema.ts` 保持兼容装配或转导出。新应用模块不得通过这些旧路径绕回页面/数据库。新操作不能继续写进路由中的大条件分支，应增加对应应用用例和必要的端口。

AI 请求先获得原有预算预留。取消监听覆盖提供商准备期和输出期；准备期间取消不能启动流。只有 `complete` 持久成功后才能发出 `done`。提供商、完成保存或失败保存异常都不能伪装完成。重复请求复用原结果，不能再调用提供商。客户端丢失响应不撤销已经持久化的结果。

## Companion

`routes_study/planning/sources/ai.py` 承接授权后的 HTTP 输入和响应。`application` 中的 Study、Planning、Source、AI 用例只拿命名端口；`infrastructure` 绑定现有 SQLite、资料库、文件、模型与配置服务。它们不能导入 server 或 routes，也不能传入整个 server 模块或使用全局反射寻找服务。

原 Native/Indexed Writer 的数据库事务、追加记录、条件文件恢复与锁顺序保留在基础设施中。原资料读取、日报、旧事件、学习池和生成内容规则分别抽出；server 保留旧函数的薄入口、启动/配置、授权及既有外部服务装配。历史 Python 模块仍有待逐步细化，本阶段没有宣称全部 Python 代码均完成分层。

读取资料时路径按阶段绑定：索引探测使用一个来源；进入 legacy 读取时，在锁内重新取得当时的 STATE 与资料库路径，此后标识、批准资料和练习复用同一路径。刷新可切换配置与 STATE，必须在刷新结束后重新绑定，不能沿用探测阶段的旧路径。

## 可执行约束和验证

`npm run architecture:check` 同时运行 TypeScript 和 Python AST 检查。Python 检查只覆盖新的 `companion/application` 与 `companion/infrastructure`：450 行/32 KB 上限、导入方向、启动层反向依赖、动态依赖/全局替换、应用层直接 I/O/环境时钟、导入环、程序清单闭包。检查不导入或执行业务源码；其故障注入回归包括类型保护分支中的反向导入、动态服务查找、缺文件和压行增长。

这不是完整的数据流安全证明。反射别名、调用约定及跨线程配置变更仍须独立审查和行为测试；现有遗留模块没有借此获得新增长豁免。`architecture.config.json` 的旧预算没有扩大。

验收保留完整 `npm test`、完整 Python、原 462 个浏览器场景，并增加 32 个桌面/窄屏、浅色/深色后端场景。新浏览器场景通过真实 HTTP handler 与生产流解码器，使用合成身份、模型和存储端口，覆盖正常与重复结果、模型失败、完成/失败保存异常、准备/输出期间取消、错误库和无效身份；它不证明真实模型效果或生产账号可用。

Companion 唯一程序清单仍是 `program-files.json`。新增嵌套模块必须通过实际新 ZIP 的内容比对、EXE 校验、隔离安装导入，以及旧配置/数据库保留测试。测试在临时目录安装，不发布或替换仓库中现有下载包，更不升级用户实际安装。

回滚时将用例、适配器、薄入口与程序清单作为同一组回滚。没有数据库迁移；不得清空正式事件、预算记录、配对配置或来源笔记来回滚代码。
