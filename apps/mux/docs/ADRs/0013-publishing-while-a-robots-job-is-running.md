# ADR-0013: Publishing while a Robots job is running is allowed, and said out loud

**Date:** 2026-09-17
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

Two sequences an editor will hit routinely:

1. Start a Robots job, then click Publish a few seconds later.
2. Start a Robots job, close the tab, come back later, click Publish.

Neither destroys anything any more. ADR-0002 made `onPublish` merge rather than replace, so a
publish carrying pending actions no longer wipes `robotsJobs` and `robotsOutputs`; the publish gate
parks browser writes while the function rewrites the field server-side; ADR-0010 made the parked
writes survive an unmount instead of being dropped in silence; and ADR-0005 made the record land at
creation, so a job started and published seconds later is already on the entry.

What none of that fixes is **staleness of the published value**. A job that is `processing` when
Publish is clicked publishes as `processing`, and the published entry keeps saying so until
somebody reopens the entry, lets the poll update the record, and publishes again. ADR-0002 already
considered and rejected reconciling Robots inside `onPublish`: the function early-returns unless
there are `pendingActions`, so it would only help the narrow subset of publishes that carry one,
and making it run on every publish means an entry update plus republish on every publish — which
re-triggers the same event and needs its own loop guard.

Sequence 2 has a second, sharper edge. `isActive` gates the Robots tab's first fetch, which is what
keeps the feature free for editors who never open it. So an editor who reopens the entry, does not
open the Robots tab, and publishes, re-publishes the same stale record — the poll never ran.

### The obvious idea: block Contentful's Publish button

Investigated and rejected, on facts rather than taste.

There is no App SDK method to disable or hide the native Publish button; it lives in the Contentful
shell, outside the app's iframe. `sdk.field.setInvalid()` is visual only — it draws the error bar
and does not block publishing — and only affects the field the app is bound to.

The documented lever is a **content-type validation**, and the specific proposal was to put a
`status: 'processing' | 'ready'` key inside the field's JSON and validate it. That does not work.
Contentful's validation vocabulary applies to a *field value*, not to a path inside one — the full
list, from `contentful-management`'s `ContentTypeFieldValidation`, is `linkContentType`, `in`,
`linkMimetypeGroup`, `enabledNodeTypes`, `enabledMarks`, `unique`, `size`, `range`, `dateRange`,
`regexp`, `prohibitRegexp`, `assetImageDimensions`, `assetFileSize` and `nodes`. None of them can
address a nested key; `regexp` is for Symbol and Text, and on an Object field the only validation
that even applies is `size`, which counts properties.

Making it work would need an **auxiliary Symbol field on the customer's content type**, and that is
where the cost sits for this app specifically:

- This is a field editor installed on JSON Object fields of content types customers already own.
  It writes no content types today, anywhere.
- Adding a field is a schema change delivered to every existing install at once — ADR-0006's
  central hazard, one level worse, because it changes their model rather than an entry's value.
- It would make the entry genuinely **un-publishable** while a job runs. A `summarize` takes
  minutes and a directive considerably longer, and an editor fixing a caption typo has no reason to
  be blocked by an AI job running in the background.

It also would not simplify anything. Every existing mechanism stays necessary: the serialized write
path (ADR-0001) because two poll loops write the field whether or not a publish is happening;
`onPublish` merging (ADR-0002) and the publish gate because the function rewrites the field on any
publish carrying `pendingActions`, which asset and caption deletes produce independently of Robots;
records-at-creation (ADR-0005) because that is about surviving a reload. Blocking publish would be
purely additive complexity that addresses one symptom by removing a capability.

## Decision

Publishing mid-job stays allowed. Two changes, both driven by one predicate over data the browser
already holds:

**`unfinishedJobRecords(value)`** (`util/robotsField.ts`) returns the job records the *entry itself*
carries that are neither terminal nor older than `ROBOTS_STALE_JOB_MS`. It reads the stored value,
so it costs no request and is known on the first render, before anything has been fetched.

1. **The editor says what a publish now will do.** A notice above the tabs — not inside the Robots
   tab, because the editor deciding to publish is not necessarily looking at it — naming how many
   jobs are running and stating that publishing now publishes the job unfinished, and that
   publishing again after it completes is what includes the result.

2. **The poll resumes without anybody opening the Robots tab.** The first-load effect now fires when
   `isActive || hasUnfinishedJobs`. The `isActive` gate is otherwise untouched, so an install that
   has never run Robots has no records, qualifies for nothing, and still fetches nothing.

The six-hour staleness cut-off is what keeps both honest. A record stuck at `processing` — a job Mux
purged, a session that died mid-run — stops driving the notice and the fetch after six hours rather
than nagging on every open and polling for the life of the entry.

## Consequences

- An editor who publishes mid-job gets an accurate published value on their *second* publish, and
  now knows that before they click rather than after.
- An entry reopened with a job in flight costs one capability resolve (cached per browser session),
  one job list and one run list per configured directive, whether or not the Robots tab is opened.
  Bounded to entries that record an unfinished job, which is a small set by construction.
- The notice is driven by the stored record, not by a live read, so it is correct the moment the
  entry renders and wrong only in the window where the job finished and nothing has polled yet —
  which the resumed poll closes within one tick.
- Nothing about this writes to the field, so an entry that predates Robots has no `robotsJobs`,
  qualifies for neither behaviour, and stays byte-identical to what is on disk (ADR-0006).
- Reconciling Robots inside `onPublish` remains rejected, and remains the only thing that would make
  a *single* publish carry a finished result. If that is ever wanted, ADR-0002's loop-guard problem
  is the thing to solve first.
