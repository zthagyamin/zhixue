# ADR: clean public source distribution

Status: accepted for the public beta.

The public repository starts from a reviewed source snapshot with a new Git history. Private development branches, learner material, operational handoffs, screenshots and production project bindings are not imported. Original synthetic examples exercise the same content contracts. MIT covers project-authored code; third-party notices remain separate.

The existing Windows release check and full regression assertions are retained. Release artifacts are excluded from Git. Build/test preparation acquires the fixed maintainer artifacts using the manifest's exact SHA-256 and byte count; it never executes installers. Future independently built releases require updated manifests and separate packaging verification.

Historical source comparisons use a frozen, versioned file-digest manifest in the public repository. Real checkout SHA/tree and manifest digest are different fields; no artificial Git tree or hidden private object is substituted. Baseline role requires a clean checkout matching the frozen source; candidate changes are visible. This replaces an unavailable private-history dependency, not learning-event regression coverage.

The initial public source remains 1.41.1 and does not include unfinished plugin work. Source publication does not deploy the website, modify a Companion installation or migrate formal learning data.
