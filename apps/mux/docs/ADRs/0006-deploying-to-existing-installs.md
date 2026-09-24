# ADR-0006: What this release must not change for installs that already exist

**Date:** 2026-09-09
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

The Mux app is a single hosted bundle behind one app definition. There is no per-install version
and no upgrade decision for the customer: when Contentful activates a bundle, **every** install is
on it at once. So this release reaches every org using the app on the same day, including the many
that will never enable Robots.

That makes "does the feature work" the easy half. The hard half is that a feature nobody asked for
must be invisible and inert for them.

Four specific hazards were found while auditing the diff against that standard, all of them
introduced by this work rather than pre-existing:

1. **The publish function stored `pendingActions: null`** where it previously omitted the key. Two
   consequences: the stored value would differ from what is on disk, so the browser's normalized
   diff would see a change and write the field again on every such publish; and the next publish's
   pending-action scan tests `'pendingActions' in value`, which is true for `null`, then indexes
   into it — throwing from outside the handler's try block and failing the whole event.
2. **The pending-action scan was widened to every locale.** Correct in the abstract, but it would
   make the next publish execute actions queued in a non-default locale that have never run —
   including asset deletes queued long ago and forgotten.
3. **The configuration screen listed Robots directives on mount.** Every existing customer opening
   app config would fire a cross-origin call to `api.mux.com/robots/v0/directives` and, on the 403
   most of them would get, see an error notice on a screen they came to for something else.
4. **The Robots panel renders inside the field extension**, so an unhandled render error there
   would unmount the whole thing: no player, no captions, no upload area.

   *Corrected 2026-09-11:* this hazard originally read "mounted on every entry with a video,
   because every `Tabs.Panel` renders". That reason is wrong. `Tabs.Panel` forwards `forceMount`
   to Radix's `Tabs.Content`, and nothing here passes it — so an inactive panel is **unmounted**,
   not merely hidden, and the Robots panel only exists while its tab is selected. The error
   boundary is still worth having; the stated reason for it was not true. See the consequences of
   that unmount recorded in ADR-0003's 2026-09-11 amendment.

   *Corrected again 2026-09-16:* the original claim is true once more, for the opposite reason.
   The panel now **does** pass `forceMount`, because the unconfirmed-create guard lives in its
   state and a tab switch was unmounting it — two clicks from paying for the same job twice — and
   because the poll loop has to keep running while the editor watches the Captions tab. So the
   Robots panel is mounted on every entry with a video again, including for installs that never
   enable Robots, and the error boundary is now load-bearing rather than precautionary. It costs
   nothing in requests: `isActive` still gates the first load.

## Decision

1. The merge deletes `pendingActions` rather than nulling it, and the scan is hardened against a
   `null` it could already encounter.
2. The scan stays first-locale-only. The multi-locale bug is documented, not fixed here.
3. Directives are listed only when someone clicks. Nothing is requested on mount.
4. The Robots panel is wrapped in `RobotsErrorBoundary`, so a fault there costs exactly that tab.

Two properties already designed for, restated here because they are the ones a regression would be
worst in:

- **The field version is derived, never asserted** (`deriveFieldVersion`). An entry with no Robots
  data produces a byte-identical value, so no `setValue` happens and no published entry flips to
  *Changed*. Pinned by tests that fail if the version is hard-coded.
- **The request body sent to Mux is unchanged when no directives are configured.**
  `buildAssetSettings` adds the `directives` key only when there is something to put in it.

## Consequences

### Positive
- An install that never enables Robots sees one extra tab and nothing else: no requests, no writes,
  no entry churn, and no exposure to faults in code it does not use.

### Negative
- The per-locale pending-action bug survives, and someone will hit it again.
- The error boundary can mask a real bug behind a friendly notice. It logs to the console, which is
  the trade accepted.

### Neutral
- The new tab shifts the tab order for everyone. Cosmetic, and unavoidable for a feature that lives
  in a tab.

## Amendment, 2026-09-21: what the tab costs, and the tab strip it sits in

Two consequences recorded above have since been measured rather than reasoned about, and one of
them was wrong.

**"One extra tab and nothing else" was true about requests and not about the tab strip.** The
Neutral note says the new tab shifts the tab order for everyone, "cosmetic, and unavoidable". It
turned out not to be only cosmetic: with eight tabs the strip is about 860 px against an entry
editor field column that is routinely half that, and `.tabs-scroll` carried a `mask-image`
gradient fading its last 20% to transparent. That was meant to hint at more tabs. Measured in a
browser at a constrained width it did three things instead — it faded whichever tab sat on the
boundary to unreadable *mid-word*, which is how "Data" and "Metadata" were reported as clipped;
it did so at every width, including widths where nothing overflowed and there was empty space
beside the last tab; and it painted over the scrollbar, erasing the one signal that appears only
when there is in fact something to scroll to.

The strip already scrolled — `overflow-x: auto` with `flex: 0 0 auto` tabs — and focusing a tab
brings it into view, so every tab was always reachable by scroll and by keyboard. The gradient is
gone and the scrollbar is the affordance: thin, always drawn rather than left to the platform's
overlay behaviour, and present exactly when there is overflow. Sixty lines of CSS for scroll
buttons that no element ever carried went with it; a decorative rule nobody reads is the same
hazard as the decorative `MUX_ASSET_MIRROR_KEYS` constant in ADR-0002's amendment, and it is part
of why the mask went unexamined.

**The "no requests" property survived a change that briefly threatened it.** Resolving Robots
capability used to be a dedicated `listRobotsJobs({ limit: 1 })` probe, cached per browser
session, awaited before the tab read anything it wanted. The probe is gone — the panel's own job
list answers the same question — which removes a serialized round trip from the first open. What
that nearly cost is the property this ADR is about: with the probe went the short-circuit that
made entries 2..n of a session free for an install where Robots is *not* available. The session
cache is still filled, now by the read that was happening anyway, and the panel reads it at mount
and does not fetch when it already says unavailable. An account does not acquire the `robots:*`
scope between two entries.

### Consequences of this amendment

- Every tab is legible at the widths this editor actually renders at, and the affordance for the
  ones off-screen appears only when some are.
- An install that never enables Robots still sees one extra tab, and opening it costs one failed
  request per session rather than one per entry.
- The gradient is the second decorative thing in this codebase to be read as a guarantee. The
  test that pins its absence is a regression guard, not a layout test — jsdom has no layout, and
  the scrolling itself is verified by hand in a browser at a constrained width.

## Amendment, 2026-09-23: what decides capability, and what is not a capability at all

The amendment above says the panel's own job list answers the capability question. It was not
the only thing answering it, and three reports from manual testing were the same fault seen from
three places.

**The config screen had no classifier.** It branched on the status alone — 401 said "credentials
rejected", 403 said "needs the `robots:*` scope, which cannot be added to an existing token —
generate a new one". The one 403 the API reference documents on the Robots endpoints means
Robots is not enabled for the environment until its terms are accepted, and Mux sends it as
`{ error: { type: "forbidden", messages: ["Go to your Robots page in the Mux Dashboard to accept
the terms: https://dashboard.mux.com/organizations/…/environments/…/robots/jobs"] } }`. So an
account that had only not accepted the terms was told to throw away a working token, which is
advice a new token cannot follow: it is refused the same way. There were never two classifiers,
only `capabilityFromError` and a status check standing in for it. The screen now adapts its raw
`fetch` response into the same `MuxApiError` `muxProxy` produces (`muxApiErrorFromResponse`) and
asks the same function, and it shows the same notes.

What tells the two apart is the status, not the type. `forbidden` is the type Mux gives every 403
of that kind, so on its own it separates nothing. The scope refusal reached the scope explainer
through a 401 or an `insufficient_scope` type, the classifier's only two routes there; nothing Mux
documents sends the second, and it is still honoured. The message is never used to classify — it
is read only for the page it names, below.

**A refused create was read as an answer about the account.** `handleRun` handed any 401 or 403
from a create to `setCapability`. `translate-audio` is refused on the free plan with
`type: "robots_workflow_not_available"` while every other workflow runs, so the run reported its
own error correctly and the tab then said Robots was not enabled at all — and, since the poll
loop is gated on capability, stopped watching the jobs already running.

A per-run refusal is distinguishable: Robots' own refusals of one run carry a `robots_*` type,
the account-level one carries `forbidden`. That is used — but it is not what the decision rests
on, because even an account-level-looking refusal of a create does not prove the account lost
Robots. Mux's scopes separate reading Robots from writing it (its CLI requests `robots:read` and
`robots:write` separately), so a create refused for scope says nothing certain about the list.
So **capability is decided by the job list read, and nothing else.** A refused create is a failed
run: its toast carries Mux's reason. One that could mean the account lost access — a 401, or a
`forbidden` 403 — asks the list again, and the list decides. A `robots_*` 403, or a type the
classifier does not know, changes nothing beyond the run.

**Units exhaustion replaced the whole tab.** The same path set `units-exhausted` as the
capability. It was never written to the session cache — only the list read writes that — but it
held for the life of the panel, which is force-mounted and keyed by asset and so outlives a tab
switch, and it stopped the poll. The list-read path would have cached it for the session had
Mux ever refused a list for units, and the mount-time cache check skips loading the tab entirely
for any unavailable answer; the reference documents no such refusal on the list, so that half was
latent.

Units are not a capability. Mux refuses a run that would not fit what is left, so a cheaper
workflow can still run, and the history and directives are worth seeing either way. The concept
is now two:

- **Capability** — `enabled`, `not-enabled`, `scope-missing`. What the tab *is*. Decided by the
  list read, cached for the session, and an unavailable answer replaces the tab, because nothing
  in it could work.
- **Advisory** — `units-exhausted`. What the last refused run ran into. A warning over a working
  tab; never cached; and not a capability by type, so neither path can store it as one.

The warning clears on the next run Mux accepts, job or directive, because that is the only
evidence units are back. The list read says nothing about units, so clearing it there would drop
a true warning within one poll tick; caching it would outlive its cause the moment a month rolls
over or a running job finishes. A remount starts without it, and the next refused run brings it
back.

**"Mux said: …" is gone from every state.** Each state's copy says what is wrong and what to do,
and Mux's sentence repeated it — except once. The terms 403 carries the exact page where the terms
are accepted, which nothing else in the response identifies, so that page is now the
`not-enabled` note's own link (`termsUrl`), read out of the message only if it is on
`https://dashboard.mux.com/`. Extracted rather than rebuilt: the organization and environment ids
are not ours to know. And given a fallback, because the reference describes this 403 without
promising the link: with none, the note links the dashboard root, which needs no ids.

### Consequences of this amendment

**Positive.** The config screen and the tab cannot disagree about a refusal, and neither tells an
editor to replace a working token on a guess. A workflow the plan lacks costs a toast; the tab,
its history and the poll keep going. Running out of units costs a warning, not the tab.

**Negative.** A token that can read Robots and not write it sees every run refused with Mux's own
reason in a toast rather than the scope explainer — the tab keeps working, and only the list could
say the token is unusable. The terms link depends on Mux keeping the URL in its message; if it
stops, the link degrades to the dashboard root rather than to nothing. And the config screen now
answers every 401 with the scope note: a mistyped secret used to get "Those Mux credentials were
rejected", and now gets an explainer whose remedy — a new token — fixes the typo too.

**Neutral.** The session cache is unchanged: still filled by the list read only, still never
invalidated on a credential change, which stays the deliberate trade it was. The units copy says
the account "does not have enough left" for the run rather than that it has none, because that
is the most a refusal can tell us.

## Amendment, 2026-09-24: what the first paint waits for

Review asked whether the tab could show the job table first and fill the rest in behind it. The
2026-09-21 amendment above had already taken the capability probe and the directive fan-out off
the first open, so what still stood in front of the table was measured before anything changed —
every Mux call simulated as one app-action round trip, which in production is a POST plus a poll of
Contentful's call log at a two-second interval.

**Before.** Nothing — not the Run button, not the headings — rendered until two round trips had
finished in series: the job list, then an asset resync the list sets off for completed jobs, which
the list read *awaited*. Three for a signed or DRM asset, whose resync also fetches playback tokens.
The directive picker filled in a round trip after that. And most first opens of an asset with
history read the job list twice: the first-load effect re-fired while the awaited resync still held
`hasLoadedOnce` false, and the second request queued behind the first.

**After.** The table paints when the job list answers: one round trip, which is the floor, because
every Mux read from the field location goes through `muxProxy`. A direct browser call to
`api.mux.com` would be quicker and is ruled out: `AGENTS.md` reserves it for the config screen,
which has to work before the app is installed and checks credentials as typed, and sends
everything else through app actions. Around that one read:

- Once the session knows Robots is on, an opened tab draws its own structure at once — the buttons,
  the Directives heading and picker — with loading rows where the jobs will go. An unopened tab,
  and one whose account is not yet known, still draws only a placeholder: for most installs the
  answer is that Robots is off, and the tab is about to become a note.
- The directive listing runs alongside the job list when Robots is known to be on, or when
  directives are configured — which an install without Robots never has, so it still costs one
  failed request per session.
- What is still being read says so, and only that: Units reads *Loading…* on a row the background
  detail pass will reach, where it used to read ADR-0005's *Not loaded* — which now means only what
  it says, a row past the window; the runs table and the picker show loading until their first
  read; and "Started elsewhere" is held back until a row's detail and the first runs pass are in,
  so it is said a moment late rather than taken back.
- The resync runs beside the list, not inside it. Awaited, its failure also landed in the list
  read's error path, where an asset GET refused with a 401 would have been classified as the
  account losing Robots and cached for the session. "Only the job list read decides capability"
  was not quite true until this change.

| Round trips until… | Run button | Job table | Picker names | Every Units cell |
|---|---|---|---|---|
| First entry of a session, 8 completed jobs, 1 directive — before | 2 | 2 | 3 | 3 |
| — after | 1 | 1 | 1 | 3 |
| Same, Robots already known this session — before | 2 | 2 | 3 | 3 |
| — after | 0 | 1 | 1 | 3 |
| Signed or DRM playback — before | 3 | 3 | 4 | 3 |
| — after | 1 | 1 | 1 | 3 |

Serialized round trips, not seconds. The Units column is unchanged on purpose: its reads are
bounded to five per pass over the newest twenty jobs (ADR-0005), and widening that trades request
volume — two CMA requests and a function per read — for a column that already says it is loading.

### Consequences of this amendment

**Positive.** The table, the Run button and the picker arrive together at the first round trip, and
every empty state waits until it is true. A resync that fails can no longer turn a working tab into
a capability note.

**Negative.** An unknown account still shows a placeholder for that first round trip rather than
the tab's structure — the price of not flashing Robots furniture at every install that never
enabled it. And with directives configured, the listing now goes out before the job list has said
whether Robots is on: on an account that has lost Robots since it was configured, that is a second
failed request in the session.

**Neutral.** The number of requests a first open makes is one lower (the duplicate job list is
gone), and none of the reads is new.
