# Legacy sources and compatibility / 旧来源兼容

This is a source compatibility reference, not the default installation guide. Normal updates preserve local configuration and learning data; do not reset a learning library to repair a connection.

The supported snapshot area is `_System/Integrations/Study Loop/sources/`, with separate `approved`, `pending` and `rejected` states. Only approved content is eligible for the formal source pool; pending candidates do not imply acceptance or mastery.

Snapshots use stable `captureId` and `itemId` identities together with source version and mapping information. Replaying the same capture must remain idempotent. Learning capture distinguishes `explicit` evidence, such as an observed or reported gap, from `speculative` recommendations that still need confirmation. The `sources/approved` directory is a projection of authorized source/state, not a second authoritative learning vault.

Use your own library directory through the normal setup and source-registration UI. No developer's absolute path, account configuration or personal courseware is required. Back up configuration and data before invoking an explicitly reviewed migration. Never edit old formal events in place or run reset scripts as an ordinary update step.

中文：此文件说明旧来源兼容，不是首次安装流程。普通更新保留配置和学习数据。候选、已批准与拒绝资料分开处理；原始资料和正式状态仍由原权威位置管理。只有明确授权的迁移才可运行，先备份，不用清空学习库代替修复。
