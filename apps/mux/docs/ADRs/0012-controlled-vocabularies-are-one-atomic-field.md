# ADR-0012: A controlled vocabulary is one atomic field, and a documented cross-field rule is a shape, not an error

**Date:** 2026-09-15
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

Three Robots workflows take a controlled vocabulary under `output_steering`:

- `find-scenes` — `topic_taxonomy`, sub-schema documented in full.
- `find-key-moments` — `topic_taxonomy`, **listed with no type, no description and no sub-schema**.
  The only evidence for its shape on that page is its parent's summary, "Curated output_steering
  controls for execution scope, selection strategy, title style, audience, taxonomy, and rubric
  tie-breakers."
- `summarize` — `tag_taxonomy`, documented in full *and* with six explicit caps: "Supports up to 50
  values and 2000 serialized characters", a name "up to 100 characters", "Supports 1-50 values", a
  label "up to 100 characters", a description "up to 300 characters", and "Up to 10 aliases, each
  up to 100 characters."

All three share one shape: `{ name?, values: [{ label, description?, aliases? }], allow_other? }`.
None of the three pages marks a single sub-field `Required` — the reference renders no required
badge anywhere in these request bodies — so "which parts are mandatory once the object is present"
is not answerable from the docs.

Separately, two workflows document a rule that spans two parameters:

- `generate-premium-captions`' `upload_to_mux`: "Whether to upload the generated VTT to the Mux
  asset as a new text track. Defaults to true. When false, no track is created and
  `replace_existing` must also be false; the generated SRT remains available via
  `temporary_srt_url`."
- `edit-captions`' `delete_original_track`: "Whether to delete the original source text track after
  the edited track upload succeeds. Has effect only when `upload_to_mux` is true. Defaults to true."

The form rendered both pairs as independent checkboxes, and `validateParams` raised an error on the
first combination after the fact. So the editor could tick two individually reasonable boxes and
then be refused for it, which is the form describing a request it will not let them make.

Alternatives considered for the vocabularies:

- **Three dotted-path fields per taxonomy** (`…tag_taxonomy.name`, `.values`, `.allow_other`), which
  is how every other nested parameter in the catalog works. It lets the three parts be set
  independently, which is exactly the problem: a name and an `allow_other` with no values produces
  `tag_taxonomy: { name: 'x', allow_other: false }` — a controlled vocabulary with nothing in it,
  against a schema that says "Supports 1-50 values". It also has nowhere to hang a cap that is
  about the object as a whole, like the 2000 serialized characters.
- **A checkbox for `allow_other`.** No page documents a default for it. A checkbox has two states
  and would have to pick one, silently answering the question for every run — the `NO_PREFERENCE`
  argument from ADR-0011, one level up.
- **Borrow `summarize`'s caps for `topic_taxonomy`.** Tempting, since the shape matches. But those
  numbers belong to a different workflow's schema, and a cap we invent blocks a run Mux accepts.
- **Leave `find-key-moments`' `topic_taxonomy` out, since its shape is undocumented.** The
  parameter itself *is* documented — it is listed in the request body. Omitting a documented,
  editorially useful control because one page is thinner than its sibling costs the editor a real
  capability over a formatting gap in the docs.

## Decision

**A taxonomy is one form field of kind `taxonomy`, holding one `TaxonomyValue`.** Rows are edited
as flat strings (`aliases` is a comma-separated box, exactly like `ask-questions`' answer options)
and converted in `toApiParamValue`, so the renderer stays generic and the conversion is testable
without mounting a component — the same split `questions` and `replacements` already use.

**The object is sent only when it has at least one labelled value, and `values` is always present
when it is.** That resolves the unanswerable required-ness question by never testing it: whichever
reading is right, what we send is valid. A name or an `allow_other` with no values is reported to
the editor rather than dropped in silence.

**`allowOther` is a tri-state string (`''` / `'true'` / `'false'`), sent as a boolean or not at
all.** `''` is "No preference", which is absence.

**Caps are declared as data per field, in `taxonomyLimits`, and an absent limit means the reference
states none.** `summarize` gets all six documented figures plus the serialized-size cap, measured
over `JSON.stringify` of the object actually sent. `find-scenes` and `find-key-moments` get none.

**`find-key-moments`' `topic_taxonomy` uses `find-scenes`' documented sub-schema**, as one shared
descriptor, and inherits no caps from `summarize`.

**A documented cross-field rule is expressed as `showWhen`, not as a validation error.**
`replace_existing` and `delete_original_track` are hidden — and therefore unsent — while
`upload_to_mux` is off, and each now sits below the checkbox that gates it. The
`generate-premium-captions` validation rule is deleted: with the combination unconstructable, it
was unreachable code describing a state the form can no longer reach.

**`showWhen` can key off what the asset is, not only off another field.** `moderate`'s
`language_code` — "Used only for audio-only assets; ignored for video assets with visual content" —
declares `{ context: 'isAudioOnly', notEquals: false }`. The condition is `notEquals` rather than
`equals` on purpose: `isAudioOnly` is tri-state, and an unknown asset kind must still render the
control. Hiding a usable control on missing information is the worse of the two failures.

## Consequences

### Positive
- The three documented controlled vocabularies are usable, and each workflow is held to its own
  documented limits rather than a shared guess.
- A request that Mux documents as invalid can no longer be built, so it can no longer be refused.
  The two mechanisms this rests on — hidden means unsent, and one predicate drives both — already
  existed for the profanity toggle.
- Asset facts and form values now gate fields through the same declarative mechanism, so
  `RobotsParamFields`, `validateParams` and `paramsFromFormValues` stay in agreement by
  construction. All three take the same `RobotsAssetContext`.

### Negative
- `taxonomy` is the first field whose form value is a nested object rather than a scalar or a row
  array. `asTaxonomyValue` exists to normalise it, and anything new reading form values directly
  has to go through it.
- The serialized-size cap is measured against our JSON. The reference does not say what it
  serializes, so this is the strict reading; it can refuse a taxonomy Mux would have accepted. The
  catalog's standing rule is that the stricter figure wins, because the looser one only buys a 400
  on a run the editor already confirmed.
- `find-key-moments`' taxonomy is built on a sibling page's schema. If Mux documents that page
  properly and the shape differs, this is where it breaks.

### Neutral
- `topic_taxonomy` and `tag_taxonomy` came off the catalog header's "deliberately omitted" list.
  `prompt_overrides` stays on it, now with the reference's own wording: "Legacy/internal
  prompt-section overrides. Prefer output_steering for new integrations." It is documented on
  `summarize` and `generate-chapters`, exposed on neither, and a test asserts no catalog parameter
  path begins with it.
- `edit-captions`' `delete_original_track` got the same treatment as `replace_existing` despite a
  weaker rule — "has effect only when" is an ignore, not a rejection. Nothing was broken; a
  checkbox that provably does nothing is still worth removing.
