# ADR-0010: The field holds data that exists nowhere else

**Date:** 2026-09-11
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

Every key the Mux field held before Robots is a **mirror**. `playbackId`, `ready`, `duration`,
`captions` — all of it is re-derived from `GET /video/v1/assets/{id}` on the next entry open, so
losing any of it costs a resync and nothing else. That assumption is load-bearing in the design:
it is why the asset poll can rebuild the mirror several times a second, why a failed write is
survivable, and why nobody has ever had to think hard about durability here.

> **See also, 2026-09-21.** "Exists nowhere else" is an argument against losing this data by
> accident, not a guarantee that it outlives its asset. `onPublish` clears the whole field —
> Robots keys included — when `GET /video/v1/assets/{id}` returns a 404, and that is decided and
> kept behaviour: see ADR-0002's amendment of the same date, which also records the first-locale
> limitation attached to it.

Robots broke the assumption. `robotsJobs` and `robotsOutputs` are written **only** by the browser,
from information that is not recoverable anywhere else: `GET /robots/v0/jobs` returns summaries
with no `passthrough`, so a job's provenance exists only in the record we wrote (ADR-0005); a
superseded output is gone from Mux after 30 days, and from the entry immediately (ADR-0008); and a
running job is *billing* whether or not anything remembers it. Two places turned out to be built
for the old assumption.

**The editor rendered an entry as empty because its asset could not be played.** The rich branch
was gated on a playback ID existing — `playbackId || signedPlaybackId || drmPlaybackId`. An asset
can lose all three: `moderate` with `on_flagged.action: delete_playback_ids` deletes every one of
them, and so does anyone clicking delete in the Mux dashboard. The mirror then correctly clears
them, and the field editor fell through to the upload area and the "URL or Mux Asset ID" form — no
player, no menu, no tabs, no Robots panel, no explanation — for an entry still holding `assetId`,
`captions`, `robotsJobs` and `robotsOutputs`.

That is worse than a blank screen, because of what the blank screen offers. The only affordance
left was the asset-ID form, whose submit is one of the three deliberate full-value replaces
(ADR-0001): `setValue({ assetId: input })`. Pasting the same asset ID back in — the obvious thing
to try — destroys `robotsJobs`, `robotsOutputs` and `captions`. The one visible recovery destroys
exactly the data that cannot be recovered. And a moderation directive is the *most likely* way to
arrive here, so the entries most exposed are the ones with Robots records on them.

> **Amended 2026-09-17.** The asset-ID form is no longer the only affordance left: the Playback tab
> can request a new playback ID, queued as a `pendingActions` create and applied on publish
> (ADR-0015). The notice and the mid-session toast name it. This ADR's decision is unchanged — the
> editor still keys off `assetId` and playability is still a property of the asset — and so is the
> rejection below of a poll that re-creates a playback ID by itself. What is new is that a person
> can ask for one, which is also why `moderate`'s `on_flagged.action` is now offered (ADR-0014).

**A write could be reported as successful when it never happened.** Two independent windows:

1. The publish gate (ADR-0002) parks browser writes for up to 90 seconds while `onPublish`
   rewrites the field server-side. The deferred path returned from `apply` without writing **and
   without throwing**, so `await updateField(...)` resolved cleanly, and `componentWillUnmount`
   then did `this.deferredMutations = []`. Reachable in full: stage a caption change → Publish →
   start a Robots job inside the window → the record is parked → close the tab. The record is
   gone, the job is running and billing, and nothing anywhere reported a problem.
2. `sdk.field.setValue` resolves when the value has crossed the postMessage bridge into the
   Contentful web app. Persisting it is the web app's own autosave, on its own schedule.
   `sdk.entry.save()` exists and is called nowhere in `frontend/src`, though other apps in this
   monorepo do call it. So even a write that "succeeded" can be lost by closing the tab quickly
   enough — which for an asset mirror is free and for a billable job record is an orphan.

Alternatives considered:

- **Keep the playback-ID gate and add a special "no playback IDs" screen.** Rejected: it is the
  same mistake one level down. The editor's job is to edit the entry's asset, and playability is a
  property of the asset, not a precondition for the entry existing. A second top-level screen
  means every future feature has to be added to both.
- **Have the asset poll re-create a playback ID when it finds none.** Rejected outright: the app
  would be undoing a moderation decision automatically, which is the opposite of what
  `delete_playback_ids` is for. *(Still rejected as of 2026-09-17. ADR-0015 adds a button, not a
  poll — the word doing the work here is "automatically".)*
- **Make `addVideoByInput` merge instead of replace.** Rejected: pasting a *different* asset ID
  must discard the old asset's mirror, and merging two assets' data into one value is worse than
  either replacing or refusing. A confirm keeps the semantics and removes the silence.
- **Make `updateField` reject immediately when it parks a mutator.** Rejected: the mutator is
  still queued and will usually be applied a moment later, so "rejected" would be a lie in the
  common case and would make callers retry a write that is about to land.
- **Have the caller's promise stay pending and block the write chain on it.** Rejected — it
  deadlocks. A parked mutator is released *through* `updateField`, so a chain waiting on the
  parked promise waits on a release that is queued behind itself.
- **Await the write chain during unmount, instead of writing directly.** Rejected: a promise
  chained at unmount may never get a turn. The flush has one shot and has to take it inline.
- **Call `sdk.entry.save()` after every write.** Rejected, firmly: the asset poll writes several
  times a second while an asset prepares, and an entry save per tick is both an entry version per
  tick and a load pattern nobody asked for. The durability is needed for the small number of
  writes that record something billable, so the caller says when.
- **Persist Robots records outside the entry** (app state, a Mux-side lookup). Genuinely viable
  and rejected as a much larger change: the field JSON is the delivery path for `robotsOutputs`,
  so the entry has to hold it regardless, and a second store would have to be reconciled with it.

## Decision

**The editor branch is gated on `assetId`.** An entry with an asset gets the editor for that
asset. Where the player would go, an asset with no playback IDs gets a note that says so, why it
can happen, and what to do about it, with its own Resync button — the Data tab's Resync is one
click away as always, but the recovery should not be behind a tab the editor has no reason to
open. The "Waiting for asset to be playable" spinner is suppressed in that state, because nothing
is coming.

Every child of that branch was checked against a missing playback ID. Three were producing dead
affordances rather than crashing, and each now says why instead: the caption table's VTT and
transcript links (which need a playback ID to build a URL), the MP4 rendition list (which was
building `https://stream.mux.com/undefined/...` for a rendition that outlived the playback IDs),
and `swapPlaybackIDs`, which queued a delete action with no `id` — newly reachable now that the
Playback tab renders in this state, and it would have made the publish function issue
`DELETE /assets/{id}/playback-ids` with no ID on four consecutive publishes before giving up.

**`addVideoByInput` asks first** when the stored value holds Robots records or captions and the
pasted ID differs from the one already there. It is still a full replace — that is the point of it
— but not a silent one. With the branch now keyed off `assetId` this path is nearly unreachable,
which is the right order to do it in: the fix removes the trap, and the confirm is what is left
standing if anyone ever re-gates the render.

**A parked write settles when it is applied, and rejects when it is dropped.** `updateField`
returns a promise that stays pending while the mutator is parked behind the publish gate, and
settles with the real outcome of the re-applied write. If it is dropped instead, it rejects with
`DiscardedFieldWriteError`. The write chain deliberately does not wait on the parked promise, for
the deadlock above.

**`componentWillUnmount` flushes the queue** before raising the unmount flag: it applies every
parked mutator in order against the current stored value and writes once, directly, not through
the chain. Best effort by construction — a closing tab may not finish anything — but the *other*
half is guaranteed regardless: every parked caller learns whether its change was written.

**`updateField(mutate, { save: true })`** calls `sdk.entry.save()` after a write that actually
changed something. Off by default, so every existing call site behaves exactly as it did. A save
failure is logged and swallowed: `setValue` has already resolved, the value is in the editor's
buffer, and reporting a failed write would make the caller retry one that happened.

## Consequences

### Positive
- An asset that loses its playback IDs costs the editor a player, and nothing else. The captions,
  the Robots tab, the menu, the metadata and the Data tab are all still there, and the entry's
  data is no longer one plausible keystroke from being destroyed.
- A caller that records something billable can tell "written" from "dropped", and can ask for the
  write to be persisted rather than buffered. Both were previously impossible to distinguish from
  success.
- The 90 s publish window stops being a data-loss window. In the common case the parked write now
  lands on unmount instead of being discarded.
- Every existing call site is untouched and behaves identically, so this changes nothing for an
  install that never enables Robots (ADR-0006).

### Negative
- A caller awaiting `updateField` during a publish now waits for the gate to lift — up to 90
  seconds — instead of returning immediately. That is the honest answer to "is my change stored",
  but it means a Resync clicked inside the publish window appears to hang. The asset poll stalls
  in the same window, which at least stops it queueing a mutator every 500 ms for 90 seconds.
- The unmount flush writes directly rather than through the chain, so in principle it can race a
  write already in flight. The gate being open is what parks writes in the first place, so the
  overlap is a write that started *before* the gate opened — narrow, and the alternative is
  certain loss.
- A dropped write now surfaces as a rejected promise. A caller that ignores the promise entirely
  turns that into an unhandled rejection in the console instead of silence. That is the intended
  direction, but it is noise that did not exist before.

### Neutral
- A mutator still sitting on the write chain (not yet parked) when the component unmounts is
  still dropped silently. The chain holds a mutator for the duration of one `setValue` —
  milliseconds — against the gate's 90 seconds, so it is not the reachable case, and closing it
  would mean tracking every in-flight apply to avoid double-writing one.
- `options.save` has no call sites in this change. It exists for the Robots write paths, which are
  wired separately.
- The confirm in `addVideoByInput` is, by design, nearly dead code. It is cheap, and it is the
  backstop for the render gate rather than a substitute for it.
