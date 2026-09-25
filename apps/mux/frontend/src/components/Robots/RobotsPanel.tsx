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
  ROBOTS_UNCONFIRMED_RECHECK_TICKS,
  RobotsPassthroughScope,
  RobotsUnconfirmedCreateError,
  RobotsUnconfirmedDirectiveRunError,
  activeDirectiveRuns,
  activeJobs,
  advisoryFromError,
  applyRobotsDirectiveRunsToValue,
  applyRobotsJobsToValue,
  cachedRobotsCapability,
  capabilityFromError,
  createRobotsDirectiveRunWithReconciliation,
  createRobotsJobWithReconciliation,
  directiveRunRefsFromJobs,
  findJobByPassthrough,
  findRecentDirectiveRun,
  jobIdsFromDirectiveRuns,
  jobsClaimedByEntry,
  recordRobotsDirectiveRun,
  unfinishedJobRecords,
} from '../../util/robots';
import {
  RobotsAdvisory,
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
import { directiveNamesById } from './useRobotsDirectiveNames';
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
 * **It shows more than it records.** The table lists every Robots job on the asset, dashboard ones
 * included; only jobs this plugin started are recorded on the entry. The newest summary and
 * moderation output is kept whoever started the job. See `isPluginOriginatedJob`, ADR-0005.
 *
 * **Neither Run button offers a retry it cannot justify.** Both creates are billable and neither
 * API has an idempotency key, so an unconfirmed outcome is reconciled against the server and,
 * failing that, held behind a guard. Both guards keep looking for what they are guarding against
 * for a bounded number of poll ticks and lift by finding it; neither ever lifts on a timer, and
 * the editor's "nothing is running" button stays the last resort. See ADR-0003.
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

type DirectiveListing =
  | { status: 'pending' }
  | { status: 'loaded'; directives: RobotsDirective[] }
  | { status: 'failed' };

/**
 * The asset gate, and it is a gate rather than an early return inside the panel.
 *
 * Everything this tab knows — the job list, the detail cache, the directive runs, the guard on an
 * unconfirmed create — is *about one Mux asset*. Returning early from a component that has already
 * run its hooks leaves all of that alive and invisible: with no asset the panel would hold a job
 * list for a video that no longer exists, and on the next asset it would hold the *previous* one's.
 * That second case is the reachable one. Pasting a different Mux asset ID replaces the whole value
 * (ADR-0001) without unmounting this panel, and the persist effect would then merge the old
 * asset's job records onto the new asset's entry — they carry a scope-matching `passthrough`, so
 * `isPluginOriginatedJob` accepts them.
 *
 * So: no asset, no component. And `key` on the asset id, so an asset swap is a remount and no
 * state can cross between two videos.
 */
const RobotsPanel: FC<RobotsPanelProps> = (props) => {
  const assetId = props.value?.assetId;

  if (!assetId) {
    return (
      <Box marginTop="spacingM">
        <Note variant="neutral">Add a video before running Robots workflows.</Note>
      </Box>
    );
  }

  return <RobotsPanelForAsset key={assetId} {...props} assetId={assetId} />;
};

const RobotsPanelForAsset: FC<RobotsPanelProps & { assetId: string }> = ({
  sdk,
  muxApi,
  value,
  isActive,
  updateField,
  resync,
  defaultDirectiveIds,
  assetId,
}) => {
  /**
   * The account's directives, for the picker. `failed` is the only state that falls back to the
   * configured ids: those come from installation parameters the web app handed this iframe when
   * it loaded, and can name a directive that has since been deleted or replaced (ADR-0009).
   */
  const [directiveListing, setDirectiveListing] = useState<DirectiveListing>({ status: 'pending' });
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
  /**
   * The same guard for the directive path, which spends more per click: the directive whose run
   * we could not confirm.
   *
   * Only the id, where the job guard also carries a passthrough — the runs endpoint takes none,
   * so there is no token to match and adoption is by asset plus recency. See ADR-0003.
   */
  const [pendingDirectiveRun, setPendingDirectiveRun] = useState<string | undefined>();
  /**
   * A limit a refused run ran into — units, today. Shown over the tab rather than instead of it,
   * because a cheaper run may still fit, and cleared by the next run Mux accepts: nothing else is
   * evidence either way, since only a create is checked against the units left.
   */
  const [advisory, setAdvisory] = useState<RobotsAdvisory | undefined>();
  /** Jobs this session created, whose record can lag the list — see `startedElsewhereIds`. */
  const [startedHereIds, setStartedHereIds] = useState<Set<string>>(new Set());

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
  /** Keep each per-refresh re-check from overlapping itself. One per guard: they look separately. */
  const isReconcilingCreateRef = useRef(false);
  const isReconcilingDirectiveRunRef = useRef(false);
  /** How many poll ticks each unresolved create has already been looked for on. */
  const createRecheckTicksRef = useRef(0);
  const directiveRecheckTicksRef = useRef(0);
  /** What the session already knew about Robots before this panel read anything. */
  const cachedCapabilityRef = useRef(cachedRobotsCapability());
  /** So the picker's names are fetched once per asset rather than on every activation. */
  const hasLoadedDirectivesRef = useRef(false);

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
    isLoading,
    setIsLoading,
    loadError,
    hasLoadedOnce,
    pollNonce,
    refresh,
    addCreatedJob,
  } = useRobotsJobList({ muxApi, assetId, onJobsFetched: resyncForFinishedJobs, isMountedRef });

  const {
    enrichedJobs,
    detailedJobIds,
    failedDetailIds,
    loadingDetailIds,
    pendingDetailIds,
    loadJobDetail,
    rememberJobDetail,
  } = useRobotsJobDetails(muxApi, jobs, isMountedRef);

  /** The runs this asset's jobs name, which is how a run started outside Contentful is found. */
  const runsNamedByJobs = useMemo(() => directiveRunRefsFromJobs(enrichedJobs), [enrichedJobs]);

  const {
    directiveRuns,
    claimingRuns,
    loadDirectiveRuns,
    addDirectiveRun,
    isPending: areDirectiveRunsPending,
  } = useRobotsDirectiveRuns({
    muxApi,
    assetId,
    defaultDirectiveIds,
    recordedRuns: value?.robotsDirectiveRuns,
    runsNamedByJobs,
    isMountedRef,
  });

  const loadDirectives = useCallback(async () => {
    if (!muxApi) return;
    try {
      const response = await muxApi.listRobotsDirectives({ limit: 100 });
      if (isMountedRef.current) {
        setDirectiveListing({ status: 'loaded', directives: response.data ?? [] });
      }
    } catch (error) {
      // Not worth blocking the tab over. A re-list that fails keeps the listing it had; only a
      // first one falls back to the ids configured at install.
      console.error('[robots] Could not list directives', error);
      if (isMountedRef.current) {
        setDirectiveListing((previous) =>
          previous.status === 'loaded' ? previous : { status: 'failed' }
        );
      }
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

  /**
   * First activation.
   *
   * Everything here is one app-action round trip, which is two CMA requests and a function that
   * may cold-start, so what matters is how many of them are *serialized*. There used to be three
   * in a row before the table could paint: a capability probe, then the job list, then the
   * directive list. Two of those are gone.
   *
   * The probe was `listRobotsJobs({ limit: 1 })` — the same call as the read below, with its
   * result thrown away. `refresh` already reports capability both ways (a successful list *is*
   * the check, and a 401/403 becomes the right `RobotsCapabilityNote`), so the real read answers
   * the question and the probe was a round trip spent learning something the next one would say.
   * The per-session cache it existed for is unchanged — `refresh` fills it now.
   *
   * What is left is one parallel pass: the job list and the directive runs together, and the
   * directive listing beside them once Robots is known to be on. An install that never enabled
   * Robots configures no directives, so neither of the other two makes a call there and the
   * non-enabled case still costs exactly one failed request. The table paints when the list
   * answers — the asset resync it sets off is not awaited (see `useRobotsJobList`).
   */
  useEffect(() => {
    // `isActive` is what keeps Robots free for editors who never open this tab — but an entry
    // reopened while a job it started is still running has to pick the loop back up on its own,
    // or a publish re-publishes the stale `processing` record. Only entries that already record
    // an unfinished job qualify, so an install that has never run Robots still fetches nothing.
    if ((!isActive && !hasUnfinishedJobs) || !muxApi || hasLoadedOnce) return;
    // Already answered, for this whole browser session: an account without the `robots:*` scope
    // does not acquire it between two entries, and asking again per entry is what the session
    // cache exists to prevent. This is the one place that reads it, because it is the only place
    // that would otherwise spend a request on a question with a known answer.
    //
    // From a ref captured at mount, not from the `capability` state. React 17 does not batch the
    // two `setState`s the fetch makes across its `await`, so `setCapability('enabled')` renders
    // before `setHasLoadedOnce(true)` does — and a `capability` dependency here would re-enter
    // this effect in that gap, with `hasLoadedOnce` still false, and fetch everything twice.
    if (cachedCapabilityRef.current && cachedCapabilityRef.current.state !== 'enabled') return;

    setIsLoading(true);
    void Promise.all([refresh({ silent: true }), loadDirectiveRuns()]);
  }, [
    isActive,
    hasUnfinishedJobs,
    muxApi,
    hasLoadedOnce,
    refresh,
    loadDirectiveRuns,
    setIsLoading,
  ]);

  useEffect(() => {
    // Only after the first load — otherwise this races it and both fetch the same runs.
    if (!isActive || capability?.state !== 'enabled' || !hasLoadedOnce) return;
    loadDirectiveRuns();
  }, [isActive, capability?.state, hasLoadedOnce, loadDirectiveRuns]);

  /**
   * The directive listing, for the picker.
   *
   * Off the path to the job table, and in parallel with it once Robots is known to be on: from
   * the session cache, or because directives are configured, which an install without Robots
   * never has. Otherwise it waits for the list read to answer, so a non-Robots install still
   * costs one request per session (ADR-0006).
   */
  const isKnownEnabled = capability?.state === 'enabled';
  const mayListDirectives = isKnownEnabled || (!capability && defaultDirectiveIds.length > 0);
  useEffect(() => {
    if (!isActive || !mayListDirectives) return;
    if (hasLoadedDirectivesRef.current) return;
    hasLoadedDirectivesRef.current = true;
    loadDirectives();
  }, [isActive, mayListDirectives, loadDirectives]);

  /**
   * Re-check an unconfirmed create against the job list, once per refresh.
   *
   * The guard has to have an exit that is not the button that duplicates the job. Keyed on
   * `pollNonce` so this is per refresh rather than per render, and bounded to a single pass: one
   * list call and at most five single-job reads, only while a create is genuinely unresolved.
   */
  useEffect(() => {
    if (!muxApi || !pendingCreate) return;
    if (isReconcilingCreateRef.current) return;
    isReconcilingCreateRef.current = true;

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
        isReconcilingCreateRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [muxApi, assetId, pendingCreate, pollNonce, scope, updateField, rememberJobDetail]);

  /**
   * The same re-check for an unconfirmed *directive* run — the effect above applied twice, not a
   * second design. Keyed on the same `pollNonce`, bounded by the same tick count, and the guard
   * it lifts is lifted the same way: by finding the run, never by a timer.
   *
   * One difference, and it is forced by the API: there is no `passthrough` on a run, so this
   * matches on directive + asset + a recent `started_at` instead of an exact token. That match is
   * `findRecentDirectiveRun`'s, unchanged and still fail-closed — a run with no `started_at` is
   * never adopted — because the cost of adopting a stranger's run is dropping the guard on a run
   * that never started. The adoption window is twice `ROBOTS_UNCONFIRMED_RECHECK_TICKS` worth of
   * ticks, so the looking stops well before a run started at the click could age out of it.
   */
  useEffect(() => {
    if (!muxApi || !pendingDirectiveRun) return;
    if (isReconcilingDirectiveRunRef.current) return;
    isReconcilingDirectiveRunRef.current = true;

    const directiveId = pendingDirectiveRun;
    let cancelled = false;
    (async () => {
      try {
        const found = await findRecentDirectiveRun(muxApi, directiveId, assetId, { attempts: 1 });
        if (cancelled || !isMountedRef.current || !found) return;

        try {
          // The same write `handleRunDirective` makes on the happy path, for the same reason:
          // it is the only place a run is added to the entry, and without it ownership of the
          // jobs this run dispatches expires with the newest 25 (ADR-0009). `save: true` because
          // the run is already billing.
          await updateField((current) => recordRobotsDirectiveRun(current, found), { save: true });
        } catch (writeError) {
          console.error(
            '[robots] Adopted an unconfirmed directive run but could not record it',
            writeError
          );
        }

        // The optimistic row, so the poll loop now has the run itself to stay alive for.
        addDirectiveRun(found);
        setPendingDirectiveRun(undefined);
      } finally {
        isReconcilingDirectiveRunRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [muxApi, assetId, pendingDirectiveRun, pollNonce, updateField, addDirectiveRun]);

  /** The newest reads, for the persist mutator to apply against. See the effect below. */
  const latestPersistInputRef = useRef<{
    jobs: RobotsJob[];
    runs: RobotsDirectiveRun[];
    claimingRuns: RobotsDirectiveRun[];
  }>({ jobs: [], runs: [], claimingRuns: [] });

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
    latestPersistInputRef.current = { jobs: enrichedJobs, runs: directiveRuns, claimingRuns };
    updateField((current) => {
      // Read at apply time, not at effect time. A write parked behind the publish gate re-applies
      // up to 90 s later, and `mergeJobRecords` lets an incoming record win — so a mutator holding
      // the snapshot from the tick it was queued on would write a stale `processing` over a stored
      // `completed`. The ref always holds the newest read, so a replay is idempotent.
      const { jobs: latestJobs, runs, claimingRuns: claiming } = latestPersistInputRef.current;
      // Runs first: their `node_states` name the jobs they dispatched, and the job pass reads
      // those ids back for ownership. This only ever *updates* runs the entry already records — a
      // run is added at creation and nowhere else — so every run it can see is safe to pass.
      const withRuns = applyRobotsDirectiveRunsToValue(current, runs);
      // Claiming is narrower: a run of a directive this entry has no tie to was started somewhere
      // else, and its jobs are shown, not recorded (ADR-0009).
      return applyRobotsJobsToValue(withRuns, latestJobs, jobIdsFromDirectiveRuns(claiming), {
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
  }, [enrichedJobs, directiveRuns, claimingRuns, updateField, scope]);

  const inFlight = useMemo(() => activeJobs(enrichedJobs), [enrichedJobs]);
  /**
   * Directive runs that may still dispatch more work.
   *
   * Not redundant with `inFlight`: a directive runs its workflows in sequence, so there is a
   * legitimate gap with zero non-terminal jobs between one finishing and the next starting.
   * Stopping there is what made mid-sequence jobs invisible until a reload.
   */
  const activeRuns = useMemo(() => activeDirectiveRuns(directiveRuns), [directiveRuns]);

  /**
   * Rows whose job the entry will not record, so each can say why. Read off the rule the persist
   * effect records by rather than off what is recorded: a job of ours is briefly unrecorded after
   * every create, and for up to 90 s behind the publish gate, and "started elsewhere" would be
   * false for it. The jobs this session created count as ours for the same reason.
   */
  const startedElsewhereIds = useMemo(() => {
    const claimed = new Set(
      jobsClaimedByEntry(value, enrichedJobs, jobIdsFromDirectiveRuns(claimingRuns), {
        scope,
        ownJobIds: startedHereIds,
      }).map((job) => job.id)
    );
    // Not said of a row whose ownership is still being read — its detail can carry our
    // passthrough, and the runs can claim it. Said a moment late rather than taken back.
    return new Set(
      enrichedJobs
        .filter(
          (job) => !claimed.has(job.id) && !pendingDetailIds.has(job.id) && !areDirectiveRunsPending
        )
        .map((job) => job.id)
    );
  }, [
    value?.robotsJobs,
    value?.robotsDirectiveRuns,
    enrichedJobs,
    claimingRuns,
    scope,
    startedHereIds,
    pendingDetailIds,
    areDirectiveRunsPending,
  ]);

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
    // The third reason to keep ticking, and the one that was missing. ADR-0003 promises an
    // unresolved create "re-checks the job list on every subsequent refresh" — but the re-check
    // effect is keyed on `pollNonce`, and `pollNonce` only advances when this loop calls
    // `refresh`. An unconfirmed create is exactly the case where nothing is in flight to arm the
    // loop, so the re-check ran once and then never again, and `runDisabledReason` — which
    // disables Run for *every* workflow, not just the one that was being created — stayed up for
    // the rest of the session. Reloading the entry was the only thing that cleared it.
    //
    // Bounded by a count of attempts rather than a clock, because ADR-0003's invariant is that
    // nothing time-based re-enables Run. What the bound ends is the *looking*; the guard itself
    // still only lifts by finding the job or by the editor saying nothing is running.
    //
    // Both guards, on the same terms. `pendingDirectiveRun` had the identical gap — its re-check
    // is keyed on the same `pollNonce`, so with nothing in flight it never ran either, and the
    // Run-directive button stayed disabled for the session. Smaller blast radius than the job
    // guard, same bug.
    const isRecheckingCreate =
      !!pendingCreate && createRecheckTicksRef.current < ROBOTS_UNCONFIRMED_RECHECK_TICKS;
    const isRecheckingDirectiveRun =
      !!pendingDirectiveRun && directiveRecheckTicksRef.current < ROBOTS_UNCONFIRMED_RECHECK_TICKS;
    if (
      inFlight.length === 0 &&
      activeRuns.length === 0 &&
      !isRecheckingCreate &&
      !isRecheckingDirectiveRun
    ) {
      return;
    }

    pollTimerRef.current = setTimeout(() => {
      if (pendingCreate) createRecheckTicksRef.current += 1;
      if (pendingDirectiveRun) directiveRecheckTicksRef.current += 1;
      // Ticks the nonce both re-checks key off, so it runs even on a directive-only tick. The
      // run list is not read here: the re-check effect reads it itself, and paying for both
      // would double what an unconfirmed run costs per tick.
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
    pendingCreate,
    pendingDirectiveRun,
    pollNonce,
    refresh,
    loadDirectiveRuns,
  ]);

  /**
   * What a refused create means beyond the run it refused. Never a capability: Mux refuses
   * `translate-audio` on the free plan while every other workflow runs, so a create is no answer
   * about the account. A refusal that could mean the account lost Robots asks the list read, which
   * is what decides that; one about units becomes the warning.
   */
  const noteRefusal = (error: MuxApiError) => {
    const refusedFor = advisoryFromError(error);
    if (refusedFor) setAdvisory(refusedFor);
    else if (capabilityFromError(error)) void refresh({ silent: true });
  };

  const handleRun = async (workflow: RobotsWorkflow, parameters: Record<string, unknown>) => {
    if (!muxApi) return;
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
      setStartedHereIds((previous) => new Set(previous).add(job.id));
      setAdvisory(undefined);

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
        createRecheckTicksRef.current = 0;
        setPendingCreate({ passthrough: error.passthrough, workflow: error.workflow });
        sdk.notifier.warning(error.message);
        await refresh({ silent: true });
      } else if (error instanceof MuxApiError) {
        sdk.notifier.error(error.message);
        noteRefusal(error);
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
    if (!muxApi || !selectedDirectiveId) return;
    // Not only the button's `isDisabled`: React processes state updates asynchronously, and two
    // clicks inside one frame would otherwise both fire a POST.
    if (isStartingDirectiveRun) return;
    setIsStartingDirectiveRun(true);
    const directiveId = selectedDirectiveId;

    try {
      const run = await createRobotsDirectiveRunWithReconciliation(muxApi, directiveId, assetId);
      if (!isMountedRef.current) return;
      setAdvisory(undefined);
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
        // A fresh budget of ticks to find the run on, the same as the job path.
        directiveRecheckTicksRef.current = 0;
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
      if (error instanceof MuxApiError) {
        sdk.notifier.error(error.message);
        noteRefusal(error);
      } else {
        sdk.notifier.error('Could not start this directive run.');
      }
    } finally {
      if (isMountedRef.current) setIsStartingDirectiveRun(false);
    }
  };

  // Before the skeleton, not after it. A capability that is already known to be unavailable — by
  // this panel's own read, or from the session cache a previous entry filled — is a final answer,
  // so there is nothing to wait for and the effect above does not fetch.
  if (capability && capability.state !== 'enabled') {
    return <RobotsCapabilityNote state={capability.state} termsUrl={capability.termsUrl} />;
  }

  // Nothing is known about the account yet, so no furniture: for most installs the answer is that
  // Robots is off and the tab is about to become a note. Once the session knows Robots is on, the
  // tab renders the moment it is opened, and only what is still being read says so. A tab nobody
  // has opened stays the inert placeholder either way.
  //
  // Not `&& isLoading`: effects run after render, so the first render with `isActive` true has not
  // started loading yet, and an empty job table would flash before the spinner.
  if (!hasLoadedOnce && !(isKnownEnabled && isActive)) {
    return (
      <Box marginTop="spacingM">
        <Skeleton.Container>
          <Skeleton.BodyText numberOfLines={4} />
        </Skeleton.Container>
      </Box>
    );
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

  const availableDirectives =
    directiveListing.status === 'loaded'
      ? directiveListing.directives
      : directiveListing.status === 'failed'
      ? defaultDirectiveIds.map((id) => ({ id, name: id } as RobotsDirective))
      : [];
  // A choice the latest listing no longer offers is no choice: running it would be a 404.
  const chosenDirectiveId = availableDirectives.some(
    (directive) => directive.id === selectedDirectiveId
  )
    ? selectedDirectiveId
    : '';
  const directivePrompt =
    directiveListing.status === 'pending'
      ? 'Loading directives…'
      : availableDirectives.length > 0
      ? 'Select a directive'
      : directiveListing.status === 'loaded'
      ? 'No directives in this Mux account'
      : 'Could not list directives';

  const directiveNames = directiveNamesById(
    directiveListing.status === 'loaded' ? directiveListing.directives : [],
    defaultDirectiveIds
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
            // The picker too: a directive created or deleted in Mux reaches it here, rather
            // than only on a reload.
            loadDirectives();
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

      {advisory && <RobotsCapabilityNote state={advisory} />}

      {/* A list that failed is not a list with nothing in it: the note above says what happened,
          and "No Robots jobs have run on this video yet" would be a claim nobody checked. */}
      {!(loadError && enrichedJobs.length === 0) && (
        <RobotsJobTable
          jobs={enrichedJobs}
          startedElsewhereIds={startedElsewhereIds}
          detailedJobIds={detailedJobIds}
          unreadableJobIds={failedDetailIds}
          onCancel={handleCancel}
          onViewOutput={setViewedJob}
          onLoadDetail={loadJobDetail}
          cancellingIds={cancellingIds}
          loadingDetailIds={loadingDetailIds}
          pendingDetailIds={pendingDetailIds}
          isLoading={!hasLoadedOnce}
        />
      )}

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
              aria-label="Directive"
              value={chosenDirectiveId}
              isDisabled={availableDirectives.length === 0}
              onChange={(event) =>
                setSelectedDirectiveId((event.target as HTMLSelectElement).value)
              }>
              <Select.Option value="">{directivePrompt}</Select.Option>
              {availableDirectives.map((directive) => (
                <Select.Option key={directive.id} value={directive.id}>
                  {directive.name || directive.id}
                </Select.Option>
              ))}
            </Select>
          </Box>
          <Button
            variant="secondary"
            isDisabled={
              !chosenDirectiveId || !!directiveRunDisabledReason || isStartingDirectiveRun
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
                {/* As on the job guard: explicit, informed, and not the only way out — the
                    re-check above resolves this by finding the run. */}
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

        <RobotsDirectiveRunTable
          runs={directiveRuns}
          directiveNames={directiveNames}
          isLoading={areDirectiveRunsPending}
        />
      </Box>

      <RobotsRunModal
        isShown={isRunModalShown}
        onClose={() => setIsRunModalShown(false)}
        onRun={handleRun}
        assetId={assetId}
        captions={captions}
        audioTracks={audioTracks}
        isAudioOnly={value?.audioOnly}
        duration={value?.is_live ? undefined : value?.duration}
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
