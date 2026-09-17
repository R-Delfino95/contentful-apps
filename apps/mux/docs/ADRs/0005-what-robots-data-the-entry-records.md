# ADR-0005: The entry records what ran through Contentful, and never forgets it

**Date:** 2026-09-09
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

The Robots tab reads `GET /robots/v0/jobs?asset_id=…`, which returns **every** job for that Mux
asset regardless of who started it: the plugin, a directive at ingest, or someone clicking around
the Mux dashboard. A first cut persisted all of them onto the entry field.

That conflates two different questions. What the tab should *show* is everything, because a list
with holes in it is worse than no list — an editor looking at a video wants to know what has been
run on it. What the entry should *store* is a narrower thing: the entry is a Contentful record, and
storing jobs nobody triggered from Contentful means the field mirrors somebody else's activity in
another tool.

The reverse case matters too. Robots purges jobs after 30 days. If stored records were reconciled
strictly against the API, a job that completed six weeks ago would silently disappear from the
entry, and so would its output.

Alternatives considered:

- **Persist everything the API returns.** Simplest, and what the first implementation did. Rejected:
  the entry ends up recording dashboard activity, and an editor cannot tell from the entry what
  their own CMS did.
- **Persist only jobs carrying the plugin's `passthrough`.** Nearly right, but it drops the jobs a
  *directive* dispatched at ingest. Those carry no passthrough of ours — Mux creates them
  server-side — yet the directive was attached by this app through `new_asset_settings`, so the
  automation is Contentful's even though the job creation was not. Excluding them would break CF 5
  and CF 7 together: automation whose output never lands anywhere.
- **Mirror the API exactly, removing records it no longer returns.** Rejected: the purge window
  would quietly erase an entry's history, and `robotsOutputs` with it.

## Decision

A job is written to the entry when it is **plugin-originated**, meaning any of:

- it is **already recorded on the entry** — the durable test, and the one that matters most in
  practice (see the amendment below);
- its `passthrough` starts with `contentful@` — this is a create response, or one reconciled
  after an unconfirmed create; or
- its id appears in the `node_states` of a directive run for this asset — automation this app
  configured.

Everything else is displayed and not stored.

> **Superseded 2026-09-11.** The prefix on its own no longer qualifies a job: `isPluginOriginatedJob`
> trusts a `passthrough` only when its scope segment names this space, environment and entry. The
> create path proves ownership through `ownJobIds` instead of by parsing its own string back out.
> Four ways to qualify now, not three. See ADR-0003's 2026-09-11 amendment.

Stored records are **append-and-update only**. A record whose job the API no longer returns is left
alone: it stops updating, and stays. Same for `robotsOutputs` — with the difference that
`robotsOutputs` is keyed by workflow rather than by job, so a re-run supersedes the previous
output while the job records themselves all remain. See ADR-0008.

## Consequences

### Positive
- The entry answers "what did we run on this video, from here" rather than "what has ever touched
  this Mux asset".
- Automation still writes its output back, which is the whole point of Phase 2 plus Phase 3a.
- A job aging out of Robots' retention does not silently rewrite an entry's history.

### Negative
- Ownership of a directive-dispatched job depends on having fetched its run. The runs are fetched
  alongside the jobs, but if that listing fails, those jobs look foreign for that tick and are not
  stored until it succeeds. Safe in the direction that matters — it under-claims rather than
  over-claims.
- A record can go stale against reality: cancel a stored job from the Mux dashboard and the entry
  keeps saying `completed`. Accepted, and the tab's live list is where current truth lives.

### Neutral
- Nothing migrates. Entries that already exist have no `robotsJobs`, and the rule only decides what
  gets added.

## Amendment, 2026-09-10: records are written at creation, not at completion

Found in manual testing: nothing was ever stored. The cause was that `GET /robots/v0/jobs` returns
a **summary** of each job — no `outputs`, and crucially no `passthrough`. So the ownership test
above could only ever succeed on the create response itself, which was never persisted, and every
later poll saw an anonymous job and correctly declined to store it.

The original design also stored terminal states only, to avoid flipping a published entry to
"Changed" because a status badge moved. That reasoning does not survive two facts:

- Clicking Run is a deliberate, billable act. An entry marked as changed because the editor just
  started an AI job on it is a record of what they did, not a surprise. The rule was protecting
  against writes the user did not cause, and this is not one of those.
- Ownership has to be **durable**. The only moment ownership is unambiguous is the create
  response. Writing the record then is what lets every subsequent summary-shaped poll recognise
  the job — and what makes it survive a reload.

So: the record is written when the job is created and updated as it progresses, and a job already
on the entry is ours by definition. `mergeJobRecords` merges rather than replaces, because an
incoming summary is *thinner* than the record we wrote from the create response and must not erase
its `passthrough` or `units_consumed`.

Cost: at most three writes per job (`pending → processing → completed`), each traceable to a
deliberate user action, and `updateField` still drops any tick that learns nothing.

## Amendment, 2026-09-10: ownership is a persistence rule, not a read gate

The rule above answers "what goes on the entry". It was also being used to answer "what may we
read", and those are not the same question.

`jobsNeedingDetail` took an `isOurs` predicate, so `GET /robots/v0/jobs/{workflow}/{id}` was only
issued for plugin-originated jobs. But the tab *lists* every Robots job on the asset — that is the
decision in the Context above, and the right one — and the list is a summary. The result was that a
job run from the Mux dashboard had a permanently blank Units column and an output modal with
nothing in it. Not a missing feature: a row that looks broken, on a job the tab chose to show.

There is no reason for the gate to be there. Reading a job is a GET; it costs nothing, charges
nobody, and reveals nothing the editor cannot already see in the Mux dashboard. So detail is now
fetched for every terminal job, and what must not happen — a stranger's job landing on the entry —
is enforced where it belongs, in `applyRobotsJobsToValue`.

Dropping the ownership filter widens the candidate pool from "our jobs" to "every job on the
asset", so it needed bounds that were previously unnecessary: `window` (default 20, newest first) is
a hard per-asset ceiling that did not exist before, and `limit` (default 5) caps one pass. Rows past
the window keep an em dash. A detail read that fails is tombstoned in the panel
(`failedDetailIds`) — without that the id never enters `jobDetails`, and the effect re-requests it
on every poll tick for as long as the entry stays open.

The subtle part is what fetching detail for other people's jobs exposes. Detail includes
`passthrough`, and ours is `contentful@<version>|<request-id>` — which identifies the **app, not the
space**. A job created by a *different Contentful install pointed at the same Mux account* carries
an identical-looking tag, and the ownership test above would have adopted it onto this entry. The
prefix was safe only for as long as a passthrough was read exclusively off a job we already knew
was ours.

So `isPluginOriginatedJob` and `applyRobotsJobsToValue` take `{ trustPassthrough }`:

- The **polling path** passes `trustPassthrough: false`. Ownership there comes only from the two
  durable, space-local signals — already recorded on the entry, or dispatched by a directive run on
  this asset.
- The **create path** and `findJobByPassthrough` keep trusting it, because they hold a job object
  they already know is theirs; the passthrough is being read back off a response to their own
  request, not off an anonymous listing.

Which leaves the decision above intact and slightly sharper: the entry still records only what ran
through Contentful *from this space*, and the tab still shows everything on the asset — now with
every row filled in.

> **Superseded 2026-09-11.** `trustPassthrough` no longer exists. The passthrough now carries the
> space, environment and entry it was written from, so ownership can be decided by *matching* the
> scope rather than by refusing to look at it. The reasoning above still explains why an
> unscoped passthrough proves nothing — that is exactly why the scope was added. See ADR-0003's
> 2026-09-11 amendment.

> **Also superseded:** this ADR predates `robotsDirectiveRuns`. Directive runs are now recorded on
> the entry at creation for the same reason jobs are, which is what stops ownership of the jobs a
> run dispatches from depending on the API's 25-run listing window. See ADR-0009.

## Amendment, 2026-09-16: the read gate stays; what it looks like changes

The amendment above bounded the widened read with `window` (newest 20) and `limit` (5 per pass).
That bound is right and it stays — every detail read is an app-action round trip, two CMA
requests, and an asset with two hundred dashboard jobs must not cost two hundred of them to open.

What was wrong was the sentence "rows past the window keep an em dash". In the Units column an em
dash reads as *this job consumed nothing*, and what it actually meant was *nobody ever asked*.
Blank-because-unknown against blank-because-empty is the same confusion that produced the empty
output modal and the blank Summary column; it had simply moved into a narrower cell. A bound that
is invisible to the reader is indistinguishable from data.

So the decision is unchanged and the presentation carries it:

- **The column has a vocabulary instead of a dash.** `unitsCell` in `RobotsJobTable` answers
  `Not charged` (errored or cancelled — Mux does not bill either, so no read is needed to know
  it), the number, `Not counted yet` (still running), `Unavailable` (the read was attempted and
  failed), `Not reported` (the whole job was read and carried no count) and `Not loaded` (past the
  window). No state renders a bare em dash.
- **Two demand-driven ways past the window, both bounded by a click.** `Not loaded` is itself the
  affordance: one detail read, for one row. And the output modal's fetch — which was already
  happening and was already being thrown away on close — is now handed back to the panel, so
  opening a row fills its Units for free. Request volume tracks interest rather than history
  length.
- **A cancelled job no longer offers "View output" at all.** It stopped before producing anything,
  so that button spent a round trip to display "This job was cancelled". The cell says so directly.
  This is the same fact as `Not charged` in the Units column, stated in the other place it shows
  up; the two have to agree, and a test holds them together.

Nothing about *ownership* moves. Detail is still read for jobs this install does not own, and what
must not happen — a stranger's job landing on the entry — is still enforced in
`applyRobotsJobsToValue`.

### Consequences of this amendment

**Positive.** The automatic cost of opening an entry is unchanged at ≤ 20 detail reads however
long the asset's history is, and no cell lies about why it is empty any more. Errored and
cancelled rows are now fully legible with no read at all.

**Negative.** Four more props on `RobotsJobTable`, which now needs to know what has been read as
well as what has been recorded. An editor who wants units for many old rows clicks many times;
that is deliberate, and the alternative is paying for rows nobody looks at.

**Neutral.** `jobsNeedingDetail` is untouched — same signature, same defaults, same bound. A
cancelled job still consumes a window slot even though `Not charged` makes its detail redundant
for the Units column; narrowing that would change which jobs can be adopted as orphans, which is
an ownership question and does not belong in a legibility fix.

## Amendment, 2026-09-16: how big this field is allowed to get

Recording only what the entry *never stops* growing by, because the decision above deliberately
makes growth monotonic: records are append-and-update only, so Mux's 30-day purge cannot erase
entry history, and nothing prunes.

Contentful confirmed the numbers for this shape: **roughly 50 KB at 200 jobs, and under 250 KB at
1,000 jobs**, against the standard Content Management API request-size limit. So a single video
would need something on the order of four thousand Robots jobs before the field became a problem.
That closes a question this ADR previously left open — the JSON-field size limit is not documented
publicly, and until now we had no figure for it.

Three things follow, none of which is a code change:

- **The request size is the field size, always.** `sdk.field.setValue` takes the whole value;
  Contentful's field API has no partial update. There is nothing to optimise here, so the only
  lever is not writing when nothing changed — which `updateField` already does, and which is
  mutation-tested.
- **What scales first is frequency, not size.** At 250 KB a job passing through
  `pending → processing → completed` is three writes of 250 KB. Still comfortable, but it grows
  with the history *and* with how much is running, where the size limit only grows with history.
  If this ever becomes a problem it will show up there, not as a rejected write.
- **Growth being monotonic is the property to keep an eye on, not the current number.** Pruning is
  what we gave up in exchange for history outliving Mux's 30-day purge. That trade is still right
  at these numbers; it is worth re-reading if the shape of what we store ever changes.
