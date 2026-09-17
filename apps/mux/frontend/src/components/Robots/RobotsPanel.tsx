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
  Tooltip,
} from '@contentful/f36-components';
import { CycleIcon } from '@contentful/f36-icons';
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
  capabilityFromError,
  createRobotsDirectiveRunWithReconciliation,
  createRobotsJobWithReconciliation,
  findJobByPassthrough,
  jobIdsFromDirectiveRuns,
  recordRobotsDirectiveRun,
  resolveRobotsCapability,
  unfinishedJobRecords,
} from '../../util/robots';
import {
  RobotsDirective,
  RobotsDirectiveRun,
  RobotsJob,
  RobotsWorkflow,
} from '../../util/robotsTypes';
import { MuxContentfulObject, Track } from '../../util/types';
import ExternalLink from '../ExternalLink';
import RobotsCapabilityNote from './RobotsCapabilityNote';
import RobotsJobTable from './RobotsJobTable';
import RobotsRunModal from './RobotsRunModal';
import RobotsOutputViewer from './RobotsOutputViewer';
import RobotsDirectiveRunTable from './RobotsDirectiveRunTable';
import ApplyToEntryModal from './ApplyToEntryModal';
import { useRobotsDirectiveRuns } from './useRobotsDirectiveRuns';
import { useRobotsJobDetails } from './useRobotsJobDetails';
import { useRobotsJobList } from './useRobotsJobList';

/**
 * The Robots tab.
 *
 * **It does nothing until the tab is looked at.** `isActive` gates the first fetch, so opening an
 * entry costs no round trips for a feature the editor may never touch. It does *not* gate the poll
 * loop: switching to the Captions tab to wait for a job must not be what stops it being noticed.
 *
 * **It never writes the field directly.** Every change goes through `updateField`, the single
 * serialized write path on the App component, so this loop and the 500 ms asset poll cannot
 * clobber each other. See ADR-0001.
 *
 * **It shows more than it stores.** The table lists every Robots job on the asset, dashboard ones
 * included; only jobs this plugin started reach the entry. See `isPluginOriginatedJob`, ADR-0005.
 *
 * **Neither Run button offers a retry it cannot justify.** Both creates are billable and neither
 * API has an idempotency key, so an unconfirmed outcome is reconciled against the server and,
 * failing that, held behind a guard the editor dismisses by hand. See ADR-0003.
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

  const [directives, setDirectives] = useState<RobotsDirective[]>([]);
  const [selectedDirectiveId, setSelectedDirectiveId] = useState('');
  const [cancellingIds, setCancellingIds] = useState<string[]>([]);
  const [isRunModalShown, setIsRunModalShown] = useState(false);
  const [isApplyModalShown, setIsApplyModalShown] = useState(false);
  const [viewedJob, setViewedJob] = useState<RobotsJob | undefined>();
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isStartingDirectiveRun, setIsStartingDirectiveRun] = useState(false);
  /**
   * A create whose outcome Mux never confirmed: the passthrough it was stamped with, and the
   * workflow that passthrough belongs to — both, because resolving it means the single-job GET and
   * the list carries no passthrough to look up.
   *
   * Held until the job list positively resolves it, not until a timer expires: a cold-started
   * function can lose its caller *after* reaching Mux, so the job may be running and billing.
   */
  const [pendingCreate, setPendingCreate] = useState<
    { passthrough: string; workflow: RobotsWorkflow } | undefined
  >();
  /** The same guard for the directive path, which spends more per click. */
  const [pendingDirectiveRun, setPendingDirectiveRun] = useState<string | undefined>();

  const isMountedRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>();
  /** Completed jobs that have already triggered a resync. */
  const resyncedJobIdsRef = useRef<Set<string>>(new Set());
  /**
   * Jobs this session has seen running.
   *
   * What separates "a job finished while the editor was watching" from "this entry has finished
   * jobs in its history". Only the first should reload the player; the second is every time
   * anyone opens this tab on an old entry.
   */
  const seenRunningJobIdsRef = useRef<Set<string>>(new Set());
  /** Keeps the per-refresh re-check of an unconfirmed create from overlapping itself. */
  const isReconcilingRef = useRef(false);

  /**
   * Which install this entry is, for scoping the passthrough we stamp and for deciding whether one
   * we read back is ours.
   *
   * `ids.environment`, never `ids.environmentAlias`: an alias is repointable, and a scope that
   * moves under a running job would orphan it. An incomplete `ids` yields `undefined`, which means
   * "trust no passthrough", never "trust every passthrough".
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
   * A completed job may have changed the Mux asset, so the mirror is stale.
   *
   * Every workflow, not just the four that attach a track: `summarize` with `update_asset_meta`,
   * `find-best-thumbnails` with `update_asset_thumbnail` and `moderate` with
   * `on_flagged: delete_playback_ids` all write to the asset too.
   *
   * The player is only reloaded for a job that finished under the editor's nose — otherwise
   * opening this tab on an entry with job history would restart whatever they were watching.
   */
  const resyncForFinishedJobs = useCallback(
    async (fetched: RobotsJob[]) => {
      const needsResync = fetched.filter(
        (job) => job.status === 'completed' && !resyncedJobIdsRef.current.has(job.id)
      );
      const finishedWhileWatching = needsResync.some((job) =>
        seenRunningJobIdsRef.current.has(job.id)
      );
      for (const job of fetched) {
        if (job.status !== 'completed' && job.status !== 'errored' && job.status !== 'cancelled') {
          seenRunningJobIdsRef.current.add(job.id);
        }
      }
      if (needsResync.length === 0) return;
      for (const job of needsResync) resyncedJobIdsRef.current.add(job.id);
      await resync({ silent: true, skipPlayerResync: !finishedWhileWatching });
    },
    [resync]
  );

  const {
    jobs,
    capability,
    setCapability,
    isLoading,
    setIsLoading,
    loadError,
    hasLoadedOnce,
    setHasLoadedOnce,
    pollNonce,
    refresh,
    addCreatedJob,
  } = useRobotsJobList({ muxApi, assetId, onJobsFetched: resyncForFinishedJobs, isMountedRef });

  const {
    enrichedJobs,
    detailedJobIds,
    failedDetailIds,
    loadingDetailIds,
    loadJobDetail,
    rememberJobDetail,
  } = useRobotsJobDetails(muxApi, jobs, isMountedRef);

  const { directiveRuns, loadDirectiveRuns, addDirectiveRun } = useRobotsDirectiveRuns({
    muxApi,
    assetId,
    defaultDirectiveIds,
    directives,
    isMountedRef,
  });

  const loadDirectives = useCallback(async () => {
    if (!muxApi) return;
    try {
      const response = await muxApi.listRobotsDirectives({ limit: 100 });
      if (isMountedRef.current) setDirectives(response.data ?? []);
    } catch (error) {
      // Not worth blocking the tab over — ad-hoc runs fall back to the ids configured at install.
      console.error('[robots] Could not list directives', error);
    }
  }, [muxApi]);

  /**
   * Whether this entry already records a job that has not finished.
   *
   * Read from the stored value, so it costs nothing and is known on the first render — before
   * anything has been fetched, and without anybody opening this tab. See ADR-0013.
   */
  const hasUnfinishedJobs = useMemo(
    () => unfinishedJobRecords(value).length > 0,
    [value?.robotsJobs]
  );

  // First activation: resolve capability once per session, then load.
  useEffect(() => {
    // `isActive` is what keeps Robots free for editors who never open this tab — but an entry
    // reopened while a job it started is still running has to pick the loop back up on its own,
    // or a publish re-publishes the stale `processing` record. Only entries that already record
    // an unfinished job qualify, so an install that has never run Robots still fetches nothing.
    if ((!isActive && !hasUnfinishedJobs) || !muxApi || !assetId || hasLoadedOnce) return;
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
  }, [
    isActive,
    hasUnfinishedJobs,
    muxApi,
    assetId,
    hasLoadedOnce,
    refresh,
    loadDirectives,
    loadDirectiveRuns,
    setCapability,
    setHasLoadedOnce,
    setIsLoading,
  ]);

  useEffect(() => {
    // Only after the first load — otherwise this races it and both fetch the same runs.
    if (!isActive || capability?.state !== 'enabled' || !hasLoadedOnce) return;
    loadDirectiveRuns();
  }, [isActive, capability?.state, hasLoadedOnce, loadDirectiveRuns]);

  /**
   * Re-check an unconfirmed create against the job list, once per refresh.
   *
   * The guard has to have an exit that is not the button that duplicates the job. Keyed on
   * `pollNonce` so this is per refresh rather than per render, and bounded to a single pass: one
   * list call and at most five single-job reads, only while a create is genuinely unresolved.
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

        // Detail we have already paid for, so the background pass does not buy it again.
        rememberJobDetail(found);
        try {
          // `ownJobIds` rather than the passthrough: this job was matched byte-for-byte against a
          // string this session generated, which is a stronger claim than parsing one back out.
          // `save: true` because we have already paid for it — losing the record again to an
          // unsaved buffer repeats the failure this recovery exists for.
          await updateField(
            (current) =>
              applyRobotsJobsToValue(current, [found], undefined, {
                scope,
                ownJobIds: new Set([found.id]),
              }),
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
  }, [muxApi, assetId, pendingCreate, pollNonce, scope, updateField, rememberJobDetail]);

  /** The newest reads, for the persist mutator to apply against. See the effect below. */
  const latestPersistInputRef = useRef<{ jobs: RobotsJob[]; runs: RobotsDirectiveRun[] }>({
    jobs: [],
    runs: [],
  });

  /**
   * Persist whatever the latest read says.
   *
   * Deliberately separate from `refresh`. Ownership of a job a directive created server-side can
   * only be established from that directive's run, and the two lists arrive independently — so
   * doing this inside `refresh` made it order-dependent, and getting the order wrong was silent.
   *
   * Re-running is free when there is nothing new: `applyRobotsJobsToValue` hands back the identical
   * value and `updateField` drops writes that would change nothing.
   */
  useEffect(() => {
    if (enrichedJobs.length === 0 && directiveRuns.length === 0) return;
    latestPersistInputRef.current = { jobs: enrichedJobs, runs: directiveRuns };
    updateField((current) => {
      // Read at apply time, not at effect time. A write parked behind the publish gate re-applies
      // up to 90 s later, and `mergeJobRecords` lets an incoming record win — so a mutator holding
      // the snapshot from the tick it was queued on would write a stale `processing` over a stored
      // `completed`. The ref always holds the newest read, so a replay is idempotent.
      const { jobs: latestJobs, runs } = latestPersistInputRef.current;
      // Runs first: their `node_states` name the jobs they dispatched, and the job pass reads
      // those ids back for ownership. This only ever *updates* runs the entry already records — a
      // run is added at creation and nowhere else.
      const withRuns = applyRobotsDirectiveRunsToValue(current, runs);
      return applyRobotsJobsToValue(withRuns, latestJobs, jobIdsFromDirectiveRuns(runs), {
        // The prefix identifies the app, not the install, so it proves nothing on its own; the
        // scope segment is what says the job was started from this space, environment and entry.
        // Passing it lets a job we created but never managed to record be adopted when it
        // finishes, rather than billing forever as nobody's.
        //
        // Known limit: `passthrough` only exists on the single-job GET, which is only issued for
        // terminal jobs — so an orphan is adopted when it finishes, not while it runs.
        scope,
      });
    }).catch((error) => {
      // Not awaited: this runs on the poll loop and must not block it. A write parked behind the
      // publish gate and then dropped at unmount rejects, and the next poll re-derives it.
      console.warn('[robots] Could not persist the latest job state', error);
    });
  }, [enrichedJobs, directiveRuns, updateField, scope]);

  const inFlight = useMemo(() => activeJobs(enrichedJobs), [enrichedJobs]);
  /**
   * Directive runs that may still dispatch more work.
   *
   * Not redundant with `inFlight`: a directive runs its workflows in sequence, so there is a
   * legitimate gap with zero non-terminal jobs between one finishing and the next starting.
   * Stopping there is what made mid-sequence jobs invisible until a reload.
   */
  const activeRuns = useMemo(() => activeDirectiveRuns(directiveRuns), [directiveRuns]);

  /** Which rows the entry actually holds, so a dashboard job's row can say it is not stored. */
  const storedJobIds = useMemo(
    () => new Set((value?.robotsJobs ?? []).map((record) => record.id)),
    [value?.robotsJobs]
  );

  /**
   * Poll while anything is live — on any tab.
   *
   * `isActive` gates the *first* load, which is what keeps Robots free for editors who never open
   * this tab. Gating the loop as well stopped the thing the loop exists for: a completed job is
   * what triggers `resync`, and the natural thing to do after starting `edit-captions` is to go
   * and watch the Captions tab. The panel is `forceMount`ed for this same reason.
   */
  useEffect(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
    if (capability?.state !== 'enabled') return;
    if (!hasLoadedOnce) return;
    if (inFlight.length === 0 && activeRuns.length === 0) return;

    pollTimerRef.current = setTimeout(() => {
      refresh({ silent: true });
      // Re-read the runs only while one is live: it costs a call per directive, and it is also the
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

      // Recorded now, while we still hold the create response — the only moment ownership is
      // unambiguous, because the job *list* carries no passthrough. Caught separately on purpose:
      // the job is already billing, so a failed *write* must never be reported as a failed *run*.
      // `save: true` because `setValue` only reaches the web app's autosave, and closing the tab
      // inside that window orphans a job that is already charging.
      try {
        await updateField(
          (current) =>
            applyRobotsJobsToValue(current, [job], undefined, {
              scope,
              ownJobIds: new Set([job.id]),
            }),
          { save: true }
        );
      } catch (writeError) {
        console.error('[robots] Started a job but could not record it on the entry', writeError);
      }

      addCreatedJob(job);
      // We started it, so whatever it changes on the asset changed while the editor was here.
      // Recorded now rather than left to the first list read, which a fast job could beat.
      seenRunningJobIdsRef.current.add(job.id);
      sdk.notifier.success(`Started ${workflow}. This can take a few minutes.`);
    } catch (error) {
      if (!isMountedRef.current) return;
      if (error instanceof RobotsUnconfirmedCreateError) {
        // Not an error toast with a retry: the job may be running and billing.
        setPendingCreate({ passthrough: error.passthrough, workflow: error.workflow });
        sdk.notifier.warning(error.message);
        await refresh({ silent: true });
      } else if (error instanceof MuxApiError) {
        if (error.status === 401 || error.status === 403) {
          setCapability(capabilityFromError(error));
        }
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
   * The most expensive click in this tab — a directive dispatches several billable workflows in
   * sequence — so it mirrors `handleRun` exactly: reconcile an unknown outcome, record the run at
   * creation, and fall back to a guard rather than a retryable error.
   */
  const handleRunDirective = async () => {
    if (!muxApi || !assetId || !selectedDirectiveId) return;
    // Not only the button's `isDisabled`: React processes state updates asynchronously, and two
    // clicks inside one frame would otherwise both fire a POST.
    if (isStartingDirectiveRun) return;
    setIsStartingDirectiveRun(true);
    const directiveId = selectedDirectiveId;

    try {
      const run = await createRobotsDirectiveRunWithReconciliation(muxApi, directiveId, assetId);
      if (!isMountedRef.current) return;
      sdk.notifier.success('Directive run started.');

      // The only place a run is added to the entry. Without it, ownership of everything this run
      // dispatches depends on the run still being inside the newest 25 that `GET .../runs`
      // returns, and a busy directive pushes it out within hours. See ADR-0009.
      try {
        await updateField((current) => recordRobotsDirectiveRun(current, run), { save: true });
      } catch (writeError) {
        console.error(
          '[robots] Started a directive run but could not record it on the entry',
          writeError
        );
      }

      // Optimistic row, and what arms the poll loop from the moment of the click: `POST .../runs`
      // answers 202 before the run is necessarily visible in `GET .../runs`, so listing straight
      // afterwards can come back empty and leave the loop with nothing to stay alive for.
      addDirectiveRun(run);
      await refresh({ silent: true });
    } catch (error) {
      if (!isMountedRef.current) return;
      if (error instanceof RobotsUnconfirmedDirectiveRunError) {
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

  // Not `&& isLoading`: effects run after render, so the first render with `isActive` true has not
  // started loading yet, and an empty job table would flash before the spinner.
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

  // An asset queued for deletion at the next publish is not worth spending units on.
  const isAssetPendingDelete = !!value?.pendingActions?.delete?.some(
    (action) => action.type === 'asset' && action.id === assetId
  );

  // No permission gate. Anyone who can open this entry can spend Mux AI units, which differs from
  // the Sanity and Strapi plugins — the Contentful requirements never specified one, so it is an
  // open product question rather than an omission. A gate here would be cosmetic anyway:
  // `muxProxy` is a generic passthrough and cannot see which path it is proxying.
  const runDisabledReason = isAssetPendingDelete
    ? 'This video is marked for deletion at the next publish.'
    : pendingCreate
    ? 'A run started but Mux never confirmed it. Refresh to check whether it is already going — starting another could bill you twice.'
    : undefined;

  // Separate from the job guard because the two spends are separate: a workflow whose outcome is
  // unknown says nothing about whether a directive can safely be run.
  const directiveRunDisabledReason =
    runDisabledReason ??
    (pendingDirectiveRun
      ? 'A directive run started but Mux never confirmed it. Refresh to check whether it is already going — starting another could bill you several times over.'
      : undefined);

  // Not a spend guard like the two above — there is simply nothing to apply yet. It reads as a
  // reason rather than a boolean because it is what the tooltip says.
  const applyDisabledReason = value?.robotsOutputs?.summarize
    ? undefined
    : 'Run a Summarize workflow to apply its title, description and tags to this entry’s own fields.';

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
          {applyDisabledReason ? (
            // Rendered disabled rather than hidden: a feature that only appears once you have
            // already done the thing that enables it is a feature nobody discovers. The tooltip
            // says what it would do and what has to happen first, which is the same
            // disabled-with-a-reason pattern `TrackList` and `Mp4RenditionsList` use.
            <Tooltip content={applyDisabledReason} placement="bottom">
              <Button variant="secondary" isDisabled>
                Apply summary
              </Button>
            </Tooltip>
          ) : (
            <Button variant="secondary" onClick={() => setIsApplyModalShown(true)}>
              Apply summary
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
                {/* The escape hatch is explicit and informed, never automatic — and no longer the
                    only way out: the reconcile effect resolves the guard by finding the job. */}
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
          <ExternalLink href={`${ROBOTS_DOCS_URL}-directives`}>Author them in Mux</ExternalLink>.
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
        job={viewedJob && (enrichedJobs.find((job) => job.id === viewedJob.id) ?? viewedJob)}
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
