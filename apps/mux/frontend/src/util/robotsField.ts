import {
  PERSISTED_OUTPUT_WORKFLOWS,
  RobotsDirectiveRun,
  RobotsDirectiveRunRecord,
  RobotsJob,
  RobotsJobRecord,
  RobotsModerateOutput,
  RobotsOutputs,
  RobotsSummarizeOutput,
  isTerminalRunStatus,
  isTerminalStatus,
  robotsJobErrorMessage,
} from './robotsTypes';
import { deriveFieldVersion } from './muxFieldVersion';
import { MuxContentfulObject } from './types';
import {
  ROBOTS_STALE_JOB_MS,
  RobotsOwnershipOptions,
  isPluginOriginatedJob,
} from './robotsPassthrough';

/**
 * Turning what the API says into what the entry stores.
 *
 * Every merge here returns the *same reference* when nothing changed, because `updateField` drops
 * writes that would change nothing and that is what keeps a poll tick from flipping a published
 * entry to "Changed" on every pass. Records are append-and-update only: Mux purges jobs after 30
 * days and the entry's history has to outlive that. See ADR-0005 and ADR-0010.
 */

function toJobRecord(job: RobotsJob): RobotsJobRecord | undefined {
  if (!job.id || !job.status) return undefined;
  const error = robotsJobErrorMessage(job);
  return compact({
    id: job.id,
    workflow: job.workflow,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    units_consumed: job.units_consumed,
    passthrough: job.passthrough,
    error,
  }) as RobotsJobRecord;
}

/**
 * Merges the jobs from an API read into the records already on the field.
 *
 * The API is authoritative when the two disagree — the records are a mirror of state Robots owns.
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
    // The list is a summary, so an incoming record can be *thinner* than the stored one — no
    // `passthrough` or `units_consumed` even though we recorded them at creation. Merging keeps
    // what only the richer response knew.
    const merged: RobotsJobRecord = { ...current, ...compact(record) };
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      byId.set(record.id, merged);
      changed = true;
    }
  }

  if (!changed) return existing;

  // Newest first, so the table reads the way an editor expects without sorting in the component.
  return Array.from(byId.values()).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/**
 * Drops keys whose value is `undefined`.
 *
 * Load-bearing in two places. Merging: a spread of a thinner API record must not erase a field the
 * richer create response gave us. Storing: an explicit `undefined` key is a key, and a record that
 * carries one is not byte-identical to what is on disk — which is what re-drafts a published entry.
 */
function compact<T extends object>(value: T): Partial<T> {
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

  const output = compact({
    jobId: job.id,
    completedAt: job.updated_at,
    title: typeof outputs.title === 'string' ? outputs.title : undefined,
    description: typeof outputs.description === 'string' ? outputs.description : undefined,
    tags: tags?.length ? tags : undefined,
  }) as RobotsSummarizeOutput;

  return output.title || output.description || output.tags ? output : undefined;
}

function extractModerateOutput(job: RobotsJob): RobotsModerateOutput | undefined {
  const outputs = job.outputs;
  if (!outputs) return undefined;

  const maxScores = outputs.max_scores as Record<string, unknown> | undefined;
  const scores =
    maxScores && typeof maxScores === 'object'
      ? compact({
          sexual: typeof maxScores.sexual === 'number' ? maxScores.sexual : undefined,
          violence: typeof maxScores.violence === 'number' ? maxScores.violence : undefined,
        })
      : undefined;

  const output = compact({
    jobId: job.id,
    completedAt: job.updated_at,
    exceedsThreshold:
      typeof outputs.exceeds_threshold === 'boolean' ? outputs.exceeds_threshold : undefined,
    maxScores: scores && Object.keys(scores).length > 0 ? scores : undefined,
  }) as RobotsModerateOutput;

  return output.exceedsThreshold !== undefined || output.maxScores ? output : undefined;
}

/**
 * Folds the outputs of completed jobs into the persisted `robotsOutputs`.
 *
 * Only summarize and moderation: the rest either already land on the Mux asset (captions, dubs,
 * thumbnails) or are too large for a JSON field (scenes, key moments). Keyed by workflow, so
 * re-running supersedes rather than accumulating. See ADR-0008.
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

  return compact({
    runId: run.run_id,
    directiveId: run.directive_id,
    status: run.status,
    startedAt: run.started_at,
    // `null` is a value the API sends for a run that has not finished, and it is not `undefined`
    // — storing it would put a `completedAt: null` on the entry.
    completedAt: run.completed_at ?? undefined,
    jobIds: jobIds.length > 0 ? jobIds : undefined,
  }) as RobotsDirectiveRunRecord;
}

/**
 * Merges directive runs from an API read into the records already on the field.
 *
 * `append` is the whole difference between the two callers. **Creation** appends — the one moment
 * ownership is unambiguous. **Polling** never does: if it did, merely opening an entry whose asset
 * happens to have a run inside the API's newest-25 window would add a key, raise the version and
 * flip a published entry to "Changed" for a run nobody started here.
 *
 * `jobIds` is unioned, never replaced: a later read may show fewer nodes, and losing an id would
 * un-claim a job the entry had already claimed. See ADR-0009.
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
      ...compact(record),
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
 * Records a directive run this app just started. The **only** place a run is added to the entry:
 * it is what makes the run, and every job it dispatches, survive a reload without depending on
 * the API's newest-25 list window. See ADR-0009.
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
 * The jobs this entry claims: what `applyRobotsJobsToValue` stores, and what the job table does
 * not mark as started elsewhere. One rule for both, so the marker can never disagree with what
 * the entry will hold.
 */
export function jobsClaimedByEntry(
  value: MuxContentfulObject | undefined,
  jobs: RobotsJob[],
  directiveRunJobIds?: Set<string>,
  options: RobotsOwnershipOptions = {}
): RobotsJob[] {
  const recordedJobIds = new Set((value?.robotsJobs ?? []).map((record) => record.id));
  // Directive-dispatched jobs are claimed from two places: the runs the caller claims, and the
  // runs this entry recorded when it started them. The second is what keeps a job claimable after
  // its run has aged out of the newest-25 window the list is capped at, or after the directive
  // itself has been deleted.
  const claimedByRuns = new Set([
    ...(directiveRunJobIds ?? []),
    ...jobIdsFromRecordedRuns(value?.robotsDirectiveRuns),
  ]);
  return jobs.filter((job) => isPluginOriginatedJob(job, claimedByRuns, recordedJobIds, options));
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
  const ours = jobsClaimedByEntry(value, jobs, directiveRunJobIds, options);

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
 * Jobs that still need `GET /robots/v0/jobs/{workflow}/{id}`, where `outputs`, `units_consumed`,
 * `errors` and `passthrough` live.
 *
 * Deliberately not filtered by ownership: the entry records only our jobs, but the tab *shows*
 * every job on the asset, and reading one is a GET that charges nobody. What must not happen is a
 * foreign job reaching the entry, and that is enforced in `applyRobotsJobsToValue`.
 *
 * Bounded in two directions because the candidate pool is every terminal job on the asset:
 * `window` caps how far back we look at all, `limit` caps one pass. The bound must not lie,
 * though — `unitsCell` says "Not loaded" for a row past it and offers the read that answers it.
 * See the 2026-09-16 amendment to ADR-0005.
 */
export function jobsNeedingDetail(
  jobs: RobotsJob[],
  alreadyDetailed: Set<string>,
  { limit = 5, window = 20 }: { limit?: number; window?: number } = {}
): RobotsJob[] {
  return jobsAwaitingDetail(jobs, alreadyDetailed, { window }).slice(0, limit);
}

/**
 * Every job the background pass will still read, not just the next batch — what the table shows
 * as loading rather than as "Not loaded". One rule with `jobsNeedingDetail`, so a cell can never
 * say it is loading a read that will not happen.
 */
export function jobsAwaitingDetail(
  jobs: RobotsJob[],
  alreadyDetailed: Set<string>,
  { window = 20 }: { window?: number } = {}
): RobotsJob[] {
  return [...jobs]
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, window)
    .filter((job) => isTerminalStatus(job.status) && !alreadyDetailed.has(job.id));
}

/** A directive run, by the two ids its single-run GET takes. */
export interface RobotsDirectiveRunRef {
  directiveId: string;
  runId: string;
}

/**
 * The directive runs these jobs name, once each.
 *
 * `directive` is on the single-job GET only, so this sees the jobs whose detail has been read —
 * which is what bounds reading their runs by the asset rather than by the account.
 */
export function directiveRunRefsFromJobs(jobs: RobotsJob[]): RobotsDirectiveRunRef[] {
  const byRunId = new Map<string, RobotsDirectiveRunRef>();
  for (const job of jobs) {
    const directiveId = job.directive?.id;
    const runId = job.directive?.run_id;
    if (directiveId && runId && !byRunId.has(runId)) byRunId.set(runId, { directiveId, runId });
  }
  return Array.from(byRunId.values());
}

/**
 * Directive runs still worth polling — what carries the loop across the gap a directive leaves
 * between one workflow finishing and the next being dispatched.
 *
 * Two terminal conditions, because a poll that never ends bills round trips for as long as the
 * entry stays open: a `completed`/`partial`/`errored` status, or a `started_at` further back than
 * `ROBOTS_STALE_JOB_MS`. The staleness cut-off is deliberately shorter than the 24 hours the
 * engine gives a binding waiting on a source workflow — Refresh is right there.
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

/** What "still running" needs to know, shared by the API shape and the stored record. */
interface PollableJob {
  status?: string;
  created_at?: number;
}

/** Jobs that are still worth polling: non-terminal, and not so old that the API has lost them. */
export function activeJobs<T extends PollableJob>(jobs: T[], now = Date.now()): T[] {
  return jobs.filter((job) => {
    if (isTerminalStatus(job.status)) return false;
    const createdMs = (job.created_at ?? 0) * 1000;
    if (!createdMs) return true;
    return now - createdMs < ROBOTS_STALE_JOB_MS;
  });
}

/**
 * Jobs the **entry itself** records as still running.
 *
 * Read from the stored value, so it costs nothing and is available before the Robots tab has
 * fetched anything — which is the point. Two things key off it, both in ADR-0013:
 *
 * - the editor-wide notice that publishing now will publish a job's *unfinished* state;
 * - starting the poll for an entry reopened while a job is in flight, without waiting for
 *   somebody to click the Robots tab.
 *
 * Bounded by the same staleness cut-off as `activeJobs`, so a record stuck at `processing` —
 * a job Mux purged, or a session that died mid-run — stops driving either of them after six
 * hours rather than nagging and polling forever.
 */
export function unfinishedJobRecords(
  value: MuxContentfulObject | undefined,
  now = Date.now()
): RobotsJobRecord[] {
  return activeJobs(value?.robotsJobs ?? [], now);
}
