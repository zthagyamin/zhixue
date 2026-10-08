# Contributing to Zhixue

[简体中文](CONTRIBUTING.zh-CN.md) · [Development](docs/en/development.md) · [Roadmap](docs/en/roadmap.md)

Zhixue is a public beta. Contributions are welcome, especially reproducible bug reports, documentation fixes, accessibility improvements, and changes that make learning flows reliable. No paid support or response-time commitment is implied.

## Start with a small, reviewable change

Check [existing issues](https://github.com/zthagyamin/zhixue/issues) and pull requests before starting. For a substantial feature, protocol change, migration, or new dependency, open an issue first with the user problem, proposed behavior, compatibility, and acceptance criteria. An issue discussion is not permission to deploy or access another person's materials.

Fork [zthagyamin/zhixue](https://github.com/zthagyamin/zhixue), create a descriptive feature branch, and open a pull request against this public repository's `main`. Do not force-push shared branches. Keep unrelated fixes separate and preserve existing work.

Read [AGENTS.md](AGENTS.md) and [architecture](docs/architecture/README.md). Human and AI-assisted contributions follow the same correctness, privacy, and review rules. Contributors remain responsible for understanding generated changes, their provenance, and the license of submitted material.

## Architectural boundaries

| Change | Location and responsibility |
| --- | --- |
| Content, assessment, and mathematical rules | `src/domain/`: deterministic rules without React, storage, HTTP, or environment I/O. Pass clocks/randomness as inputs. |
| Study, planning, submission, and retry use cases | `src/application/`: explicit ports; no page or React dependency. |
| Database, browser storage, source, model, and Companion adapters | `src/infrastructure/`: implement controlled ports. |
| UI and temporary interaction state | `src/features/`: use application/domain contracts; no direct database or model access. |
| HTTP/Worker/page entry points | `app/`, `worker/`: authenticate, decode, and assemble dependencies; do not grow business controllers. |
| Companion additions | Follow its application/infrastructure boundaries and the single `companion/program-files.json` manifest. |

The modular migration is incremental; legacy `app/` paths still exist. Use public module exports, avoid universal utility buckets and service locators, and do not duplicate an old implementation with a second writer.

Architecture budgets are review constraints, not a scoreboard. Do not inflate limits, regenerate baselines, compress code into long lines, or remove assertions to make a check pass. An exception needs a focused ADR, scope, reason, and exit condition.

## Learning and data invariants

- Plugins render interactions and submit intent. They do not write formal events, change scheduling, directly call models, or access another account's storage.
- Bind owner, library, content/version, answer, request, and navigation scope. Late results must not affect a newer question or account.
- Save successfully before advancing. Retry the same logical submission; handle a lost receipt without creating duplicate results.
- Formal events are immutable. Content changes have new identities; unknown protocols are rejected or explicitly degraded.
- First attempts, assisted attempts, drafts, remediation, and pending evaluation stay separate. An unavailable model is not a wrong answer; a completed UI round is not mastery.
- Preserve old records and source responsibility. Persistence/protocol/scheduling changes need a compatibility, migration, rollback, and authorization plan.
- Do not generate personal learning results to test a feature. Use synthetic materials, isolated stores, and mock providers by default; no paid API calls without explicit permission.

## Tests and acceptance

Use [development](docs/en/development.md) to install prerequisites. For a behavior fix, add a meaningful failure reproduction before changing the behavior. A refactor needs a behavior baseline. Run related checks during development and the complete `npm test` before submitting; it includes architecture, release consistency, lint, type checking, production build, and Node regressions.

Run `npm run test:python` when Companion or shared rules are involved. Shared TypeScript/Python rules use the same versioned JSON fixtures. Report pass/fail/skip counts and exact commands; a platform skip is not a pass. Keep output encoding explicit for cross-platform subprocesses.

Depending on the change, cover duplicate clicks, cancellation/late results, question/account/library switches, lost receipts, source changes, old data, offline state, and unavailable AI. UI changes need actual component/browser paths, desktop and narrow-screen checks, keyboard behavior, and explicit light/dark theme checks. Screenshots do not replace interaction checks, and static checks do not replace screenshots.

Public imported-baseline fixtures are authenticated to the initial public source tree. This repository has a new public history; unavailable private ancestry is not a reason to weaken save, recovery, or evaluation regressions.

## Pull requests

Use the repository's pull-request template. Describe:

1. The concrete trigger and before/after behavior.
2. Scope, important invariants, compatibility, and rollback.
3. Actual tests and manual checks, including failures and unverified paths.
4. Relevant screenshots with synthetic content for visual changes.

Do not commit personal notes, learner answers, account identifiers, credentials, absolute source paths, raw private logs, local databases, generated builds, or downloaded release/runtime binaries. Review screenshots as carefully as text. Do not include material you cannot license for redistribution.

Assessment rules, formal persistence, isolation/permissions, migrations, synchronization, and cross-module refactors need independent review before integration. Do not invent code owners or imply an approval that did not occur.

## Merge and release

Required checks must pass on the reviewed commit. Missing, failed, or cancelled checks do not count as success. Distinguish head commit, merge commit, source tree, and deployed version.

A merged code change does not authorize website deployment, Companion publication, or installation on a user's computer. Maintainers handle these as separate operations with suitable approvals. Packaging must use the program manifest, verify installation/upgrade and old-data preservation, and respect third-party distribution terms. Do not overwrite an old binary to claim a new release.

## Reporting issues safely

For ordinary bugs, provide the version, platform, entry point, steps, expected/actual behavior, and a minimal synthetic example. Redact notes, answers, pairing codes, tokens, API keys, sensitive paths, and account identifiers. Suspected vulnerabilities follow [SECURITY.md](SECURITY.md), not an ordinary public issue.

## License

Submit only contributions you are entitled to provide under the project's [MIT License](LICENSE), identifying any third-party material and its compatible terms. The license does not cover users' imported materials or automatically relicense third-party packages. See [third-party notices](THIRD_PARTY_NOTICES.md).
