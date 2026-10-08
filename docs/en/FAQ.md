# Frequently asked questions

[简体中文](../zh-CN/FAQ.md) · [Get started](getting-started.md) · [README](../../README.md)

## Is Zhixue a course catalog or a replacement for Obsidian?

No. It is a practice and review interface for materials you select. The original material remains in your local vault/folder or connected source. Importing material, generating a summary, or finishing a round does not prove mastery.

## Do I need Companion, Obsidian, or an AI subscription to begin?

The browser note trial needs neither Companion nor an API key. Follow the site's sign-in prompt where required. Obsidian is optional. Companion adds supported ongoing source access and local writeback; AI features need their own API configuration and may cost money. A ChatGPT website subscription is not API credit.

## Does all of my data stay local?

No. The note trial processes selected text in the browser without upload or AI. Other features have different boundaries: enabled account synchronization carries structured practice content and learning/plan information; API requests carry relevant question/context/answer text. Some practice text is derived from original notes. Notion is itself an external service. Inspect the source and settings before enabling those paths.

Local source mappings and local credentials are handled by Companion. Account-mode API keys are separately configured and encrypted in the account service, rather than copied from the local credential store. “Cloud-safe” export means a restricted data contract, not a guarantee that no personal text could appear in an allowed field.

## Can I use it offline, on macOS, Linux, or a phone?

The web interface supports narrow screens, but this is not full offline functionality. Cloud services and AI need connectivity; source operations need the relevant Companion to be running. Supported browser-local material features remain device/browser-specific.

The packaged Companion workflow targets Windows x64. No macOS/Linux installer is promised. Phones and tablets can use supported browser/account features; they cannot run the Windows executable or directly operate another computer's local Companion. Real physical devices and cross-device learning still need broader validation.

## Why do I still see example content after pairing?

Installation, pairing, source registration, and account-library activation are separate. Preview and confirm a small source under “连接你的笔记”, then inspect the connection/sync status. A successful connection check alone does not prove your intended questions were imported.

## Why did my trial answers disappear?

Note-trial answers and retry marks are temporary page data. Saving trial materials separately saves the questions/material in this browser, not the answers or formal grades. Keep the original file and use supported backup/export controls before changing devices or clearing storage. Other study modes have their own persistence rules; read their save status.

## Does “saved” mean it is already in my vault and on every device?

No. Browser save, account synchronization, and source writeback have different receipts. Pending records should not be discarded while troubleshooting. Keep unsaved input, preserve backups, and inspect the destination-specific status rather than repeatedly recreating a library.

## Is an AI grade authoritative? What does “pending” mean?

AI can be wrong or lack enough evidence. Unknown/pending evaluation is neither a correct nor an incorrect grade. Feedback should be checked against the source, and source extraction errors should be corrected. First attempts and remediation are distinct; later success does not erase the first attempt or establish long-term retention.

## What can the programming and math plugins verify?

Programming supports the included Python execution path and supplied cases. Passing those cases is not a proof of complete correctness or safe execution of arbitrary untrusted code. C/C++ production execution is not promised by this baseline.

Math checks are bounded: supported numeric/symbolic comparisons and mapped related exercises. They do not verify arbitrary proofs or every expression. Unsupported cases may abstain. The [development guide](development.md) describes implementation and security boundaries.

## Can it read any PDF or Notion workspace?

No. PDFs must be readable within the relevant importer's limits; scans need OCR elsewhere, and complex columns, formulas, and figures require checking against the original page. Notion reads explicitly authorized pages rather than automatically traversing a workspace. Writing records requires a separate configured destination and permissions.

## Is self-hosting one command?

Not for full production parity. Source development is supported, but the current production service depends on Sites identity and D1. A checkout has neither production credentials nor a ready-made alternative identity provider. Development mock authentication is not suitable for an exposed service. Start with [development](development.md) and the documented hosting prerequisites.

## Does the MIT license cover my imported materials and downloaded runtimes?

No. MIT covers project-authored code as stated in [LICENSE](../../LICENSE). Your materials and third-party papers, dependencies, fonts, and binaries retain their own rights and terms. See [third-party notices](../../THIRD_PARTY_NOTICES.md). Open source does not by itself grant access to the hosted service or guarantee its availability.

## How should I report a problem?

Use [Issues](https://github.com/zthagyamin/zhixue/issues) for reproducible non-security problems. Include the version, OS/browser, entry point, steps, expected/actual result, and a minimal synthetic example. Redact credentials, pairing codes, account identifiers, private notes, answers, and sensitive paths. Follow [SECURITY.md](../../SECURITY.md) for suspected vulnerabilities; do not publish exploit details in an ordinary issue.
