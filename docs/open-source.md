# Public distribution boundary / 公开边界

| Published / 公开 | Not included / 不公开 |
| --- | --- |
| Project source, tests and reviewed generic architecture | Private development history and work-in-progress branches |
| English and Chinese user/developer guides | Agent handoffs, internal plans, raw operational logs and unreviewed screenshots |
| Original synthetic course/paper fixtures | Personal notes, learner answers, courseware and third-party paper source excerpts |
| Empty configuration examples and a neutral hosting template | Production project bindings, credentials, account state and local paths |
| Third-party notices and locked dependency metadata | Installer/runtime binaries in Git; separate binary redistribution needs its own verification |

The public repository starts with a reviewed source snapshot. There is no hidden private branch inside this public repository. Future imports must repeat the content/provenance review; copying a private repository wholesale is not the update process.

Public checks include documentation links and excluded-content rules plus a pinned secret scanner. A scanner finding may be a false positive, but every exception must have narrow scope and a concrete explanation. Never ignore all tests, all history or all generic-key rules to make a scan pass.

No scanner guarantees absence of every sensitive fact. Review content, screenshots, sample provenance, dependency licenses and archive contents in addition to credential patterns. User issues and PRs must also be sanitized.

源码公开不改变官网、用户学习数据或本机安装。MIT 不包含第三方资料的再分发授权。未来从私有开发引入更新时，重新检查内容与来源，不直接推送私有 Git 历史。
