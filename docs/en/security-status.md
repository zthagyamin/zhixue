# Security and dependency maintenance status

This initial 1.41.1 public source snapshot is a beta, not a production security certification.

An actual `npm audit` of the inherited lockfile reported **13 high-severity advisory entries and 0 critical entries**. Several entries concern development/build tooling and transitive dependencies. This count is a package-audit result, not 13 independently validated vulnerabilities in Zhixue or proof that a hosted account can be compromised. Applicability and remediation remain to be reviewed.

Dependencies were not silently upgraded during source publication. Before deploying an internet-facing fork, review current upstream advisories, reachable paths, compatibility and regression coverage. Keep private reports in the channel described by [SECURITY.md](../../SECURITY.md); do not publish exploit details or private logs in issues.

The initial checks include a secret scan of the exact public files and new Git history, documentation/known-private-content checks, complete source regression checks and isolated installation regressions. These do not prove all model outputs, all self-hosting setups or real learning outcomes are safe/correct.

Updates must report their own dependency audit and actual tests. The advisory count above describes initial preparation and must not be reused as a current result after dependency changes.
