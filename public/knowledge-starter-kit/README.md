# 知学知识库入门包

从一份能核对的材料、一次真实作答开始。无需先搭复杂知识库，也不需要购买 AI 服务。

网站首次进入会展示七步新手教学，可以跳过；之后可在首页或“数据与设置”点击“新手教学”重新打开。本入门包是可下载的详细资料，不代替你自己的实际作答。

## 先选一条路

| 你的情况 | 从哪里开始 |
|---|---|
| 没有笔记库 | 解压入门包，按 [10 分钟上手](QUICKSTART.md) 接入 `Starter/materials/` |
| 已有 Obsidian 或普通目录 | 保留原件，选一个小目录；见 [Obsidian 教学](OBSIDIAN.md) 或 [接入说明](CONNECTIONS.md) |
| 使用 Notion | 在线页面或 Markdown & CSV 导出；见 [接入说明](CONNECTIONS.md) |
| 想让 AI 整理 | 在网站填写目标、基础和时间，复制提示词，连同自己的材料交给 AI |

下载与编辑无需账号；连接 Companion 和跨设备学习需要登录知学。新安装自带运行环境，无需安装 Python 或 Obsidian。Python 从新来源入口导入需要 Companion 1.15.1 或以上。

## 解压后有什么

```text
knowledge-starter-kit/
├─ README.md               本入口
├─ QUICKSTART.md           第一次接入和学习
├─ CONNECTIONS.md          普通目录、Obsidian、Notion
├─ OBSIDIAN.md             从零建库、已有库接入与学习记录
├─ WORKFLOW.md             每天学习、每周整理
├─ TROUBLESHOOTING.md       常见问题
├─ Starter/
│  ├─ materials/           词汇、Python、概念、课程、论文阅读示例
│  └─ records/             自己填写的真实学习记录
└─ Templates/              空白模板，复制填写后再使用
```

根目录保留可单独下载的同名示例。**只接入 `Starter/materials/`，不要选整个解压目录**，避免把指南和空模板也变成练习。

## 材料和学习证据分开

- 示例标记 `generated: true`、`learning_status: unattempted`，不是原文引句、真题、学习记录或掌握证据。
- 先用示例检查接入，再换自己的材料。保留来源标题、章节或页码；缺失写“待补充”。
- 练习先作答，再看提示与答案。AI 生成的答案需要核对，不填写虚构正确率、练习日期或掌握等级。
- 示例代码只使用基础 Python。初始代码、测试、参考实现分别保存，无需虚构来源或学习状态链接。

## 已有固定索引用户（fixed-index）

推荐在「连接你的笔记」接入小目录。原有「资料结构映射」仍可使用：把材料放在学习库的 `Starter/materials/`，按下表预览后确认。

| 相对路径 | 学科标识 | 名称 | 类型 | 拆分方式 |
|---|---|---|---|---|
| Starter/materials/vocabulary.md | mapped:starter-vocabulary | 入门词汇 | vocabulary | table |
| Starter/materials/python.md | mapped:starter-python | Python 入门 | code | table |
| Starter/materials/concepts.md | mapped:starter-concepts | 概念回忆 | quiz | table |

不要同时用两个入口重复导入。不要把教材放进 `_System` 后就认为已登记；系统目录不会作为普通教材扫描。接入生成练习内容，不代表正式掌握状态已经建立。
