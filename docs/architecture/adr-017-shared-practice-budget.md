# ADR-017: Optional shared practice budget

Status: local implementation; release and browser acceptance remain separate.

`practiceBudgetGroups` is additive opt-in configuration on the existing long-term
spec, carried unchanged into each issued daily allocation. A group binds stable
subject IDs, a 0–180 minute daily selection budget and a 1–30 minute fallback
estimate. No config preserves the old quantity-based selection. Existing issued
days, due obligations, histories and 20/5 word minima are not rewritten.

One pure selector serves native/account rendering and navigation. Completed,
started, locked and explicitly appended tasks remain selected and consume time;
overage is visible. Due practice precedes new subject practice. Budget-ineligible
reviews cannot consume the global quantity goal. Reading, manual tasks, new words
and ungrouped subjects retain their existing behavior. A selection is not an
attempt or completion; repeated physical items retain distinct round identities.

Automatic cached membership does not confer explicit retention when opted in.
Explicit additions are scoped to owner, library, study day, source and the exact
budget snapshot. Source or budget changes invalidate that temporary selection.

Companion support is advertised as `practice-budget-v1`; a new client must verify
this capability before publishing an allocation containing this field. An old
Companion strictly rejects unknown allocation fields. New long-term data must not
be edited through an old client that cannot display the policy: such clients may
preserve but cannot claim to apply it. Do not auto-upgrade installations or plans.

Rollback: preserve/export the complete long-term and daily snapshots and learning
history. Disable groups through the current preview/save/revision flow for future
days; do not strip fields from an issued day or downgrade its semantics. A code
rollback requires keeping budget-bearing plans read-only until a capable client
is restored. No migration grants permission to deploy, install or alter records.

## Nonword continuation integration (2026-10-07)

Budget retention and evidence of starting practice remain distinct. The account
group view can receive optional `verifiedStartedTaskIds` from source-bound saved
records, when the approved original catalog is available. Within an identified
nonword subject, these positive records lead continuation before the existing
started/locked fallback. An empty list does not disprove an ungraded pending answer
or paused draft. Vocabulary, missing source metadata and callers without this port
retain their original priority. The budget selector still retains every protected
task; the global focus selector, native legacy navigation, formal records and
issued budget snapshots are unchanged.
