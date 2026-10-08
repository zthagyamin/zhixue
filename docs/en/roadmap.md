# Roadmap

[简体中文](../zh-CN/roadmap.md) · [README](../../README.md) · [Contributing](../../CONTRIBUTING.md)

This roadmap separates implemented engineering from user acceptance. It is a direction for the public beta, not a delivery-date or service-level promise. Track concrete proposals through [Issues](https://github.com/zthagyamin/zhixue/issues) and pull requests.

## Current baseline: 1.41.1

The source includes daily planning/review, vocabulary modes, connected-source workflows, account-isolated synchronization, and non-vocabulary attempts with distinct first answers, supported attempts, remediation, and pending evaluation.

The course-practice engineering work includes specific source-bound recall tasks, structured choice questions, detailed feedback, in-place remediation, and recovery. Programming/calculation engineering includes execution attribution, public-case feedback, original-page correction, optional step checking, mapped related exercises, and formula/long-content presentation.

These are implemented capabilities, not a blanket statement that every real material, API provider, device, or learning outcome has passed acceptance. Public-source preparation and its test receipts are reported separately from earlier private development checks.

## Next: paper study and non-vocabulary flashcards

The committed baseline already has paper reading tools and flashcards. The next improvement phase targets their learning experience:

- Paper study centered on one passage or section: identify the goal, read, answer a concrete question, compare against the source, and continue.
- Reliable paper identity, location, and access to the original page; extraction errors remain visible.
- Method understanding and application as the main paper-recall focus, with experimental evidence where it serves the task.
- Whole-paper organization and review tools available on demand instead of competing with the current reading task.
- One learning point per non-vocabulary flashcard; unfamiliar items can show the key point, hide it, and retry.
- Temporary additional practice separate from an explicit, source-reviewed addition to formal review.

This phase is planned improvement work. Uncommitted prototypes are not part of the public 1.41.1 baseline and are not marked as delivered. Vocabulary-plugin behavior is outside this improvement scope.

## Real-material acceptance

Use representative course notes, papers, programming tasks, and mathematics exercises supplied with the necessary permissions. Confirm question usefulness, source fidelity, feedback quality, recovery, and continuity with actual use.

Required evidence includes:

1. Correct, partially correct, incorrect, and unknown/pending evaluations.
2. Hints, source reveal, retry, skip, pause, refresh, and return.
3. Provider failure/delayed replies without invented grades or duplicate records.
4. Desktop and physical mobile-device interactions, keyboard/input behavior, and relevant cross-device paths.
5. Long Chinese/English text, equations, code, and long feedback.
6. User trial feedback and time-estimate calibration.

A group should generally target 10–15 minutes and allow pause/resume; actual duration needs measurement. Passing test fixtures, completing a round, and improved long-term retention are separate outcomes.

## Maintainability and contributor access

Continue the incremental modular-monolith migration while preserving behavior. Keep domain rules pure, use controlled ports, and avoid growing legacy controllers. Improve public setup reproducibility, documentation, third-party notices, and useful synthetic examples.

Provider-independent production self-hosting, non-Windows installers, and any wider binary distribution require separate designs, security/compatibility checks, and acceptance. They are not promised by publishing the source.

## Propose an improvement

Describe the learning task, current obstacle, smallest useful change, preserved data boundaries, and observable acceptance criteria. Prefer a synthetic example or material you can legally share. Follow [Contributing](../../CONTRIBUTING.md); report suspected vulnerabilities through [SECURITY.md](../../SECURITY.md).
