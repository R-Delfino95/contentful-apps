import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MuxApiError } from './muxApi';
import {
  RobotsUnconfirmedCreateError,
  RobotsUnconfirmedDirectiveRunError,
  activeDirectiveRuns,
  activeJobs,
  applyRobotsDirectiveRunsToValue,
  applyRobotsJobsToValue,
  buildJobPassthrough,
  capabilityFromError,
  createRobotsDirectiveRunWithReconciliation,
  createRobotsJobWithReconciliation,
  findRecentDirectiveRun,
  isOwnPassthrough,
  isPluginOriginatedJob,
  jobIdsFromDirectiveRuns,
  jobsNeedingDetail,
  mergeDirectiveRunRecords,
  mergeJobRecords,
  mergeRobotsOutputs,
  parseJobPassthrough,
  recordRobotsDirectiveRun,
  resetRobotsCapabilityCache,
  resolveRobotsCapability,
} from './robots';
import { RobotsDirectiveRun, RobotsJob } from './robotsTypes';
import { MuxContentfulObject } from './types';

/** The install every fixture below belongs to. */
const scope = { space: 'space-1', environment: 'master', entry: 'entry-1' };

/** Ownership options exactly as the panel passes them. */
const ours = { scope };

/** A passthrough stamped by *this* install for *this* entry — the only kind that is trusted. */
const ourPassthrough = (requestId = 'abcdef0123456789') =>
  `contentful@2.0.0|${scope.space}:${scope.environment}:${scope.entry}|${requestId}`;

/** A job this plugin started — it carries our passthrough. */
const job = (overrides: Partial<RobotsJob> = {}): RobotsJob =>
  ({
    id: 'rjob_1',
    workflow: 'summarize',
    status: 'completed',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    passthrough: ourPassthrough('req-1-0000000000'),
    ...overrides,
  } as RobotsJob);

/** A job someone ran from the Mux dashboard against the same asset. */
const foreignJob = (overrides: Partial<RobotsJob> = {}): RobotsJob =>
  job({ id: 'rjob_dashboard', passthrough: undefined, ...overrides });

const baseValue = (extra: Partial<MuxContentfulObject> = {}): MuxContentfulObject =>
  ({ version: 3, assetId: 'asset-1', ready: true, ...extra } as MuxContentfulObject);

describe('buildJobPassthrough', () => {
  it('carries the plugin id and a unique request id', () => {
    const first = buildJobPassthrough(scope);
    const second = buildJobPassthrough(scope);

    expect(first.startsWith('contentful@')).toBe(true);
    expect(first).toContain('|');
    expect(first).not.toBe(second);
  });

  it('names the space, environment and entry, so the tag identifies the install', () => {
    const parsed = parseJobPassthrough(buildJobPassthrough(scope));
    expect(parsed?.scope).toEqual(scope);
  });

  it('uses a 16-character request id, which is what keeps it inside Mux\'s 255-char cap', () => {
    // The budget, with Contentful's 64-character id limit spent three times over:
    //   "contentful@" 11 + version 20 + "|" + space 64 + ":" + environment 64 + ":" + entry 64
    //   + "|" + request id 16  =  243.
    // A 36-character UUID in that last slot makes it 263 and the passthrough is rejected.
    const requestId = buildJobPassthrough(scope).split('|')[2];
    expect(requestId).toMatch(/^[0-9a-f]{16}$/);

    const longIds = {
      space: 'a'.repeat(64),
      environment: 'b'.repeat(64),
      entry: 'c'.repeat(64),
    };
    expect(buildJobPassthrough(longIds).length).toBeLessThanOrEqual(255);
  });

  it('falls back to the old two-segment form with no scope, which nothing trusts', () => {
    const legacy = buildJobPassthrough();
    expect(legacy.split('|')).toHaveLength(2);
    expect(parseJobPassthrough(legacy)?.scope).toBeUndefined();
  });
});

describe('parseJobPassthrough', () => {
  it('never throws, whatever it is handed', () => {
    for (const input of [
      undefined,
      null,
      42,
      {},
      '',
      'contentful@',
      'contentful@2.0.0|',
      'contentful@2.0.0||',
      'contentful@2.0.0|a:b|req',
      'contentful@2.0.0|a:b:c:d|req',
      'contentful@2.0.0|::|req',
      'someone-else|a:b:c|req',
    ]) {
      expect(() => parseJobPassthrough(input)).not.toThrow();
    }
  });

  it('reads nothing out of a passthrough that is not ours', () => {
    expect(parseJobPassthrough('mux-dashboard|whatever')).toBeUndefined();
  });

  it('reads the version but no scope from a malformed scope segment', () => {
    expect(parseJobPassthrough('contentful@2.0.0|only-two-parts:here|req')).toEqual({
      version: '2.0.0',
    });
  });
});

describe('isOwnPassthrough', () => {
  it('trusts a passthrough that names this exact install', () => {
    expect(isOwnPassthrough(buildJobPassthrough(scope), scope)).toBe(true);
  });

  it('refuses another space, environment or entry', () => {
    const stamped = buildJobPassthrough(scope);
    expect(isOwnPassthrough(stamped, { ...scope, space: 'space-2' })).toBe(false);
    expect(isOwnPassthrough(stamped, { ...scope, environment: 'staging' })).toBe(false);
    expect(isOwnPassthrough(stamped, { ...scope, entry: 'entry-2' })).toBe(false);
  });

  it('refuses the old two-segment format, which names only the app', () => {
    expect(isOwnPassthrough('contentful@2.0.0|abcdef0123456789', scope)).toBe(false);
  });

  it('trusts nothing at all when there is no scope to compare against', () => {
    // The default has to fail closed. "No identity" meaning "trust everything" would adopt every
    // Contentful install's jobs onto this entry, silently.
    expect(isOwnPassthrough(buildJobPassthrough(scope), undefined)).toBe(false);
  });

  it('refuses junk without throwing', () => {
    expect(isOwnPassthrough(undefined, scope)).toBe(false);
    expect(isOwnPassthrough('contentful@', scope)).toBe(false);
    expect(isOwnPassthrough(12345, scope)).toBe(false);
  });
});

describe('capabilityFromError', () => {
  it('reads units-exhausted from the forwarded error type, not the status', () => {
    const error = new MuxApiError('Limit reached', 403, 'robots_units_limit_exceeded');
    expect(capabilityFromError(error)).toEqual({
      state: 'units-exhausted',
      message: 'Limit reached',
    });
  });

  it('reads a missing scope from its own error type', () => {
    const error = new MuxApiError('Missing scope', 403, 'insufficient_scope');
    expect(capabilityFromError(error).state).toBe('scope-missing');
  });

  it('treats a 401 as a token problem', () => {
    expect(capabilityFromError(new MuxApiError('Unauthorized', 401)).state).toBe('scope-missing');
  });

  it('falls back to not-enabled for a bare 403', () => {
    expect(capabilityFromError(new MuxApiError('Forbidden', 403)).state).toBe('not-enabled');
  });

  it('falls back to not-enabled for a non-Mux failure', () => {
    expect(capabilityFromError(new Error('offline')).state).toBe('not-enabled');
  });
});

describe('resolveRobotsCapability', () => {
  beforeEach(() => resetRobotsCapabilityCache());

  it('resolves enabled from a successful list call', async () => {
    const muxApi = { listRobotsJobs: vi.fn(async () => ({ data: [] })) };
    expect(await resolveRobotsCapability(muxApi as never)).toEqual({ state: 'enabled' });
  });

  it('caches the answer, so opening ten entries costs one call', async () => {
    const listRobotsJobs = vi.fn(async () => ({ data: [] }));
    const muxApi = { listRobotsJobs } as never;

    await resolveRobotsCapability(muxApi);
    await resolveRobotsCapability(muxApi);
    await resolveRobotsCapability(muxApi);

    expect(listRobotsJobs).toHaveBeenCalledTimes(1);
  });

  it('caches a negative answer too', async () => {
    const listRobotsJobs = vi.fn(async () => {
      throw new MuxApiError('Not enabled', 403);
    });

    const first = await resolveRobotsCapability({ listRobotsJobs } as never);
    const second = await resolveRobotsCapability({ listRobotsJobs } as never);

    expect(first.state).toBe('not-enabled');
    expect(second).toBe(first);
    expect(listRobotsJobs).toHaveBeenCalledTimes(1);
  });
});

describe('createRobotsJobWithReconciliation', () => {
  it('stamps a passthrough on the created job', async () => {
    const createRobotsJob = vi.fn(async () => ({ data: job() }));
    await createRobotsJobWithReconciliation(
      { createRobotsJob } as never,
      'summarize',
      'asset-1',
      { asset_id: 'asset-1' }
    );

    const [, , passthrough] = createRobotsJob.mock.calls[0] as unknown[];
    expect(String(passthrough)).toContain('contentful@');
  });

  it('surfaces a failure Mux actually answered, without reconciling', async () => {
    const listRobotsJobs = vi.fn();
    const muxApi = {
      createRobotsJob: vi.fn(async () => {
        throw new MuxApiError('Limit reached', 403, 'robots_units_limit_exceeded');
      }),
      listRobotsJobs,
    } as never;

    await expect(
      createRobotsJobWithReconciliation(muxApi, 'summarize', 'asset-1', {})
    ).rejects.toBeInstanceOf(MuxApiError);
    // Nothing started, so there is nothing to reconcile against.
    expect(listRobotsJobs).not.toHaveBeenCalled();
  });

  it('recovers the job by passthrough when the app-action call timed out', async () => {
    // Modelled on the real API: the list is a six-field summary with no `passthrough`, so the
    // match can only be made by opening each candidate.
    let stamped = '';
    const listRobotsJobs = vi.fn(async () => ({
      data: [
        { id: 'rjob_older', workflow: 'summarize', status: 'completed', created_at: 1 },
        { id: 'rjob_started', workflow: 'summarize', status: 'processing', created_at: 99 },
      ],
    }));
    const getRobotsJob = vi.fn(async (_workflow: string, jobId: string) => ({
      data: {
        id: jobId,
        workflow: 'summarize',
        status: 'processing',
        passthrough: jobId === 'rjob_started' ? stamped : 'someone-else',
      },
    }));

    const muxApi = {
      createRobotsJob: vi.fn(async (_workflow, _parameters, passthrough: string) => {
        stamped = passthrough;
        // What `appActionCall.createWithResponse` throws after 15 polls: a plain Error, no status.
        throw new Error('The app action response is taking longer than expected to process.');
      }),
      listRobotsJobs,
      getRobotsJob,
    } as never;

    const recovered = await createRobotsJobWithReconciliation(muxApi, 'summarize', 'asset-1', {});

    expect(recovered.id).toBe('rjob_started');
    // Narrowed server-side by workflow, so we never open a candidate we know cannot match.
    expect(listRobotsJobs).toHaveBeenCalledWith(
      expect.objectContaining({ asset_id: 'asset-1', workflow: 'summarize' })
    );
    // Newest first, so the job we just created is the first one opened.
    expect(getRobotsJob.mock.calls[0][1]).toBe('rjob_started');
  });

  it('does not claim success when reconciliation finds no matching job', async () => {
    vi.useFakeTimers();
    const muxApi = {
      createRobotsJob: vi.fn(async () => {
        throw new Error('taking longer than expected');
      }),
      listRobotsJobs: vi.fn(async () => ({
        data: [{ id: 'rjob_other', workflow: 'summarize', status: 'completed', created_at: 1 }],
      })),
      // Somebody else's job on the same asset must not be mistaken for ours.
      getRobotsJob: vi.fn(async () => ({
        data: { id: 'rjob_other', workflow: 'summarize', status: 'completed', passthrough: 'x' },
      })),
    } as never;

    const pending = expect(
      createRobotsJobWithReconciliation(muxApi, 'summarize', 'asset-1', {})
    ).rejects.toBeInstanceOf(RobotsUnconfirmedCreateError);
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();
  });

  it('reports unknown rather than failed when reconciliation itself fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const muxApi = {
      createRobotsJob: vi.fn(async () => {
        throw new Error('taking longer than expected');
      }),
      listRobotsJobs: vi.fn(async () => {
        throw new Error('also offline');
      }),
    } as never;

    const pending = expect(
      createRobotsJobWithReconciliation(muxApi, 'summarize', 'asset-1', {})
    ).rejects.toBeInstanceOf(RobotsUnconfirmedCreateError);
    await vi.runAllTimersAsync();
    await pending;
    vi.useRealTimers();
  });

  it('hands the passthrough back so the caller can keep checking for that exact job', async () => {
    vi.useFakeTimers();
    let stamped = '';
    const muxApi = {
      createRobotsJob: vi.fn(async (_w, _p, passthrough: string) => {
        stamped = passthrough;
        throw new Error('taking longer than expected');
      }),
      listRobotsJobs: vi.fn(async () => ({ data: [] })),
    } as never;

    const pending = createRobotsJobWithReconciliation(muxApi, 'summarize', 'asset-1', {}).catch(
      (error) => error
    );
    await vi.runAllTimersAsync();
    const error = await pending;
    vi.useRealTimers();

    expect(error).toBeInstanceOf(RobotsUnconfirmedCreateError);
    expect((error as RobotsUnconfirmedCreateError).passthrough).toBe(stamped);
  });
});

describe('mergeJobRecords', () => {
  it('stores a job at every stage of its life, not only once it finishes', () => {
    // Recording from creation is what makes ownership durable: the list omits `passthrough`, so
    // an unrecorded job is indistinguishable from a stranger's after a reload.
    const merged = mergeJobRecords(undefined, [
      job({ id: 'a', status: 'processing' }),
      job({ id: 'b', status: 'completed' }),
    ]);
    expect(merged?.map((record) => record.id).sort()).toEqual(['a', 'b']);
  });

  it('returns the same reference when nothing changed, so no write happens', () => {
    const existing = mergeJobRecords(undefined, [job()]);
    expect(mergeJobRecords(existing, [job()])).toBe(existing);
  });

  it('adds an in-flight job rather than ignoring it', () => {
    const existing = mergeJobRecords(undefined, [job()]);
    const merged = mergeJobRecords(existing, [job({ id: 'c', status: 'pending' })]);
    expect(merged?.map((record) => record.id).sort()).toEqual(['c', 'rjob_1']);
  });

  it('keeps what only the richer response knew when a summary comes back thinner', () => {
    // The create response has `passthrough` and `units_consumed`; the list does not. Merging
    // rather than replacing is what stops a poll tick from erasing them.
    const existing = mergeJobRecords(undefined, [
      job({ status: 'processing', units_consumed: 12, passthrough: 'contentful@2.0.0|req-1' }),
    ]);
    const merged = mergeJobRecords(existing, [
      { id: 'rjob_1', workflow: 'summarize', status: 'completed' } as never,
    ]);

    expect(merged?.[0]).toMatchObject({
      status: 'completed',
      units_consumed: 12,
      passthrough: 'contentful@2.0.0|req-1',
    });
  });

  it('lets the API win when a stored record disagrees', () => {
    const existing = mergeJobRecords(undefined, [job({ status: 'completed' })]);
    const merged = mergeJobRecords(existing, [job({ status: 'errored', errors: { messages: ['nope'] } })]);
    expect(merged?.[0].status).toBe('errored');
    expect(merged?.[0].error).toBe('nope');
  });

  it('sorts newest first', () => {
    const merged = mergeJobRecords(undefined, [
      job({ id: 'old', created_at: 1 }),
      job({ id: 'new', created_at: 2 }),
    ]);
    expect(merged?.map((record) => record.id)).toEqual(['new', 'old']);
  });
});

describe('mergeRobotsOutputs', () => {
  it('persists summarize output with its provenance', () => {
    const merged = mergeRobotsOutputs(undefined, [
      job({ outputs: { title: 'A title', description: 'A description', tags: ['x', 'y'] } }),
    ]);

    expect(merged?.summarize).toEqual({
      jobId: 'rjob_1',
      completedAt: 1_700_000_100,
      title: 'A title',
      description: 'A description',
      tags: ['x', 'y'],
    });
  });

  it('persists moderation scores', () => {
    const merged = mergeRobotsOutputs(undefined, [
      job({
        id: 'rjob_mod',
        workflow: 'moderate',
        outputs: { exceeds_threshold: false, max_scores: { sexual: 0.1, violence: 0.2 } },
      }),
    ]);

    expect(merged?.moderate).toMatchObject({
      jobId: 'rjob_mod',
      exceedsThreshold: false,
      maxScores: { sexual: 0.1, violence: 0.2 },
    });
  });

  it('ignores workflows whose output is not persisted', () => {
    expect(
      mergeRobotsOutputs(undefined, [
        job({ workflow: 'find-scenes', outputs: { scenes: [{ start_ms: 0 }] } }),
      ])
    ).toBeUndefined();
  });

  it('ignores jobs that are not completed', () => {
    expect(
      mergeRobotsOutputs(undefined, [job({ status: 'processing', outputs: { title: 'A' } })])
    ).toBeUndefined();
  });

  it('returns the same reference when the same job comes back again', () => {
    const existing = mergeRobotsOutputs(undefined, [job({ outputs: { title: 'A' } })]);
    expect(mergeRobotsOutputs(existing, [job({ outputs: { title: 'A' } })])).toBe(existing);
  });

  it('lets a newer summarize run replace an older one', () => {
    const existing = mergeRobotsOutputs(undefined, [job({ outputs: { title: 'Old' } })]);
    const merged = mergeRobotsOutputs(existing, [
      job({ id: 'rjob_2', updated_at: 1_700_000_500, outputs: { title: 'New' } }),
    ]);
    expect(merged?.summarize?.title).toBe('New');
  });

  it('does not let a stale job overwrite a newer summary', () => {
    const existing = mergeRobotsOutputs(undefined, [
      job({ id: 'rjob_new', updated_at: 1_700_000_500, outputs: { title: 'New' } }),
    ]);
    const merged = mergeRobotsOutputs(existing, [
      job({ id: 'rjob_old', updated_at: 1_700_000_100, outputs: { title: 'Old' } }),
    ]);
    expect(merged?.summarize?.title).toBe('New');
  });
});

describe('applyRobotsJobsToValue', () => {
  it('returns the identical value when there is nothing new — no write, no "Changed" entry', () => {
    const value = baseValue();
    expect(applyRobotsJobsToValue(value, [], undefined, ours)).toBe(value);
    // A job that is not ours changes nothing, whatever its status.
    expect(
      applyRobotsJobsToValue(value, [foreignJob({ status: 'pending' })], undefined, ours)
    ).toBe(value);
  });

  it('returns the identical value when a stored job reports the same state again', () => {
    const stored = applyRobotsJobsToValue(
      baseValue(),
      [job({ status: 'processing' })],
      undefined,
      ours
    );
    expect(applyRobotsJobsToValue(stored, [job({ status: 'processing' })], undefined, ours)).toBe(
      stored
    );
  });

  it('leaves every other key alone when it does write', () => {
    const value = baseValue({
      captions: [{ type: 'text', id: 'track-1' } as never],
      pendingActions: { delete: [], create: [], update: [] },
    });

    const next = applyRobotsJobsToValue(value, [job({ outputs: { title: 'A' } })], undefined, ours);

    expect(next).not.toBe(value);
    expect(next?.captions).toBe(value.captions);
    expect(next?.pendingActions).toBe(value.pendingActions);
    expect(next?.robotsJobs).toHaveLength(1);
    expect(next?.robotsOutputs?.summarize?.title).toBe('A');
  });

  it('does nothing when the field has no value at all', () => {
    expect(applyRobotsJobsToValue(undefined, [job()], undefined, ours)).toBeUndefined();
  });
});

describe('activeJobs', () => {
  const now = 1_700_000_000_000;

  it('keeps only non-terminal jobs', () => {
    const jobs = [
      job({ id: 'a', status: 'pending', created_at: now / 1000 }),
      job({ id: 'b', status: 'processing', created_at: now / 1000 }),
      job({ id: 'c', status: 'completed' }),
      job({ id: 'd', status: 'errored' }),
      job({ id: 'e', status: 'cancelled' }),
    ];
    expect(activeJobs(jobs, now).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('stops waiting on a job the API seems to have lost', () => {
    const ancient = job({ status: 'processing', created_at: (now - 24 * 3600 * 1000) / 1000 });
    expect(activeJobs([ancient], now)).toHaveLength(0);
  });

  it('keeps a job with no creation timestamp rather than dropping it', () => {
    expect(activeJobs([job({ status: 'pending', created_at: undefined })], now)).toHaveLength(1);
  });
});


describe('activeDirectiveRuns', () => {
  const now = 1_700_000_000_000;

  /** The REST shape: `run_id` and `subject_id`, not the webhook's `id` and `asset_id`. */
  const run = (overrides: Partial<RobotsDirectiveRun> = {}): RobotsDirectiveRun => ({
    run_id: 'drvrun_1',
    subject_id: 'asset-1',
    status: 'running',
    started_at: now / 1000,
    ...overrides,
  });

  it('keeps a run that may still dispatch more workflows', () => {
    const runs = [
      run({ run_id: 'a', status: 'pending' }),
      run({ run_id: 'b', status: 'dispatching' }),
      run({ run_id: 'c', status: 'running' }),
      run({ run_id: 'd', status: 'waiting' }),
      run({ run_id: 'e', status: 'completed' }),
      run({ run_id: 'f', status: 'partial' }),
      run({ run_id: 'g', status: 'errored' }),
    ];
    expect(activeDirectiveRuns(runs, now).map((entry) => entry.run_id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('stops waiting on a run that is stuck, so the poll cannot bill forever', () => {
    const stuck = run({ started_at: (now - 24 * 3600 * 1000) / 1000 });
    expect(activeDirectiveRuns([stuck], now)).toHaveLength(0);
  });

  it('keeps a run with no start time, which is the row the create response seeds', () => {
    expect(activeDirectiveRuns([run({ status: 'pending', started_at: undefined })], now)).toHaveLength(
      1
    );
  });
});

describe('job ownership — what gets written to the entry', () => {
  it('recognises a job this plugin started', () => {
    expect(isPluginOriginatedJob(job(), undefined, undefined, ours)).toBe(true);
  });

  it('does not claim a job someone ran from the Mux dashboard', () => {
    expect(isPluginOriginatedJob(foreignJob(), undefined, undefined, ours)).toBe(false);
    expect(
      isPluginOriginatedJob(
        foreignJob({ passthrough: 'someone-elses-tag' }),
        undefined,
        undefined,
        ours
      )
    ).toBe(false);
  });

  it('takes the caller\'s word for a job it just created', () => {
    // The create path holds the response to its own POST. It should not have to prove ownership
    // by parsing a string back out — and this is what keeps the record being written even where
    // `sdk.ids` handed us no scope at all.
    expect(
      isPluginOriginatedJob(foreignJob(), undefined, undefined, {
        ownJobIds: new Set(['rjob_dashboard']),
      })
    ).toBe(true);
  });

  it('claims a job dispatched by a directive run we can see', () => {
    const runs = [
      {
        run_id: 'drvrun_1',
        node_states: [{ job_id: 'rjob_dashboard', workflow_name: 'summarize' }],
      },
    ];
    expect(isPluginOriginatedJob(foreignJob(), jobIdsFromDirectiveRuns(runs))).toBe(true);
  });

  it('collects job ids across every node of every run', () => {
    expect(
      jobIdsFromDirectiveRuns([
        { run_id: 'r1', node_states: [{ job_id: 'a' }, { job_id: 'b' }] },
        { run_id: 'r2', node_states: [{ job_id: 'c' }, {}] },
        { run_id: 'r3' },
      ])
    ).toEqual(new Set(['a', 'b', 'c']));
  });

  it('shows a dashboard job but never stores it', () => {
    const value = baseValue();
    // Displaying everything is what makes the list honest; the entry records only what was done
    // through Contentful.
    expect(
      applyRobotsJobsToValue(value, [foreignJob({ outputs: { title: 'A' } })], undefined, ours)
    ).toBe(value);
  });

  it('stores a directive job once its run identifies it as ours', () => {
    const value = baseValue();
    const runs = [{ run_id: 'drvrun_1', node_states: [{ job_id: 'rjob_dashboard' }] }];

    const next = applyRobotsJobsToValue(
      value,
      [foreignJob({ outputs: { title: 'Automated' } })],
      jobIdsFromDirectiveRuns(runs)
    );

    expect(next).not.toBe(value);
    expect(next?.robotsOutputs?.summarize?.title).toBe('Automated');
  });

  it('keeps a stored record the API no longer returns', () => {
    // Robots purges jobs after 30 days, and a job deleted upstream must not vanish from the
    // entry: once a run finished, that is a fact about this entry's history.
    const withRecord = applyRobotsJobsToValue(baseValue(), [job()], undefined, ours);
    expect(withRecord?.robotsJobs).toHaveLength(1);

    const afterPurge = applyRobotsJobsToValue(withRecord, [], undefined, ours);
    expect(afterPurge?.robotsJobs).toHaveLength(1);
    expect(afterPurge).toBe(withRecord);
  });

  it('keeps a stored output after the job that produced it is gone', () => {
    const withOutput = applyRobotsJobsToValue(
      baseValue(),
      [job({ outputs: { title: 'Kept' } })],
      undefined,
      ours
    );
    const afterPurge = applyRobotsJobsToValue(withOutput, [], undefined, ours);
    expect(afterPurge?.robotsOutputs?.summarize?.title).toBe('Kept');
  });
});

describe('the shape the list endpoint actually returns', () => {
  /**
   * `GET /robots/v0/jobs` returns a summary per job: no `outputs`, and — the part that broke
   * persistence — no `passthrough`. Every other fixture in this file hand-supplies both, which is
   * precisely why the original implementation passed its tests and stored nothing in production.
   */
  const summaryJob = (overrides: Partial<RobotsJob> = {}): RobotsJob =>
    ({
      id: 'rjob_summary',
      workflow: 'ask-questions',
      status: 'completed',
      created_at: 1_700_000_000,
      updated_at: 1_700_000_100,
      ...overrides,
    } as RobotsJob);

  it('records a job the entry already knows about, whatever the list omits', () => {
    // First contact: the app started this job, so it was recorded at create time.
    const value = baseValue({
      robotsJobs: [{ id: 'rjob_summary', workflow: 'ask-questions', status: 'processing' }],
    });

    // Later poll: the same job comes back as a summary with no passthrough at all.
    const next = applyRobotsJobsToValue(value, [summaryJob()]);

    expect(next).not.toBe(value);
    expect(next?.robotsJobs).toHaveLength(1);
    expect(next?.robotsJobs?.[0].status).toBe('completed');
  });

  it('treats a job already on the entry as ours for good', () => {
    expect(
      isPluginOriginatedJob(summaryJob(), undefined, new Set(['rjob_summary']))
    ).toBe(true);
  });

  it('still ignores a summary job nothing has ever claimed', () => {
    const value = baseValue();
    expect(applyRobotsJobsToValue(value, [summaryJob()])).toBe(value);
  });

  it('records a job we just created, before it has finished', () => {
    const created = summaryJob({
      id: 'rjob_new',
      status: 'pending',
      passthrough: ourPassthrough('req-9-0000000000'),
    });

    const next = applyRobotsJobsToValue(baseValue(), [created], undefined, ours);

    expect(next?.robotsJobs).toEqual([
      expect.objectContaining({ id: 'rjob_new', status: 'pending' }),
    ]);
  });

  it('carries a stored job through a poll that reports no change', () => {
    const first = applyRobotsJobsToValue(
      baseValue(),
      [summaryJob({ status: 'pending', passthrough: ourPassthrough('req-9-0000000000') })],
      undefined,
      ours
    );
    const second = applyRobotsJobsToValue(first, [summaryJob({ status: 'pending' })], undefined, ours);
    expect(second).toBe(first);
  });
});


describe('jobsNeedingDetail', () => {
  it('asks for detail on finished jobs only', () => {
    const jobs = [
      { id: 'a', workflow: 'summarize', status: 'completed' },
      { id: 'b', workflow: 'summarize', status: 'processing' },
      { id: 'c', workflow: 'summarize', status: 'errored' },
    ] as never as RobotsJob[];

    expect(jobsNeedingDetail(jobs, new Set()).map((j) => j.id).sort()).toEqual(['a', 'c']);
  });

  it('never asks twice for the same job', () => {
    const jobs = [{ id: 'a', workflow: 'summarize', status: 'completed' }] as never as RobotsJob[];
    expect(jobsNeedingDetail(jobs, new Set(['a']))).toEqual([]);
  });

  it('fetches detail for jobs run outside the plugin too', () => {
    // Reading a job costs nothing and charges nobody, and a dashboard job with a permanently
    // blank Units column and no output looks broken. Ownership is a persistence rule, enforced
    // in `applyRobotsJobsToValue` — not a reason to leave a visible row half-rendered.
    const foreign = [
      { id: 'a', workflow: 'summarize', status: 'completed', passthrough: 'someone-else' },
    ] as never as RobotsJob[];

    expect(jobsNeedingDetail(foreign, new Set()).map((j) => j.id)).toEqual(['a']);
  });

  it('bounds the burst, newest first', () => {
    const jobs = Array.from({ length: 12 }, (_, index) => ({
      id: `job-${index}`,
      workflow: 'summarize',
      status: 'completed',
      created_at: index,
    })) as never as RobotsJob[];

    const picked = jobsNeedingDetail(jobs, new Set(), { limit: 3 });
    expect(picked.map((j) => j.id)).toEqual(['job-11', 'job-10', 'job-9']);
  });

  it('will not look further back than the window, however many passes it takes', () => {
    // The bound that matters now that every terminal job is a candidate: an asset with a long
    // dashboard history must not turn into one detail read per job.
    const jobs = Array.from({ length: 50 }, (_, index) => ({
      id: `job-${index}`,
      workflow: 'summarize',
      status: 'completed',
      created_at: index,
    })) as never as RobotsJob[];

    const attempted = new Set<string>();
    for (let pass = 0; pass < 20; pass += 1) {
      for (const job of jobsNeedingDetail(jobs, attempted, { window: 5 })) attempted.add(job.id);
    }

    expect([...attempted].sort()).toEqual(['job-45', 'job-46', 'job-47', 'job-48', 'job-49']);
  });

  it('does not mutate the caller\'s array', () => {
    const jobs = [
      { id: 'old', workflow: 'summarize', status: 'completed', created_at: 1 },
      { id: 'new', workflow: 'summarize', status: 'completed', created_at: 2 },
    ] as never as RobotsJob[];

    jobsNeedingDetail(jobs, new Set());
    expect(jobs.map((j) => j.id)).toEqual(['old', 'new']);
  });
});


/**
 * Ownership on the polling path, which is where the scope segment earns its place.
 *
 * The polling path fetches detail for every terminal job on the asset — including jobs it does
 * not own — so it reads `passthrough` values it has no claim to. The old answer was
 * `trustPassthrough: false`: ignore the tag entirely. Safe, and expensive — a job this install
 * created but never managed to record could then never be claimed by anything, so it ran, it
 * billed, and it belonged to nobody. The scope segment makes the tag install-specific, so that
 * job comes home and a stranger's still does not.
 */
describe('applyRobotsJobsToValue — ownership from a scoped passthrough', () => {
  const value = () => ({ assetId: 'asset-1', version: 3 }) as never as MuxContentfulObject;

  const listed = (passthrough?: string, id = 'rjob_listed') =>
    [
      { id, workflow: 'summarize', status: 'completed', passthrough },
    ] as never as RobotsJob[];

  it('adopts an orphan of ours, which nothing else could ever claim', () => {
    // The page was closed during the cold-start window, so the create was never recorded. Before
    // the scope segment this job was unclaimable for good.
    const next = applyRobotsJobsToValue(value(), listed(ourPassthrough()), undefined, ours);
    expect(next?.robotsJobs?.map((record) => record.id)).toEqual(['rjob_listed']);
  });

  it('refuses another Contentful install pointed at the same Mux account', () => {
    const foreign = `contentful@2.0.0|other-space:master:other-entry|0123456789abcdef`;
    expect(applyRobotsJobsToValue(value(), listed(foreign), undefined, ours)).toEqual(value());
  });

  it('refuses another entry in this very space and environment', () => {
    const sibling = `contentful@2.0.0|${scope.space}:${scope.environment}:entry-2|0123456789abcdef`;
    expect(applyRobotsJobsToValue(value(), listed(sibling), undefined, ours)).toEqual(value());
  });

  it('refuses a pre-scope passthrough, exactly as trustPassthrough: false did', () => {
    // Not a regression: any pre-change job of ours is already recorded on the entry, which is a
    // stronger signal, and a pre-change orphan was already lost.
    const legacy = 'contentful@2.0.0|req-from-before-the-scope';
    expect(applyRobotsJobsToValue(value(), listed(legacy), undefined, ours)).toEqual(value());
  });

  it('trusts nothing when there is no identity, rather than everything', () => {
    expect(applyRobotsJobsToValue(value(), listed(ourPassthrough()))).toEqual(value());
    expect(applyRobotsJobsToValue(value(), listed(ourPassthrough()), undefined, {})).toEqual(
      value()
    );
  });

  it('still records a job the entry already knows about', () => {
    const withRecord = {
      assetId: 'asset-1',
      version: 4,
      robotsJobs: [{ id: 'rjob_ours', workflow: 'summarize', status: 'pending' }],
    } as never as MuxContentfulObject;

    const next = applyRobotsJobsToValue(
      withRecord,
      [{ id: 'rjob_ours', workflow: 'summarize', status: 'completed' }] as never as RobotsJob[],
      undefined,
      ours
    );

    expect(next?.robotsJobs?.[0].status).toBe('completed');
  });

  it('still records a job a directive run on this asset dispatched', () => {
    const next = applyRobotsJobsToValue(
      value(),
      [{ id: 'rjob_directive', workflow: 'summarize', status: 'completed' }] as never as RobotsJob[],
      new Set(['rjob_directive']),
      ours
    );

    expect(next?.robotsJobs?.map((r) => r.id)).toEqual(['rjob_directive']);
  });
});

/**
 * Directive runs recorded on the entry.
 *
 * Before this, a directive's jobs were claimed only by matching them against a *freshly listed*
 * run: `GET /robots/v0/directives/{id}/runs` capped at 25, filtered client-side because the API
 * cannot filter by asset. A busy directive pushes this asset's run out of that window within
 * hours and a deleted directive removes it immediately, and the jobs it dispatched then become
 * permanently unclaimable. See ADR-0009.
 */
describe('mergeDirectiveRunRecords', () => {
  const run = (overrides: Partial<RobotsDirectiveRun> = {}): RobotsDirectiveRun =>
    ({
      run_id: 'drvrun_1',
      directive_id: 'drv_1',
      subject_id: 'asset-1',
      status: 'pending',
      started_at: 1_700_000_000,
      ...overrides,
    } as RobotsDirectiveRun);

  it('appends a run at creation, which is the only time a run is added', () => {
    const records = mergeDirectiveRunRecords(undefined, [run()], { append: true });
    expect(records).toEqual([
      { runId: 'drvrun_1', directiveId: 'drv_1', status: 'pending', startedAt: 1_700_000_000 },
    ]);
  });

  it('never adds a run on the polling path', () => {
    // Otherwise merely opening an entry whose asset has any directive run inside the API's
    // newest-25 window would add a key to it, raise the version to v6, and flip a published entry
    // to "Changed" for a run nobody started from here.
    expect(mergeDirectiveRunRecords(undefined, [run()])).toBeUndefined();
    const existing = [{ runId: 'drvrun_other', directiveId: 'drv_9' }];
    expect(mergeDirectiveRunRecords(existing, [run()])).toBe(existing);
  });

  it('fills in the job ids as node_states reveals them', () => {
    // The create response is a run id and `pending`; the jobs arrive over the following minutes.
    const recorded = mergeDirectiveRunRecords(undefined, [run()], { append: true });
    const withJobs = mergeDirectiveRunRecords(recorded, [
      run({
        status: 'running',
        node_states: [{ job_id: 'rjob_a' }, { job_id: 'rjob_b' }, { reason: 'no job yet' }],
      }),
    ]);

    expect(withJobs?.[0].jobIds).toEqual(['rjob_a', 'rjob_b']);
    expect(withJobs?.[0].status).toBe('running');
  });

  it('never drops a job id it has already recorded', () => {
    // A later listing can come back without `node_states`, and losing an id there would un-claim
    // a job the entry had already claimed.
    const recorded = mergeDirectiveRunRecords(
      undefined,
      [run({ node_states: [{ job_id: 'rjob_a' }] })],
      { append: true }
    );
    const thinner = mergeDirectiveRunRecords(recorded, [run({ status: 'completed' })]);
    expect(thinner?.[0].jobIds).toEqual(['rjob_a']);
  });

  it('returns the same reference when nothing changed, so no write happens', () => {
    const recorded = mergeDirectiveRunRecords(undefined, [run()], { append: true });
    expect(mergeDirectiveRunRecords(recorded, [run()])).toBe(recorded);
  });

  it('ignores a run with no id or no directive, which nothing could be keyed on', () => {
    expect(
      mergeDirectiveRunRecords(undefined, [{ run_id: 'drvrun_2' } as RobotsDirectiveRun], {
        append: true,
      })
    ).toBeUndefined();
  });
});

describe('recordRobotsDirectiveRun', () => {
  const run = {
    run_id: 'drvrun_1',
    directive_id: 'drv_1',
    subject_id: 'asset-1',
    status: 'pending',
    started_at: 1_700_000_000,
  } as RobotsDirectiveRun;

  it('puts the run on the entry and raises the version to v4', () => {
    const next = recordRobotsDirectiveRun(baseValue(), run);
    expect(next?.robotsDirectiveRuns?.[0].runId).toBe('drvrun_1');
    expect(next?.version).toBe(4);
  });

  it('leaves every other key alone', () => {
    const value = baseValue({ captions: [{ type: 'text', id: 'track-1' } as never] });
    const next = recordRobotsDirectiveRun(value, run);
    expect(next?.captions).toBe(value.captions);
    expect(next?.assetId).toBe('asset-1');
  });

  it('returns the identical value when the run is already recorded', () => {
    const first = recordRobotsDirectiveRun(baseValue(), run);
    expect(recordRobotsDirectiveRun(first, run)).toBe(first);
  });

  it('does nothing when the field has no value at all', () => {
    expect(recordRobotsDirectiveRun(undefined, run)).toBeUndefined();
  });
});

describe('ownership from a recorded directive run', () => {
  it('claims a dispatched job with no live run in sight', () => {
    // The point of the whole thing: the run has fallen out of the list window, or the directive
    // has been deleted. The entry still knows which jobs it dispatched.
    const value = baseValue({
      robotsDirectiveRuns: [
        { runId: 'drvrun_1', directiveId: 'drv_1', jobIds: ['rjob_auto'] },
      ],
    });

    const next = applyRobotsJobsToValue(
      value,
      [{ id: 'rjob_auto', workflow: 'summarize', status: 'completed' }] as never as RobotsJob[],
      undefined,
      ours
    );

    expect(next?.robotsJobs?.map((record) => record.id)).toEqual(['rjob_auto']);
  });

  it('still refuses a job no recorded run names', () => {
    const value = baseValue({
      robotsDirectiveRuns: [{ runId: 'drvrun_1', directiveId: 'drv_1', jobIds: ['rjob_auto'] }],
    });

    expect(
      applyRobotsJobsToValue(
        value,
        [{ id: 'rjob_theirs', workflow: 'summarize', status: 'completed' }] as never as RobotsJob[],
        undefined,
        ours
      )
    ).toBe(value);
  });
});

describe('applyRobotsDirectiveRunsToValue', () => {
  it('updates a recorded run without adding an unrecorded one', () => {
    const value = baseValue({
      robotsDirectiveRuns: [{ runId: 'drvrun_1', directiveId: 'drv_1', status: 'pending' }],
    });

    const next = applyRobotsDirectiveRunsToValue(value, [
      {
        run_id: 'drvrun_1',
        directive_id: 'drv_1',
        status: 'completed',
        node_states: [{ job_id: 'rjob_a' }],
      } as RobotsDirectiveRun,
      { run_id: 'drvrun_ingest', directive_id: 'drv_2', status: 'running' } as RobotsDirectiveRun,
    ]);

    expect(next?.robotsDirectiveRuns).toHaveLength(1);
    expect(next?.robotsDirectiveRuns?.[0]).toMatchObject({
      status: 'completed',
      jobIds: ['rjob_a'],
    });
  });

  it('leaves an entry with no recorded runs byte-identical', () => {
    const value = baseValue();
    expect(
      applyRobotsDirectiveRunsToValue(value, [
        { run_id: 'drvrun_ingest', directive_id: 'drv_2' } as RobotsDirectiveRun,
      ])
    ).toBe(value);
  });
});

/**
 * The directive path had no reconciliation at all: a cold-start timeout produced an error toast,
 * and clicking again ran the whole directive a second time. It is the *more* expensive path —
 * several billable workflows per run — so it was the wrong one to leave unprotected.
 */
describe('createRobotsDirectiveRunWithReconciliation', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  it('returns the created run, tagged with the directive that started it', async () => {
    const muxApi = {
      createRobotsDirectiveRun: vi.fn(async () => ({
        data: { run_id: 'drvrun_1', subject_id: 'asset-1', status: 'pending' },
      })),
    } as never;

    const run = await createRobotsDirectiveRunWithReconciliation(muxApi, 'drv_1', 'asset-1');
    expect(run).toMatchObject({ run_id: 'drvrun_1', directive_id: 'drv_1' });
  });

  it('surfaces a failure Mux actually answered, without reconciling', async () => {
    // A 409 is the "already running on this video" case, and the caller has copy for it.
    const listRobotsDirectiveRuns = vi.fn();
    const muxApi = {
      createRobotsDirectiveRun: vi.fn(async () => {
        throw new MuxApiError('Already running', 409);
      }),
      listRobotsDirectiveRuns,
    } as never;

    await expect(
      createRobotsDirectiveRunWithReconciliation(muxApi, 'drv_1', 'asset-1')
    ).rejects.toBeInstanceOf(MuxApiError);
    expect(listRobotsDirectiveRuns).not.toHaveBeenCalled();
  });

  it('adopts the run it just started when the app-action call timed out', async () => {
    vi.useFakeTimers();
    try {
      const muxApi = {
        createRobotsDirectiveRun: vi.fn(async () => {
          // What `appActionCall.createWithResponse` throws after 15 polls: no status, so Mux may
          // well have received the request and started billing.
          throw new Error('The app action response is taking longer than expected to process.');
        }),
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [
            { run_id: 'drvrun_old', subject_id: 'asset-1', started_at: nowSeconds - 86_400 },
            { run_id: 'drvrun_new', subject_id: 'asset-1', started_at: nowSeconds },
          ],
        })),
      } as never;

      const pending = createRobotsDirectiveRunWithReconciliation(muxApi, 'drv_1', 'asset-1');
      await vi.runAllTimersAsync();
      const run = await pending;

      // Never the old one: adopting a run from yesterday would drop the guard on a run that never
      // started.
      expect(run.run_id).toBe('drvrun_new');
      expect(run.directive_id).toBe('drv_1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports unknown rather than failed when no recent run turns up', async () => {
    vi.useFakeTimers();
    try {
      const muxApi = {
        createRobotsDirectiveRun: vi.fn(async () => {
          throw new Error('taking longer than expected');
        }),
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [{ run_id: 'drvrun_old', subject_id: 'asset-1', started_at: nowSeconds - 86_400 }],
        })),
      } as never;

      const pending = createRobotsDirectiveRunWithReconciliation(
        muxApi,
        'drv_1',
        'asset-1'
      ).catch((error) => error);
      await vi.runAllTimersAsync();
      const error = await pending;

      expect(error).toBeInstanceOf(RobotsUnconfirmedDirectiveRunError);
      expect((error as RobotsUnconfirmedDirectiveRunError).directiveId).toBe('drv_1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports unknown when the reconciliation read itself fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const muxApi = {
        createRobotsDirectiveRun: vi.fn(async () => {
          throw new Error('taking longer than expected');
        }),
        listRobotsDirectiveRuns: vi.fn(async () => {
          throw new Error('also offline');
        }),
      } as never;

      const pending = createRobotsDirectiveRunWithReconciliation(
        muxApi,
        'drv_1',
        'asset-1'
      ).catch((error) => error);
      await vi.runAllTimersAsync();
      expect(await pending).toBeInstanceOf(RobotsUnconfirmedDirectiveRunError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries the create, whatever happens', async () => {
    vi.useFakeTimers();
    try {
      const createRobotsDirectiveRun = vi.fn(async () => {
        throw new Error('taking longer than expected');
      });
      const muxApi = {
        createRobotsDirectiveRun,
        listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
      } as never;

      const pending = createRobotsDirectiveRunWithReconciliation(
        muxApi,
        'drv_1',
        'asset-1'
      ).catch(() => undefined);
      await vi.runAllTimersAsync();
      await pending;

      expect(createRobotsDirectiveRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('findRecentDirectiveRun', () => {
  const now = 1_700_000_000_000;
  const nowSeconds = now / 1000;

  const listing = (runs: unknown[]) =>
    ({ listRobotsDirectiveRuns: vi.fn(async () => ({ data: runs })) } as never);

  it('ignores a run against a different asset', async () => {
    const found = await findRecentDirectiveRun(
      listing([{ run_id: 'drvrun_1', subject_id: 'asset-2', started_at: nowSeconds }]),
      'drv_1',
      'asset-1',
      { now }
    );
    expect(found).toBeUndefined();
  });

  it('ignores a run that started before the adoption window', async () => {
    const found = await findRecentDirectiveRun(
      listing([{ run_id: 'drvrun_1', subject_id: 'asset-1', started_at: nowSeconds - 600 }]),
      'drv_1',
      'asset-1',
      { now }
    );
    expect(found).toBeUndefined();
  });

  it('ignores a run with no start time, because it cannot be dated', async () => {
    // Failing to adopt costs one informed click; adopting the wrong run drops the guard on a run
    // that never started, and that costs money.
    const found = await findRecentDirectiveRun(
      listing([{ run_id: 'drvrun_1', subject_id: 'asset-1' }]),
      'drv_1',
      'asset-1',
      { now }
    );
    expect(found).toBeUndefined();
  });

  it('tolerates a clock a little ahead of ours', async () => {
    const found = await findRecentDirectiveRun(
      listing([{ run_id: 'drvrun_1', subject_id: 'asset-1', started_at: nowSeconds + 30 }]),
      'drv_1',
      'asset-1',
      { now }
    );
    expect(found?.run_id).toBe('drvrun_1');
  });
});
