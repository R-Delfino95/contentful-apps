import { useCallback, useRef, useState } from 'react';
import { MuxApiError, MuxApiService } from '../../util/muxApi';
import { cachedRobotsCapability, capabilityFromError } from '../../util/robots';
import { RobotsCapability, RobotsJob } from '../../util/robotsTypes';

/**
 * The job list, and the capability the list read doubles as.
 *
 * The read is not optional and does not go away once records are on the entry: jobs created by a
 * directive at upload, or from the Mux dashboard, were never seen by a browser, so the field
 * mirror is incomplete by construction.
 */
export interface RobotsJobListState {
  jobs: RobotsJob[];
  capability?: RobotsCapability;
  setCapability: React.Dispatch<React.SetStateAction<RobotsCapability | undefined>>;
  isLoading: boolean;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loadError?: string;
  hasLoadedOnce: boolean;
  setHasLoadedOnce: React.Dispatch<React.SetStateAction<boolean>>;
  /**
   * Bumped after every refresh attempt, successful or not. The poll effect keys off this rather
   * than off `jobs`: a refresh that throws leaves `jobs` untouched, so keying off the data alone
   * means one transient network error silently ends the loop.
   */
  pollNonce: number;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  /** Adds a job this session just created, and keeps it until the list catches up. */
  addCreatedJob: (job: RobotsJob) => void;
}

export function useRobotsJobList({
  muxApi,
  assetId,
  onJobsFetched,
  isMountedRef,
}: {
  muxApi?: MuxApiService;
  assetId?: string;
  /** Runs inside the fetch, with the freshly read list, before it is stored. */
  onJobsFetched: (jobs: RobotsJob[]) => Promise<void> | void;
  isMountedRef: React.MutableRefObject<boolean>;
}): RobotsJobListState {
  const [capability, setCapability] = useState<RobotsCapability | undefined>(
    cachedRobotsCapability()
  );
  const [jobs, setJobs] = useState<RobotsJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);

  /** Guards the fetch against overlapping itself when a tick is slower than the interval. */
  const isFetchingRef = useRef(false);
  /**
   * A refresh asked for while one was already running. Dropping it silently is what made the
   * Refresh button do nothing at all when a poll tick happened to be in flight.
   */
  const queuedRefreshRef = useRef(false);
  /**
   * Jobs this session created that the list has not caught up with yet.
   *
   * `POST` answers before `GET /robots/v0/jobs` lists the job, so a refresh already in flight when
   * Run was clicked resolves afterwards and its wholesale replace would drop the optimistic row —
   * leaving nothing non-terminal for the poll effect to arm on.
   */
  const locallyCreatedRef = useRef<Map<string, RobotsJob>>(new Map());

  const refresh = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!muxApi || !assetId) return;
      if (isFetchingRef.current) {
        queuedRefreshRef.current = true;
        return;
      }
      isFetchingRef.current = true;
      if (!options.silent) setIsLoading(true);

      try {
        const response = await muxApi.listRobotsJobs({ asset_id: assetId, limit: 100 });
        const fetched = response.data ?? [];
        if (!isMountedRef.current) return;

        // Once the list knows a job, the API's copy wins and the local one is forgotten.
        const listed = new Set(fetched.map((job) => job.id));
        for (const id of locallyCreatedRef.current.keys()) {
          if (listed.has(id)) locallyCreatedRef.current.delete(id);
        }
        const pendingLocal = Array.from(locallyCreatedRef.current.values());
        setJobs(pendingLocal.length > 0 ? [...pendingLocal, ...fetched] : fetched);
        setLoadError(undefined);
        // A successful list *is* the capability check. Keep the identity stable when it has not
        // changed, so this does not re-render on every tick.
        setCapability((previous) =>
          previous?.state === 'enabled' ? previous : { state: 'enabled' }
        );

        await onJobsFetched(fetched);
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
          // Serve whoever asked while this pass was running, rather than dropping it.
          if (queuedRefreshRef.current) {
            queuedRefreshRef.current = false;
            void refreshRef.current?.({ silent: true });
          }
        }
      }
    },
    [muxApi, assetId, onJobsFetched, isMountedRef]
  );

  const refreshRef = useRef<typeof refresh>();
  refreshRef.current = refresh;

  const addCreatedJob = useCallback((job: RobotsJob) => {
    locallyCreatedRef.current.set(job.id, job);
    setJobs((previous) => [job, ...previous.filter((existing) => existing.id !== job.id)]);
  }, []);

  return {
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
  };
}
