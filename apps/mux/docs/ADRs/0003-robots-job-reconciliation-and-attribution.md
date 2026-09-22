# ADR-0003: Reconciling an unconfirmed Robots job instead of retrying it

**Date:** 2026-09-09
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

Every Mux call goes through `appActionCall.createWithResponse`, which is two operations: a POST that
creates the call and returns a `callId` immediately, then a poll of Contentful's call log for the
result — every 2 s, up to 15 times, then a rejection reading "taking longer than expected".

That rejection means *we stopped waiting*, nothing more. The request to Mux already went out and
the function may have returned `{ok:true}` perfectly. Cold starts, a slow Mux call, a call log that
is not queryable yet, a backgrounded tab with throttled timers — any of these produce it. The App
Function itself can also be killed *after* its request to Mux has gone out, with the same result.

This bug class already exists in the app: `addByURL` → `createAsset` has the same shape, and a
retry after a timeout creates a second Mux asset. Nobody noticed because it is rare and the cost is
invisible. Robots makes it per-click and **billable**.

The Robots API has no idempotency key.

Alternatives considered:

- **Retry the create.** Rejected outright: it double-charges.
- **Show a plain error.** Rejected: the editor re-runs and double-charges by hand.
- **Raise the client's retry budget.** `createWithResponse` honours `retries` / `retryInterval` at
  runtime (the plain client spreads params straight into the adapter, though its TypeScript type
  omits them, so it needs a cast). Rejected as a *fix* — it widens the window but does not close it,
  and relying on an untyped passthrough for correctness is worse than reconciling. Worth revisiting
  as an optimisation once Contentful confirms it is supported rather than incidental.
- **Match on `asset_id` + workflow + creation time.** Rejected: a guess, and wrong when two editors
  run the same workflow on the same video within the window.

## Decision

Every job created by this app carries a `passthrough` of `contentful@<version>|<request-id>`, where
the request id is client-generated per attempt. `passthrough` is a top-level field on job creation
that Mux returns as-is.

`createRobotsJobWithReconciliation` then splits the failure cases:

- **Mux answered** — `muxProxy` returns `{ok:false, status}` over HTTP 200, so the browser gets a
  typed `MuxApiError` with a status. Nothing started; surface the message.
- **Outcome unknown** — anything else. Re-read `GET /robots/v0/jobs?asset_id=…&workflow=…` and match
  on our own `passthrough`. An exact match means the job started, and it is adopted as if the create
  had succeeded.
- **Still unknown** — no match after three attempts (a job created a second ago is not always in
  the list yet), or the reconciliation call also failed. The `passthrough` is handed back to the
  caller, which keeps it and re-checks the job list on **every** subsequent refresh. Run stays
  disabled the whole time.

  Nothing time-based unblocks it. Correctness here cannot rest on "probably long enough": the job
  may be running and billing, and a timer that re-enables Run is exactly the double-charge this
  exists to prevent. The only two ways out are the job appearing in the list, or the editor
  clicking *"Nothing is running — let me try again"*, which is a decision they make with the
  situation explained to them.

The same `passthrough` doubles as two other things, which is why the plugin id and version are in
it rather than just a bare request id:

- **Job-origin attribution.** It survives into the job record rather than being request metadata,
  and needs no header change on the app's other Mux calls.
- **Ownership.** Only jobs whose `passthrough` starts with `contentful@`, plus jobs a directive
  run on this asset dispatched, are written onto the entry. A job run from the Mux dashboard is
  shown in the tab but never stored — the entry records what was done through Contentful. Once
  stored, a record is never removed, so Robots' 30-day purge does not erase an entry's history.

> **Superseded 2026-09-11.** The two-segment format above and the bare `startsWith('contentful@')`
> ownership test are both gone. The passthrough now carries the space, environment and entry it was
> written from, and a job is ours only when that scope matches `sdk.ids` — see *The passthrough is
> now scoped to the install*, below. The rest of this section still holds: the reconciliation, the
> escape hatch and the two roles the string plays are unchanged.

## Consequences

### Positive
- An unconfirmed create can never double-charge.
- Attribution is per job and includes the plugin version, without touching every Mux call the app
  makes.
- The app already distinguished the two failure classes; this just names the distinction
  (`MuxApiError.muxAnswered`).

### Negative
- A failed create costs up to three extra list calls, spread over ~4.5 s.
- An editor whose job genuinely never started, on an account where the job list is also failing,
  has to click the escape hatch to run again. Deliberate: the alternative is spending their money
  on a guess.
- Attribution depends on the Robots service persisting `passthrough` on `workflow_jobs`, and on
  nothing else in Mux claiming that field. Both are external assumptions.

### Neutral
- `addByURL`'s identical hazard is left alone. Fixing it is the same shape but it is not Robots, and
  it belongs in its own change.

## Amendment, 2026-09-11: the reconciliation this ADR describes was half-built

Three things found while re-reading the implementation against the text above. Two of them are
places where this document described behaviour the code did not have, and the third is the design
flaw that made one of those unfixable.

### The directive path had no reconciliation at all

Everything above is about `POST /robots/v0/jobs/{workflow}`. `POST
/robots/v0/directives/{id}/runs` — the *more* expensive call, because a directive dispatches
several billable workflows in sequence — was a bare create with an error toast on any failure. The
identical cold-start timeout therefore produced the identical "we stopped waiting" rejection, and
the obvious next move for the editor was to click Run directive again and pay for the whole
directive twice. The hazard this ADR exists for was left unprotected on the path where it costs
the most.

It now mirrors the job path exactly. If Mux answered — a 409 "already running", a 403, a 404 — the
failure is real and is surfaced, and the 409 keeps its own copy. Otherwise
`GET /robots/v0/directives/{id}/runs` is re-read and a run on this asset that started within two
minutes is adopted. Only when that finds nothing is the outcome unknown, and then the tab holds a
pending guard with the same informed escape hatch rather than an error the editor can retry.

The match is weaker than the job path's and it has to be: the runs endpoint takes no
`passthrough`, so there is no client-generated token to match exactly. The narrowest honest test is
directive + asset + a two-minute window, and it fails closed — a run with no `started_at` is not
adopted, because failing to adopt costs one click and adopting the wrong run drops the guard on a
run that never started.

The Run-directive button also had no in-flight disable, which the job path has had since it was
written. A double click fired two POSTs with no help from any timeout at all.

### "Re-checks the job list on every subsequent refresh" was never implemented

The third bullet under **Decision** promises that an unresolved `passthrough` "is handed back to
the caller, which keeps it and re-checks the job list on **every** subsequent refresh". It was
handed back and then never used: `findJobByPassthrough` was called from exactly one place, inside
the create.

What the refresh path actually did was this:

```ts
setPendingPassthrough((pending) =>
  pending && fetched.some((job) => job.passthrough === pending) ? undefined : pending
);
```

`fetched` is `GET /robots/v0/jobs`, which is a six-field summary — `id`, `workflow`, `status`,
`created_at`, `updated_at`, `_links`. `job.passthrough` is **always** `undefined` on it, so that
predicate could not be true, ever. The consequence is worse than a guard that never lifts: the only
remaining way out was *"Nothing is running — let me try again"*, which is the one button that
creates a duplicate. A guard against double-billing whose sole exit was double-billing.

The re-check now does what the text always said, in its own effect keyed on the refresh counter:
one bounded `findJobByPassthrough` pass — one list call and at most five single-job reads, no
retry sleeps — and on a match the job is recorded on the entry and the guard lifts. It runs only
while a create is unresolved, which is almost never.

This also needed the pending state to carry the **workflow** alongside the passthrough. Detail is
`GET /robots/v0/jobs/{workflow}/{id}`; a passthrough with no workflow cannot be looked up, which is
part of why the promise was never kept.

### The passthrough is now scoped to the install

`contentful@<version>|<request-id>` identifies the *app*, not the install. ADR-0005's second
amendment already recorded the consequence — the polling path reads passthroughs off jobs it does
not own, so it has to pass `trustPassthrough: false` — and accepted the cost. The cost is larger
than it looked: a job we created but never managed to record, because the page was closed during
the cold-start window, can then be claimed by nothing. It runs, it bills, and it belongs to nobody
for good. The mechanism protecting against paying twice was creating a category of work nobody
could account for once.

The new format is:

```
contentful@<version>|<space>:<environment>:<entry>|<16 hex>
```

and `trustPassthrough` is gone, replaced by a scope: a passthrough is trusted when it parses *and*
its space, environment and entry match `sdk.ids`. Both paths pass the same scope. The create path
additionally names the job id it is holding the response for, because proving ownership of your own
POST by parsing a string back out is silly and it would otherwise depend on `sdk.ids` being
present.

`ids.environment`, never `ids.environmentAlias`: an alias can be repointed and a scope that moves
underneath a running job would orphan it.

Mux documents `passthrough` as at most 255 characters and Contentful ids can be 64. The worst case:

```
"contentful@"  11
version        20   (generous; it is "2.0.0" today)
"|"             1
space          64
":"             1
environment    64
":"             1
entry          64
"|"             1
request id     16
             ----
              243   ≤ 255
```

A full 36-character UUID in that last slot makes it 263 and the create is rejected, which is why the
request id is 16 hex characters — 64 bits, against a namespace of "the handful of jobs one entry
starts on one asset".

Two things stay as they are, deliberately:

- **A passthrough with no scope segment is not trusted**, the same as under
  `trustPassthrough: false`. Not a regression: any pre-change job of ours is already recorded on the
  entry, which is a stronger signal than its tag, and a pre-change orphan was already lost. Parsing
  is defensive throughout and cannot throw on arbitrary input.
- **`findJobByPassthrough` is unchanged.** It compares the whole string against one the caller
  generated, so it is an identity check, not an ownership check. It neither parses the passthrough
  nor needs to know what a scope is.

The known limit, recorded here and in the code: `passthrough` exists only on the single-job GET, and
that is only issued for **terminal** jobs. So an orphan of ours is adopted when it *finishes*, not
while it runs. Widening detail fetching to non-terminal jobs would cost a read per job per poll
tick, and is not done.

### Consequences of this amendment

**Positive.** The expensive click is protected the same way the cheap one is. The guard on an
unconfirmed job now lifts by finding the job, which is what this ADR claimed all along, so the
duplicate-creating button is a genuine last resort rather than the only door. A job created and
never recorded is no longer orphaned for good.

**Negative.** The directive match is heuristic where the job match is exact, because the API gives
nothing better; two minutes is a judgement, not a proof. The per-refresh re-check costs up to six
extra reads on the ticks where a create is unresolved. And adoption of an orphan waits for the job
to reach a terminal state, which for a long workflow is minutes.

**Neutral.** `addByURL` still has the untreated version of this bug, as noted above. Nothing
migrates: the scope only changes what is written from now on, and the old format is simply never
trusted.

## Amendment, 2026-09-21: the re-check could not run in the one case it exists for

The amendment above says the per-refresh re-check now "does what the text always said". It does,
and it still could not run.

The re-check is an effect keyed on `pollNonce`. `pollNonce` advances only when `refresh` completes,
and `refresh` is called by the poll loop, and the poll loop armed only on
`inFlight.length > 0 || activeRuns.length > 0`. An unconfirmed create is **precisely** the state
where nothing is in flight: the job is not on the entry, and it is not in the list — that is what
"unconfirmed" means. So the one `refresh` in `handleRun`'s catch produced exactly one re-check,
against a list Mux had usually not caught up with yet, and then the loop went quiet for the rest of
the session. The promise was kept for jobs the tab could already see and broken for the only job
it could not.

What that costs is larger than one workflow, because `runDisabledReason` is not per-workflow. It
disables **Run a workflow** outright, for all twelve. This is the shape of a client report we could
not reproduce: `generate-premium-captions` completed, and afterwards `edit-captions` and
`generate-chapters` "appeared blocked". They were blocked, along with everything else, by a guard
raised minutes earlier on a different workflow that nothing was ever going to lift. Reloading the
entry cleared it, which is why it looked intermittent.

Two other hypotheses were tested against the code first and are recorded here because they are the
obvious ones and they are both wrong:

- **The new caption track lands `preparing`, not `ready`, and a consumer counts only `ready`.**
  It does not. Both copies of `isCaptionTrack` admit `preparing` deliberately, the run form's
  track picker filters on nothing at all, and `hasCaptions` counts the mirrored list. The only
  `ready`-only tests in the app are the two download links in `TrackList`, which render an empty
  cell and block nothing. The asset poll also re-polls a `preparing` track to `ready` on its own.
- **The captions precondition reads a list that has not refreshed.** The resync a completed job
  triggers re-reads the asset, and a `preparing` caption enters `captions` on that same read.

So: the poll loop now also arms while a create is unresolved, which is what gives the re-check the
refreshes it was always specified to run on.

It is bounded by a **count of attempts** (`ROBOTS_UNCONFIRMED_RECHECK_TICKS`, ten at the 6 s
cadence) rather than by a clock, and the distinction is the whole reason this ADR's original text
says "nothing time-based unblocks it". A timer that re-enabled Run would be the double-charge this
exists to prevent. A bound on how long we keep *looking* is not that: the guard stays up, Run stays
disabled, and the two ways out are unchanged — the job turning up, or the editor saying nothing is
running. What the bound stops is an open tab spending two CMA requests every six seconds forever
over a job that never started.

Ten ticks is a minute. A job Mux did create is listed within seconds of the create returning, and
`findJobByPassthrough` opens the newest few candidates whatever their status — so unlike the
orphan-adoption path described above, it does not have to wait for the job to reach a terminal
state.

### Consequences of this amendment

**Positive.** The guard now lifts by itself in the case it was written for, rather than only in the
case where something else happened to be running. A single unconfirmed create no longer disables
every workflow in the catalog for the life of the session.

**Negative.** An unconfirmed create now costs up to ten poll ticks — one list read each, plus the
re-check's own list and up to five single-job reads per pass. Rare by construction, and the
alternative is an editor who cannot run anything until they reload.

**Neutral.** `pendingDirectiveRun` has no per-refresh re-check of its own and still lifts only by
`loadDirectiveRuns` finding the run or by the escape hatch. It disables the directive button
alone, not the workflow one, so it does not have the blast radius that made this worth fixing. It
is the same shape of gap and it is not fixed here.
