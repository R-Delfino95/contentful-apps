import { MuxApiError, MuxApiService } from './muxApi';
import {
  PERSISTED_OUTPUT_WORKFLOWS,
  RobotsCapability,
  RobotsDirectiveRun,
  RobotsDirectiveRunRecord,
  RobotsJob,
  RobotsJobRecord,
  RobotsModerateOutput,
  RobotsOutputs,
  RobotsSummarizeOutput,
  RobotsWorkflow,
  isTerminalRunStatus,
  isTerminalStatus,
  robotsJobErrorMessage,
} from './robotsTypes';
import { deriveFieldVersion } from './muxFieldVersion';
import { MuxContentfulObject } from './types';

/** How the plugin identifies itself on a job. */
export const ROBOTS_PLUGIN_ID = 'contentful';

/**
 * The prefix every `passthrough` this app writes starts with.
 *
 * A necessary condition for "is this job ours", never a sufficient one: the prefix names the app,
 * and two Contentful installs pointed at the same Mux account both write it. What actually
 * decides ownership is the scope segment that follows — see `isOwnPassthrough`.
 *
 * Only jobs the plugin originated are persisted onto the entry. A job someone ran from the Mux
 * dashboard against the same asset is still *shown* — the tab lists everything the API returns,
 * which is what makes the list honest — but it is never written into the entry. The entry records
 * what was done through Contentful and nothing else.
 */
export const ROBOTS_PASSTHROUGH_PREFIX = `${ROBOTS_PLUGIN_ID}@`;

const APP_VERSION = typeof __MUX_APP_VERSION__ === 'string' ? __MUX_APP_VERSION__ : 'unknown';

export const ROBOTS_PRICING_URL = 'https://www.mux.com/docs/pricing/overview#mux-robots-pricing';
export const ROBOTS_DOCS_URL = 'https://www.mux.com/docs/guides/robots';
export const ROBOTS_TOKEN_DOCS_URL = 'https://dashboard.mux.com/settings/access-tokens';

/**
 * How long a job may sit in a non-terminal state before the tab stops waiting on it.
 * Purely a client-side guard against polling forever on a job the API has lost track of.
 */
export const ROBOTS_STALE_JOB_MS = 6 * 60 * 60 * 1000;

/** Poll cadence for in-flight jobs. Deliberately three orders of magnitude slower than the
 * 500 ms asset loop: an asset becomes playable in seconds, a Robots job takes minutes, and each
 * tick here costs at least two CMA requests through the app-action bridge. */
export const ROBOTS_POLL_INTERVAL_MS = 6000;

/**
 * The install a `passthrough` names: this space, this environment, this entry.
 *
 * Taken from `sdk.ids`. `environment` is the real environment id and never `environmentAlias` —
 * an alias can be repointed, and a scope that changes underneath a running job would orphan it.
 */
export interface RobotsPassthroughScope {
  space: string;
  environment: string;
  entry: string;
}

/** What an ownership check is allowed to trust. */
export interface RobotsOwnershipOptions {
  /**
   * This install. A `passthrough` is trusted only when it names exactly this scope.
   *
   * Absent means **trust no passthrough at all** — never "trust every passthrough". The default
   * has to fail closed: the expensive mistake here is adopting someone else's billable job onto
   * this entry, and that is silent.
   */
  scope?: RobotsPassthroughScope;
  /**
   * Ids the caller established as ours by other means — in practice the create path, which holds
   * the response to its own POST and does not need to prove anything by parsing a string.
   */
  ownJobIds?: Set<string>;
}

/**
 * Whether a job was started through this plugin, and so belongs on the entry.
 *
 * Four ways to qualify, in the order they are checked:
 *
 * - It is **already recorded on the entry**. The durable answer, and the only one that survives a
 *   reload: `GET /robots/v0/jobs` returns a summary that omits `passthrough`, so without the
 *   record a job we started is indistinguishable from a stranger's.
 * - The caller says so (`ownJobIds`) — it is holding the create response.
 * - It carries a `passthrough` naming **this** space, environment and entry.
 * - Its id appears in a directive run for this asset, listed or recorded. Those jobs are created
 *   server-side by Mux at ingest, with no passthrough of ours, but the directive was attached by
 *   this app through `new_asset_settings`, so the automation is ours even though the job creation
 *   was not.
 *
 * Anything else — a job someone ran from the Mux dashboard — is displayed but never stored.
 *
 * The passthrough test used to be a bare `startsWith('contentful@')` guarded by a
 * `trustPassthrough` boolean that the polling path set to `false`. The prefix identifies the
 * *app*, not the install, so a second Contentful install pointed at the same Mux account stamps
 * an identical-looking tag, and the polling path reads passthroughs off jobs it does not own (it
 * fetches detail for every terminal job, to fill in the Units column). Turning the whole signal
 * off was safe but expensive: a job we created and then failed to record — the page closed during
 * the cold-start window — could never be claimed, so it ran, it billed, and it belonged to
 * nobody. The scope segment makes the tag install-specific, so that job is adopted and a
 * stranger's still is not.
 */
export function isPluginOriginatedJob(
  job: RobotsJob,
  directiveRunJobIds?: Set<string>,
  recordedJobIds?: Set<string>,
  options: RobotsOwnershipOptions = {}
): boolean {
  // Already on the entry. This is the durable answer and it comes first: `GET /robots/v0/jobs`
  // returns a summary with no `passthrough`, so a job we started is otherwise indistinguishable
  // from a stranger's the moment the page reloads. Writing the record at creation time is what
  // makes this work — see `RobotsJobRecord`.
  if (recordedJobIds?.has(job.id)) return true;
  // The caller is holding the response to its own create.
  if (options.ownJobIds?.has(job.id)) return true;
  // Stamped by this install, on this entry.
  if (isOwnPassthrough(job.passthrough, options.scope)) return true;
  // Dispatched by a directive run on this asset.
  return !!directiveRunJobIds?.has(job.id);
}

/** Collects the job ids a set of directive runs dispatched, in binding order. */
export function jobIdsFromDirectiveRuns(runs: RobotsDirectiveRun[]): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    for (const node of run.node_states ?? []) {
      if (node.job_id) ids.add(node.job_id);
    }
  }
  return ids;
}

/** Number of hex characters in the request id. See the budget on `buildJobPassthrough`. */
const REQUEST_ID_HEX_LENGTH = 16;

/**
 * 16 hex characters — 64 random bits.
 *
 * Deliberately not a UUID. `passthrough` is capped at 255 characters and the scope segment can
 * now spend up to 194 of them; a 36-character UUID would push the worst case past the cap. 64
 * bits is far more than enough for what this has to be unique against, which is the handful of
 * jobs one entry starts on one asset, not the whole account.
 */
function randomRequestId(): string {
  const cryptoObj = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(REQUEST_ID_HEX_LENGTH / 2));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // No `crypto` at all (an old embedded webview). Weaker, still the right length.
  const seed = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  return seed.padEnd(REQUEST_ID_HEX_LENGTH, '0').slice(-REQUEST_ID_HEX_LENGTH);
}

/** Separates the three ids inside the scope segment. Contentful ids never contain a colon. */
const SCOPE_SEPARATOR = ':';

/**
 * The `passthrough` stamped on every job this app creates:
 * `contentful@<version>|<space>:<environment>:<entry>|<16 hex>`.
 *
 * Three jobs in one string:
 *
 * - **Attribution** — plugin id and version per job, without adding a version header to every
 *   Mux call the app makes. `x-source-platform: contentful` already goes out on the proxied
 *   path; this adds the version and survives into `workflow_jobs` as job data rather than
 *   request metadata.
 * - **Idempotency** — a client-generated request id, so a create whose outcome is unknown can be
 *   matched *exactly* against the job list instead of guessing from asset id + workflow +
 *   creation time.
 * - **Install scope** — which space, environment and entry started it. Without this the tag
 *   identifies the app and nothing more, so a second Contentful install pointed at the same Mux
 *   account is indistinguishable from us and the polling path has to ignore the tag entirely.
 *
 * The length budget, because Mux documents `passthrough` as at most 255 characters and Contentful
 * ids may be up to 64:
 *
 * ```
 * "contentful@"  11
 * version        20  (generous; it is "2.0.0" today)
 * "|"             1
 * space          64
 * ":"             1
 * environment    64
 * ":"             1
 * entry          64
 * "|"             1
 * request id     16
 *              ----
 *               243  ≤ 255
 * ```
 *
 * A full 36-character UUID in place of the request id would make that 263 and blow the cap, which
 * is the whole reason the request id is 16 hex characters.
 *
 * With no scope this falls back to the old two-segment form. That string is never trusted off a
 * listing — see `isOwnPassthrough` — so the fallback is safe rather than silently permissive.
 */
export function buildJobPassthrough(scope?: RobotsPassthroughScope): string {
  const head = `${ROBOTS_PASSTHROUGH_PREFIX}${APP_VERSION}`;
  const scopeSegment = scope
    ? [scope.space, scope.environment, scope.entry].join(SCOPE_SEPARATOR)
    : undefined;
  return [head, ...(scopeSegment ? [scopeSegment] : []), randomRequestId()].join('|');
}

/**
 * Reads a passthrough this app wrote back apart. Defensive by construction: anything that does
 * not parse comes back `undefined`, and nothing here can throw on arbitrary input.
 */
export function parseJobPassthrough(
  passthrough: unknown
): { version: string; scope?: RobotsPassthroughScope } | undefined {
  if (typeof passthrough !== 'string') return undefined;
  if (!passthrough.startsWith(ROBOTS_PASSTHROUGH_PREFIX)) return undefined;

  const [head, ...rest] = passthrough.split('|');
  const version = head.slice(ROBOTS_PASSTHROUGH_PREFIX.length);
  // Two segments is the pre-scope format, `contentful@<version>|<random>`. Parsed, not trusted.
  if (rest.length < 2) return { version };

  const parts = rest[0].split(SCOPE_SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part === '')) return { version };
  return { version, scope: { space: parts[0], environment: parts[1], entry: parts[2] } };
}

/**
 * Whether a `passthrough` was written by **this** install, for **this** entry.
 *
 * Fails closed in every uncertain case: no scope to compare against, a string that does not
 * parse, or the old two-segment format all answer `false`. Treating the old format as untrusted
 * is not a regression — a pre-change job of ours is already recorded on the entry, which is a
 * stronger signal than its passthrough, and a pre-change job we failed to record was already
 * unclaimable under `trustPassthrough: false`.
 */
export function isOwnPassthrough(
  passthrough: unknown,
  scope: RobotsPassthroughScope | undefined
): boolean {
  if (!scope) return false;
  const parsed = parseJobPassthrough(passthrough);
  if (!parsed?.scope) return false;
  return (
    parsed.scope.space === scope.space &&
    parsed.scope.environment === scope.environment &&
    parsed.scope.entry === scope.entry
  );
}

/**
 * Raised when a job creation neither succeeded nor provably failed.
 *
 * Carries the `passthrough` that was stamped on the attempt **and the workflow it was stamped
 * for**, because `findJobByPassthrough` needs both: the detail endpoint is
 * `GET /robots/v0/jobs/{workflow}/{id}`, so a passthrough with no workflow cannot be looked up.
 * That is what the caller keeps and re-checks on every later refresh instead of guessing or
 * giving up.
 */
export class RobotsUnconfirmedCreateError extends Error {
  constructor(
    public readonly passthrough: string,
    public readonly workflow: RobotsWorkflow,
    public readonly cause?: unknown
  ) {
    super(
      'Mux never confirmed this run. It may already be running and billing, so nothing was retried — refresh the job list to find out.'
    );
    this.name = 'RobotsUnconfirmedCreateError';
  }
}

/**
 * Raised when a directive run neither succeeded nor provably failed.
 *
 * The directive path is the *more* expensive one — a directive runs several workflows in
 * sequence, so an accidental second run multiplies the bill rather than doubling one job — and it
 * had no reconciliation at all until this existed: a cold-start timeout showed a plain error
 * toast, and the editor clicked again.
 */
export class RobotsUnconfirmedDirectiveRunError extends Error {
  constructor(public readonly directiveId: string, public readonly cause?: unknown) {
    super(
      'Mux never confirmed this directive run. It may already be running and billing, so nothing was retried — refresh the runs list to find out.'
    );
    this.name = 'RobotsUnconfirmedDirectiveRunError';
  }
}

/** How many of the newest candidate jobs to open when reconciling. */
const RECONCILE_CANDIDATE_LIMIT = 5;

/**
 * Looks for a specific job by the `passthrough` we stamped on it.
 *
 * `GET /robots/v0/jobs` does not return `passthrough` and does not accept it as a filter — the
 * list is a six-field summary (`id`, `workflow`, `status`, `created_at`, `updated_at`, `_links`).
 * So the only way to read a passthrough is `GET /robots/v0/jobs/{workflow}/{id}`, one job at a
 * time. This narrows hard before paying for that: filter server-side by asset and workflow, sort
 * newest first, and open at most a handful — a job we tried to create seconds ago is by
 * definition among the newest for that pair.
 *
 * Retried, because a job created a moment ago is not necessarily listed yet. The delays are short
 * and bounded and are *not* what correctness rests on — the passthrough match is. If every
 * attempt comes up empty the caller keeps the passthrough and checks again on the next refresh,
 * for as long as it takes.
 *
 * Unaffected by the scope segment, and deliberately so: this compares the whole string against
 * one it was handed by the caller that generated it. It is an identity check, not an ownership
 * check, so it neither parses the passthrough nor needs to know what an install scope is.
 */
export async function findJobByPassthrough(
  muxApi: MuxApiService,
  assetId: string,
  workflow: RobotsWorkflow,
  passthrough: string,
  attempts = 1
): Promise<RobotsJob | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
    try {
      const response = await muxApi.listRobotsJobs({ asset_id: assetId, workflow, limit: 100 });
      const candidates = [...(response.data ?? [])]
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        .slice(0, RECONCILE_CANDIDATE_LIMIT);

      for (const candidate of candidates) {
        const full = await muxApi.getRobotsJob(workflow, candidate.id);
        if (full.data?.passthrough === passthrough) return full.data;
      }
    } catch (error) {
      console.error('[robots] Could not read the job list while reconciling', error);
    }
  }
  return undefined;
}

/**
 * Creates a job and, if the call's outcome is unknown, works out whether it actually started.
 *
 * The hazard this exists for: `appActionCall.createWithResponse` creates the call and then polls
 * Contentful's call log for the result, giving up after 15 tries on a 2 s grid. That rejection
 * means "we stopped waiting" — the request to Mux already went out and may well have succeeded.
 * A plain error here would have the editor click Run again and pay twice.
 *
 * So: if Mux answered at all (even a 403) the failure is real and is surfaced. Otherwise the job
 * list is re-read and matched on our own `passthrough`, which is exact. Only when that finds
 * nothing is the outcome genuinely unknown, and the caller keeps Run disabled rather than
 * offering a retry.
 */
export async function createRobotsJobWithReconciliation(
  muxApi: MuxApiService,
  workflow: RobotsWorkflow,
  assetId: string,
  parameters: Record<string, unknown>,
  scope?: RobotsPassthroughScope
): Promise<RobotsJob> {
  const passthrough = buildJobPassthrough(scope);

  try {
    const response = await muxApi.createRobotsJob(workflow, parameters, passthrough);
    if (response.error) {
      // Every message, not just the first: a rejected job lists one per bad parameter, and
      // showing one of three has the editor fix them one round trip at a time. `muxProxy` does
      // the same for the non-2xx path — this branch is the rarer case of an error arriving in an
      // otherwise successful response body.
      const messages = (response.error.messages ?? []).filter(
        (message) => typeof message === 'string' && message.trim() !== ''
      );
      throw new MuxApiError(
        messages.length > 0 ? messages.join(' ') : 'Mux rejected this job but gave no reason.',
        400
      );
    }
    return response.data;
  } catch (error) {
    if (error instanceof MuxApiError && error.muxAnswered) {
      // Mux said no. Nothing started, nothing was billed, the message is worth showing.
      throw error;
    }

    // Outcome unknown. Never retry the create — reconcile.
    //
    // Three attempts rather than one: this is the cold-start case, and a function that took long
    // enough to lose its caller has often only just reached Mux, so the job can be a second or
    // two behind the list. If none of them find it we hand the passthrough back rather than
    // deciding either way.
    const reconciled = await findJobByPassthrough(muxApi, assetId, workflow, passthrough, 3);
    if (reconciled) return reconciled;

    throw new RobotsUnconfirmedCreateError(passthrough, workflow, error);
  }
}

/**
 * How recently a listed run must have started to be adopted as the one we just tried to create.
 *
 * Two minutes covers the whole hazard window — `createWithResponse` gives up after ~30 s, and a
 * cold-started function that lost its caller has already reached Mux by then — while being far
 * too short to sweep up an unrelated run of the same directive on the same asset.
 */
export const ROBOTS_DIRECTIVE_RUN_ADOPTION_WINDOW_MS = 2 * 60 * 1000;

/**
 * Looks for a directive run on this asset that started just now.
 *
 * The directive equivalent of `findJobByPassthrough`, and weaker than it by necessity: `POST
 * /robots/v0/directives/{id}/runs` takes no `passthrough` and the API has no idempotency key, so
 * there is no exact token to match on. What is left is the narrowest honest match — the same
 * directive, the same asset, started inside `ROBOTS_DIRECTIVE_RUN_ADOPTION_WINDOW_MS`.
 *
 * A run with no `started_at` is **not** adopted. Failing to adopt costs the editor one informed
 * click on the escape hatch; adopting the wrong run drops the guard on a run that never started,
 * which is the mistake that costs money.
 */
export async function findRecentDirectiveRun(
  muxApi: MuxApiService,
  directiveId: string,
  assetId: string,
  {
    attempts = 1,
    now = Date.now(),
    windowMs = ROBOTS_DIRECTIVE_RUN_ADOPTION_WINDOW_MS,
  }: { attempts?: number; now?: number; windowMs?: number } = {}
): Promise<RobotsDirectiveRun | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
    try {
      const response = await muxApi.listRobotsDirectiveRuns(directiveId, { limit: 25 });
      const candidate = (response.data ?? [])
        // `subject_id`, not `asset_id` — the REST shape. See `RobotsDirectiveRun`.
        .filter((run) => !!run.run_id && run.subject_id === assetId)
        .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
        .find((run) => {
          const startedMs = (run.started_at ?? 0) * 1000;
          if (!startedMs) return false;
          // Absolute, so a clock a little ahead of ours does not read as "not ours".
          return Math.abs(now - startedMs) <= windowMs;
        });

      if (candidate) return { ...candidate, directive_id: directiveId };
    } catch (error) {
      console.error('[robots] Could not read the directive runs while reconciling', error);
    }
  }
  return undefined;
}

/**
 * Starts a directive run and, if the call's outcome is unknown, works out whether it actually
 * started.
 *
 * Same hazard and same shape as `createRobotsJobWithReconciliation`, on the path where it costs
 * more: a directive dispatches several billable workflows, so a duplicate run multiplies the
 * spend. This was previously unprotected — a timeout produced a plain error toast and the obvious
 * next move was to click Run directive again.
 *
 * If Mux answered at all (a 409 "already running", a 404, a 403) the failure is real and is
 * surfaced. Otherwise the run list is re-read and a run on this asset that started inside the
 * adoption window is adopted. Only when that finds nothing is the outcome genuinely unknown.
 */
export async function createRobotsDirectiveRunWithReconciliation(
  muxApi: MuxApiService,
  directiveId: string,
  assetId: string
): Promise<RobotsDirectiveRun> {
  try {
    const response = await muxApi.createRobotsDirectiveRun(directiveId, assetId);
    const created = response?.data;
    // A 2xx whose body does not name the run is the same "we do not know" as a dropped response:
    // the run may exist, and we have nothing to point at. Reconcile rather than assume either way.
    if (!created?.run_id) {
      const reconciled = await findRecentDirectiveRun(muxApi, directiveId, assetId, {
        attempts: 3,
      });
      if (reconciled) return reconciled;
      throw new RobotsUnconfirmedDirectiveRunError(directiveId);
    }
    return { ...created, directive_id: directiveId };
  } catch (error) {
    if (error instanceof RobotsUnconfirmedDirectiveRunError) throw error;
    if (error instanceof MuxApiError && error.muxAnswered) {
      // Mux said no — including the 409 the caller turns into "already running on this video".
      throw error;
    }

    const reconciled = await findRecentDirectiveRun(muxApi, directiveId, assetId, { attempts: 3 });
    if (reconciled) return reconciled;

    throw new RobotsUnconfirmedDirectiveRunError(directiveId, error);
  }
}

/**
 * Works out whether this installation can use Robots, from a single cheap list call.
 *
 * Reactive by design. Hiding a workflow before the editor clicks it would need to know the org's
 * plan, and the app has no entitlement data — no Robots endpoint exposes one. So the tab shows
 * everything and explains the 403 when it arrives.
 */
export function capabilityFromError(error: unknown): RobotsCapability {
  if (!(error instanceof MuxApiError)) {
    return { state: 'not-enabled' };
  }

  const type = error.errorType;
  const message = error.message;

  if (type === 'robots_units_limit_exceeded') {
    return { state: 'units-exhausted', message };
  }
  // A token predating the `robots:*` scope: the scope cannot be added to an existing token, so
  // the fix is a new token rather than a settings toggle. Worth its own copy.
  if (type === 'insufficient_scope' || error.status === 401) {
    return { state: 'scope-missing', message };
  }
  if (error.status === 403) {
    return { state: 'not-enabled', message };
  }
  return { state: 'not-enabled', message };
}

/**
 * Capability is resolved once per browser session, not once per asset. Opening ten entries in a
 * row should not cost ten extra app-action round trips to learn the same answer.
 */
let capabilityCache: RobotsCapability | undefined;

export function cachedRobotsCapability(): RobotsCapability | undefined {
  return capabilityCache;
}

export function resetRobotsCapabilityCache(): void {
  capabilityCache = undefined;
}

export async function resolveRobotsCapability(muxApi: MuxApiService): Promise<RobotsCapability> {
  if (capabilityCache) return capabilityCache;
  try {
    await muxApi.listRobotsJobs({ limit: 1 });
    capabilityCache = { state: 'enabled' };
  } catch (error) {
    capabilityCache = capabilityFromError(error);
  }
  return capabilityCache;
}

// --- Field JSON reconciliation ---

function toJobRecord(job: RobotsJob): RobotsJobRecord | undefined {
  if (!job.id || !job.status) return undefined;
  const error = robotsJobErrorMessage(job);
  return {
    id: job.id,
    workflow: job.workflow,
    status: job.status,
    ...(job.created_at !== undefined && { created_at: job.created_at }),
    ...(job.updated_at !== undefined && { updated_at: job.updated_at }),
    ...(job.units_consumed !== undefined && { units_consumed: job.units_consumed }),
    ...(job.passthrough !== undefined && { passthrough: job.passthrough }),
    ...(error !== undefined && { error }),
  };
}

/**
 * Merges the finished jobs from an API read into the records already on the field.
 *
 * Returns the same array reference when nothing changed, so the caller's no-op check can skip the
 * write entirely — the whole point being that a poll tick which learns nothing must not bump the
 * entry version and flip a published entry to "Changed".
 *
 * The API list is authoritative when the two disagree: the records on the field are a mirror of
 * state Robots owns.
 */
export function mergeJobRecords(
  existing: RobotsJobRecord[] | undefined,
  jobs: RobotsJob[]
): RobotsJobRecord[] | undefined {
  const incoming = jobs.map(toJobRecord).filter((record): record is RobotsJobRecord => !!record);
  if (incoming.length === 0) return existing;

  const byId = new Map<string, RobotsJobRecord>();
  for (const record of existing ?? []) byId.set(record.id, record);

  let changed = false;
  for (const record of incoming) {
    const current = byId.get(record.id);
    if (!current) {
      byId.set(record.id, record);
      changed = true;
      continue;
    }
    // The list is a summary, so an incoming record can be *thinner* than the stored one — it may
    // have no `passthrough` or `units_consumed` even though we recorded them at creation. Merging
    // rather than replacing keeps what only the richer response knew, while still letting the API
    // win on the fields it is authoritative for.
    const merged: RobotsJobRecord = { ...current, ...stripUndefined(record) };
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      byId.set(record.id, merged);
      changed = true;
    }
  }

  if (!changed) return existing;

  // Newest first, so the table reads the way an editor expects without sorting in the component.
  return Array.from(byId.values()).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/** Drops keys whose value is `undefined`, so a spread cannot erase what we already knew. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as Partial<T>;
}

function extractSummarizeOutput(job: RobotsJob): RobotsSummarizeOutput | undefined {
  const outputs = job.outputs;
  if (!outputs) return undefined;
  const tags = Array.isArray(outputs.tags)
    ? (outputs.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
    : undefined;

  const output: RobotsSummarizeOutput = {
    jobId: job.id,
    ...(job.updated_at !== undefined && { completedAt: job.updated_at }),
    ...(typeof outputs.title === 'string' && { title: outputs.title }),
    ...(typeof outputs.description === 'string' && { description: outputs.description }),
    ...(tags?.length && { tags }),
  };

  return output.title || output.description || output.tags ? output : undefined;
}

function extractModerateOutput(job: RobotsJob): RobotsModerateOutput | undefined {
  const outputs = job.outputs;
  if (!outputs) return undefined;

  const maxScores = outputs.max_scores as Record<string, unknown> | undefined;
  const scores =
    maxScores && typeof maxScores === 'object'
      ? {
          ...(typeof maxScores.sexual === 'number' && { sexual: maxScores.sexual }),
          ...(typeof maxScores.violence === 'number' && { violence: maxScores.violence }),
        }
      : undefined;

  const output: RobotsModerateOutput = {
    jobId: job.id,
    ...(job.updated_at !== undefined && { completedAt: job.updated_at }),
    ...(typeof outputs.exceeds_threshold === 'boolean' && {
      exceedsThreshold: outputs.exceeds_threshold,
    }),
    ...(scores && Object.keys(scores).length > 0 && { maxScores: scores }),
  };

  return output.exceedsThreshold !== undefined || output.maxScores ? output : undefined;
}

/**
 * Folds the outputs of completed jobs into the persisted `robotsOutputs`.
 *
 * Only summarize and moderation are persisted; the rest either land on the Mux asset already
 * (captions, dubs, thumbnails) or are large enough that storing them on a JSON field is the wrong
 * call (scenes, key moments) and stay live-fetched in the tab.
 *
 * Returns the same reference when nothing changed, for the same no-op reason as `mergeJobRecords`.
 * The newest completion wins, so re-running summarize replaces the previous summary rather than
 * accumulating.
 */
export function mergeRobotsOutputs(
  existing: RobotsOutputs | undefined,
  jobs: RobotsJob[]
): RobotsOutputs | undefined {
  const relevant = jobs.filter(
    (job) => job.status === 'completed' && PERSISTED_OUTPUT_WORKFLOWS.includes(job.workflow)
  );
  if (relevant.length === 0) return existing;

  const next: RobotsOutputs = { ...(existing ?? {}) };
  let changed = false;

  for (const job of relevant) {
    if (job.workflow === 'summarize') {
      const output = extractSummarizeOutput(job);
      if (!output) continue;
      if (isNewerOutput(next.summarize, output)) {
        next.summarize = output;
        changed = true;
      }
    }
    if (job.workflow === 'moderate') {
      const output = extractModerateOutput(job);
      if (!output) continue;
      if (isNewerOutput(next.moderate, output)) {
        next.moderate = output;
        changed = true;
      }
    }
  }

  return changed ? next : existing;
}

function isNewerOutput(
  current: { jobId: string; completedAt?: number } | undefined,
  candidate: { jobId: string; completedAt?: number }
): boolean {
  if (!current) return true;
  if (current.jobId === candidate.jobId) {
    return JSON.stringify(current) !== JSON.stringify(candidate);
  }
  return (candidate.completedAt ?? 0) >= (current.completedAt ?? 0);
}

function toDirectiveRunRecord(run: RobotsDirectiveRun): RobotsDirectiveRunRecord | undefined {
  if (!run.run_id || !run.directive_id) return undefined;
  const jobIds = (run.node_states ?? [])
    .map((node) => node.job_id)
    .filter((id): id is string => !!id);

  return {
    runId: run.run_id,
    directiveId: run.directive_id,
    ...(run.status !== undefined && { status: run.status }),
    ...(run.started_at !== undefined && { startedAt: run.started_at }),
    ...(run.completed_at !== undefined &&
      run.completed_at !== null && { completedAt: run.completed_at }),
    ...(jobIds.length > 0 && { jobIds }),
  };
}

/**
 * Merges directive runs from an API read into the records already on the field.
 *
 * `append` is the whole difference between the two callers, and it is deliberate:
 *
 * - **Creation** (`recordRobotsDirectiveRun`) appends. That is the one moment ownership is
 *   unambiguous, and it is what puts the run on the entry at all.
 * - **Polling** (`applyRobotsDirectiveRunsToValue`) never appends. It only fills in runs the
 *   entry already records — their status, their completion, and the job ids `node_states`
 *   reveals as the sequence dispatches.
 *
 * If polling appended, merely opening an entry whose asset happens to have a directive run inside
 * the API's newest-25 window would add a `robotsDirectiveRuns` key, raise the version to v4 and
 * flip a published entry to "Changed" — for a run nobody started from this entry. That is exactly
 * the re-draft `deriveFieldVersion` exists to avoid, arriving through a different door.
 *
 * `jobIds` is unioned, never replaced: a later read of the same run may show fewer nodes (a run
 * listing without `node_states`), and losing an id would un-claim a job the entry had already
 * claimed. Same append-only rule as `robotsJobs` — Mux purges after 30 days and the entry's
 * history has to outlive that.
 *
 * Returns the same array reference when nothing changed, so the caller's no-op check skips the
 * write entirely.
 */
export function mergeDirectiveRunRecords(
  existing: RobotsDirectiveRunRecord[] | undefined,
  runs: RobotsDirectiveRun[],
  { append = false }: { append?: boolean } = {}
): RobotsDirectiveRunRecord[] | undefined {
  const incoming = runs
    .map(toDirectiveRunRecord)
    .filter((record): record is RobotsDirectiveRunRecord => !!record);
  if (incoming.length === 0) return existing;

  const byId = new Map<string, RobotsDirectiveRunRecord>();
  for (const record of existing ?? []) byId.set(record.runId, record);

  let changed = false;
  for (const record of incoming) {
    const current = byId.get(record.runId);
    if (!current) {
      if (!append) continue;
      byId.set(record.runId, record);
      changed = true;
      continue;
    }

    const jobIds = Array.from(new Set([...(current.jobIds ?? []), ...(record.jobIds ?? [])]));
    const merged: RobotsDirectiveRunRecord = {
      ...current,
      ...stripUndefined(record),
      ...(jobIds.length > 0 && { jobIds }),
    };
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      byId.set(record.runId, merged);
      changed = true;
    }
  }

  if (!changed) return existing;

  return Array.from(byId.values()).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** Job ids named by the directive runs the entry itself records. */
function jobIdsFromRecordedRuns(records: RobotsDirectiveRunRecord[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const record of records ?? []) {
    for (const id of record.jobIds ?? []) ids.add(id);
  }
  return ids;
}

/**
 * Records a directive run this app just started. The **only** place a run is added to the entry.
 *
 * Written at creation for the same reason a job record is: it is the one moment ownership is
 * unambiguous, and it is what makes the run — and every job it goes on to dispatch — survive a
 * reload without depending on the run still being inside the API's newest-25 list window. See
 * ADR-0009.
 */
export function recordRobotsDirectiveRun(
  value: MuxContentfulObject | undefined,
  run: RobotsDirectiveRun
): MuxContentfulObject | undefined {
  return applyDirectiveRunRecords(value, [run], { append: true });
}

/**
 * Folds fresh directive-run data into runs the entry already records. Never adds one — see
 * `mergeDirectiveRunRecords`.
 */
export function applyRobotsDirectiveRunsToValue(
  value: MuxContentfulObject | undefined,
  runs: RobotsDirectiveRun[]
): MuxContentfulObject | undefined {
  return applyDirectiveRunRecords(value, runs, { append: false });
}

function applyDirectiveRunRecords(
  value: MuxContentfulObject | undefined,
  runs: RobotsDirectiveRun[],
  options: { append: boolean }
): MuxContentfulObject | undefined {
  if (!value) return value;

  const robotsDirectiveRuns = mergeDirectiveRunRecords(value.robotsDirectiveRuns, runs, options);
  if (robotsDirectiveRuns === value.robotsDirectiveRuns) return value;

  const next: MuxContentfulObject = {
    ...value,
    ...(robotsDirectiveRuns && { robotsDirectiveRuns }),
  };

  return { ...next, version: deriveFieldVersion(next) };
}

/**
 * The single mutator the Robots tab hands to `updateField`: fold an API read into the stored
 * value, touching nothing else and returning the input untouched when there is nothing new.
 */
export function applyRobotsJobsToValue(
  value: MuxContentfulObject | undefined,
  jobs: RobotsJob[],
  directiveRunJobIds?: Set<string>,
  options: RobotsOwnershipOptions = {}
): MuxContentfulObject | undefined {
  if (!value) return value;

  // Only what this plugin originated goes on the entry. See `isPluginOriginatedJob`.
  const recordedJobIds = new Set((value.robotsJobs ?? []).map((record) => record.id));
  // Directive-dispatched jobs are claimed from two places: the runs currently listed by the API,
  // and the runs this entry recorded when it started them. The second is what keeps a job
  // claimable after its run has aged out of the newest-25 window the list is capped at, or after
  // the directive itself has been deleted.
  const claimedByRuns = new Set([
    ...(directiveRunJobIds ?? []),
    ...jobIdsFromRecordedRuns(value.robotsDirectiveRuns),
  ]);
  const ours = jobs.filter((job) =>
    isPluginOriginatedJob(job, claimedByRuns, recordedJobIds, options)
  );

  const robotsJobs = mergeJobRecords(value.robotsJobs, ours);
  const robotsOutputs = mergeRobotsOutputs(value.robotsOutputs, ours);

  if (robotsJobs === value.robotsJobs && robotsOutputs === value.robotsOutputs) return value;

  const next: MuxContentfulObject = {
    ...value,
    ...(robotsJobs && { robotsJobs }),
    ...(robotsOutputs && { robotsOutputs }),
  };

  // Raise the stored version to match what the value now actually holds. Derived, never
  // asserted — a value with no Robots data keeps whatever version it had, which is what stops
  // this from re-drafting entries that predate the feature.
  return { ...next, version: deriveFieldVersion(next) };
}

/**
 * Jobs that still need `GET /robots/v0/jobs/{workflow}/{id}`.
 *
 * The list gives status and timing and nothing else, so `outputs`, `units_consumed`, `errors` and
 * `passthrough` are all unavailable from it. Without this, `robotsOutputs` could never be
 * populated — not even for summarize — and a failed job could never record why.
 *
 * This deliberately does **not** filter by ownership. An earlier version did, which conflated a
 * persistence rule with a read gate: the entry only records jobs this plugin started, but the tab
 * *shows* every job on the asset, and a row with no units and no output is not worth showing. So
 * a job run from the Mux dashboard gets its detail fetched too — reading a job costs nothing and
 * charges nobody. What must not happen is that job ending up on the entry, and that is enforced
 * where it belongs, in `applyRobotsJobsToValue`.
 *
 * Bounded in two directions, because the candidate pool is now every terminal job on the asset:
 * `window` caps how far back we are willing to look at all, and `limit` caps one pass. An asset
 * with two hundred dashboard jobs costs at most `window` detail reads however long it stays open.
 *
 * What the bound must not do is lie. A row past the window has no `units_consumed` because nobody
 * ever asked for it, and rendering that as an em dash made it indistinguishable from a job that
 * consumed nothing — the blank-because-unknown against blank-because-empty confusion that has
 * already produced several bugs here. So the bound stays and the *presentation* carries it:
 * `unitsCell` in `RobotsJobTable` says "Not loaded" and offers the single read that answers it,
 * and errored and cancelled rows read "Not charged" without needing any read at all. See the
 * 2026-09-16 amendment to ADR-0005.
 */
export function jobsNeedingDetail(
  jobs: RobotsJob[],
  alreadyDetailed: Set<string>,
  { limit = 5, window = 20 }: { limit?: number; window?: number } = {}
): RobotsJob[] {
  return [...jobs]
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, window)
    .filter((job) => isTerminalStatus(job.status) && !alreadyDetailed.has(job.id))
    .slice(0, limit);
}

/**
 * Directive runs that are still worth polling, by the same rule `activeJobs` uses.
 *
 * This is what carries the poll across the gap a directive leaves behind. A directive dispatches
 * its workflows *in sequence*, so between one job finishing and the next being dispatched there
 * is a window with zero non-terminal jobs on the asset — and in that window the run is the only
 * thing that knows more work is coming. Without it the loop stops dead after the first job and
 * the rest of the sequence only ever appears on a page reload.
 *
 * The terminal condition, spelled out, because a poll that never ends bills real app-action round
 * trips for as long as the entry stays open. Polling stops when either:
 *
 * - the run reaches `completed`, `partial` or `errored` — the statuses it can never leave; or
 * - `started_at` is further back than `ROBOTS_STALE_JOB_MS`, whatever the status says.
 *
 * The second is the one that matters, and it is deliberately *shorter* than the 24-hour cap the
 * engine gives a binding waiting on a source workflow. A run that is genuinely still waiting
 * after six hours is not something to keep an open browser tab spinning on; Refresh is right
 * there. A run with no `started_at` counts as active, matching `activeJobs` — in practice the
 * list always sends one, so this only covers the optimistic row `handleRunDirective` adds from
 * the create response, which the next list read replaces.
 */
export function activeDirectiveRuns(
  runs: RobotsDirectiveRun[],
  now = Date.now()
): RobotsDirectiveRun[] {
  return runs.filter((run) => {
    if (isTerminalRunStatus(run.status)) return false;
    const startedMs = (run.started_at ?? 0) * 1000;
    if (!startedMs) return true;
    return now - startedMs < ROBOTS_STALE_JOB_MS;
  });
}

/** Jobs that are still worth polling: non-terminal, and not so old that the API has lost them. */
export function activeJobs(jobs: RobotsJob[], now = Date.now()): RobotsJob[] {
  return jobs.filter((job) => {
    if (isTerminalStatus(job.status)) return false;
    const createdMs = (job.created_at ?? 0) * 1000;
    if (!createdMs) return true;
    return now - createdMs < ROBOTS_STALE_JOB_MS;
  });
}
