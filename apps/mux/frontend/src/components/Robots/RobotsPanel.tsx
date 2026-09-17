import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FieldExtensionSDK } from '@contentful/app-sdk';
import {
  Box,
  Button,
  Flex,
  Note,
  Select,
  Skeleton,
  Subheading,
  Text,
  TextLink,
} from '@contentful/f36-components';
import { CycleIcon, ExternalLinkIcon } from '@contentful/f36-icons';
import { MuxApiError, MuxApiService } from '../../util/muxApi';
import {
  ROBOTS_DOCS_URL,
  ROBOTS_POLL_INTERVAL_MS,
  RobotsPassthroughScope,
  RobotsUnconfirmedCreateError,
  RobotsUnconfirmedDirectiveRunError,
  activeDirectiveRuns,
  activeJobs,
  applyRobotsDirectiveRunsToValue,
  applyRobotsJobsToValue,
  cachedRobotsCapability,
  capabilityFromError,
  createRobotsDirectiveRunWithReconciliation,
  createRobotsJobWithReconciliation,
  findJobByPassthrough,
  jobIdsFromDirectiveRuns,
  jobsNeedingDetail,
  recordRobotsDirectiveRun,
  resolveRobotsCapability,
} from '../../util/robots';
import {
  RobotsCapability,
  RobotsDirective,
  RobotsDirectiveRun,
  RobotsJob,
  RobotsWorkflow,
} from '../../util/robotsTypes';
import { MuxContentfulObject, Track } from '../../util/types';
import RobotsCapabilityNote from './RobotsCapabilityNote';
import RobotsJobTable from './RobotsJobTable';
import RobotsRunModal from './RobotsRunModal';
import RobotsOutputViewer from './RobotsOutputViewer';
import RobotsDirectiveRunTable from './RobotsDirectiveRunTable';
import ApplyToEntryModal from './ApplyToEntryModal';

/**
 * The Robots tab.
 *
 * Two things worth knowing about how this is wired:
 *
 * **It does nothing until the tab is looked at.** `isActive` gates the first fetch, so opening an
 * entry costs no extra app-action round trips for a feature the editor may never touch — and
 * capability is resolved once per browser session, not once per asset. It does *not* gate the
 * poll loop: once a job is in flight, switching to the Captions tab to wait for it must not be
 * what stops it being noticed.
 *
 * **It never writes the field directly.** Every change goes through `updateField`, the single
 * serialized write path on the App component, so this loop and the 500 ms asset poll cannot
 * clobber each other.
 *
 * **It shows more than it stores.** The table lists every Robots job on the asset, including ones
 * run from the Mux dashboard. Only jobs this plugin started are written to the entry — see
 * `isPluginOriginatedJob`, and the note there on why a `contentful@` passthrough is only trusted
 * when it names this space, environment and entry.
 *
 * **Detail is read for the newest jobs only, and the column says so.** `units_consumed`, `outputs`
 * and `errors` exist only on the single-job GET, and reading every terminal job on a
 * long-running asset would be one app-action round trip each. So the background pass is capped
 * (`jobsNeedingDetail`), and the two ways past the cap are both driven by the editor: the Units
 * cell on an unread row offers one read, and opening the output modal hands its own fetch back
 * through `rememberJobDetail`.
 *
 * **Neither Run button ever offers a retry it cannot justify.** Both creates are billable and
 * neither API has an idempotency key, so an unconfirmed outcome is reconciled against the server
 * and, failing that, held behind a guard the editor has to dismiss by hand — see
 * `createRobotsJobWithReconciliation` and `createRobotsDirectiveRunWithReconciliation`.
 */

interface RobotsPanelProps {
  sdk: FieldExtensionSDK;
  muxApi?: MuxApiService;
  value?: MuxContentfulObject;
  /** True while this tab is the selected one. */
  isActive: boolean;
  updateField: (
    mutate: (current: MuxContentfulObject | undefined) => MuxContentfulObject | undefined,
    options?: { save?: boolean }
  ) => Promise<void>;
  /** Re-reads the Mux asset, for workflows that attach a track. */
  resync: (params?: { silent?: boolean; skipPlayerResync?: boolean }) => Promise<void>;
  /** Directives configured at install time, offered for ad-hoc runs. */
  defaultDirectiveIds: string[];
}

const RobotsPanel: FC<RobotsPanelProps> = ({
  sdk,
  muxApi,
  value,
  isActive,
  updateField,
  resync,
  defaultDirectiveIds,
}) => {
  const assetId = value?.assetId;

  const [capability, setCapability] = useState<RobotsCapability | undefined>(
    cachedRobotsCapability()
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [jobs, setJobs] = useState<RobotsJob[]>([]);
  const [directiveRuns, setDirectiveRuns] = useState<RobotsDirectiveRun[]>([]);
  const [directives, setDirectives] = useState<RobotsDirective[]>([]);
  const [selectedDirectiveId, setSelectedDirectiveId] = useState('');
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const [isRunModalShown, setIsRunModalShown] = useState(false);
  const [isApplyModalShown, setIsApplyModalShown] = useState(false);
  const [viewedJob, setViewedJob] = useState<RobotsJob | undefined>();
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isStartingDirectiveRun, setIsStartingDirectiveRun] = useState(false);
  /**
   * A create whose outcome Mux never confirmed: the `passthrough` it was stamped with, and the
   * workflow that passthrough belongs to.
   *
   * Both, because resolving it means `GET /robots/v0/jobs/{workflow}/{id}` — the list is a
   * six-field summary and carries no passthrough at all, so a passthrough with no workflow cannot
   * be looked up.
   *
   * Held until the job list positively resolves it, not until a timer expires. A cold-started
   * function can lose its caller *after* reaching Mux, so the job may be running and billing —
   * re-enabling Run on a timeout would be exactly the double-charge this is here to prevent.
   */
  const [pendingCreate, setPendingCreate] = useState<
    { passthrough: string; workflow: RobotsWorkflow } | undefined
  >();
  /** The same guard for the directive path, which spends more per click. */
  const [pendingDirectiveRun, setPendingDirectiveRun] = useState<string | undefined>();
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  /**
   * Bumped after every refresh attempt, successful or not.
   *
   * The poll effect keys off this rather than off `jobs`: a refresh that throws leaves `jobs`
   * untouched, so keying off the data alone means one transient network error silently ends the
   * poll loop until the editor hits Refresh by hand.
   */
  const [pollNonce, setPollNonce] = useState(0);
  /**
   * Full job objects, keyed by id, for the fields `GET /robots/v0/jobs` leaves out.
   *
   * The list is a six-field summary — `id`, `workflow`, `status`, `created_at`, `updated_at`,
   * `_links`. Everything the feature actually needs downstream (`outputs`, `units_consumed`,
   * `errors`, `passthrough`) only exists on `GET /robots/v0/jobs/{workflow}/{id}`. Terminal
   * details never change, so once fetched they are cached for the life of the component.
   */
  const [jobDetails, setJobDetails] = useState<Record<string, RobotsJob>>({});
  /**
   * Jobs whose detail read failed, so it is not retried on every poll tick. Separate from
   * `jobDetails` rather than a null sentinel in it, so nothing downstream has to treat "we know
   * this job has no detail" as a job object.
   */
  const [failedDetailIds, setFailedDetailIds] = useState<Set<string>>(new Set());
  /** Jobs with an on-demand detail read in flight, so a second click cannot start a second one. */
  const [loadingDetailIds, setLoadingDetailIds] = useState<string[]>([]);

  const isMountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** Guards the fetch against overlapping itself when a tick is slower than the interval. */
  const isFetchingRef = useRef(false);
  /** Tracks which completed jobs have already triggered a resync. */
  const resyncedJobIdsRef = useRef<Set<string>>(new Set());
  /**
   * Jobs this session has seen in a non-terminal state.
   *
   * What separates "a job finished while the editor was watching" from "this entry has finished
   * jobs in its history". Only the first should reload the player: the second is every time
   * anyone opens the Robots tab on an old entry, and reloading the player there would restart
   * whatever they were watching for no reason.
   */
  const seenRunningJobIdsRef = useRef<Set<string>>(new Set());
  /** Keeps the per-refresh re-check of an unconfirmed create from overlapping itself. */
  const isReconcilingRef = useRef(false);

  /**
   * Which install this entry is, for scoping the `passthrough` we stamp and for deciding whether
   * a passthrough we read back is ours.
   *
   * `ids.environment`, never `ids.environmentAlias`: an alias is repointable, and a scope that
   * moves under a running job would orphan it. Built defensively — an incomplete `ids` yields
   * `undefined`, which means "trust no passthrough", never "trust every passthrough".
   */
  const scope = useMemo<RobotsPassthroughScope | undefined>(() => {
    const ids = sdk?.ids;
    if (!ids?.space || !ids?.environment || !ids?.entry) return undefined;
    return { space: ids.space, environment: ids.environment, entry: ids.entry };
  }, [sdk?.ids?.space, sdk?.ids?.environment, sdk?.ids?.entry]);

  useEffect(
    () => () => {
      isMountedRef.current = false;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    },
    []
  );

  const captions = useMemo(() => (value?.captions ?? []) as Track[], [value?.captions]);
  const audioTracks = useMemo(() => (value?.audioTracks ?? []) as Track[], [value?.audioTracks]);

  /**
   * Reads the job list from the API and folds anything finished into the stored value.
   *
   * The list read is not optional and does not go away once records are persisted: jobs created
   * by a directive at upload, or from the Mux dashboard, were never seen by a browser, so a field
   * mirror is incomplete by construction.
   */
  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!muxApi || !assetId) return;
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      if (!options.silent) setIsLoading(true);

      try {
        const response = await muxApi.listRobotsJobs({ asset_id: assetId, limit: 100 });
        const fetched = response.data ?? [];
        if (!isMountedRef.current) return;

        setJobs(fetched);
        setLoadError(undefined);
        // A successful list *is* the capability check. Keep the identity stable when it has not
        // changed, so this does not re-render on every tick.
        setCapability((previous) =>
          previous?.state === 'enabled' ? previous : { state: 'enabled' }
        );

        // Note what is *not* here: an attempt to clear `pendingCreate` from this list. It used to
        // be `fetched.some((job) => job.passthrough === pending)`, which can never be true —
        // `GET /robots/v0/jobs` is a six-field summary and `job.passthrough` is always
        // `undefined` on it. So the guard could only ever be dismissed by the one button that
        // creates a duplicate. Resolving it needs the single-job GET, which is expensive enough
        // to belong in its own effect below.

        // A completed job may have changed the Mux asset, so the asset mirror is now stale.
        // Every workflow, not just the four that attach a track: `summarize` with
        // `update_asset_meta`, `find-best-thumbnails` with `update_asset_thumbnail` and
        // `moderate` with `on_flagged: delete_playback_ids` all write to the asset too, and
        // gating on track production left those three mirroring nothing. It is one GET, deduped
        // per job per session by `resyncedJobIdsRef`.
        const needsResync = fetched.filter(
          (job) => job.status === 'completed' && !resyncedJobIdsRef.current.has(job.id)
        );
        // A job that finished under the editor's nose, rather than one already finished the first
        // time this session looked. `edit-captions` and the other three track-producing workflows
        // change what the player should be loading, and the player only picks that up on
        // `reloadPlayer` — which `skipPlayerResync` suppressed, unconditionally, so a finished
        // caption edit needed an F5 to show up. Narrow, because the alternative is reloading the
        // player every time someone opens this tab on an entry with job history.
        const finishedWhileWatching = needsResync.some((job) =>
          seenRunningJobIdsRef.current.has(job.id)
        );
        for (const job of fetched) {
          if (job.status !== 'completed' && job.status !== 'errored' && job.status !== 'cancelled') {
            seenRunningJobIdsRef.current.add(job.id);
          }
        }
        if (needsResync.length > 0) {
          for (const job of needsResync) resyncedJobIdsRef.current.add(job.id);
          await resync({ silent: true, skipPlayerResync: !finishedWhileWatching });
        }
      } catch (error) {
        if (!isMountedRef.current) return;
        if (error instanceof MuxApiError && (error.status === 401 || error.status === 403)) {
          setCapability(capabilityFromError(error));
        } else {
          setLoadError(
            error instanceof Error ? error.message : 'Could not load Robots jobs for this video.'
          );
        }
      } finally {
        isFetchingRef.current = false;
        if (isMountedRef.current) {
          setIsLoading(false);
          setHasLoadedOnce(true);
          setPollNonce((previous) => previous + 1);
        }
      }
    },
    [muxApi, assetId, resync]
  );

  const loadDirectives = useCallback(async () => {
    if (!muxApi) return;
    try {
      const response = await muxApi.listRobotsDirectives({ limit: 100 });
      if (isMountedRef.current) setDirectives(response.data ?? []);
    } catch (error) {
      // A directive listing failure is not worth blocking the tab over — ad-hoc runs simply fall
      // back to the ids configured at install time.
      console.error('[robots] Could not list directives', error);
    }
  }, [muxApi]);

  const loadDirectiveRuns = useCallback(async () => {
    if (!muxApi || !assetId) return;
    const directiveIds = Array.from(
      new Set([...defaultDirectiveIds, ...directives.map((directive) => directive.id)])
    );
    if (directiveIds.length === 0) return;

    const results = await Promise.all(
      directiveIds.map(async (directiveId) => {
        try {
          const response = await muxApi.listRobotsDirectiveRuns(directiveId, { limit: 25 });
          const runs = (response.data ?? [])
            // `subject_id`, not `asset_id`. The API cannot filter runs by asset, so this is the
            // only narrowing there is — and matching on the webhook payload's name for the same
            // value silently matched nothing, which is what left the runs table empty forever.
            .filter((run) => run.subject_id === assetId)
            // The response never names its own directive, so the association only exists in the
            // request. The table's Directive column and the merge below both read it back.
            .map((run) => ({ ...run, directive_id: directiveId }));

          // `node_states` is on the list response, so this is a safety net rather than a normal
          // path. It stays because it is the ownership signal: it is what says which server-side
          // jobs this directive dispatched, and without it a directive's jobs are indistinguishable
          // from a stranger's and never reach the entry. Cheap to keep, expensive to be wrong about.
          return Promise.all(
            runs.map(async (run) => {
              if (run.node_states) return run;
              try {
                const full = await muxApi.getRobotsDirectiveRun(directiveId, run.run_id);
                return full.data ? { ...full.data, directive_id: directiveId } : run;
              } catch (error) {
                console.error(`[robots] Could not load directive run ${run.run_id}`, error);
                return run;
              }
            })
          );
        } catch (error) {
          console.error(`[robots] Could not list runs for directive ${directiveId}`, error);
          return undefined;
        }
      })
    );
    if (!isMountedRef.current) return;

    setDirectiveRuns((previous) =>
      results
        .flatMap(
          (runs, index) =>
            // A directive whose list read failed keeps whatever was last known about it. Replacing
            // it with nothing reads as "the run finished", and since the poll loop is gated on this
            // list, one bad tick would end the loop exactly the way an always-empty list did.
            runs ?? previous.filter((run) => run.directive_id === directiveIds[index])
        )
        .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
    );
  }, [muxApi, assetId, defaultDirectiveIds, directives]);

  // First activation: resolve capability once per session, then load.
  useEffect(() => {
    if (!isActive || !muxApi || !assetId || hasLoadedOnce) return;
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      const resolved = await resolveRobotsCapability(muxApi);
      if (cancelled || !isMountedRef.current) return;
      setCapability(resolved);
      if (resolved.state !== 'enabled') {
        setIsLoading(false);
        setHasLoadedOnce(true);
        return;
      }
      await Promise.all([refresh({ silent: true }), loadDirectiveRuns()]);
      // Directive *names*, for the picker. Cosmetic, and it widens which directives
      // `loadDirectiveRuns` looks at on its next pass, so it goes last.
      await loadDirectives();
    })();

    return () => {
      cancelled = true;
    };
  }, [isActive, muxApi, assetId, hasLoadedOnce, refresh, loadDirectives, loadDirectiveRuns]);

  useEffect(() => {
    // Only after the first load has been done by the effect above — otherwise this races it and
    // both fetch the same runs.
    if (!isActive || capability?.state !== 'enabled' || !hasLoadedOnce) return;
    loadDirectiveRuns();
  }, [isActive, capability?.state, hasLoadedOnce, loadDirectiveRuns]);

  /**
   * The jobs the rest of the panel works with: the list summary, enriched with whatever detail
   * has been fetched for each one.
   */
  const enrichedJobs = useMemo(
    () => jobs.map((job) => (jobDetails[job.id] ? { ...job, ...jobDetails[job.id] } : job)),
    [jobs, jobDetails]
  );

  /**
   * Fill in the fields the list omits, for every finished job on the asset.
   *
   * Covers jobs run outside the plugin too. They are shown in the table either way, and a row
   * whose Units and output are permanently blank looks like a bug — reading a job is free, and
   * whether a job goes *on the entry* is decided separately, in the persist effect below.
   *
   * Bounded on purpose: only terminal jobs (their detail is final and cacheable), only the newest
   * `window` of them, and only a few per pass so a video with a long history does not fire a
   * burst of app-action calls. The rest arrive on later passes.
   *
   * A fetch that fails is remembered as failed. Without that the id never enters `jobDetails` and
   * the effect retries it on every poll tick forever — a 404 on a purged job would loop for as
   * long as the entry stayed open.
   */
  useEffect(() => {
    if (!muxApi || jobs.length === 0) return;
    const attempted = new Set([...Object.keys(jobDetails), ...failedDetailIds]);
    const pending = jobsNeedingDetail(jobs, attempted);
    if (pending.length === 0) return;

    let cancelled = false;
    (async () => {
      const fetched = await Promise.all(
        pending.map(async (job) => {
          try {
            const response = await muxApi.getRobotsJob(job.workflow, job.id);
            return response.data ? ([job.id, response.data] as const) : ([job.id, null] as const);
          } catch (error) {
            console.error(`[robots] Could not load job ${job.id}`, error);
            return [job.id, null] as const;
          }
        })
      );
      if (cancelled || !isMountedRef.current) return;

      const loaded = fetched.filter(
        (entry): entry is readonly [string, RobotsJob] => entry[1] !== null
      );
      const failed = fetched.filter((entry) => entry[1] === null).map(([id]) => id);

      if (loaded.length > 0) {
        setJobDetails((previous) => ({ ...previous, ...Object.fromEntries(loaded) }));
      }
      if (failed.length > 0) {
        setFailedDetailIds((previous) => new Set([...previous, ...failed]));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [muxApi, jobs, jobDetails, failedDetailIds]);

  /**
   * Fill in one row's detail because somebody asked for it.
   *
   * The background pass above stops at `window` newest jobs and that ceiling stays — an asset with
   * two hundred dashboard jobs must not cost two hundred app-action round trips to open. What was
   * wrong was not the bound but what the bound looked like: rows past it rendered an em dash in
   * the Units column, indistinguishable from a job that consumed nothing. They now say
   * "Not loaded" and this is what that offers — one read, for one row, on a click. Request volume
   * tracks interest rather than history length.
   *
   * Failures are tombstoned in `failedDetailIds` exactly as the background pass does, so the row
   * settles on "Unavailable" instead of offering a click that will keep failing.
   */
  const loadJobDetail = useCallback(
    async (job: RobotsJob) => {
      if (!muxApi) return;
      // Already known, already failed, or already being read. Any of the three makes this a no-op.
      if (jobDetails[job.id] || failedDetailIds.has(job.id)) return;
      if (loadingDetailIds.includes(job.id)) return;

      setLoadingDetailIds((previous) => [...previous, job.id]);
      try {
        const response = await muxApi.getRobotsJob(job.workflow, job.id);
        if (!isMountedRef.current) return;
        if (response.data) {
          setJobDetails((previous) => ({ ...previous, [job.id]: response.data }));
        } else {
          setFailedDetailIds((previous) => new Set([...previous, job.id]));
        }
      } catch (error) {
        console.error(`[robots] Could not load job ${job.id}`, error);
        if (isMountedRef.current) {
          setFailedDetailIds((previous) => new Set([...previous, job.id]));
        }
      } finally {
        if (isMountedRef.current) {
          setLoadingDetailIds((previous) => previous.filter((id) => id !== job.id));
        }
      }
    },
    [muxApi, jobDetails, failedDetailIds, loadingDetailIds]
  );

  /**
   * Keep what the output modal already paid for.
   *
   * Opening a row past the detail window makes the viewer fetch the whole job — and until this,
   * that record died with the modal, so the row it came from went back to saying it knew nothing
   * about its own Units. The read has happened either way; the only question was whether anything
   * kept it.
   *
   * Never overwrites: a detail already in hand is at least as complete as this one, and replacing
   * it would change `jobDetails`' identity on every open for no gain.
   */
  const rememberJobDetail = useCallback((job: RobotsJob) => {
    setJobDetails((previous) => (previous[job.id] ? previous : { ...previous, [job.id]: job }));
  }, []);

  /** Rows whose full record is in hand, so a blank Units cell means Mux sent no count. */
  const detailedJobIds = useMemo(() => new Set(Object.keys(jobDetails)), [jobDetails]);

  /**
   * Re-check an unconfirmed create against the job list, once per refresh.
   *
   * ADR-0003 promised exactly this — "the `passthrough` is handed back to the caller, which keeps
   * it and re-checks the job list on **every** subsequent refresh" — and the code never did it.
   * `findJobByPassthrough` was called from one place, inside the create. The refresh path tried to
   * clear the guard with `fetched.some((job) => job.passthrough === pending)`, a predicate that
   * cannot be true because the list omits `passthrough`. The result: after one unconfirmed create,
   * Run stayed disabled for the whole session even once the job was listed and finished, and the
   * only way out was *"Nothing is running — let me try again"* — the one button that creates a
   * duplicate. A double-billing guard whose sole exit was double-billing.
   *
   * Keyed on `pollNonce`, which is bumped after every refresh attempt, so this is per refresh
   * rather than per render. Bounded on purpose: one pass (`attempts = 1`, no sleeps), which costs
   * one list call and at most five single-job reads, and only while a create is actually
   * unresolved — the common case is that this effect never runs at all.
   */
  useEffect(() => {
    if (!muxApi || !assetId || !pendingCreate) return;
    if (isReconcilingRef.current) return;
    isReconcilingRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const found = await findJobByPassthrough(
          muxApi,
          assetId,
          pendingCreate.workflow,
          pendingCreate.passthrough,
          1
        );
        if (cancelled || !isMountedRef.current || !found) return;

        // Detail we have already paid for. Cache it so the detail effect does not buy it again.
        setJobDetails((previous) =>
          previous[found.id] ? previous : { ...previous, [found.id]: found }
        );
        try {
          // `ownJobIds` rather than the passthrough: this job was matched byte-for-byte against a
          // string this session generated, which is a stronger claim than parsing one back out.
          await updateField(
            (current) =>
              applyRobotsJobsToValue(current, [found], undefined, {
                scope,
                ownJobIds: new Set([found.id]),
              }),
            // Adopting an orphan: we have already paid for this job, so losing the record again
            // to an unsaved buffer would repeat exactly the failure this recovery exists for.
            { save: true }
          );
        } catch (writeError) {
          console.error('[robots] Adopted an unconfirmed job but could not record it', writeError);
        }
        // Only now, with the job positively identified, does Run come back.
        setPendingCreate(undefined);
      } finally {
        isReconcilingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [muxApi, assetId, pendingCreate, pollNonce, scope, updateField]);

  /**
   * Persist whatever the latest read says, whenever either input changes.
   *
   * Deliberately separate from `refresh`. Ownership of a job created server-side by a directive
   * can only be established from that directive's run, and the two lists arrive independently —
   * so doing this inside `refresh` made it order-dependent, and getting the order wrong was
   * silent: a directive's jobs looked foreign on the one pass that would have stored them, and
   * `refresh` does not run again once every job is terminal.
   *
   * Re-running is free when there is nothing new: `applyRobotsJobsToValue` hands back the
   * identical value, and `updateField` skips writes that would change nothing.
   */
  useEffect(() => {
    if (enrichedJobs.length === 0 && directiveRuns.length === 0) return;
    updateField((current) => {
      // Runs first: their `node_states` name the jobs they dispatched, and the job pass below
      // reads those ids back for ownership. This only ever *updates* runs the entry already
      // records — a run is added at creation and nowhere else, so opening an entry whose asset
      // happens to have a directive run in the API's window cannot add a key to it.
      const withRuns = applyRobotsDirectiveRunsToValue(current, directiveRuns);
      return applyRobotsJobsToValue(
        withRuns,
        enrichedJobs,
        jobIdsFromDirectiveRuns(directiveRuns),
        {
          // These jobs came from the list, and their `passthrough` — where present at all — was
          // read by fetching detail for jobs we may not own. The prefix identifies the app, so it
          // proves nothing on its own; the scope segment is what says the job was started from
          // this space, environment and entry. Passing `scope` here is what lets a job we
          // created but never managed to record be adopted when it finishes, instead of billing
          // forever as nobody's.
          //
          // Known limit: `passthrough` only exists on the single-job GET, and that is only issued
          // for terminal jobs. So an orphan is adopted when it *finishes*, not while it runs.
          // Widening detail fetching to non-terminal jobs would cost a read per job per poll tick
          // and is deliberately not done here.
          scope,
        }
      );
    }).catch((error) => {
      // Deliberately not awaited — this runs on the poll loop and must not block it. But a write
      // parked behind the publish gate and then dropped at unmount now rejects, so without this
      // the poll loop would raise an unhandled rejection every time an entry is closed mid-publish.
      // Nothing is lost that the next poll will not re-derive, so a log is the whole response.
      console.warn('[robots] Could not persist the latest job state', error);
    });
  }, [enrichedJobs, directiveRuns, updateField, scope]);

  // Poll only while something is actually in flight, and only on the active tab.
  const inFlight = useMemo(() => activeJobs(enrichedJobs), [enrichedJobs]);

  /**
   * Which rows the entry actually holds. The table lists every job on the asset, but only the
   * ones this plugin started are written to the field — so a job run from the Mux dashboard shows
   * its status and units here and appears nowhere in the entry's data.
   */
  const storedJobIds = useMemo(
    () => new Set((value?.robotsJobs ?? []).map((record) => record.id)),
    [value?.robotsJobs]
  );
  /**
   * Directive runs that may still dispatch more work — see `activeDirectiveRuns` for the terminal
   * condition that keeps this from polling forever.
   *
   * Re-derived whenever the runs array changes identity, which `loadDirectiveRuns` guarantees on
   * every tick it runs, so the staleness cut-off is re-evaluated as the poll goes round.
   */
  const activeRuns = useMemo(() => activeDirectiveRuns(directiveRuns), [directiveRuns]);

  useEffect(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
    /**
     * Not gated on `isActive`, and that is the fix rather than an oversight.
     *
     * `isActive` still gates the *first* load, which is what keeps Robots free for editors who
     * never open the tab. But once something is in flight, stopping the loop on a tab switch
     * stopped the thing the loop exists for: a completed job is what triggers `resync`, and the
     * natural thing to do after starting an `edit-captions` run is to go and watch the Captions
     * tab for the new track — which is exactly where nothing was ever polled, so the track only
     * appeared after an F5 or a manual Resync. The panel is `forceMount`ed for this same class of
     * reason, so it is still here to do the work.
     *
     * The cost is bounded by the same terminal conditions as before: the loop only arms while a
     * job or directive run is live, and both reach a terminal state.
     */
    if (capability?.state !== 'enabled') return;
    if (!hasLoadedOnce) return;
    // Two independent reasons to keep going, and the second is not redundant: a directive runs its
    // workflows in sequence, so `inFlight` is legitimately empty between one finishing and the next
    // starting. Stopping there is what made mid-sequence jobs invisible until a page reload.
    if (inFlight.length === 0 && activeRuns.length === 0) return;

    pollTimerRef.current = setTimeout(() => {
      refresh({ silent: true });
      // Re-read the runs only while one is live. It costs a call per directive, and it is also the
      // only way an active run is ever seen to reach a terminal status — i.e. the only way this
      // loop stops.
      if (activeRuns.length > 0) loadDirectiveRuns();
    }, ROBOTS_POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [
    capability?.state,
    hasLoadedOnce,
    inFlight.length,
    activeRuns.length,
    pollNonce,
    refresh,
    loadDirectiveRuns,
  ]);

  const handleRun = async (workflow: RobotsWorkflow, parameters: Record<string, unknown>) => {
    if (!muxApi || !assetId) return;
    setIsStartingRun(true);
    try {
      const job = await createRobotsJobWithReconciliation(
        muxApi,
        workflow,
        assetId,
        parameters,
        scope
      );
      if (!isMountedRef.current) return;

      // Record it on the entry now, while we still hold the create response.
      //
      // This is the only moment ownership is unambiguous. The create response carries the
      // `passthrough` we stamped; the job *list* does not, so if the editor reloads before this
      // job finishes there is nothing left to tell it apart from one someone ran in the Mux
      // dashboard — and it would never be recorded at all. Writing it here also means the entry
      // reflects what the editor just did, immediately, which is what they expect after paying
      // for it.
      //
      // Caught separately on purpose: the job has already started and is already billing, so a
      // failed *write* must never be reported as a failed *run*. The record is recoverable — the
      // next poll carries the same `passthrough` — but telling the editor the run failed would
      // have them pay for it twice.
      try {
        // `ownJobIds`, not the passthrough: we are holding the response to our own POST, so the
        // claim needs no string to be parsed and holds even where `sdk.ids` gave us no scope.
        await updateField(
          (current) =>
            applyRobotsJobsToValue(current, [job], undefined, {
              scope,
              ownJobIds: new Set([job.id]),
            }),
            // `save: true`: this record is the only durable proof that a billable job is ours.
            // `setValue` hands the value to the web app's autosave and returns; closing the tab
            // inside that window loses the record and orphans a job that is already running and
            // already charging. Saving here costs one CMA write on a path the editor took
            // deliberately — cheap against paying twice.
          { save: true }
        );
      } catch (writeError) {
        console.error('[robots] Started a job but could not record it on the entry', writeError);
      }

      // Optimistic row, reconciled by the next list read.
      setJobs((previous) => [job, ...previous.filter((existing) => existing.id !== job.id)]);
      // We started it, so whatever it changes on the asset changed while the editor was here.
      // Recorded now rather than left to the first list read, which a fast job could beat.
      seenRunningJobIdsRef.current.add(job.id);
      sdk.notifier.success(`Started ${workflow}. This can take a few minutes.`);
    } catch (error) {
      if (!isMountedRef.current) return;
      if (error instanceof RobotsUnconfirmedCreateError) {
        // Deliberately not an error toast with a retry: the job may be running and billing.
        setPendingCreate({ passthrough: error.passthrough, workflow: error.workflow });
        sdk.notifier.warning(error.message);
        await refresh({ silent: true });
      } else if (error instanceof MuxApiError) {
        const derived = capabilityFromError(error);
        if (error.status === 401 || error.status === 403) setCapability(derived);
        sdk.notifier.error(error.message);
      } else {
        sdk.notifier.error('Could not start this Robots job.');
      }
    } finally {
      if (isMountedRef.current) setIsStartingRun(false);
    }
  };

  const handleCancel = async (job: RobotsJob) => {
    if (!muxApi) return;
    setCancellingIds((previous) => [...previous, job.id]);
    try {
      await muxApi.cancelRobotsJob(job.id);
      await refresh({ silent: true });
    } catch (error) {
      sdk.notifier.error(
        error instanceof MuxApiError ? error.message : 'Could not cancel this job.'
      );
    } finally {
      if (isMountedRef.current) {
        setCancellingIds((previous) => previous.filter((id) => id !== job.id));
      }
    }
  };

  /**
   * Starting a directive run is the most expensive click in this tab — a directive dispatches
   * several billable workflows in sequence — and until this it was the *least* protected one: a
   * plain `createRobotsDirectiveRun`, and an error toast on any failure. A cold-start timeout
   * means the run may have started and be billing, so that toast invited the editor to pay twice.
   *
   * Now it mirrors `handleRun` exactly: reconcile an unknown outcome against the server, record
   * the run on the entry at creation, and fall back to a guard rather than a retryable error.
   */
  const handleRunDirective = async () => {
    if (!muxApi || !assetId || !selectedDirectiveId) return;
    // Not only the button's `isDisabled`: React processes the state update asynchronously, and
    // two clicks inside one frame would otherwise both get through and fire two POSTs.
    if (isStartingDirectiveRun) return;
    setIsStartingDirectiveRun(true);
    const directiveId = selectedDirectiveId;

    try {
      const run = await createRobotsDirectiveRunWithReconciliation(muxApi, directiveId, assetId);
      if (!isMountedRef.current) return;
      sdk.notifier.success('Directive run started.');

      // Record it on the entry now, while we still hold the create response — the same reasoning
      // as `handleRun`, and the same separate try/catch so a failed *write* is never reported as a
      // failed *run*. This is also the only place a run is ever added to the entry: without it,
      // ownership of everything this run dispatches depends on the run still being inside the
      // newest 25 that `GET .../runs` returns, and a busy directive pushes it out within hours.
      try {
        await updateField((current) => recordRobotsDirectiveRun(current, run), { save: true });
      } catch (writeError) {
        console.error(
          '[robots] Started a directive run but could not record it on the entry',
          writeError
        );
      }

      // Optimistic row, reconciled by the next list read — and, more to the point, what arms the
      // poll loop from the moment of the click. `POST .../runs` answers 202 with the run's id and
      // `pending` before the run is necessarily visible in `GET .../runs`, so listing straight
      // afterwards can come back empty and leave the loop with nothing to stay alive for.
      setDirectiveRuns((previous) => [
        run,
        ...previous.filter((existing) => existing.run_id !== run.run_id),
      ]);

      await refresh({ silent: true });
    } catch (error) {
      if (!isMountedRef.current) return;
      if (error instanceof RobotsUnconfirmedDirectiveRunError) {
        // Same posture as the job path: the run may be going and billing, so no retry is offered.
        setPendingDirectiveRun(error.directiveId);
        sdk.notifier.warning(error.message);
        await loadDirectiveRuns();
        return;
      }
      if (error instanceof MuxApiError && error.status === 409) {
        sdk.notifier.warning('That directive is already running on this video.');
        await loadDirectiveRuns();
        return;
      }
      sdk.notifier.error(
        error instanceof MuxApiError ? error.message : 'Could not start this directive run.'
      );
    } finally {
      if (isMountedRef.current) setIsStartingDirectiveRun(false);
    }
  };

  if (!assetId) {
    return (
      <Box marginTop="spacingM">
        <Note variant="neutral">Add a video before running Robots workflows.</Note>
      </Box>
    );
  }

  // Not `&& isLoading`: effects run after render, so the first render with `isActive` true has
  // not started loading yet, and an empty job table would flash before the spinner.
  if (!hasLoadedOnce) {
    return (
      <Box marginTop="spacingM">
        <Skeleton.Container>
          <Skeleton.BodyText numberOfLines={4} />
        </Skeleton.Container>
      </Box>
    );
  }

  if (capability && capability.state !== 'enabled') {
    return <RobotsCapabilityNote state={capability.state} message={capability.message} />;
  }

  // An asset queued for deletion at the next publish is not worth spending units on: the work
  // would disappear along with the video. The existing "marked for deletion" notice already tells
  // the editor why the video looks the way it does; this stops them paying for it as well.
  const isAssetPendingDelete = !!value?.pendingActions?.delete?.some(
    (action) => action.type === 'asset' && action.id === assetId
  );

  // No permission gate. Anyone who can open this entry can spend Mux AI units, which is a
  // different posture from the Sanity and Strapi plugins for the same feature — both gate
  // directive runs behind roles. The Contentful requirements never specified one, so it is an
  // open product question rather than an omission here. Note that a gate in this component would
  // be cosmetic anyway: `muxProxy` is a generic passthrough and cannot see which path it is
  // proxying, so a real gate needs either a Robots-specific app action or path validation inside
  // the function.
  const runDisabledReason = isAssetPendingDelete
    ? 'This video is marked for deletion at the next publish.'
    : pendingCreate
    ? 'A run started but Mux never confirmed it. Refresh to check whether it is already going — starting another could bill you twice.'
    : undefined;

  // The directive guard is separate from the job guard because the two spends are separate: a
  // workflow whose outcome is unknown says nothing about whether a directive can safely be run.
  const directiveRunDisabledReason =
    runDisabledReason ??
    (pendingDirectiveRun
      ? 'A directive run started but Mux never confirmed it. Refresh to check whether it is already going — starting another could bill you several times over.'
      : undefined);

  const availableDirectives = directives.length
    ? directives
    : defaultDirectiveIds.map((id) => ({ id, name: id }) as RobotsDirective);

  const directiveNames = Object.fromEntries(
    availableDirectives.map((directive) => [directive.id, directive.name ?? directive.id])
  );

  return (
    <Box marginTop="spacingS">
      <Flex justifyContent="space-between" alignItems="center" marginBottom="spacingM">
        <Flex alignItems="center" gap="spacingS">
          <Button
            variant="primary"
            isDisabled={!!runDisabledReason || isStartingRun}
            title={runDisabledReason}
            onClick={() => setIsRunModalShown(true)}>
            Run a workflow
          </Button>
          {!!value?.robotsOutputs?.summarize && (
            <Button variant="secondary" onClick={() => setIsApplyModalShown(true)}>
              Apply to entry
            </Button>
          )}
        </Flex>
        <Button
          variant="transparent"
          startIcon={<CycleIcon />}
          isDisabled={isLoading}
          onClick={() => {
            refresh();
            loadDirectiveRuns();
          }}>
          Refresh
        </Button>
      </Flex>

      {runDisabledReason && (
        <Box marginBottom="spacingM">
          <Note variant={pendingCreate ? 'warning' : 'neutral'}>
            {runDisabledReason}
            {pendingCreate && (
              <Box marginTop="spacingS">
                {/* The escape hatch is explicit and informed, never automatic. If the job really
                    did not start, only the editor can tell us it is safe to try again. It is no
                    longer the *only* way out, either: the effect above resolves the guard by
                    finding the job, which is what ADR-0003 always said would happen. */}
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => setPendingCreate(undefined)}>
                  Nothing is running — let me try again
                </Button>
              </Box>
            )}
          </Note>
        </Box>
      )}

      {loadError && (
        <Box marginBottom="spacingM">
          <Note variant="negative">{loadError}</Note>
        </Box>
      )}

      <RobotsJobTable
        jobs={enrichedJobs}
        storedJobIds={storedJobIds}
        detailedJobIds={detailedJobIds}
        unreadableJobIds={failedDetailIds}
        onCancel={handleCancel}
        onViewOutput={setViewedJob}
        onLoadDetail={loadJobDetail}
        cancellingIds={cancellingIds}
        loadingDetailIds={loadingDetailIds}
      />

      <Box marginTop="spacingL">
        <Subheading marginBottom="spacingXs">Directives</Subheading>
        <Text fontColor="gray600">
          A directive runs several workflows in order.{' '}
          <TextLink
            href={`${ROBOTS_DOCS_URL}-directives`}
            target="_blank"
            rel="noopener noreferrer"
            icon={<ExternalLinkIcon />}
            alignIcon="end">
            Author them in Mux
          </TextLink>
          .
        </Text>
        <Flex gap="spacingS" alignItems="flex-end" marginTop="spacingM" marginBottom="spacingM">
          <Box style={{ minWidth: '18rem' }}>
            <Select
              id="robots-directive"
              value={selectedDirectiveId}
              onChange={(event) =>
                setSelectedDirectiveId((event.target as HTMLSelectElement).value)
              }>
              <Select.Option value="">Select a directive</Select.Option>
              {availableDirectives.map((directive) => (
                <Select.Option key={directive.id} value={directive.id}>
                  {directive.name ?? directive.id}
                </Select.Option>
              ))}
            </Select>
          </Box>
          <Button
            variant="secondary"
            // `isStartingDirectiveRun` matters as much as the guards: without it a double click
            // fired two POSTs and paid for two runs of the whole directive.
            isDisabled={
              !selectedDirectiveId || !!directiveRunDisabledReason || isStartingDirectiveRun
            }
            title={directiveRunDisabledReason}
            onClick={handleRunDirective}>
            Run directive
          </Button>
        </Flex>

        {pendingDirectiveRun && (
          <Box marginBottom="spacingM">
            <Note variant="warning" data-testid="robots-directive-run-unconfirmed">
              {directiveRunDisabledReason}
              <Box marginTop="spacingS">
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => setPendingDirectiveRun(undefined)}>
                  Nothing is running — let me try again
                </Button>
              </Box>
            </Note>
          </Box>
        )}

        <RobotsDirectiveRunTable runs={directiveRuns} directiveNames={directiveNames} />
      </Box>

      <RobotsRunModal
        isShown={isRunModalShown}
        onClose={() => setIsRunModalShown(false)}
        onRun={handleRun}
        assetId={assetId}
        captions={captions}
        audioTracks={audioTracks}
        isAudioOnly={value?.audioOnly}
        isRunDisabled={!!runDisabledReason || isStartingRun}
        runDisabledReason={runDisabledReason}
      />

      <RobotsOutputViewer
        job={viewedJob && (jobDetails[viewedJob.id] ?? viewedJob)}
        muxApi={muxApi}
        onLoaded={rememberJobDetail}
        onClose={() => setViewedJob(undefined)}
      />

      <ApplyToEntryModal
        isShown={isApplyModalShown}
        onClose={() => setIsApplyModalShown(false)}
        sdk={sdk}
        outputs={value?.robotsOutputs}
      />
    </Box>
  );
};

export default RobotsPanel;
