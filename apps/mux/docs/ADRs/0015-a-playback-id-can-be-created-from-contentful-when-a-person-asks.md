# ADR-0015: A playback ID can be created from Contentful, when a person asks for it

**Date:** 2026-09-17
**Status:** Accepted
**Deciders:** Renzo Delfino

## Context

An asset with no playback ID of any policy is a state this app arrives at rather than one it
creates: a delete in the Mux dashboard, or a `moderate` run configured with
`on_flagged.action: delete_playback_ids`. ADR-0010 made the field editor survive it — the rich
branch keys off `assetId`, and a notice explains that the video cannot be played while everything
recorded against it is still there.

The notice was accurate and useless. The only way out of the state was the Mux dashboard, and the
only affordance left on the screen was the "URL or Mux Asset ID" form, whose submit replaces the
whole value and destroys the Robots records. ADR-0014 makes the state reachable *by design* rather
than by accident, which turns "go and use the other tool" from a rough edge into a missing half of
a feature.

The Playback tab was the obvious home, and it turned out to be actively broken for this. Its
switcher computes the current policy and treats a click on the current policy as a no-op. With no
playback ID at all, that computation fell through to `'public'` — so the tab reported the asset as
already public, and a request for the one policy every account can create was silently dropped. The
same fall-through existed twice, in `App.swapPlaybackIDs` and in `PlaybackSwitcher`, and the two
copies did not even agree: on an asset holding both a public and a DRM playback ID the switcher
said public and the swap handler said DRM, so picking DRM in the UI was discarded as "already DRM"
and the radio sprang back.

Alternatives considered:

- **A direct `POST /assets/{id}/playback-ids` from the browser.** Rejected on the app's oldest
  rule: the field editor does not call Mux. It also breaks the tab's own contract, where every
  other control queues work and applies it on publish, so one button would take effect immediately
  and the three beside it would not.
- **A new `pendingActions` action type for creation.** Rejected — there already is one. `create`
  with `{ type: 'playback', data: { policy } }` is exactly this request; `swapPlaybackIDs` has been
  queueing it for every policy swap, and since the delete-with-no-`id` fix it has queued it
  *without* a matching delete whenever there was nothing to delete. The shape needed no work; the
  code deciding whether to queue it did.
- **Re-create automatically when the poll finds no playback ID.** Rejected in ADR-0010 and still
  rejected: the app would be undoing a moderation decision by itself. What changes here is only
  that a person can ask.
- **A separate tab or a modal for the empty state.** Rejected for ADR-0010's reason, one level
  down: a second place to manage playback means every future playback feature has to be added to
  both.

## Decision

**Creation goes through `pendingActions.create`, the same path as a policy swap, and applies in
`onPublish`.** Nothing new reaches Mux from the browser, the queued work shows as an unpublished
change like everything else in that tab, and the publish gate and retry counter cover it for free.

**"No playback ID" is a policy value of its own — `undefined` — not a fall-through to `public`.**
`util/playbackPolicy.ts` holds the three readings as one module: `existingPlaybackPolicy` (from the
stored IDs, public before signed before DRM), `pendingPlaybackPolicy` (from a queued create), and
`currentPlaybackPolicy` (the queued one if there is one, else the stored one). `swapPlaybackIDs`
and `PlaybackSwitcher` both read it, so the click and the radio cannot disagree about what is
current. Extracting it settled the public-versus-DRM disagreement in favour of what the UI displays.

**The Playback tab shows a create affordance in place of the switcher when there is no playback ID
at all**, rather than beside it: with nothing stored there is nothing to switch between, and a
switcher whose selection means "what I would like" reads identically to one whose selection means
"what this is". The affordance is the *same* `PlaybackPolicySelector` the switcher uses, so signed
and DRM are offered exactly where the installation has them and DRM stays off audio-only assets. A
policy we know will fail is not a choice.

**A queued create says it is queued.** Once one exists the tab shows which policy will be created
and that it happens on publish, instead of the radio quietly moving to a policy that does not exist
yet. The switcher's own pending state is the radio position; this one needs words, because the
difference between "this asset is public" and "this asset will be public" is the whole state.

**`onPublish` refuses a playback create with no policy.** `createMuxPlaybackId` serialises
`{ policy }`, and `JSON.stringify({ policy: undefined })` is `{}` — so a malformed action would let
Mux choose the policy on an asset whose playback a moderation run had just deleted. It is dropped
with a warning rather than retried: no number of publishes adds a policy to an action that never
had one. This is the create-side twin of the delete action with no `id`, which issued
`DELETE /assets/{id}/playback-ids` against the collection endpoint and failed on four consecutive
publishes. That one was fixed only where actions are queued; this one is guarded at the point of
use as well, because there are now two places that queue creates.

## Consequences

### Positive
- The state ADR-0010 made survivable is now recoverable, from the tab the notice already pointed
  at, without touching the Mux dashboard and without the asset-ID form that destroys the entry's
  Robots records.
- ADR-0014's destructive option has a matching way back, which is what made it shippable.
- One definition of "what policy is this asset on", used by both callers, with a latent
  disagreement between them resolved on the way.

### Negative
- A created playback ID only exists after the entry is published. An editor who requests one and
  does not publish has changed nothing, which is consistent with the rest of the tab and still a
  step people forget.
- The create affordance and the switcher are two layouts of the same tab. They share the selector
  but not the surrounding chrome, so a change to how policies are presented has two places to land.

### Neutral
- The toast shown when playback IDs vanish mid-session, and the notice in the editor, both said
  "add one in Mux and resync". They now name the Playback tab first; the Mux route still works and
  is still mentioned.
- Nothing about the automatic case changed. ADR-0010's rejection of a poll that re-creates a
  playback ID stands — this is an editor asking, on a screen that tells them what they are asking
  for, and the app still never undoes a moderation decision on its own.
