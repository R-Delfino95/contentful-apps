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
