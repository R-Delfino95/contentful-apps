# ADR-0008: Robots outputs are keyed by workflow, so a re-run supersedes the last one

**Date:** 2026-09-10
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

`robotsOutputs` on the field JSON is a map keyed by **workflow name**, not by job id:

```ts
export interface RobotsOutputs {
  summarize?: RobotsSummarizeOutput;
  moderate?: RobotsModerateOutput;
}
```

Only those two workflows persist output at all (`PERSISTED_OUTPUT_WORKFLOWS`). The rest either
attach a track to the Mux asset or arrive through the existing asset mirror, so they never need a
slot here.

The consequence of that shape is that running `summarize` twice on the same asset leaves one
summary on the entry: `mergeRobotsOutputs` writes the newest completed run into `.summarize` and the
previous values are gone. Same for `moderate`. Whether that is a bug depends on what the field is
*for*, and the field is a **current-state mirror for the Delivery API**. A CDA consumer asking "what
is this video's summary?" wants one answer, not an array to pick from, and
`entry.fields.muxVideo.robotsOutputs.summarize.description` is only a stable read path because the
key is the workflow.

Provenance does not depend on the key. Each output object carries its own `jobId` and `completedAt`,
so whatever is on the entry is always traceable to the exact job that produced it — what a re-run
discards is the superseded *values*, not the record of what ran. The history of runs lives in
`robotsJobs`, which is append-and-update only (ADR-0005): every summarize job that ever ran from
this space is still listed there with its id, status and timing. And the job itself is still
readable from Mux for 30 days via `GET /robots/v0/jobs/{workflow}/{id}`, outputs included.

Alternatives considered:

- **Key by job id.** Breaks the stable read path — the consumer has to enumerate the map, sort by
  `completedAt` and pick, for a question that has one useful answer. It also pushes a policy
  decision (which summary is the summary?) out to every consumer independently.
- **Keep an array per workflow.** Same burden on the consumer, plus unbounded growth of the field
  for data that is by definition superseded. Contentful's JSON-field size limits are undocumented,
  which is exactly the reason scenes and key moments are not persisted either.
- **Refuse to overwrite, or ask the editor to confirm.** The common case is an editor deliberately
  re-running summarize because the first result was not good enough. A confirm dialog there is
  noise on the happy path, and refusing outright would mean the better result cannot reach the
  Delivery API at all.

## Decision

`robotsOutputs` stays keyed by workflow, and the newest completed run wins. `isNewerOutput` compares
`completedAt`, so a late-arriving older job does not clobber a newer output, but among successive
runs the last one to complete is the one the entry keeps.

History is answered elsewhere, deliberately: `robotsJobs` for which jobs ran and when, Mux for what
a specific job produced.

> **Amended 2026-09-25.** Every completed summarize and moderate job on the asset is now a
> candidate, whoever started it, so `robotsJobs` answers only for the jobs run from here; and a tie
> on `completedAt` goes to the greater job id. See the amendment of that date below.

## Consequences

### Positive
- `robotsOutputs.summarize.description` is a stable, single-valued read path on the Delivery API. No
  sorting, no choosing, no array handling in the consumer.
- The field cannot grow with re-runs. A video summarized fifty times has the same
  `robotsOutputs` size as one summarized once.
- The surviving output is still attributable: `jobId` and `completedAt` say which run produced it.
- Re-running to get a better title just works, which is what an editor expects from a Run button.

### Negative
- **A superseded output is unrecoverable from Contentful, and recoverable from Mux only for 30
  days.** After the purge window it is gone. There is no undo in the entry, and re-running summarize
  to get a better title silently discards the previous one — usually what the editor wants, and not
  reversible from Contentful either way.
- The entry cannot answer "did the summary change between these two runs". Comparing runs means
  reading both jobs from Mux inside the retention window.

### Neutral
- `robotsJobs` and `robotsOutputs` disagree in cardinality by design: many jobs, at most one output
  per workflow. Anyone reading the field needs to know that the two are answering different
  questions.
- Nothing migrates. The map has always had this shape; this ADR records why it keeps it.

## Amendment, 2026-09-25: any job on the asset can supply the output, so the order has to be total

ADR-0005's amendment of the same date makes every completed summarize and moderate job on the
asset a candidate for this map, not only the ones the entry claims: an output describes the video,
whoever asked for it. The key and "newest completed wins" are unchanged. Two things this ADR says
about them needed restating.

**Provenance no longer implies a job record.** The Context says the history of runs lives in
`robotsJobs`, where every summarize job that ever ran from this space is still listed. That stays
true of those jobs; but the output's `jobId` can now name a job `robotsJobs` does not hold, because
it was started from the dashboard, another entry, or a directive this entry does not claim. That
absence is the signal: a reader who finds `robotsOutputs.summarize.jobId` missing from `robotsJobs`
is looking at a summary this entry did not ask for. The output still carries its own `jobId` and
`completedAt`, and the job is still readable from Mux for 30 days. "History is answered elsewhere"
now reads: `robotsJobs` for which jobs ran *from here*, and when; Mux for what any job produced.
`robotsJobs` and `robotsOutputs` now differ in membership as well as in cardinality.

**On a tie the comparison had no answer.** `isNewerOutput` compared `completedAt` with `>=`, a
missing value counting as 0. Mux timestamps are whole seconds, so two jobs completing in the same
second tie, and so do two with no timestamp; the tie went to whichever was read last. While only
the entry's own runs fed the map, that was rare and settled after one extra write, because the list
order is stable. With the dashboard and every directive on the asset feeding it, it is less rare,
and across sessions it does not settle: two editors with the tab open, each having read a different
one of the pair — a detail read failed in one session and was tombstoned, or one opened a row past
the window that the other has not — rewrite the entry back and forth on every poll tick while
anything on the asset is running, each write an entry version and a *Changed* badge.

So the order is now strict: a later `completedAt` wins, and on a tie the greater job id does. The
id means nothing; what matters is that every session, every read order and every subset of reads
agrees, so a session that has only seen the losing job leaves the winning one alone. A missing
`completedAt` still counts as oldest: an output whose completion cannot be placed does not displace
one that can, and one that can displaces it. A stored `completedAt` that is not a number now counts
as missing too — the field JSON is user-reachable, and under `?? 0` a string made every comparison
false, pinning that output against every later run.

**Reads bound what can compete.** Outputs come only from job detail, which is read for the newest
20 jobs on the asset (ADR-0005). An older job read late — a row past that window, opened later —
is compared like any other and cannot displace a newer output. The reverse is the gap: when the
newest summarize is itself past the window, the entry keeps the older output until its row is read.
That is ADR-0005's bound applied to outputs, not a new one.

### Consequences of this amendment

**Positive.** One answer per workflow, whichever session asks and in whatever order reads land, so
two open tabs cannot trade writes over a tie. A garbled timestamp no longer freezes an output.

**Negative.** The tie-break is arbitrary. It is not "the one that really finished last", which the
API cannot tell us at a second's resolution. And a summary from elsewhere now supersedes one run
here by the same rule, which an editor who re-ran summarize from the dashboard to compare may not
expect.

**Neutral.** The key, the read path and the provenance fields are unchanged; nothing migrates.
