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

> **Superseded 2026-09-17.** There is no checkbox. The target dropdown is the only control on a
> row and `Do not apply` is how a row is skipped; the rule that a row which would replace existing
> content is not pre-selected survives as "no target is pre-filled". See the amendment below.

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

## Amendment, 2026-09-17: one control per row, and Rich Text is a target

Review of the shipped dialog found the mapping UI working and nearly unusable. Three of the
findings are presentation and are recorded here only because the fourth is a design change.

**The button did not say what it did, and was hidden until it worked.** "Apply to entry" appeared
only once a summarize output had been stored, so the only way to find out the feature existed was
to run the workflow that enables it — the reviewer did not know it was there. It is now
`Apply summary`, always rendered, and disabled with a tooltip saying what has to happen first.
That is the same disabled-with-a-reason pattern `TrackList` and `Mp4RenditionsList` already use for
a control that cannot act yet, so nothing new was invented for it. The general rule this is an
instance of: **a feature gated on its own output is undiscoverable**, and the disabled state is the
advertisement.

**The Apply checkbox is gone.** A checkbox *and* a target dropdown whose options included "Do not
apply" were two controls for one decision, and they could disagree: choosing an occupied field
re-set the checkbox to unticked, so deliberately picking a field in order to replace it did
nothing and said nothing. The dropdown is now the whole decision and `isSelected` is gone from the
model, not merely hidden.

The rule the checkbox carried does not go with it. Pre-filling a target is now consent to write,
so `defaultTargetFieldId` declines to pre-fill a suggestion that would replace existing content —
the same outcome the unticked checkbox produced, expressed in the one control that is left. What
that loses is the sight of the field it declined, so the row names it: *"SEO Description already
has content. Pick it as the target to replace it."* Choosing it then applies it, which is the
trap above, fixed.

**Rich Text is now a valid target for the title and the description.** It was refused because
`canHoldText` allowed only `Symbol` and `Text`, and that refusal was correct as long as the write
path was `setValue(string)`: a Rich Text field holds a document, and a bare string in one is not a
field the entry editor can render. The fix is the conversion, not a looser check — `valueForField`
wraps the generated string in the minimal valid document (one `paragraph`, one unmarked `text`
node, `data` on every node and `marks` on the text node), verified against
`@contentful/rich-text-types@16.8.5`'s own `EMPTY_DOCUMENT` rather than assumed.

That shape is declared locally rather than imported. The package is only present here as a
transitive dependency of `contentful-management`, and taking a direct dependency on someone else's
dependency tree for three interfaces buys less than it costs; the document format is the CDA/CMA
wire format and does not move. Reading in the other direction is handled too:
`richTextToPlainText` is why an occupied Rich Text field previews as its text instead of a wall of
JSON, and why a field holding nothing but an empty document still counts as empty.

Tags are still refused for Rich Text. A list of strings has no single-document home, which is the
same reason moderation scores and chapters are not mappable at all.

### Consequences of this amendment

**Positive.** An editor who has never run a Robots job can see the feature and read what it would
do. One control per row cannot contradict itself. The most obvious target a marketing content type
has for a generated description — a Rich Text body — stops being the one type the dialog would not
write to.

**Negative.** A Rich Text write is lossy in the sense that it flattens to one paragraph: a
multi-paragraph description arrives as a single block with the newlines inside it. Splitting on
blank lines was considered and rejected — it is guessing at structure the model never expressed,
and a document that does not validate breaks the field's editor outright, which is worse than a
plain one. Someone will eventually want the split; it is a change to `richTextDocument` alone.

**Neutral.** Allowing Rich Text for `title` as well as `description` is not a recommendation to use
it. The conversion is identical for both and a type rule that applied to one text output and not
the other would be arbitrary, so the dialog offers it and the editor decides.
