# 开发指南

[English](../en/development.md) · [贡献指南](../../CONTRIBUTING.zh-CN.md) · [架构入口](../architecture/README.md)

本指南对应公开 1.41.1 源码基线及其打包适配，不承诺一条命令获得完整生产能力。普通用户可先使用[在线笔记试学](getting-started.md)。

## 环境要求

- **Node.js >=22.13.0** 和 npm；标准验收路径使用支持的 Node 22 版本。
- 源码 Companion 开发及涉及 Python 的测试使用 **Python >=3.11**。
- 完整 Windows 发布/安装验收与 `package:companion` 使用 Windows x64、PowerShell 7。
- npm 依赖和发布校验所需固定发行资源需要网络。

网页使用 React、TypeScript、Vite/vinext、Sites Vite 集成与 Cloudflare Workers/D1；Python Companion 是独立本机服务。公开仓库从干净导入开始，不包含私有开发历史。

## 安装依赖

从公开仓库或自己的 Fork 开始：

```sh
git clone https://github.com/zthagyamin/zhixue.git
cd zhixue
npm ci
```

以 lockfile 为依赖依据。安装可能出现既有依赖警告，应如实报告，不隐藏失败，也不通过自动破坏性升级消除审计数字。

标准 Windows 验收环境，在 PowerShell 7 中执行：

```powershell
python -m venv .venv
$env:PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
& $env:PYTHON -m pip install -r companion/requirements.txt
npm test
npm run test:python
```

`PYTHON` 指向 Node 测试包装器使用的真实解释器；不要填写展示名称。解释器必须安装所需 Python 依赖，`npm ci` 不会替你安装它们。

其他系统可以建立 venv、安装同一 requirements，并把 `PYTHON` 指向相应解释器。相关网页/领域测试有价值，但含平台跳过的 Linux/macOS 运行不能代替 Windows 安装验收。

## 下载资源不是 Git 源码

公开副本不把旧维护者 EXE/便携包或内置运行环境 ZIP 提交 Git。公开准备钩子在构建/测试前，按版本化固定 URL 获取所需发行资源并核对 SHA-256；EXE 和便携包合计约 **27 MB**。它们是构建/校验输入，不代表新开源二进制发行，也不会因此自动安装。

网络、下载或哈希失败应停止准备。禁止删断言、把预期哈希改成收到的值，或随意替换二进制。下载资源和生成输出不要提交。单一下载清单位于 `src/infrastructure/downloads/index.mjs`，地址和哈希依版本而定。

Companion 打包另需匹配 `runtime-manifest.json` 的 `companion/runtime-windows-x64.zip`。开发 venv 不能替代此包。准备或分发时需要官方上游运行环境及依赖、完整性核对与对应许可声明，见[第三方声明](../../THIRD_PARTY_NOTICES.md)。此 ZIP 有意不进 Git。

## 运行网页开发服务

```sh
npm run dev
```

使用终端实际显示的本机地址，不猜固定端口，不沿用已结束预览的 URL。开发 middleware 含模拟登录，仅供本机开发，不是生产认证。

`.env.example` 默认关闭账号功能。需要配置时，只把文档变量复制到已忽略的本机环境文件，理解所需服务前提；不把生产 Token、数据库或私人笔记目录复制到源码。

当前应用依赖 Sites 提供身份和已配置的 D1 绑定。本地模拟身份、占位数据库绑定或页面渲染成功，不证明真实账号隔离、部署或双设备同步。替换生产身份/托管适配器需要单独设计和测试，本测试版没有受支持的一键跨供应商生产自托管方案。

Companion 源码开发使用 `companion/requirements.txt`、配置模板及当前[Companion 指南](../../companion/README.md)，选一次性合成来源与独立数据目录。打包启动器/安装器路径需要配套运行环境，缺失发行环境不等于 Python 源码错误。

## 验证命令

| 命令 | 内容 |
| --- | --- |
| `npm test` | 完整架构、发布一致性、lint、类型、生产构建和 Node 回归链。 |
| `npm run test:node` | 仅 Node 回归，不代替完整链。 |
| `npm run test:python` | 通过已选 Python 执行 Companion unittest。 |
| `npm run architecture:check` | 层级/依赖约束和受控旧代码预算。 |
| `npm run typecheck` | TypeScript 检查。 |
| `npm run lint` | lint；既有警告与新增错误分别报告。 |
| `npm run build` | 生产构建及资源准备/输出校验。 |
| `npm run package:companion` | Windows 打包，另需准备发行运行环境。 |

默认使用合成材料与模拟提供商。不为测试调用付费 AI 或写个人成绩。报告实际命令、退出码、失败、跳过及未验证的浏览器/材料路径。本指南不宣称你的副本已通过测试。

公开基线夹具绑定首次导入源码树，而不是不可访问的私有提交。基线适配必须保留评价、可靠保存、取消和恢复的行为断言。

## 代码放在哪里

纯规则进 `src/domain`，用例/ports 进 `src/application`，适配器进 `src/infrastructure`，交互进 `src/features`。`app`、`worker` 含路由、装配与旧兼容入口。`companion/program-files.json` 仍是唯一打包/安装清单。协议、调度、持久化或架构预算修改前先读[贡献指南](../../CONTRIBUTING.zh-CN.md)。

## 排障与发布边界

- **找不到 Python：** 配置 `PYTHON`，确认同一解释器能导入依赖。
- **发行资源不匹配/离线：** 核对固定清单和网络结果，保留失败，不放松校验。
- **缺少运行环境 ZIP：** 源码测试与二进制打包输入不同，所需安装测试前先准备官方匹配包。
- **账号/AI 不可用：** 核对功能开关与服务配置，不把账号故障当作本地领域规则故障。
- **预览无法连接：** 核对正在运行的地址和进程，构建成功不代表预览正在运行。

代码合并、网站部署、Companion 发布与用户安装分别处理，身份和回执分别记录，不用一种证据宣称另一种完成。漏洞按 [SECURITY.md](../../SECURITY.md)报告。

