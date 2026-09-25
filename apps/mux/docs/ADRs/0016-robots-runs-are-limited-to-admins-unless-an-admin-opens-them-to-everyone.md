# ADR-0016: Robots runs are limited to admins unless an admin opens them to everyone

**Date:** 2026-09-25
**Status:** Accepted
**Deciders:** Renzo Delfino, with the client

## Context

Robots was built with no gate: anyone who could open an entry could run a workflow, run a
directive, cancel a job, and choose which directives ride on an upload. Every one of those spends
Mux AI units or stops work that is spending them. That was deliberate and pinned by a test — the
Contentful requirements never asked for a gate, and their parity argument, that Mux's Sanity and
Strapi plugins gate directive runs behind roles, did not survive a read of Sanity's code, whose
only role gate hides the screen where credentials are entered.

The client asked for a control anyway. A spike on 2026-09-22 settled what an app can know
([assessment: "Who Can Run Robots"](https://claude.ai/artifact/KVV9tfjkbu3Y4tAnvD4DJE)):

- **The browser has one dependable signal.** `sdk.user.spaceMembership.admin` is true for space
  admins on every plan, and the admin role cannot be edited. `spaceMembership.roles` carries only
  names, which can be renamed, and is empty for an admin.
- **The function knows who, never what role.** `muxProxy` receives the caller's id in
  `x-contentful-user-id`, but App Identity cannot read `Role` or `SpaceMembership`, the config
  screen is refused `SpaceMembership` and `SpaceMember` "from within an app" even as an admin, and
  touching `context.can` kills the invocation. No function-side gate by role or by admin is
  buildable today.
- **Two routes skip the app whatever it decides.** `muxProxy` forwards any method and path, and the
  Mux secret reaches every editor's browser in `sdk.parameters.installation`.

Alternatives considered, lettered as in the assessment:

- **A. Keep no gate.** Defensible: the spend guards that matter — reconciliation instead of blind
  retry (ADR-0003) and a confirm step that names the cost (ADR-0014) — already exist. Rejected
  because the client wants people who should not be spending kept from doing it by accident.
- **D. A function-side check against a list of people an admin picks.** The only option that
  survives a determined user. It needs the secret moved out of the browser first (H), rests on a
  header Contentful has not documented for functions, and makes every new person a manual
  addition. Not for this release.
- **E. A role picker in the config screen, UI-only.** Matches on role names, which are renameable
  and absent for admins, and offers almost no choice on Free and Lite. The same protection as the
  decision below, with more ways to be wrong.
- **An unset switch meaning everyone.** The codebase's convention is that an unknown context never
  gates a billable action (`robotsCatalog.test.ts`), and the assessment applied it here. Rejected
  for the default: that convention is about not guessing at an entitlement Mux may grant, not about
  overriding a choice an admin can make in one click — and Robots has never shipped, so no install
  has access to lose.
- **B, F and H** — allowlisting proxy paths, splitting Robots out of `muxProxy`, moving the secret
  to a `Secret` parameter — harden the app whoever may run Robots. They are not this decision.

## Decision

**`canRunRobots = sdk.user.spaceMembership.admin || muxRobotsAllowEveryone === true`.** The rule
and its copy live in `util/robotsAccess.ts`; the field's `App` works it out once and passes it
down.

**"Run" is every control that spends units or stops a job:** Run a workflow and its modal, the
directive picker with Run directive, Cancel, and choosing directives in the upload dialog. Someone
who cannot run sees none of them — hidden, not disabled — and the Robots tab shows a note naming
the switch in their place.

**Results stay open to everyone.** The job table, directive runs, outputs and Apply to entry spend
nothing, and a tab emptied for non-admins would read as broken.

**Default directives still run on a non-admin's upload.** The upload dialog lists them read-only,
with a line saying an admin sets them, and attaches them as it would for an admin.

**The switch is "Let everyone run Robots"**, a checkbox in the Robots section of the config screen,
saved as an explicit boolean in installation parameters. No App Definition change: `onConfigure`
saves `parameters` whole, which is how `muxDefaultDirectiveIds` was added.

**Unset means admins only.** The `=== true` in `canRunRobots` is the whole default.

**Admin means the membership flag, never a role name.** A location that hands over no user reads
as not an admin, so a gap narrows access rather than widening it.

**It is a UI guardrail.** The config help text says only who sees the controls, and nothing on
screen calls it a permission. Nothing in `functions/` changes. The test that pinned the old position,
"lets anyone who can open the entry run a workflow", is replaced by tests of both sides of the
rule.

## Consequences

### Positive
- Accidental spend by people who should not be spending is off by default, decided by the one
  signal that means the same on every plan and cannot be renamed out from under the app.
- One function answers for the tab, the upload dialog and any future location, and the note, the
  config label and the tests share one copy of the words.
- Opening Robots to everyone is a single checkbox, and the note says which one.

### Negative
- It does not stop a determined user. `muxProxy` forwards any path, the secret reaches the
  browser, and `scripts/call-app-action.ts` reaches the proxy without loading the app at all. Only
  D, after H, would.
- All or nothing: no "Editors yes, Authors no". With the switch off, admins are the bottleneck for
  every run and every cancel, including a job someone else started.
- Installation parameters are a snapshot from when the iframe loaded, so flipping the switch
  reaches an entry that is already open only when it is reloaded.

### Neutral
- The default applies to every install on release day (ADR-0006). Nobody loses access, because
  Robots was not on `master`, but the release notes should name the switch.
- An install that wants no automatic spend from non-admins configures no default directives.
- A running job a non-admin cannot cancel says in its Actions cell that its output appears when it
  finishes, rather than leaving the cell blank.
- Any future control that starts, cancels or chooses a Robots run — a page that creates or runs
  directives, for one — reads `canRunRobots` too.
