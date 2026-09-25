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

> **See also, 2026-09-25.** For summarize and moderate the hole is smaller than this says: their
> outputs now reach `robotsOutputs` whoever dispatched the job, so an unclaimable job's summary is
> still kept (ADR-0005's amendment of that date). What stays unclaimable is the job record, which
> is what this ADR, and every "shown is not stored" below, is about.

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

## Amendment, 2026-09-21: which directives get read, and saying so after an upload

Two things, both about the set of directives this tab asks the runs endpoint for.

### The set was "every directive in the account"

The Context above writes the ownership derivation as
`listRobotsDirectives({ limit: 100 }) ∪ defaultDirectiveIds → listRobotsDirectiveRuns(...)`, and
that first term is a list fetched for something else entirely: the *names* in the ad-hoc picker.
Unioning it into the poll set means the runs of every directive in the account are read, one
app-action round trip each, to find the at most one or two that touch this asset. Measured on a
fixture account with fifty directives, opening the tab went from 4 calls to 56 — 52 of them
`listRobotsDirectiveRuns` against directives with no connection to the video on screen.

Recording it as a decision would overstate it: the widening was a side effect of where
`loadDirectives` sat in the load order, and the original code even hid it by accident, because the
widened pass usually collided with the one already in flight and was dropped by the hook's own
one-at-a-time guard. A fan-out that large, landing only sometimes, is worse than either outcome.

The set is now three narrower sources, and none of them is the account: the directives configured
to run at ingest, the directives this entry already records a run from, and the ones currently on
screen. The middle one is what this ADR is for — a run started from the tab is recorded at
creation, so its directive stays in the set even if an admin later drops it from the
configuration, and even after the run has aged out of the API's newest-25 window. The rejected
alternative is unchanged: there is still no `asset_id` filter on the runs endpoint, so asking
fewer directives is the only lever there is.

### Ingest-dispatched runs now say hello, once

The Negative consequence above stands: a run Mux dispatches from `new_asset_settings` has no
creation moment in the browser, so there is nothing for this app to record, and its jobs are
claimable only while the run is listed. Testing found the editor-facing half of that gap, which is
smaller and worth closing on its own: the asset uploaded, the attached directive ran correctly,
and the editor had no idea until they happened to open the Robots tab.

So when an asset reports `ready` after an upload that attached a directive, the app checks once
for jobs or runs on it and, if there are any, says so — a notifier toast pointing at the tab. It
is not a fix for the ownership gap and does not pretend to be; ownership still needs either a
server-side filter on the runs endpoint or a record written by `onPublish`.

Four bounds, because a toast is not worth a poll loop:

- **Only for an upload that attached a directive.** The ids are stashed at `onConfirmModal`,
  which is the one moment the browser knows automation was requested. An install with no
  directives configured makes no request and hears nothing (ADR-0006).
- **Once per session**, from an instance flag — never derived from the stored value, which is
  what keeps it off every later open of an entry whose asset happens to have automation on it.
- **Four attempts, five seconds apart**, then it stops and leaves the question to the tab.
- **`await`ed waits, not scheduled callbacks**, with an unmount check before each attempt and
  before the toast. A closing tab stops rather than notifying into a component that is gone.

It fires on `ready` rather than on the asset id appearing, because that is when an
ingest-attached directive actually starts — for a long video the id arrives minutes earlier.

### Consequences of this amendment

**Positive.** Opening the tab costs a bounded number of round trips again, independent of how
many directives the account has. Automation an editor could not see now announces itself at the
moment they are still looking at the upload.

**Negative.** A directive whose run this entry has never recorded, and which is no longer in the
configuration, is not polled. That is the intended narrowing and it is a real loss: the case it
gives up is an ingest-dispatched run from a directive an admin removed after the upload. It was
already unclaimable once its run left the list window.

**Neutral.** The full directive listing is still fetched, still once, still only for the picker's
names — it just no longer decides what gets polled. The same listing now also labels the upload
modal's Automation section, which used to render raw ids beside a checkbox asking whether to
spend money.

## Amendment, 2026-09-23: the runs a video's own jobs name

The amendment above narrowed the runs this tab reads to three sources — directives configured at
install, directives this entry records a run from, directives already on screen — and recorded
its loss as "an ingest-dispatched run from a directive an admin removed after the upload". The
loss was larger. A video imported from Mux, with a directive run on it, listed its jobs and said
"No directive runs for this video yet": its directive was never configured here and no run was
recorded, so none of the three sources named it, and only the fan-out over every directive in the
account had ever found it.

The fan-out is not coming back. The single-job GET names the run that dispatched a job —
`directive: { id, run_id }`, documented in the API reference and in `@mux/mux-node` as
`JobDirectiveContext`, absent for a job created by a direct POST, never on the list summary — and
those are exactly the two ids `GET /robots/v0/directives/{id}/runs/{run_id}` takes. The tab
already reads that GET for the newest terminal jobs on the asset (ADR-0005), so those jobs name
the runs worth reading, and each is read once, by id: `directiveRunRefsFromJobs`, then
`useRobotsDirectiveRuns`.

**Bounded by the asset.** One read per distinct run the asset's jobs name that no listing already
returned. A finished run is not read again; a running one is re-read at the cadence the listing
already polls live runs at, and keeps the loop alive the way a listed run does. No directive is
listed to find it, and a named run does not join the listed set, so nothing about the size of the
account enters the cost.

**Shown is not stored.** A named run goes through `applyRobotsDirectiveRunsToValue`, which only
ever updates runs the entry records, so no `robotsDirectiveRuns` key is added to an entry nobody
started a run from — the rule this ADR's Decision exists for, and the re-draft
`deriveFieldVersion` guards against. Its jobs are claimed only if its directive is one this entry
already claims runs of — configured at install, recorded, or started from this tab — which is the
rule a listed run has always been held to, now independent of how the run was found. A run of any
other directive is shown, and its jobs are marked as started elsewhere.

**The documented gap narrows.** The Negative consequence above — runs dispatched at ingest are
hostage to the list window — no longer holds for a configured directive whose run is named by a
job the tab has read: the window stops mattering, and the jobs are claimed. It still holds for a
run none of whose jobs are among the newest twenty terminal ones, because nothing names it.

**A run still in progress is found when its first job finishes.** Detail is read for terminal
jobs only, so until then no job names the run. Accepted, for three reasons. The poll is already
running for that job, and the read that reveals the run is one the tab makes anyway, so finding
it costs nothing extra. No read bounded by the asset can find a run before it dispatches anything,
so a gap exists whatever is done; reading jobs still running would shorten it, not close it. And
that read — the single-job GET on a job still running — is the one ADR-0003 declined for
orphans; if it is ever worth making, it serves both, and deserves its own decision.

**The one-pass-at-a-time guard now queues.** `loadDirectiveRuns` dropped a pass asked for while
another ran, which was harmless while every request covered the same set. Job detail now changes
the set, and routinely lands while the first listing is still in flight, so the named run went
unread until something else asked. A request for a different set is served after the running
pass; a duplicate of it is still dropped, which is what keeps a first open at one listing per
directive.

### Consequences of this amendment

**Positive.** An imported video shows the automation that ran on it, at a cost set by the video's
own jobs. The fan-out stays gone. A configured directive's ingest run is claimable after it leaves
the newest-25 window, as long as one of its jobs has been read.

**Negative.** A run is found only through a job whose detail has been read: one whose first job is
still running, or whose jobs are all older than the detail window, stays invisible. And claiming
past the window writes `robotsJobs` to entries the window used to keep it off — the claim ADR-0005
always intended, reaching entries it did not before, so some existing entries will show Changed
the next time someone opens their Robots tab.

**Neutral.** The job's `directive` reference is documented, and it is newer than the rest of the
job shape this app relies on. If it were ever absent, a named run would simply not be found, and
everything else would behave as it did before this amendment.

## Amendment, 2026-09-24: configured ids that no longer resolve

Two reports, one fault. Replacing the Mux token in the app's settings left the directives chosen
under the old one configured, where they may not exist. And with directive A configured, A deleted
in Mux and B created in its place: B was selected and saved, and the entry editor went on offering
A — in the Robots tab's picker and in the upload modal's Automation section — until a full page
reload.

Both are a configured id that no longer resolves against the current credentials. Two causes were
suspected; the code had some of each.

**Deselecting A was possible, and nothing said it was needed.** A saved id the listing did not
return was not invisible: it rendered under "Selected by ID", checked, and unticking it removed it.
But it rendered exactly like an id typed in by hand, so a deleted directive survived every save
looking legitimate. The listing was also not tied to the token it was read with: replace the token
and the previous account's directives stayed on screen as choices; and a listing refused on page
two was used as if it were complete.

**The stale answer in the entry editor is the installation-parameter snapshot, made worse by our
own code.** `sdk.parameters.installation` is handed to the iframe once, when it loads — this
repository's link-checker app ran into the same thing and reloads on it (commit `c7a41f4f5`).
Nothing here re-reads it, and no module-level cache holds directive ids: the capability cache and
the API client's action ids are the only ones, and each iframe starts both from nothing. So what
the reviewer's editor showed came from the parameters it was handed when it loaded; a full reload
fixing it fits both an editor that predated the save and a web app handing a newly opened one an
older copy, and which of the two it was is not observable from here. What this app added on top: the
picker offered that snapshot while the listing was in flight, fell back to it when the listing
came back *empty*, and never listed again — Refresh did not touch it. The upload modal attached
every id in the snapshot, whether Mux had it or not.

### What changed

**One rule, applied where each id is used: the configured ids are a hint, and a complete listing
from Mux is the answer.**

- *The config screen* keeps a listing together with the credentials it was read with, and shows
  it only while those are the ones in the form. A selected id that a complete listing does not
  return is marked as not in this Mux account, with a Remove button. A replaced token is flagged
  until the directives are listed again, not cleared: a new token for the same environment keeps
  every id valid, and clearing would drop the automation of an admin who was only rotating it.
- *The Robots tab's picker* offers what the listing returns, falls back to the configured ids only
  when the listing fails, says so when the account has none, and Refresh lists again. A choice the
  newest listing no longer offers is dropped rather than run into a 404.
- *The upload modal* does not attach a configured id that a complete listing — fewer than one full
  page — does not return, and says why. A listing that fails, or fills a page, is not evidence of
  absence, and attaches everything as before.

**Reading the installation fresh was considered and not done.** A CMA read of the app installation
at mount would close the snapshot gap, and it would cost a request on every open of every entry
with a video, for every install — including the ones that never enable Robots (ADR-0006). This
repository's content-insights app removed exactly that read for CMA rate-limit pressure (commit
`c114828d8`); link-checker still makes it, only when its page is returned to, and found the SDK's
client there offers only the org-wide `getForOrganization` (commit `c7a41f4f5`). What is left
open: a directive *added* to the configuration after an editor's page loaded is not attached to
that editor's uploads, nor polled as a configured directive, until the page reloads — the picker
does list it, because the picker lists what Mux has. The upload modal says a reload picks up a
changed configuration when it finds a configured id Mux does not have.

### Consequences of this amendment

**Positive.** A configured directive Mux does not have can no longer ride on an upload or be picked
for a run, and the config screen shows it for what it is at the moment an admin can remove it. A
listing is never read against a token it did not come from.

**Negative.** The picker is empty for the length of the listing round trip rather than showing the
configured ids straight away. And the snapshot gap is narrowed, not closed: an editor whose page
predates a configuration change still gets the old defaults, minus any Mux no longer has.

**Neutral.** Nothing is removed from the configuration automatically. Every removal is an admin's
click on a listing made with the token in the form, and nothing is saved until they save.
