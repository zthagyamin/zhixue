# Zhixue · 知学

**Turn your own notes into practice, feedback, and a daily review routine.**

[简体中文](README.zh-CN.md) · [Website](https://zhixue-daily.zthagyamin.chatgpt.site/) · [Get started](docs/en/getting-started.md) · [FAQ](docs/en/FAQ.md)

Zhixue is a learning workspace for course study, vocabulary, programming, mathematics, and paper reading. It connects selected personal materials to practice, records what you actually attempted, and helps you revisit weak points. Your Obsidian vault or connected source remains the home of the original material; the website is the learning interface.

**Public beta · source baseline 1.41.1.** Engineering checks and isolated browser tests do not establish teaching effectiveness or reliable AI grading on arbitrary materials. The hosted website can advance independently of a checkout; check its displayed version.

## Start small

1. Open the [learning workspace](https://zhixue-daily.zthagyamin.chatgpt.site/study) and follow the sign-in prompt where required.
2. Try **“用自己的笔记试学”** with a short Markdown/TXT file or pasted paragraph.
3. Answer before revealing the source, then retry the items you marked as unfamiliar.
4. Optionally save the material to the current browser. Connect Companion later if you want ongoing source access and local writeback.

This first trial needs neither Companion nor an AI key. Its answers are temporary; saving the material is a separate action and does not create formal learning results.

## What you can do

| Area | Included in this baseline | Important limit |
| --- | --- | --- |
| Daily study | Long-term arrangements, grouped practice, review queues, and progress views | Availability depends on registered content and setup; time estimates need real-use calibration. |
| Vocabulary | Staged learning, quick due-word review, spelling, and compatible flashcard modes | Supported behavior depends on the card's content and mode. |
| Course practice | Source-aware recall, single/multiple-choice practice, feedback, and in-place remediation | AI may abstain; pending evaluation is not a correct or incorrect grade. |
| Programming | Python exercise execution, public-case feedback, hints, and in-place correction | Passing supplied tests does not prove complete correctness. C/C++ is not a supported production execution promise. |
| Mathematics | Bounded numeric/symbolic checks, optional step review, and supported related exercises | Arbitrary proofs and arbitrary expressions are not covered; unsupported answers may remain pending. |
| Paper reading | PDF/text reading, notes, selection tools, and supported figure references | Extraction quality varies; scans, complex layouts, and source fidelity need human checking. |

Course, code, calculation, and paper workflows are **beta capabilities**. Real-material evaluation, model quality, physical mobile-device behavior, cross-device learning, and learning outcomes remain areas for validation. See the [roadmap](docs/en/roadmap.md).

## Where the data goes

“Local source” does **not** mean every feature is offline or every excerpt stays on the device.

| Part | Role and boundary |
| --- | --- |
| Original materials | Local files stay at their selected source. Notion remains an external service. Connecting a source does not move its ownership to Zhixue. |
| Browser-only note trial | Reads selected text in the page without AI or upload. Explicitly saved trial materials stay in the current browser; trial answers are not retained after leaving/reloading. |
| Companion | A local Windows bridge for authorized source access, pairing, and supported writeback. Local source references and local credentials are handled on the computer. |
| Account features | When enabled, structured practice content, learning events, and plan/progress information use account-scoped cloud services, with browser/local copies where supported. Practice content can include text derived from your notes. |
| AI | Enabled requests send the question, relevant context, and/or answer to the selected API provider. Local-mode keys use the system credential store; separately configured account-mode keys are encrypted in the account service. API use can cost money. |

Review a source before enabling it. Do not connect material you are not allowed to process. For more detail, read the [FAQ](docs/en/FAQ.md) and the current in-app settings before using cloud or AI features.

## Platforms and hosting

- The web interface has desktop and narrow-screen layouts. A responsive layout is not a claim that every physical device has been tested.
- The supported packaged Companion workflow targets **Windows x64**. There is no promised macOS/Linux installer in this beta.
- Phones and tablets can use supported browser/account features; they do not run the Windows Companion. Initial source registration and local writeback may require the connected Windows computer.
- The current hosted service uses **OpenAI Sites identity and Cloudflare D1**. A source checkout does not include hosting credentials, production accounts, or a ready-made provider-independent self-hosting solution.
- Offline availability is feature-specific. Cloud synchronization, API grading, and source access through a stopped Companion will not continue merely because the page was previously opened.

The existing website's [Companion guide](https://zhixue-daily.zthagyamin.chatgpt.site/companion-guide) describes its Windows setup. This source repository does not certify or bundle a separately audited binary release; use release-specific notices and checksums when a package is published.

## Build, contribute, and report

For source setup and supported development paths, see [development](docs/en/development.md). Runtime credentials are not needed to read or modify the code, but production account features need their service configuration.

- [Contributing](CONTRIBUTING.md): change scope, tests, and review expectations.
- [Roadmap](docs/en/roadmap.md): planned work and acceptance boundaries.
- [Issues](https://github.com/zthagyamin/zhixue/issues): reproducible bugs and feature discussions. Remove private notes, answers, credentials, pairing codes, and account identifiers from reports.
- [Security](SECURITY.md): report suspected vulnerabilities through the documented private channel rather than a public issue.

## License

Project-authored code is released under the [MIT License](LICENSE). Third-party dependencies and separately distributed assets retain their own terms; MIT is not a blanket license for imported papers, personal course materials, fonts, or runtime binaries. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Security and maintenance

The initial dependency audit has unresolved high-severity advisories. Read [the actual maintenance status](docs/en/security-status.md) before deploying a fork; this beta is not production-security certified.

