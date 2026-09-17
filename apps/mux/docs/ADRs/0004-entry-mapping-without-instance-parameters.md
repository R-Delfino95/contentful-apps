# ADR-0004: The apply-to-entry dialog is the field mapping UI

**Date:** 2026-09-09
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

Generated summaries are only *retrievable* on the field JSON, not *queryable*: the Delivery API
cannot filter, search or order on values inside a JSON object field. To query by a generated title
or tag, the value has to land on a real entry field. That needs a mapping from output to field.

Alternatives considered:

- **Per-content-type instance parameters.** The spec's original suggestion. Rejected: instance
  parameter *definitions* live in the App Definition, which Contentful owns and which is not in this
  repo, so declaring them is a change on their side rather than a PR. The app declares none today.
  And the app does not render that form — Contentful generates it from the declaration, so the
  mapping UI would be text boxes where someone types field IDs by hand (`seoDescription`, not the
  label "SEO Description"), failing silently on a typo until an editor clicks Apply.
- **Installation parameters holding a content-type → field map.** Workable and needs nothing from
  Contentful, but it is a config screen an admin has to fill in before an editor gets any value, for
  a mapping the app can usually guess correctly.
- **A pure convention with no UI**, the way `MetadataConfiguration` finds a `title` field and syncs
  it to the Mux asset. Rejected on its own: that case only *reads*, so guessing wrong is free —
  worst case the Mux asset has no title. This case *writes*, so guessing wrong overwrites an
  editor's copy.

## Decision

The apply-to-entry dialog *is* the mapping UI. One row per generated output, a target dropdown
filtered to type-compatible fields and pre-filled by convention, the generated value beside the
current value, and a checkbox per row. Rows that would replace existing content are unchecked by
default.

Everything it needs is already at the field location: `sdk.contentType.fields` for names,
`sdk.entry.fields[id]` for type, `items` and `setValue`. No CMA call, no App Definition change, no
config screen.

The convention only has to *pre-fill*, not be correct — the preview is what makes it safe. Writes
go to the default locale unless the field is not localized there, in which case its own locale is
used. Fields are written independently so one validation failure does not discard the rest.

## Consequences

### Positive
- Nothing to configure, and nothing needed from Contentful.
- An editor sees exactly what would be replaced before anything is written.
- Reuses a convention pattern the app already ships.

### Negative
- The mapping is not remembered between runs. For bulk work that is repetitive; installation
  parameters could carry a remembered choice later as an add-on.
- Only summarize output is mappable. Moderation scores are numbers no editor would paste into a
  text field, and chapters/scenes/key moments are structured arrays with no single-field home.

### Neutral
- Where a content type has no type-compatible field, the dialog says so rather than silently
  skipping — the opposite of the read-only convention's behaviour, and deliberately so.
