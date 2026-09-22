import { useCallback, useMemo, useRef, useState } from 'react';
import { MuxApiService } from '../../util/muxApi';
import { RobotsDirectiveRun, RobotsDirectiveRunRecord } from '../../util/robotsTypes';

/**
 * The directive runs on this asset.
 *
 * Read per directive, because `GET /robots/v0/directives/{id}/runs` cannot filter by asset and
 * returns one page — so `subject_id` is the only narrowing there is, and the association between
 * a run and its directive exists only in the request that fetched it.
 */
export interface RobotsDirectiveRunsState {
  directiveRuns: RobotsDirectiveRun[];
  loadDirectiveRuns: () => Promise<void>;
  /** For the optimistic row a create adds, which is what arms the poll from the moment of a click. */
  addDirectiveRun: (run: RobotsDirectiveRun) => void;
}

export function useRobotsDirectiveRuns({
  muxApi,
  assetId,
  defaultDirectiveIds,
  recordedRuns,
  isMountedRef,
}: {
  muxApi?: MuxApiService;
  /** Required: the panel does not mount without an asset, and remounts when it changes. */
  assetId: string;
  defaultDirectiveIds: string[];
  /** Runs the entry itself records, so a directive dropped from the config is still polled. */
  recordedRuns?: RobotsDirectiveRunRecord[];
  isMountedRef: React.MutableRefObject<boolean>;
}): RobotsDirectiveRunsState {
  const [directiveRuns, setDirectiveRuns] = useState<RobotsDirectiveRun[]>([]);
  /** One pass at a time: overlapping passes resolve out of order and the loser wins. */
  const isLoadingRef = useRef(false);

  /** Directives this entry has actually seen a run from, whatever the config says today. */
  const recordedDirectiveIds = useMemo(
    () => (recordedRuns ?? []).map((run) => run.directiveId).filter(Boolean),
    [recordedRuns]
  );
  const liveDirectiveIds = useMemo(
    () => directiveRuns.map((run) => run.directive_id).filter((id): id is string => !!id),
    [directiveRuns]
  );

  /**
   * Every directive worth reading, as one stable string.
   *
   * Three sources, and **not** "every directive in the account". This used to union in the full
   * `listRobotsDirectives` result, which is fetched for the picker's *names* — so opening the tab
   * on an account with a hundred directives listed the runs of all hundred, one app-action round
   * trip each, to find the at most one or two that touch this asset. The runs endpoint cannot
   * filter by asset (ADR-0009), so the only way to keep that bounded is to ask fewer directives:
   * the ones configured to run at ingest, the ones this entry already records a run from, and the
   * ones currently on screen. A run started from this tab is recorded at creation, so it enters
   * the second set immediately and stays there even if an admin later drops it from the config.
   *
   * Sorted and joined because the identity matters: `loadDirectiveRuns` is a dependency of the
   * poll effect, so a set that merely re-orders would re-arm the 6 s timer before it ever fired.
   */
  const directiveIdKey = useMemo(
    () =>
      Array.from(new Set([...defaultDirectiveIds, ...recordedDirectiveIds, ...liveDirectiveIds]))
        .sort()
        .join(','),
    [defaultDirectiveIds, recordedDirectiveIds, liveDirectiveIds]
  );

  const loadDirectiveRuns = useCallback(async () => {
    if (!muxApi) return;
    const directiveIds = directiveIdKey ? directiveIdKey.split(',') : [];
    if (directiveIds.length === 0) return;
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      const results = await Promise.all(
        directiveIds.map(async (directiveId) => {
          try {
            const response = await muxApi.listRobotsDirectiveRuns(directiveId, { limit: 25 });
            const runs = (response.data ?? [])
              // `subject_id`, not `asset_id` — the webhook payload's name for the same value
              // matches nothing here, which is what left this table empty forever.
              .filter((run) => run.subject_id === assetId)
              .map((run) => ({ ...run, directive_id: directiveId }));

            // `node_states` is normally on the list response; this is the fallback. It is the
            // ownership signal — what says which jobs this directive dispatched — so without it a
            // directive's jobs are indistinguishable from a stranger's and never reach the entry.
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
              // A directive whose read failed keeps what was last known about it. Replacing it
              // with nothing reads as "the run finished", and the poll loop is gated on this list
              // — so one bad tick would end the loop.
              runs ?? previous.filter((run) => run.directive_id === directiveIds[index])
          )
          .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
      );
    } finally {
      isLoadingRef.current = false;
    }
  }, [muxApi, assetId, directiveIdKey, isMountedRef]);

  const addDirectiveRun = useCallback((run: RobotsDirectiveRun) => {
    setDirectiveRuns((previous) => [
      run,
      ...previous.filter((existing) => existing.run_id !== run.run_id),
    ]);
  }, []);

  return { directiveRuns, loadDirectiveRuns, addDirectiveRun };
}
