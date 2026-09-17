# ADR-0011: A form-only control gates an optional API object, instead of a synthetic enum member

**Date:** 2026-09-14
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

`edit-captions` takes an optional `auto_censor_profanity` object. Inside it, `mode` is an enum —
`blank`, `remove`, `mask` — and the reference documents `blank` as its default *when the object is
present*. The object itself is optional: the API requires at least one of `replacements` and
`auto_censor_profanity`, so "replace these words and censor nothing" is a perfectly ordinary
request.

The run form rendered `mode` as a select with a fourth, invented option: `''`, labelled "Leave as
is", preselected. That single control was carrying two unrelated decisions — *whether* to censor,
and *how* — and the sentinel that meant "not at all" was sitting in the same list as the three real
enum members. Two things followed from that:

- The form's default did not match the API's. Mux documents `blank`; the form preselected a value
  Mux has never heard of.
- Fixing that by preselecting `blank` would have made every `edit-captions` run censor. The intent
  the `''` option was expressing is real and has to survive.

The same shape shows up on the steering selects — `find-key-moments`' `selection_strategy` and
`title_style`, `find-best-thumbnails`' `selection_strategy` — but not for the same reason. There the
reference documents **no** default at all: they are best-effort guidance, so an absent parameter
means no steering rather than some other steering. The `''` option is the only way to say that, and
it was labelled "Default", a claim about Mux that the reference does not make.

Alternatives considered:

- **Preselect a real enum member on every select.** Ground rule on this feature is that we never
  invent a value. Picking `blank` for profanity censors runs nobody asked to censor; picking
  `face_or_action` for thumbnails steers every thumbnail run toward faces. Choosing a default the
  API does not document is inventing one, just at a higher level than inventing an enum member.
- **Keep `''` and relabel it "Leave as is" on the profanity select too.** Leaves one control
  answering two questions, so the documented default can never be the form's default. It also reads
  as a fourth mode in a list of three.
- **Send `auto_censor_profanity: {}` and let Mux apply its own default.** Undocumented behaviour —
  the reference describes `mode`'s default within a present object, not what a present-but-empty
  object does. Not something to find out from production.

## Decision

Two rules, both expressed in the catalog rather than in component code:

**A `formOnly` field shapes the request without being a request parameter.** `edit-captions` gains
`censor_profanity`, a checkbox that never reaches Mux. `paramsFromFormValues` drops it.

**A `showWhen` field is hidden and unsent by the same predicate.** The three `auto_censor_profanity.*`
fields declare `showWhen: { field: 'censor_profanity', equals: true }`. `RobotsParamFields` filters
on `isFieldVisible` and so does `paramsFromFormValues`, so the form cannot display one request and
send another. With the toggle off nothing profanity-related is sent at all; with it on, `mode` is
sent explicitly at its documented `blank`.

Where the reference documents no default, the `''` sentinel stays and keeps omitting the parameter.
Only its label changes, from "Default" to "No preference" — the sentinel was right, the claim it
made was not.

## Consequences

### Positive
- Both intents are expressible, and each control answers one question. "Censor nothing" is a
  cleared checkbox; "censor like this" is a documented enum member.
- The form's default now matches the API's documented default wherever one exists.
- Visibility and payload come off one predicate, so a hidden field can never leak into a request.
- The pattern generalises. Any future optional API object with required-ish contents gets the same
  treatment without new component code.

### Negative
- `values` now holds keys that are not parameter paths. Anything reading form values has to know
  that `formOnly` fields exist — `validateParams`' `edit-captions` check reads `censor_profanity`
  directly, which is a coupling that did not exist before.
- A `showWhen` field's value survives while it is hidden. That is deliberate — toggling twice does
  not lose what was typed — but it means the stored form state can describe a request that is not
  being sent.

### Neutral
- `toApiParamValue` no longer drops a value equal to its catalog default. That branch was only ever
  reachable for `''` defaults, which the empty-string check above it already handled, and it would
  now be actively wrong: dropping `mode: 'blank'` leaves an `auto_censor_profanity` object with no
  mode in it.
- Seven other selects still carry a `''` option labelled "Default". They are untouched here because
  each needs its own reference check first — whether Mux documents a default for that specific
  parameter is not a question one sweep can answer.

> **Superseded 2026-09-15.** That reference check has since been done, one parameter at a time, and
> every remaining select was relabelled: `summarize.tone`,
> `summarize.output_steering.summary_style`,
> `generate-chapters.output_steering.{chapter_style,chapter_granularity}` and
> `find-scenes.output_steering.{segmentation_strategy,title_style,narration_detail}` are all
> documented as best-effort guidance with no stated default. No catalog select carries a "Default"
> option now — the label is the shared `NO_PREFERENCE_LABEL`, and `robotsCatalog.test.ts` asserts
> none can go back.
