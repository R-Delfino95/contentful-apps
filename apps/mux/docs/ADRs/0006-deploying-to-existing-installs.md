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
