# 历史维护说明（不是当前安装教程）

当前步骤请看安装目录中的 README.md，或访问 https://zhixue-daily.zthagyamin.chatgpt.site/companion-guide 。下方保留旧模式和迁移背景，正常安装、更新不需要执行这些命令。

---

# 知学 Companion（Windows 试用版）

Companion 在你的电脑上读取你明确授权的学习资料。默认旧同步只发送结构化进度和学习事件；用户另行启用“账号题库”后，已登记词卡及练习所需题干、答案、解析和代码素材也会进入账号云空间，供同账号手机使用。未登记原笔记、本机路径、机器凭据和本机 DeepSeek Key 不上传。

## v1.9 固定学习库索引

推荐模式的唯一入口是学习库 `_System/Integrations/Study Loop/gateway/index.md` 和 `subjects/*.md`。索引只存配置与双链，学习内容、结果卡、练习日志和进度留在各学科目录。没有 gateway 的旧库保留以下旧版方式；gateway 已存在但损坏时明确报错，不退回全库扫描。

在本目录执行：

```powershell
python gateway_cli.py --vault "C:\你的学习库" init
python gateway_cli.py --vault "C:\你的学习库" add-subject --id biology --name "生物学" --domain biology --plugin quiz --root "01 学习/生物学"
python gateway_cli.py --vault "C:\你的学习库" validate
```

新增学科登记一次，之后在登记目录增加符合协议的 Markdown 内容即可。支持 `zhixue-content`、词库、来源表和学习结果卡。固定目录约每分钟检查；也可在网页立即同步。新增兼容学科/内容不需要升级或重启；新题型、协议版本和程序修复仍需要更新。

本次需升级并重启一次 Companion。升级保留原数据库和账号映射。换机时应一并迁移原 Companion 数据或使用已启用的云同步，不能把旧账号隔离日志自动归给新账号。浏览器阶段/FSRS 可从验证过的事件重建；不会推断缺失的历史答题计数或正式 mastery。

以下 sources 审批、中央 sessions/学习结果和每日扫描说明仅适用于旧模式或历史审计。

## 一键安装或更新

1. 在 64 位 Windows 上从知学网站下载并双击 `Zhixue-Companion-Setup.exe`，无需预装 Python 或 Obsidian。安装包附带离线运行环境。
2. 安装程序寻找当前 Windows 用户已注册的旧目录，备份后原地更新；早期便携版可按提示选择旧目录。新安装默认保存在当前用户的个人程序目录。
3. 新用户自动获得独立学习空间；旧用户的配置、知识库路径和数据库保持原样。
4. 保持 Companion 窗口开启，在自动打开的网站中登录自己的账号并输入一次性配对码。端口冲突时新安装会选择空闲端口，自动打开的链接带有相应设置。
5. 在数据源页面的「连接你的笔记」中选择文件夹、文件、Notion 导出或在线页面，检查预览后确认。没有历史记录的新安装也可在这里改用已有 Obsidian 库。
6. 如需 AI，在网页 AI 设置中配置；凭据保存在本机系统凭据库。

### 多种笔记来源与 Notion

- 普通目录与单文件支持 Markdown、TXT、HTML、CSV、可提取文字的 PDF。CSV 应包含词汇/释义列或问题/答案列。扫描 PDF 需先识别文字。其他笔记软件可通过这些导出格式接入。
- Notion 离线导出选择 **Markdown & CSV**，把 ZIP 保存在本机，再在来源设置中填写路径。无需手动解压。
- 在线 Notion 只读取明确填写的页面（最多 10 个）。在本机表单填写个人访问令牌或内部连接令牌；内部连接需要在 Notion 来源页面中添加该连接。令牌不会存入网页本地存储或上传到知学网站。
- 勾选学习结果写回时，填写另一个独立记录父页，并授权读取及新增内容。知学按日建立子页，只追加已经持久接收的真实练习记录；不修改原始笔记，不把同步成功当作掌握。
- 文件约每分钟检查、Notion 约每五分钟读取；需要保持 Companion 运行。可点击「立即同步并核对」。读取失败保留上次完整版本，写回失败保留队列。
- 「待核对」表示请求结果不明确；系统先查远端标识，避免重复提交。不会盲目创建第二份记录。授权失效可在「更新来源与授权」中修复。
- 停用会停止该来源的自动读取和写回，并从当前练习目录隐藏，原始文件和已保存历史仍保留。重新启用后继续处理。

### 不同用户与安装位置

每个 Windows 用户使用自己的安装目录、学习空间和系统凭据库。一份安装绑定一个知学账号；误登录时切回原账号。需要同一 Windows 用户使用多个知学账号时，应使用不同的便携目录并从各自程序打开网页，不要删除数据库来切换身份。已有学习记录后不能直接改学习空间；添加新资料目录请使用来源设置。

离线运行环境损坏时重新运行安装程序修复。旧数据备份保留；安装失败不会清空知识库。安装包目前提供 Windows x64 运行环境，未验证其他系统或架构。

以后可以在知学网站点击“启动已安装 Companion”，也可以双击 `start-companion.cmd`。浏览器首次调用时，Windows 可能要求确认打开本地应用。

便携 ZIP 仍然保留。解压后双击 `install-companion.cmd` 或 `upgrade-companion.cmd`，也会进入相同的自动更新流程，不需要手动把新版文件复制到旧目录。更新前会备份原有 `config.local.json`、`data` 和被替换的程序文件；失败时自动恢复。

完整资料同步每天执行一次；轻量变更候选每 15 分钟检查一次。需要立即检查时，在网站点击“立即扫描”，需要立即刷新全部学习内容时点击“立即同步”。

## 学习会话读取适配

Companion 会只读扫描 `_System/Integrations/Study Loop/sessions/YYYY/MM/*.md` 中
`type: learning-session` 的会话记录，并将当天会话与网站练习事件合并到今日面板的活动统计。
会话按 `session_id` 去重；来源链接、状态和薄弱能力仅作为证据展示，不会改变课程掌握状态、复习队列或正式计划。
网站练习题仍只由 `01 学习/学习结果/` 中的 `learning-result` 卡生成。

## v0.10 权威学习计划迁移

v0.10 把当前正式计划放在 `01 学习/学习计划/00 学习计划总览.md`，把学习约束放在同目录的 `01 学习约束.md`。Companion 只修改两个文件中的知学托管块，不改托管块外的用户文字，也不删除旧 `plan/revisions.jsonl`。

迁移必须依次执行：

```powershell
python authoritative_migration.py preview --vault "C:\你的\Obsidian Vault"
python authoritative_migration.py apply --vault "C:\你的\Obsidian Vault" --preview-id "上一步返回的 previewId"
```

如果应用后需要撤销，使用 `apply` 返回的 `backupId`：

```powershell
python authoritative_migration.py rollback --vault "C:\你的\Obsidian Vault" --backup-id "migration-..."
```

`apply` 会再次核对预览涉及的文件哈希。只要用户在预览后修改过相关文件，迁移就会停止并要求重新预览，不会覆盖新内容。

旧版 `reset-companion.ps1` 是破坏性的维护工具，不用于正常切换账号或更新安装；正常使用请保留原安装，切回其绑定账号或建立独立安装目录。

## 数据边界

- 一份 Companion 安装目录只能绑定一个网站账号。
- 配对码连续输错 5 次会自动作废；会话最长保留 30 天。
- 本地配置写入 `config.local.json`，不会包含在分享包中。
- 普通本地笔记目录会递归读取 Markdown、TXT 和 PDF，并忽略隐藏目录、`node_modules` 与缓存目录。
- 本地学习数据库位于 `data/study-loop.db`。
- 换电脑不会自动同步；需要重新配置或使用未来的加密导出功能。

## v1.0 Codex 学习捕获与资源快照

Codex 学习会话结束并写回知识库时，通过本机 Companion 的 `POST /v1/capture`
上报结构化捕获记录（同一 `captureId` 幂等）：

- **显式负向证据**（`evidence: "explicit"`：用户说"不记得"、实际答错、依赖提示、迁移失败）直接进入
  唯一计划托管区的"知识缺口与到期复习"，并标记已处理。
- **推测性学习项**（`evidence: "speculative"`：仅因内容重要而建议）只写入 `sources/pending/` 候选区，
  不自动进入正式复习。
- 同一 `itemId + abilityId` 的重复负向证据强化同一条目，不重复创建；缺少
  `stateRef`/`abilityId` 的捕获标记为未映射，不写正式状态。

Vault 内的资源快照目录：

```text
sources/
├── approved/   # 已获准快照：schemaVersion/captureId/itemId/domain/sourceNote/
│               # stateRef/abilityId/contentFingerprint/approvedAt/pluginType/planRevision
├── pending/    # 推测候选（等待用户批准）
└── rejected/   # 用户拒绝的候选（保留审计）
```

网站学习池由 `sources/approved/` 的获准快照驱动；`current_source`/`next_source`
仅保留兼容读取，不再决定学习内容。`POST /v1/sources/init` 初始化目录结构。
