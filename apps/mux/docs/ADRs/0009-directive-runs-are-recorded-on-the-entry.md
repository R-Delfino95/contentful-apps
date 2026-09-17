# ADR-0009: A directive run is recorded on the entry, so its jobs stay claimable

**Date:** 2026-09-11
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

ADR-0005 decided that a job dispatched by a directive run on this asset belongs on the entry, even
though Mux creates it server-side and it carries no `passthrough` of ours. The automation was
configured by this app through `new_asset_settings`, so the work is Contentful's.

The implementation of that rule depended entirely on being able to *see the run*, every time, from
scratch:

```
listRobotsDirectives({ limit: 100 }) ∪ defaultDirectiveIds
  → listRobotsDirectiveRuns(directiveId, { limit: 25 })
  → filter client-side on run.subject_id === assetId
  → jobIdsFromDirectiveRuns(runs)
```

Every one of those steps is a window, and the API gives no way to narrow any of them. There is no
`asset_id` filter on the runs endpoint — the filtering above happens in the browser, on whatever
25 runs came back — so on a directive that runs on every upload, this asset's run is pushed out of
the newest 25 within hours. A directive that is deleted takes its runs with it immediately. In
both cases the jobs that run dispatched stop being recognisable as ours: they are still listed in
the tab, they are still visible in Mux, and they can never again reach the entry. The entry ends up
with a permanent hole in exactly the automation ADR-0005 was written to preserve.

`handleRunDirective` made this worse than it needed to be. Starting a run from the Robots tab is a
deliberate, billable act by a named editor on a specific entry — the one case where ownership is
beyond doubt — and it wrote **nothing**. The record existed only in Mux, inside a list window, and
the app spent the rest of the session trying to re-derive a fact it had held in its hand.

The job path had already learned this. ADR-0005's first amendment moved job records from completion
to creation for the same reason: the only moment ownership is unambiguous is the create response,
and everything after that is a summary that cannot tell our work from a stranger's.

Alternatives considered:

- **Paginate the run list.** `listRobotsDirectiveRuns` takes `limit` and `page`, so the window can
  be walked. Rejected: the walk has no stopping condition. Nothing in a page says whether this
  asset's run is further back, so finding one run means reading every run of every directive in the
  account — on a poll loop, through the app-action bridge, on an entry the editor may just be
  glancing at. It also does not help at all with a deleted directive, which is the case that fails
  immediately rather than eventually.
- **Filter server-side.** The obvious fix, and the API cannot do it. `GET
  /robots/v0/directives/{id}/runs` accepts pagination and nothing else; there is no `asset_id` or
  `subject_id` parameter. Worth asking Mux for, and not something to block on.
- **Record the run only once it completes.** Symmetrical with the rejected "store terminal jobs
  only" from ADR-0005, and wrong for the same reason: the run can fall out of the window before it
  finishes, and then there is nothing to record.
- **Record every run the poll sees for this asset, not just the ones started here.** Tempting,
  because it would fix ingest-dispatched runs too. Rejected: it would add a `robotsDirectiveRuns`
  key — and with it a version bump and a "Changed" badge — to every existing entry whose asset merely
  has a directive run inside the API's window, for a run nobody started from that entry. That is
  the re-draft `deriveFieldVersion` exists to prevent, arriving through a different door.
- **Key the record by job instead of by run.** The run is the thing with an id at creation time;
  the jobs do not exist yet. Recording by job would mean recording nothing at the one moment the
  record is certain.

## Decision

A directive run started from the Robots tab is written to the entry **at creation**, in a new
`robotsDirectiveRuns` array on the field JSON:

```ts
interface RobotsDirectiveRunRecord {
  runId: string;
  directiveId: string;
  status?: RobotsDirectiveRunStatus;
  startedAt?: number;
  completedAt?: number;
  /** Ids of the jobs this run dispatched, as they become known. Append-only. */
  jobIds?: string[];
}
```

`jobIds` starts empty — `POST .../runs` answers with a run id and `pending`, nothing more — and
fills in as later reads report `node_states`. Ownership of a directive-dispatched job then comes
from the union of the runs currently listed by the API and the runs the entry itself records, so a
run falling out of the list window, or its directive being deleted, stops mattering.

The same rules as `robotsJobs` apply, for the same reasons:

- **Append-and-update only.** A record is never removed, and `jobIds` is unioned rather than
  replaced — a later listing can arrive without `node_states`, and dropping an id there would
  un-claim a job the entry had already claimed. Mux purges after 30 days; the entry's history has
  to outlive that.
- **Merged, not replaced**, so a thinner read cannot erase what a richer one knew.
- **Written through `updateField`**, in its own try/catch. The run has started and is billing, so a
  failed *write* is never reported as a failed *run*.

Adding a run is confined to creation. The polling path calls
`applyRobotsDirectiveRunsToValue`, which only ever *updates* runs the entry already holds; adding
is `recordRobotsDirectiveRun`, called from one place. That split is what keeps the change from
touching entries nobody started a run from.

### The version

`robotsDirectiveRuns` raises the value to **v4** — the same version `robotsJobs` and
`robotsOutputs` raise it to, not a third number of its own.

An earlier draft of this ADR gave each key its own version: jobs v4, outputs v5, directive runs
v6. That was wrong, and it is worth saying why, because it is the kind of wrong that looks
rigorous. A version exists to tell apart shapes written by *different builds*. All three keys ship
in the same release, so no build ever writes one without knowing about the other two, and there is
no shape for the extra numbers to distinguish. They would have described a history that never
happened — and every one of them is a number a future reader has to hold in their head, and a
place the two copies of the rule can drift apart.

```ts
const holdsRobotsData =
  (Array.isArray(jobs) && jobs.length > 0) ||
  !!value?.robotsOutputs ||
  (Array.isArray(directiveRuns) && directiveRuns.length > 0);

return Math.max(carried, holdsRobotsData ? FIELD_VERSION_WITH_ROBOTS : 0);
```

Derived, never asserted, and that distinction is the whole point. The version says what the value
*holds*, not what the build *knows about*. Hard-coding 4 would make the rebuilt value differ from
what is on disk for every entry that predates Robots, so merely opening one would trigger a
`setValue` and flip a published entry to "Changed" with no cause the editor can see — across every
org running this app, for a feature none of them have used. An entry with no Robots data keeps
whatever version it had, v1 and v2 records included, and the version is never downgraded, not even
from a version newer than this build understands.

`Array.isArray` rather than a truthy `.length` is also load-bearing: the field JSON is
user-reachable data, and a string has a `length` too. The same rule is duplicated in
`functions/src/helpers/muxField.ts` for `onPublish` (separate packages, independent builds — see
the note at the top of `muxFieldVersion.ts`). If the two ever disagree about the same value they
never converge: the browser writes its answer, the function writes its own on the next publish,
and the value flips back and forth for as long as the entry is edited. A mirrored table in
`muxFieldVersionParity.test.ts`, on both sides, is what holds them together.

## Consequences

### Positive

- A directive run started from Contentful, and every job it dispatches, stays attributable for the
  life of the entry. Not for as long as the run happens to be among the newest 25.
- Deleting a directive in Mux no longer silently orphans the work it did. The run record outlives
  the directive.
- The entry answers "what automation did we run on this video, from here, and when" without a
  network call, which is the same thing `robotsJobs` does for ad-hoc runs.
- The write is bounded and traceable: one record per deliberate click, updated as the run
  progresses, and `updateField` drops any tick that learns nothing.

### Negative

- **Runs dispatched at ingest are still hostage to the list window.** Those are created by Mux from
  `new_asset_settings`, with no browser involved, so there is no creation moment for this app to
  record. Their jobs are still claimed while the run is listed and still become unclaimable once it
  is not. Fixing that needs either a server-side filter on the runs endpoint or a record written by
  `onPublish`, and neither belongs in this change.
- Starting a directive run now writes to the entry, so it flips a published entry to "Changed"
  where it previously did not. Deliberate, and the same trade ADR-0005's first amendment made for
  jobs: the editor spent money on this video and the entry says so.
- A record can go stale. Cancel a run from the Mux dashboard and the entry keeps whatever status it
  last saw. Accepted — the tab's live list is where current truth lives.
- One more key on a JSON field whose size limits Contentful does not document. Small: an id, a
  directive id, two timestamps and a handful of job ids per run.

### Neutral

- Nothing migrates. Existing entries have no `robotsDirectiveRuns`, stay on whatever version they
  hold, and only gain the key if someone starts a directive run from them.
- `robotsJobs` and `robotsDirectiveRuns` overlap on purpose: a dispatched job appears in both, once
  as a job record and once as an id inside its run. They answer different questions — what ran, and
  what set it running.
