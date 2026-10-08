# Data and privacy boundaries

[简体中文](../zh-CN/privacy.md) · [Get started](getting-started.md) · [FAQ](FAQ.md)

This document explains the public 1.41.1 implementation boundaries. It is not a promise that every deployment, optional integration, or third-party service has identical settings. The hosted service, your Companion, your browser, and any API provider are different processing locations.

## Source ownership and permission

Original notes, PDFs, and course materials remain managed by the selected source. A local Obsidian vault or folder is not converted into a cloud-owned repository by connecting it. Notion, when chosen, is already an external service.

Connect only material you are entitled to read and process. Access rights do not automatically include the right to send it to a model or publicly redistribute it. Start with a small source, inspect the preview, and check permissions before enabling cloud/AI paths. A document filename is not proof of a valid source binding.

## Processing by feature

| Feature | Processing and persistence |
| --- | --- |
| Browser note trial | Selected Markdown/TXT or pasted text is read in the page without upload or AI. The trial extracts up to three prompts. Answers and retry marks are temporary and do not survive leaving/reloading. |
| Saved trial materials | Explicit saving retains material/questions in the current browser's scoped storage; it does not automatically synchronize with the account or write to Obsidian. |
| Local Companion | Reads authorized sources, manages local source mappings/credentials, and performs supported writeback. Local configuration, databases, caches, and backups remain local artifacts. |
| Account learning | Enabled services receive structured practice content, plan/progress data, and supported immutable learning events. Such content can contain question/reference text derived from notes. Source mapping and account data have separate roles. |
| AI | Enabled requests transmit the question, quoted/selected/page context, learner answer, code, or errors as relevant to the operation. The selected provider processes these according to its own terms. |
| Notion | Reads explicitly authorized pages; optional learning-record writeback uses a separately configured parent page. Source and destination permissions matter independently. |

A portable/“cloud-safe” contract restricts fields and identities. It does not anonymize every permitted free-text field or guarantee that a learner never included sensitive information. Do not put secrets into source text or answers.

## Credentials and model use

Local-mode AI keys and Notion authorization use the system credential store through Companion. Account-mode model keys are independently configured and encrypted in the account service. These are different storage scopes; the local key is not automatically published as an account key.

Encryption at storage is not end-to-end secrecy from the service performing the API request. The selected API endpoint receives the key needed for authentication and the request content. A custom API address changes the recipient; review it before using your key.

AI settings require acknowledgment of content transmission and possible charges. Usage is billed to the API account associated with the configured key, subject to provider limits. A connection test makes a real API call with a fixed check message, not the current learning page. Model availability and connection success do not establish judgment accuracy.

The copy-prompt tool writes text to your clipboard; it does not itself send it to a model. If you paste it into another service, inspect the included context and follow that service's terms. Do not send keys or pairing codes through conversations.

## Identity, copies, and writeback

Hosted account features use the configured identity and account/library isolation. Browser drafts, local data, cloud copies, and source writeback have separate receipts. “Saved here” does not mean “written everywhere.” Retrying a logical submission should not duplicate formal learning results.

First attempts, assisted attempts, remediation, pending evaluation, and formal events have distinct purposes. Unknown evaluation must not be presented as a grade or proof of mastery. A file export or successful synchronization is not a learning result.

Closing Companion pauses local reads/writeback. It does not cancel every cloud action or erase copies already saved. Browser storage is tied to the device/profile and can be lost when cleared. Keep original materials and use supported recovery exports before moving devices or deleting local data.

## Retention, deletion, and backups

Do not infer a universal retention or complete-erasure policy from this source document. The implementation stores different categories in different places, and third-party providers have their own retention behavior.

Inspect the current app's data-management controls and their scope before using them. Removing a source connection does not by itself prove that all previously imported content, cloud records, local backups, or API-provider copies are erased. Formal event immutability is an integrity property, not a blanket declaration about legal deletion rights. Any broader deletion requirement must cover the actual destinations and be designed and verified explicitly.

The Companion update workflow uses local backups to protect configuration and learning data. Those backups can retain sensitive data after an update or source removal. Treat backup and export files as private; do not attach them to a public issue.

## What belongs in the public repository

Public source includes project-authored code, reviewed configuration templates, documentation, tests, and permitted synthetic examples. It must not include credentials, pairing codes, private vaults, learner records, local databases, account identifiers, sensitive paths, or unredacted operational logs/screenshots. The clean public import does not expose private development branches/history.

Third-party assets and imported materials retain their own rights. Build inputs downloaded outside Git are not automatically approved for public redistribution. See [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Reporting safely

Prefer a minimal synthetic reproduction. Redact material, answers, identifiers, source paths, tokens, pairing codes, and keys from text and images; check filenames and browser/UI details too. Avoid posting exported databases or complete recovery bundles.

Use ordinary [Issues](https://github.com/zthagyamin/zhixue/issues) for non-security bugs and [SECURITY.md](../../SECURITY.md) for suspected vulnerabilities. Publishing the source does not certify every configuration or replace a security review of your deployment.
