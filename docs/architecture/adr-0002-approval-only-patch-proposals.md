# ADR-0002: Approval-only downstream patch proposals

## Status
Accepted

## Date
2026-08-08

## Context

### Problem Statement

When an approved upstream document changes, completed downstream chapters need a
computed severity and a concrete proposed patch. The proposal must be reviewable
without changing chapter content or version history until a human explicitly
accepts it.

### Constraints

- Existing document versions are immutable and the canonical document pointer
  must remain compatible with the pipeline.
- Existing dependency dirty markers and review routes are already shipped.
- GitHub Actions is unavailable; the local repository gate is authoritative.

### Requirements

- Compute severity from the existing contradiction detector and persist it on the
  downstream dirty marker.
- Store proposals separately from document versions, bound to the exact parent
  version hash.
- Expose preview, reject, and explicit accept operations in the review UI/API.
- Never apply a proposal during generation or preview; reject stale parents.

## Decision

Use a small file-backed AutoPatchService under each project's .patches/
directory. A proposal stores the complete candidate content, line hunks for
preview, the parent version number/hash, instructions, and a pending lifecycle
status. The proposal endpoint generates against the current immutable parent.
The accept endpoint rechecks that parent, appends an agent-patch version, then
updates the canonical pointer and in-memory step result. A changed parent causes
the old proposal to be superseded and a replacement proposal to be generated;
no content is applied in that response.

Severity is computed at approval time only when the approved upstream step has a
prior approved version and a newer version. Cosmetic-only upstream changes map
to none; contradiction errors map to high; warnings/informational findings map
to low.

### Architecture Diagram

    approved upstream edit
             |
             v
    dependency dirty markers -> contradiction detector -> severity on marker
             |
             v
    review UI -> propose -> .patches/<step>.json -> preview/reject/accept
                                                   |
                                       parent hash recheck
                                                   |
                                       append immutable version + pointer update

### Key Interfaces

- GET /api/projects/:id/steps/:stepId/patches
- POST /api/projects/:id/steps/:stepId/patches/propose
- POST /api/projects/:id/steps/:stepId/patches/:patchId/reject
- POST /api/projects/:id/steps/:stepId/patches/:patchId/accept
- PatchProposal.parentV and PatchProposal.parentSha256 are the acceptance
  concurrency boundary.

## Alternatives Considered

### Alternative 1: Apply generated patches immediately

- **Description**: Write generated output directly to the chapter pointer and
  append a version as soon as an upstream change is approved.
- **Pros**: Fewer review interactions and less storage.
- **Cons**: Violates the human-review gate and makes accidental changes hard to
  undo.
- **Rejection Reason**: Explicitly disallowed by M4.3's non-auto-apply invariant.

### Alternative 2: Keep proposals only in process memory

- **Description**: Hold candidates in a gateway map until the reviewer acts.
- **Pros**: No project files to manage.
- **Cons**: Restart loses review work and makes the UI non-deterministic.
- **Rejection Reason**: Review artifacts must survive restarts and be inspectable.

## Consequences

### Positive

- Reviewers can inspect and edit a concrete candidate before acceptance.
- Parent hashes make double-clicks, refreshes, and concurrent edits safe.
- Existing versioning remains the sole content mutation path.

### Negative

- Proposal files require lifecycle cleanup and can grow with repeated proposals.
- Full-document candidate storage is larger than a minimal patch representation.

### Risks

- AI output may be malformed or unrelated; the reviewer sees it as pending and
  can reject it. Patch mode also asks the provider to preserve untouched text.
- A stale proposal may require another model call; the old proposal is never
  silently applied.

## Performance Implications

- **CPU**: Line diff is O(n*m) for document line counts; intended for step-sized
  documents rather than whole manuscripts.
- **Memory**: One in-memory LCS table per proposal generation.
- **Load Time**: One proposal file read alongside versions and impact data.
- **Network**: One model request per proposal, plus normal review API calls.

## Migration Plan

No data migration is required. Existing projects lazily seed document v1 when
the proposal or review route first requests version history. .patches/ is
created on the first proposal.

## Validation Criteria

- Local npm run check is green.
- Focused service tests prove proposal-only does not append a version, explicit
  acceptance does append one, and stale parents are recomputed without apply.
- Review UI tests prove proposal submission remains separate from acceptance.

## Related Decisions

- docs/engineering/release-procedure.md
