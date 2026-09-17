# ADR-0001: A single serialized write path for the Mux field value

**Date:** 2026-09-09
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

Adding Robots gives the app a second poll loop. The asset loop polls Mux every 500 ms while an
asset prepares; the Robots loop polls every few seconds for minutes. Both do a read-modify-write
of the same JSON object field.

Before this change, ten of the field's write sites read the current value from `this.state.value`,
which `sdk.field.onValueChanged` only refreshes asynchronously. With one loop that staleness is
invisible. With two it is a lost update in both directions: a Robots write landing mid-flight in
the asset loop gets rebuilt away, and an asset write landing mid-flight in the Robots loop
clobbers freshly-polled asset state.

Worse, `pollForAssetDetails` rebuilt the whole value from a fixed **allowlist** of keys, so any key
it did not know about was dropped on every tick — several times a second while an asset prepared.

Alternatives considered:

- **Fold Robots into the existing asset loop.** One loop, one writer, no race. Rejected: 500 ms
  while an asset prepares and 5–10 s across several minutes are different problems, and merging
  them would multiply app-action calls (each costs at least two CMA requests) for no benefit.
- **Keep the existing `isPolling` / `pollPending` guard.** Rejected: that guard is re-entrancy
  protection for `pollForAssetDetails` against *itself*. It says nothing about a second loop.
- **A mutex around `setValue`.** Rejected as insufficient on its own — serialising the writes
  without also reading the authoritative value inside the critical section still loses updates,
  because the *value being written* was computed from stale state before the lock was taken.
- **Derive Robots state and never persist it.** Genuinely viable, and it would have kept the write
  topology exactly as it is today. Rejected because Phase 3 persists `robotsOutputs` from the same
  loop regardless, so the serialized write path has to exist either way; deferring it would have
  meant building the tab on an unsafe write path and refactoring underneath it later.

## Decision

`App.updateField(mutate)` is the only place the field value is written. Callers describe their own
change as a mutator; `updateField` reads the current value through `sdk.field.getValue()`, applies
the mutator, skips the write when the normalized value is unchanged, and chains concurrent calls
on a promise so they serialize.

Three writes stay direct because they deliberately discard everything: `resetField`, pasting an
existing Mux asset ID, and the upload-id → asset-id handoff.

The `pollForAssetDetails` rebuild now spreads the current value first and overlays only the keys it
owns, instead of rebuilding from an allowlist.

## Consequences

### Positive
- The two loops cannot clobber each other, and no future writer can either.
- Keys the asset loop does not know about survive, which is what makes `robotsJobs` and
  `robotsOutputs` possible at all.
- No-op writes are impossible, which is enforced in one place. That is what keeps entries with no
  Robots data byte-identical to what is on disk today, so they never flip to *Changed*.

### Negative
- Ten call sites unrelated to Robots were migrated. Mechanical, but it is a diff through code the
  feature does not otherwise touch, in a repo where every PR needs Contentful review.
- Reading the field rather than React state means a mutator cannot use component helpers that read
  state. `swapPlaybackIDs` had to inline its policy detection for exactly this reason.

### Neutral
- Callers get a promise that rejects on a failed write, while the internal chain never rejects.
