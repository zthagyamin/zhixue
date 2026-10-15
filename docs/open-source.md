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

## Repeatable selective imports / 后续选择性同步

1. Record the public base commit and reviewed source versions outside the published tree. Compare changes from the previous source baseline; do not replace the public checkout wholesale or fetch private Git objects into its object database.
2. Select source, tests, migrations and generic contracts together. Resolve dependencies before splitting PRs. Preserve public-only documentation, original synthetic examples, empty configuration, license files, asset preparation hooks and independent public history.
3. Merge public adaptations against their prior source baseline. Verify incoming file hashes, inspect conflicts and review every new sample, image, archive and third-party dependency for redistribution rights. Operational logs, internal plans and real learning materials stay outside the public tree.
4. Run `npm run open-source:check`, the applicable regression suite, the full public-history secret scan and a manual content/provenance review. A failed or unavailable check is not a pass. Check both tracked files and non-ignored candidates before staging.
5. Publish a focused PR with its scope, compatibility, actual evidence and unverified paths. Creating a source PR does not authorize deployment, binary publication or user installation.

The machine-readable [distribution policy](../public-distribution-policy.json) rejects excluded paths, private markers, local operator paths, unsafe file modes, broken published-document links, changed license/configuration invariants and missing preparation hooks. It pins original examples and the public baseline. A hash change requires a deliberate content/provenance review and an explanation in the same PR; never regenerate all hashes to silence a failure. New exceptions need exact scope, evidence and a reason.

The guard has behavior tests in `tests/open-source-policy.test.mjs`. Its output complements the pinned credential scanner and human review; it does not prove that every sensitive fact or licensing issue has been detected.
