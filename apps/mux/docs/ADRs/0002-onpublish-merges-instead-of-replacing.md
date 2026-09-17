# ADR-0002: The publish function merges the field value instead of replacing it

**Date:** 2026-09-09
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

`onPublish` is the second writer of the Mux field, and it writes from a server with no knowledge of
the browser. When an entry is published carrying `pendingActions`, the function runs those actions
against Mux and then refreshes the field from a fresh `GET /video/v1/assets/{id}`.

That refresh constructed a brand new object from a fixed key list and **assigned** it over every
locale of the field. Three consequences, all silent:

1. Any key not on the list was destroyed. `robotsJobs` and `robotsOutputs` are written only by the
   browser, so "editor deletes a caption → publishes" would wipe them and publish the wiped value.
2. It wrote `version: 1`, downgrading a v3 record on every publish that carried a pending action.
3. It wrote one shared object to *every* locale, flattening per-locale values.

Alongside those, only the first locale of the field is scanned for pending actions — so actions
queued from any other locale never run.

There is also a timing problem. The function runs in two cycles — clear `pendingActions` and
update, then rebuild the field and republish — while the browser's existing guard keyed off
`pendingActions` still being present. So the guard lifted one cycle *before* the destructive write
landed, leaving a window in which a browser write was overwritten and then published.

Alternatives considered:

- **Have the browser stop writing during a publish, and leave the function alone.** Rejected as
  insufficient: the browser cannot observe the function directly, so any gate is a heuristic. A
  heuristic in front of a destructive replace is not a fix.
- **Have the function skip the field refresh entirely** and let the browser resync. Rejected: the
  refresh is what makes a publish leave correct data behind for consumers even if the editor closes
  the tab immediately.
- **Reconcile Robots outputs inside the function**, so a directive that ran unattended lands its
  output at publish time. Rejected for now: the function early-returns unless there are
  `pendingActions`, so it would only help on the narrow subset of publishes that carry one. Making
  it run on *every* publish means an entry update plus republish on every publish, which re-triggers
  the same event — a loop that needs its own guard, for a case the browser already covers on the
  next entry open.

## Decision

`mergeMuxAssetIntoField` (in `functions/src/helpers/muxField.ts`) spreads the existing locale value,
overlays only the keys the function owns, derives the version rather than asserting it, and is
called once per locale with *that locale's* value. `pendingActions` is set only when actions
actually failed, and **deleted** otherwise — not set to `null`. That matters twice: every
published entry out there already has the key absent once its actions have run, and `null` would
both differ from that (making the browser's next diff see a change and bump the entry version for
nothing) and make the *next* publish's pending-action scan index into `null` and throw from
outside the handler's try block.

The first-locale-only pending-action scan is **left exactly as it is**. Fixing it was tempting and
is unrelated to Robots, but it would mean the next publish suddenly executes actions queued in a
non-default locale that have never run — including asset deletes an editor queued long ago and
forgot about. That is a destructive surprise to ship to installs that already exist, so it stays a
documented limitation with its own follow-up. The scan is only hardened against a `null`
`pendingActions`, which it could already encounter and would already have thrown on.

Alongside it, the browser holds a **publish gate**: when a sys change shows the entry was published
while `pendingActions` were present, browser writes are queued until the function's own publish
lands (or a 90 s timeout). Queued mutators are then re-applied against the value the function left
behind.

Outputs from jobs that completed with nobody watching are reconciled in the browser on the next
entry open, not at publish time.

## Consequences

### Positive
- The worst case in the publish window stops being "destroyed" and becomes "briefly stale": the
  function overwrites the asset mirror, Robots keys survive, and the next poll reconciles.
- Two standing bugs fixed on the way — the `version: 1` downgrade and the per-locale flattening.
- `functions/` has its first tests.

### Negative
- The gate is a heuristic, not a lock. It narrows the window; the merge is what makes the remainder
  survivable. Both are needed and neither is sufficient alone.
- A directive that runs unattended lands its output on the next entry *open*, which produces a
  draft change the editor did not ask for. Unavoidable while the field JSON is the delivery path.

### Neutral
- The per-locale pending-action scan is still wrong, just no more wrong than before.
- `deriveFieldVersion` is duplicated between `functions/` and `frontend/`. The two are separate
  packages with independent builds — the same split that already exists between `util/apiClient.tsx`
  and `functions/src/helpers/muxClient.ts`.

## Amendment, 2026-09-11: the two writers disagreed about captions, and two mirror keys never cleared

The merge fixed *which keys* the function may touch. It did not look at whether the values it puts
in them match what the browser would have put there. Two ways they did not.

**The caption filter had drifted.** The browser mirrors a track into `captions` when
`text_type === 'subtitles'` and its status is `ready` or `preparing`. The function took
`type === 'text'` at any status. So a publish swapped the field's caption list for a
differently-filtered one: an errored caption track, or a non-subtitle text track such as `cues`,
reappeared on the entry that the app had already filtered out — and stayed there, published, until
someone opened the entry and the mount resync removed it again.

The browser's filter wins, because it is the one the app actually applies and the one every
existing entry was written with. The two live in separate packages with independent builds, so
there is no module to share: the predicate is now a named `isCaptionTrack` on each side, and each
one's comment names the other. Small enough to state twice; too load-bearing to let drift again.

**`captions` and `audioTracks` were the only mirror keys that could not clear.** They were spread
in conditionally — `...(captions?.length && { captions })` — so an asset with no tracks left
produced a mirror with the key *absent*, and `{ ...existing, ...assetMirror }` then kept whatever
the entry already held. Every other mirror key is written as an explicit `undefined`, which JSON
drops on the way to the CMA, which is how a key clears.

Be accurate about how bad this is, because a first pass overstated it. **It is a correction that
fails to happen, not a resurrection of deleted data.** For the function to run at all the entry
must carry `pendingActions`, which means the field editor was mounted, which means the mount
resync has already corrected `captions` — so `existing` is normally already right and there is
nothing stale to preserve. The window is narrow and specific: open the entry (resync runs), stay
off the Robots tab, a directive deletes a track in Mux, stage a pending action, publish. The
function then holds the true asset, sees zero captions, and declines to clear. The entry publishes
with a phantom track, and it self-heals on the next reload.

It is worth fixing anyway, for the asymmetry rather than the blast radius: the code promised one
thing and did another, silently, in the one place where a stale array reaches the Delivery API.

The reason it was invisible is the more interesting half. `MUX_ASSET_MIRROR_KEYS` documented both
keys as mirror-owned, and **nothing read that constant** — so the list and the object could
disagree with nothing to notice. Decorative documentation about a data-loss boundary is worse than
none, because it is read as a guarantee. So the mirror is now built by iterating the list
(`buildAssetMirror`), typed by it (`Record<MuxAssetMirrorKey, unknown>`), and a key that is listed
but not supplied is a compile error rather than a key that silently never clears.

Alternatives considered:

- **Make the browser match the function** (`type === 'text'`, any status). Rejected: it would put
  errored tracks on every entry, which is precisely what the browser filter exists to avoid, and
  it would rewrite the `captions` array of every entry on its next resync.
- **Share the predicate through a build step.** Rejected for the same reason `deriveFieldVersion`
  is duplicated: `frontend/` and `functions/` are separate packages with independent builds, and
  the split already exists between `util/apiClient.tsx` and `helpers/muxClient.ts`. A build
  dependency between them is a much larger commitment than eight duplicated lines.
- **Delete `MUX_ASSET_MIRROR_KEYS`.** Genuinely viable — a constant nobody reads is dead weight,
  and deleting it is honest. Rejected because the mirror keys *are* the contract between the two
  writers, and enforcing it costs one loop.
- **Write `captions: []` rather than `undefined` when the asset has no tracks.** Rejected: it
  would differ from what the browser stores for the same asset, so the next browser diff would see
  a change and write the field again — entry churn for nothing, which is the ADR-0006 property.

### Consequences

- A publish now leaves exactly the caption list the app itself would have written, and a deleted
  last track clears instead of lingering.
- A key added to `MUX_ASSET_MIRROR_KEYS` and forgotten in the mirror stops type-checking, and the
  tests assert the two agree by iteration rather than by a list someone has to maintain twice.
- The duplicated predicate is still duplicated. It is now duplicated *on purpose*, named the same
  on both sides, with each copy pointing at the other.
