# ADR-0001: Classify Dirty Steps at Review Approval

## Status

Accepted

## Date

2026-08-08

## Context

When an approved upstream step gains a new version, the dependency graph marks completed downstream steps dirty. Reviewers need to distinguish harmless formatting edits from changes that contradict established story facts.

The entity index is already owned and persisted by ContextEngine, and evidence-chained chapter checks already exist in ContradictionDetector. A second entity extractor or continuity model would duplicate state and produce inconsistent findings.

## Decision

Use DirtyStepClassifier as a narrow integration layer:

- Read dirty downstream steps from the dependency graph markers.
- Compare the prior and current approved source contents.
- Return none immediately for whitespace, punctuation, heading, and case-only changes.
- Otherwise load the existing ContextEngine context and run ContradictionDetector once per dirty step.
- Map detector severities error, warning, and info to high, low, and low; no findings map to none.
- Inject the classifier into ProjectEngine.
- Run classification from the review approval path after a newer source version is approved, using immutable version contents.
- Persist the resulting severity on each dirty marker and return the classifications in the approval response.

## Alternatives Considered

### Rebuild entity extraction in the classifier

This would make the classifier self-contained, but would duplicate the canonical entity database and drift from existing context state. Rejected.

### Run the whole-project continuity report

This rechecks unrelated chapters, costs more, and does not identify which dirty downstream step is affected. Rejected.

### Classify synchronously inside dependency-graph marking

The graph service is pure state/relationship logic and should not own AI or persistence concerns. Rejected.

## Consequences

### Positive

- Cosmetic approved edits avoid an AI call.
- Substantive edits reuse existing evidence-chained tooling.
- Severity is attached directly to the dirty marker and is visible to review consumers.
- The classifier remains independently testable through injected tool interfaces.

### Negative and Risks

- A substantive edit costs one consistency-model call per dirty step.
- Detector/model outages can fail the approval request; operational callers should surface that failure for retry rather than silently claiming a severity.

## Validation

- Focused classifier and dependency-graph tests pass.
- The economic-system E2E test uses the real ContextEngine and ContradictionDetector with a deterministic model response.
- The repository TypeScript gate passes on the current checkout.
