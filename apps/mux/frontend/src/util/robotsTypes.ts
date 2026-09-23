/**
 * Types for the Mux Robots API surface the app talks to.
 *
 * Field names mirror the Mux payloads verbatim (snake_case) wherever the value comes off the
 * wire, following the convention the rest of the stored field JSON already uses. The two
 * exceptions are the *persisted* shapes at the bottom of this file (`RobotsJobRecord`,
 * `RobotsOutputs`), which are ours and use the app's camelCase.
 */

/** The twelve public workflows, exactly as they appear in `POST /robots/v0/jobs/{workflow}`. */
export const ROBOTS_WORKFLOWS = [
  'generate-premium-captions',
  'edit-captions',
  'translate-captions',
  'translate-audio',
  'summarize',
  'ask-questions',
  'find-key-moments',
  'find-best-thumbnails',
  'generate-engagement-insights',
  'generate-chapters',
  'find-scenes',
  'moderate',
] as const;

export type RobotsWorkflow = (typeof ROBOTS_WORKFLOWS)[number];

export type RobotsJobStatus = 'pending' | 'processing' | 'completed' | 'errored' | 'cancelled';

/** Statuses a job will never leave, so polling can stop and a stored record is final. */
export const ROBOTS_TERMINAL_STATUSES = ['completed', 'errored', 'cancelled'] as const;
export type RobotsTerminalStatus = (typeof ROBOTS_TERMINAL_STATUSES)[number];

export function isTerminalStatus(status?: string): status is RobotsTerminalStatus {
  return !!status && (ROBOTS_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A job as the Robots API returns it. `errors` is typed loosely on purpose: the API documents it
 * only as "present when errored", so it is normalised through `robotsJobErrorMessage` rather than
 * read directly.
 */
export interface RobotsJob {
  id: string;
  workflow: RobotsWorkflow;
  status: RobotsJobStatus;
  created_at?: number;
  updated_at?: number;
  passthrough?: string;
  units_consumed?: number;
  parameters?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  errors?: unknown;
  resources?: unknown;
  /** Single-job GET only, like `passthrough`. Absent for a job created by a direct POST. */
  directive?: RobotsJobDirective;
}

/**
 * The directive run that dispatched a job, as `GET /robots/v0/jobs/{workflow}/{id}` names it: the
 * two ids `GET /robots/v0/directives/{id}/runs/{run_id}` takes. Documented in the API reference
 * and in `@mux/mux-node`'s `JobDirectiveContext`.
 */
export interface RobotsJobDirective {
  id: string;
  run_id: string;
}

export interface RobotsDirectiveWorkflowBinding {
  reference_id?: string;
  workflow?: RobotsWorkflow;
  inputs?: string[];
  params?: Record<string, unknown>;
}

export interface RobotsDirective {
  id: string;
  name?: string;
  subject?: { type?: string };
  resources?: unknown[];
  workflows?: RobotsDirectiveWorkflowBinding[];
  created_at?: number;
  updated_at?: number;
}

export type RobotsDirectiveRunStatus =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'partial'
  | 'errored';

/** Run statuses a directive will never leave, so polling can stop. */
export const ROBOTS_TERMINAL_RUN_STATUSES = ['completed', 'partial', 'errored'] as const;

export function isTerminalRunStatus(status?: string): boolean {
  return !!status && (ROBOTS_TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export type RobotsNodeStatus =
  | 'dispatched'
  | 'failed'
  | 'waiting_for_resources'
  | 'waiting_for_source_workflow';

export interface RobotsNodeState {
  reference_id?: string;
  status?: RobotsNodeStatus;
  workflow_name?: RobotsWorkflow | string;
  job_id?: string;
  /** Present when `status` is `failed`. */
  reason?: string;
  /** Present when `status` is `waiting_for_source_workflow`. */
  source_workflows?: string[];
}

/**
 * A directive run as the REST API returns it, from both `GET .../runs` and `GET .../runs/{id}`.
 *
 * The field names are the ones to be careful about, because Mux serialises a run two different
 * ways. The **webhook** payload nests `{ id, directive_id, asset_id, … }`; the **REST** responses
 * use `run_id` and `subject_id` and carry no directive id at all. Modelling the webhook shape here
 * is what made the runs table permanently empty: filtering on `asset_id` matched nothing, ever.
 * Confirmed against `@mux/mux-node`'s generated `DirectiveRunDetail`, since the API reference
 * documents these three endpoints with no response schema at all.
 *
 * `subject_id` rather than `asset_id` because a directive's subject is what it runs against, and
 * today that is always an asset.
 */
export interface RobotsDirectiveRun {
  run_id: string;
  subject_id?: string;
  status?: RobotsDirectiveRunStatus;
  /** Returned in the order the bindings appear in the directive's `workflows`. */
  node_states?: RobotsNodeState[];
  started_at?: number;
  completed_at?: number | null;
  /**
   * Not on the wire. Attached by the caller from the directive whose runs it asked for — which is
   * the only place the association exists, since the response never names its own directive.
   */
  directive_id?: string;
}

/**
 * Whether this installation can use Robots at all. Anything but `enabled` replaces the tab with
 * an explainer, because nothing in it could work — so only the job list read decides it, never a
 * refused run. See ADR-0006's 2026-09-23 amendment.
 */
export type RobotsCapabilityState = 'enabled' | RobotsUnavailableState;

/** The token cannot reach Robots, or Robots is not turned on for the account. */
export type RobotsUnavailableState = 'not-enabled' | 'scope-missing';

export interface RobotsCapability {
  state: RobotsCapabilityState;
  /** Where the terms that turn Robots on are accepted, when Mux's answer named the page. */
  termsUrl?: string;
}

/**
 * Robots works, but something limits it right now. A warning over a working tab, never instead
 * of it, and never cached for the session: it is about the runs Mux refused, not about the tab.
 */
export type RobotsAdvisory = 'units-exhausted';

// --- Persisted shapes (ours, camelCase) ---

/**
 * The record mirrored onto the entry field for a job this plugin started.
 *
 * Recorded from the moment it is created, not only once it finishes. An earlier version stored
 * terminal states only, to avoid flipping a published entry to "Changed" for a status badge
 * moving — but that reasoning does not survive contact with two facts:
 *
 * - Clicking Run is a deliberate, billable act. An entry marked as changed because the editor
 *   just started an AI job on it is not a surprise; it is a record of what they did. The rule was
 *   protecting against writes the user did not cause, and this is not one.
 * - Ownership has to be durable. `GET /robots/v0/jobs` returns a summary with no `passthrough`,
 *   so a job started here is indistinguishable from one run in the Mux dashboard unless we wrote
 *   it down. Recording it at creation is what makes the entry the source of truth for "we started
 *   this", and it survives a reload.
 *
 * The cost is bounded: a job passes through at most `pending → processing → completed`, so three
 * writes, and `updateField` skips any poll tick that learns nothing.
 */
export interface RobotsJobRecord {
  id: string;
  workflow: RobotsWorkflow;
  status: RobotsJobStatus;
  created_at?: number;
  updated_at?: number;
  units_consumed?: number;
  passthrough?: string;
  /** First error message, when the job errored. */
  error?: string;
}

/**
 * The record mirrored onto the entry field for a directive run this app started.
 *
 * Written at creation, for the same reason `RobotsJobRecord` is: it is the only moment ownership
 * is unambiguous, and it is what makes the run survive a reload.
 *
 * Before this existed, a directive's jobs were claimed as ours only by matching them against a
 * *freshly listed* run — `GET /robots/v0/directives/{id}/runs` capped at the newest 25, filtered
 * client-side by `subject_id`, because the API cannot filter by asset. A busy directive pushes
 * this asset's run out of that window within hours and a deleted directive removes it outright,
 * and at that point the jobs it dispatched become permanently unclaimable: they are shown in the
 * tab and can never reach the entry. Recording the run removes the list window from the ownership
 * path entirely. See ADR-0009.
 *
 * `jobIds` fills in as `node_states` reveals them — the create response is a `run_id` and
 * `pending`, nothing more — and is append-only, like every other record on this field.
 */
export interface RobotsDirectiveRunRecord {
  runId: string;
  directiveId: string;
  status?: RobotsDirectiveRunStatus;
  startedAt?: number;
  completedAt?: number;
  /** Ids of the jobs this run dispatched, as they become known. Append-only. */
  jobIds?: string[];
}

export interface RobotsSummarizeOutput {
  /** Provenance lives inside the output so it survives independently of `robotsJobs`. */
  jobId: string;
  completedAt?: number;
  title?: string;
  description?: string;
  tags?: string[];
}

export interface RobotsModerateOutput {
  jobId: string;
  completedAt?: number;
  exceedsThreshold?: boolean;
  maxScores?: { sexual?: number; violence?: number };
}

/**
 * Outputs written onto the field JSON so the Delivery API returns them with the entry.
 *
 * Only summarize and moderation live here, per the spec: captions and dubs stay Mux tracks, and
 * chapters and best thumbnails arrive through the existing asset mirror. That also keeps this
 * object small — scenes and key moments, the two outputs that could realistically approach
 * Contentful's JSON-field size limit, are never persisted.
 */
export interface RobotsOutputs {
  summarize?: RobotsSummarizeOutput;
  moderate?: RobotsModerateOutput;
}

/** Workflows whose outputs are persisted onto the field JSON. */
export const PERSISTED_OUTPUT_WORKFLOWS: RobotsWorkflow[] = ['summarize', 'moderate'];

// There used to be a `TRACK_PRODUCING_WORKFLOWS` list here, gating the post-completion asset
// resync on the four workflows that attach a track. It was deleted rather than left in place,
// because nothing reads it any more and a constant that describes a rule the code no longer
// follows is worse than no constant. The gate was wrong: `summarize` with `update_asset_meta`,
// `find-best-thumbnails` with `update_asset_thumbnail` and `moderate` with
// `on_flagged: delete_playback_ids` all change the Mux asset too, and none of them attach a
// track. The tab now resyncs once per newly-completed job whatever the workflow — one GET,
// deduped per job per session.

/** Pulls a human-readable message out of the API's loosely-documented `errors`. */
export function robotsJobErrorMessage(job: Pick<RobotsJob, 'errors'>): string | undefined {
  const { errors } = job;
  if (!errors) return undefined;

  if (typeof errors === 'string') return errors;

  if (Array.isArray(errors)) {
    const first = errors[0] as Record<string, unknown> | string | undefined;
    if (!first) return undefined;
    if (typeof first === 'string') return first;
    const messages = first.messages;
    if (Array.isArray(messages) && typeof messages[0] === 'string') return messages[0];
    if (typeof first.message === 'string') return first.message;
    return undefined;
  }

  const asObject = errors as Record<string, unknown>;
  if (Array.isArray(asObject.messages) && typeof asObject.messages[0] === 'string') {
    return asObject.messages[0] as string;
  }
  if (typeof asObject.message === 'string') return asObject.message;
  return undefined;
}
