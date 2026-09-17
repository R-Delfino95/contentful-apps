import { MuxApiError, MuxApiService } from './muxApi';
import {
  RobotsCapability,
  RobotsDirectiveRun,
  RobotsJob,
  RobotsWorkflow,
} from './robotsTypes';

/**
 * Deciding which Robots jobs are ours, and recovering a create whose outcome Mux never confirmed.
 *
 * Ownership governs **what is written to the entry**, not what is read: the tab shows every job on
 * the asset, dashboard ones included, and fetches their detail. Conflating the two is what made
 * dashboard jobs render a permanently blank Units column. See ADR-0003 and ADR-0005.
 */

const ROBOTS_PLUGIN_ID = 'contentful';

/**
 * A necessary condition for "is this job ours", never a sufficient one: the prefix names the
 * *app*, and two Contentful installs on the same Mux account both write it. The scope segment
 * that follows is what decides ownership — see `isOwnPassthrough`.
 */
const ROBOTS_PASSTHROUGH_PREFIX = `${ROBOTS_PLUGIN_ID}@`;

const APP_VERSION = typeof __MUX_APP_VERSION__ === 'string' ? __MUX_APP_VERSION__ : 'unknown';

export const ROBOTS_PRICING_URL = 'https://www.mux.com/docs/pricing/overview#mux-robots-pricing';
export const ROBOTS_DOCS_URL = 'https://www.mux.com/docs/guides/robots';
export const ROBOTS_TOKEN_DOCS_URL = 'https://dashboard.mux.com/settings/access-tokens';

/**
 * How long a job may sit in a non-terminal state before the tab stops waiting on it.
 * Purely a client-side guard against polling forever on a job the API has lost track of.
 */
export const ROBOTS_STALE_JOB_MS = 6 * 60 * 60 * 1000;

/**
 * Poll cadence for in-flight jobs. Much slower than the 500 ms asset loop on purpose: a Robots job
 * takes minutes, and each tick costs at least two CMA requests through the app-action bridge.
 */
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
 * Four ways to qualify, checked in order. Anything else — a job someone ran from the Mux
 * dashboard — is displayed but never stored.
 */
export function isPluginOriginatedJob(
  job: RobotsJob,
  directiveRunJobIds?: Set<string>,
  recordedJobIds?: Set<string>,
  options: RobotsOwnershipOptions = {}
): boolean {
  // Already on the entry: the durable answer, and the only one that survives a reload — the job
  // list omits `passthrough`, so without the record a job we started looks like a stranger's.
  if (recordedJobIds?.has(job.id)) return true;
  // The caller is holding the response to its own create.
  if (options.ownJobIds?.has(job.id)) return true;
  // Stamped by this install, on this entry.
  if (isOwnPassthrough(job.passthrough, options.scope)) return true;
  // Dispatched by a directive run on this asset: created server-side with no passthrough of ours,
  // but the directive was attached by this app through `new_asset_settings`.
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

const REQUEST_ID_HEX_LENGTH = 16;

/**
 * 64 random bits, not a UUID: `passthrough` is capped at 255 characters and the scope segment can
 * spend up to 194, so a 36-character UUID would push the worst case past the cap.
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
 * Three jobs in one string: **attribution** (plugin and version, as job data rather than request
 * metadata), **idempotency** (a client-generated request id, so an unconfirmed create can be
 * matched exactly rather than guessed at from asset + workflow + time), and **install scope**
 * (without it the tag names the app, and a second Contentful install on the same Mux account is
 * indistinguishable from us).
 *
 * Length budget: Mux caps `passthrough` at 255 and Contentful ids run to 64, so the worst case is
 * 11 + 20 + 1 + 64 + 1 + 64 + 1 + 64 + 1 + 16 = 243. A 36-character UUID in place of the request
 * id would make it 263 — which is why the request id is 16 hex characters.
 *
 * With no scope this falls back to the old two-segment form, which `isOwnPassthrough` trusts for
 * nothing.
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
 * Fails closed in every uncertain case — no scope, a string that does not parse, or the old
 * two-segment format. The expensive mistake is adopting someone else's billable job, and it is
 * silent.
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
 * Carries the workflow as well as the passthrough: the detail endpoint is
 * `GET /robots/v0/jobs/{workflow}/{id}`, so a passthrough alone cannot be looked up.
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
 * Raised when a directive run neither succeeded nor provably failed. The more expensive path: a
 * directive runs several workflows in sequence, so a second run multiplies the bill.
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
 * The list omits `passthrough` and cannot filter by it, so the only way to read one is the
 * single-job GET. This narrows hard before paying for that: filter by asset and workflow, newest
 * first, and open at most a handful — a job created seconds ago is among the newest for that pair.
 *
 * Retried because a fresh job is not necessarily listed yet, but the delays are not what
 * correctness rests on: the passthrough match is exact, and a caller that finds nothing keeps the
 * passthrough and checks again on the next refresh.
 *
 * An identity check, not an ownership check — it compares the whole string against one the caller
 * generated, so it never parses it or looks at the scope.
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
 * `appActionCall.createWithResponse` gives up after ~30 s, and that rejection means "we stopped
 * waiting" — the request to Mux may well have succeeded and be billing. So: if Mux answered at
 * all, even a 403, the failure is real and is surfaced; otherwise the job list is re-read and
 * matched on our own passthrough. Only when that finds nothing is the outcome genuinely unknown,
 * and Run stays disabled rather than offering a retry. See ADR-0003.
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

    // Outcome unknown: reconcile, never retry. Three attempts because a function that took long
    // enough to lose its caller has often only just reached Mux, so the job lags the list.

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
const ROBOTS_DIRECTIVE_RUN_ADOPTION_WINDOW_MS = 2 * 60 * 1000;

/**
 * The directive equivalent of `findJobByPassthrough`, and weaker by necessity: the runs endpoint
 * takes no `passthrough` and has no idempotency key, so the narrowest honest match is the same
 * directive, the same asset, started inside the adoption window.
 *
 * A run with no `started_at` is **not** adopted. Failing to adopt costs one informed click on the
 * escape hatch; adopting the wrong run drops the guard on a run that never started.
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
 * Same hazard and same shape as `createRobotsJobWithReconciliation`, on the path where it costs
 * more: a directive dispatches several billable workflows, so a duplicate run multiplies the
 * spend.
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
 * Works out whether this installation can use Robots, from the error a call came back with.
 *
 * Reactive by design: hiding a workflow up front would need entitlement data, which no Robots
 * endpoint exposes. So the tab shows everything and explains the 403 when it arrives.
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
