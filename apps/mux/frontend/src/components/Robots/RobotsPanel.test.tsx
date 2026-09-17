/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { FieldExtensionSDK } from '@contentful/app-sdk';
import RobotsPanel from './RobotsPanel';
import RobotsErrorBoundary from './RobotsErrorBoundary';
import { MuxApiError } from '../../util/muxApi';
import { ROBOTS_POLL_INTERVAL_MS, resetRobotsCapabilityCache } from '../../util/robots';
import { MuxContentfulObject } from '../../util/types';

/**
 * Every state the Robots tab can render.
 *
 * The four capability states are the ones that matter most: they are only distinguishable because
 * `muxProxy` forwards Mux's `error.type`, so a regression there collapses three of them into one
 * generic 403 and these tests are what would catch it.
 */

/** The install these tests run as. Scoped passthroughs are matched against exactly this. */
const ids = { space: 'space-1', environment: 'master', entry: 'entry-1' };

const sdk = {
  ids,
  field: { id: 'muxVideo' },
  locales: { default: 'en-US' },
  contentType: { fields: [] },
  entry: { fields: {} },
  notifier: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
} as unknown as FieldExtensionSDK;

/** A passthrough stamped by this install, for this entry. */
const ourPassthrough = (requestId = 'abcdef0123456789') =>
  `contentful@2.0.0|${ids.space}:${ids.environment}:${ids.entry}|${requestId}`;

const value = (extra: Partial<MuxContentfulObject> = {}): MuxContentfulObject =>
  ({ version: 3, assetId: 'asset-1', ready: true, ...extra } as MuxContentfulObject);

const renderPanel = (overrides: Record<string, any> = {}) =>
  render(
    <RobotsPanel
      sdk={sdk}
      muxApi={overrides.muxApi}
      value={'value' in overrides ? overrides.value : value()}
      isActive={overrides.isActive ?? true}
      updateField={overrides.updateField ?? vi.fn(async () => undefined)}
      resync={overrides.resync ?? vi.fn(async () => undefined)}
      defaultDirectiveIds={overrides.defaultDirectiveIds ?? []}
    />
  );

const apiThatFailsWith = (error: unknown) => ({
  listRobotsJobs: vi.fn(async () => {
    throw error;
  }),
  listRobotsDirectives: vi.fn(async () => ({ data: [] })),
  listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
});

/**
 * `GET /robots/v0/jobs` returns a six-field summary — no `outputs`, `passthrough`,
 * `units_consumed` or `errors`. `getRobotsJob` is where those live, so it is mocked separately
 * and deliberately returns nothing extra unless a test says otherwise.
 */
const apiThatReturns = (jobs: unknown[], details: Record<string, unknown> = {}) => ({
  listRobotsJobs: vi.fn(async () => ({ data: jobs })),
  getRobotsJob: vi.fn(async (_workflow: string, jobId: string) => ({
    data: details[jobId] ?? (jobs as any[]).find((job) => job.id === jobId),
  })),
  listRobotsDirectives: vi.fn(async () => ({ data: [] })),
  listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
});

describe('RobotsPanel capability states', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('enabled: shows the job table and a way to run something', async () => {
    renderPanel({
      muxApi: apiThatReturns([
        {
          id: 'rjob_1',
          workflow: 'summarize',
          status: 'completed',
          created_at: 1_700_000_000,
        },
      ]),
    });

    await waitFor(() => expect(screen.getByText('Run a workflow')).toBeInTheDocument());
    expect(screen.getByTestId('robots_job_table')).toBeInTheDocument();
    expect(screen.getByText('Summarize')).toBeInTheDocument();
  });

  it('not enabled: explains what Robots is instead of showing an error', async () => {
    renderPanel({ muxApi: apiThatFailsWith(new MuxApiError('Forbidden', 403)) });

    await waitFor(() => expect(screen.getByTestId('robots-not-enabled')).toBeInTheDocument());
    expect(screen.queryByText('Run a workflow')).not.toBeInTheDocument();
  });

  it('scope missing: says a new token is needed, because the scope cannot be added', async () => {
    renderPanel({
      muxApi: apiThatFailsWith(
        new MuxApiError('Token is missing the robots:* scope', 403, 'insufficient_scope')
      ),
    });

    await waitFor(() => expect(screen.getByTestId('robots-scope-missing')).toBeInTheDocument());
    expect(screen.getByText(/cannot be added to a token that already exists/)).toBeInTheDocument();
  });

  it('units exhausted: shows the free-plan copy, not a generic 403', async () => {
    renderPanel({
      muxApi: apiThatFailsWith(
        new MuxApiError('Monthly unit limit reached', 403, 'robots_units_limit_exceeded')
      ),
    });

    await waitFor(() => expect(screen.getByTestId('robots-units-exhausted')).toBeInTheDocument());
    expect(screen.getByText(/100,000 AI units a month/)).toBeInTheDocument();
  });

  it('no video yet: asks for one rather than calling Mux', async () => {
    const muxApi = apiThatReturns([]);
    renderPanel({ muxApi, value: undefined });

    expect(screen.getByText('Add a video before running Robots workflows.')).toBeInTheDocument();
    expect(muxApi.listRobotsJobs).not.toHaveBeenCalled();
  });

  it('inactive tab: costs nothing, so opening an entry does not pay for Robots', async () => {
    const muxApi = apiThatReturns([]);
    renderPanel({ muxApi, isActive: false });

    await waitFor(() => expect(muxApi.listRobotsJobs).not.toHaveBeenCalled());
  });
});

describe('RobotsPanel spend guards', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('lets anyone who can open the entry run a workflow', async () => {
    // Deliberate, and an open product question: Sanity and Strapi both gate directive runs behind
    // roles, the Contentful requirements never specified one. Pinned here so adding a gate later
    // is a decision someone makes on purpose.
    renderPanel({ muxApi: apiThatReturns([]) });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled()
    );
  });

  it('blocks a run on a video already queued for deletion', async () => {
    renderPanel({
      muxApi: apiThatReturns([]),
      value: value({
        pendingActions: {
          delete: [{ type: 'asset', id: 'asset-1', retry: 0 }],
          create: [],
          update: [],
        },
      }),
    });

    await waitFor(() =>
      expect(
        screen.getByText('This video is marked for deletion at the next publish.')
      ).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeDisabled();
  });

  /**
   * The button used to be hidden until a summary existed, which made the whole feature invisible
   * to anyone who had not already run the workflow that enables it. It is now always rendered,
   * and disabled-with-a-reason is what carries the "not yet" — so what these two assert is
   * discoverability, not merely the enabled/disabled flip.
   */
  it('shows the apply button before there is anything to apply, disabled', async () => {
    renderPanel({ muxApi: apiThatReturns([]) });
    await waitFor(() => expect(screen.getByText('Run a workflow')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Apply summary' })).toBeDisabled();
  });

  it('says on hover what the apply button would do and what has to happen first', async () => {
    renderPanel({ muxApi: apiThatReturns([]) });
    await waitFor(() => expect(screen.getByText('Run a workflow')).toBeInTheDocument());

    fireEvent.mouseOver(screen.getByRole('button', { name: 'Apply summary' }));

    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        /Run a Summarize workflow to apply its title, description and tags/
      )
    );
  });

  it('enables apply once a summary has been stored', async () => {
    renderPanel({
      muxApi: apiThatReturns([]),
      value: value({ robotsOutputs: { summarize: { jobId: 'rjob_1', title: 'A title' } } }),
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply summary' })).toBeEnabled()
    );
  });
});

describe('RobotsPanel field writes', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('never writes the field directly — everything goes through updateField', async () => {
    const updateField = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (mutate: (current: any) => any) => undefined
    );
    renderPanel({
      muxApi: apiThatReturns([
        { id: 'rjob_1', workflow: 'summarize', status: 'completed', created_at: 1 },
      ]),
      updateField,
    });

    await waitFor(() => expect(updateField).toHaveBeenCalled());
    expect(typeof updateField.mock.calls[0][0]).toBe('function');
  });

  it('leaves an entry with no Robots data untouched, so it cannot flip to Changed', async () => {
    const updateField = vi.fn(async (mutate: any) => {
      // The mutator must hand back the identical object when the API reports nothing terminal.
      const current = value();
      expect(mutate(current)).toBe(current);
    });

    renderPanel({
      muxApi: apiThatReturns([{ id: 'rjob_1', workflow: 'summarize', status: 'processing' }]),
      updateField,
    });

    await waitFor(() => expect(updateField).toHaveBeenCalled());
  });

  it('resyncs the asset once when a track-producing workflow finishes', async () => {
    const resync = vi.fn(async () => undefined);
    renderPanel({
      muxApi: apiThatReturns([
        {
          id: 'rjob_caption',
          workflow: 'generate-premium-captions',
          status: 'completed',
          created_at: 1,
        },
      ]),
      resync,
    });

    await waitFor(() => expect(resync).toHaveBeenCalledTimes(1));
  });

  it('resyncs after a workflow that attaches no track, because it can still change the asset', async () => {
    // This used to assert the opposite, gated on a `TRACK_PRODUCING_WORKFLOWS` list. The gate was
    // wrong: `summarize` with `update_asset_meta` writes the asset's title and description,
    // `find-best-thumbnails` with `update_asset_thumbnail` moves its poster, and `moderate` with
    // `on_flagged: delete_playback_ids` removes playback ids outright. None attach a track, all
    // three left the mirror stale until something else happened to refresh it.
    const resync = vi.fn(async () => undefined);
    renderPanel({
      muxApi: apiThatReturns([
        { id: 'rjob_sum', workflow: 'summarize', status: 'completed', created_at: 1 },
      ]),
      resync,
    });

    await waitFor(() => expect(resync).toHaveBeenCalledTimes(1));
    expect(resync).toHaveBeenCalledWith({ silent: true, skipPlayerResync: true });
  });

  it('resyncs once per job however many times the list is read', async () => {
    // The dedup is what makes "resync for every workflow" affordable: one GET per newly-completed
    // job per session, not one per poll tick.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const done = {
      id: 'rjob_sum',
      workflow: 'summarize',
      status: 'completed',
      created_at: nowSeconds,
    };
    const running = {
      id: 'rjob_live',
      workflow: 'find-scenes',
      status: 'processing',
      created_at: nowSeconds,
    };
    const resync = vi.fn(async () => undefined);
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [{ ...done }, { ...running }] })),
      getRobotsJob: vi.fn(async (_workflow: string, id: string) => ({ data: { ...done, id } })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, resync });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(resync).toHaveBeenCalledTimes(1);

      for (let tick = 0; tick < 3; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
        });
      }

      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(resync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resync for a job that has not finished', async () => {
    const resync = vi.fn(async () => undefined);
    renderPanel({
      muxApi: apiThatReturns([
        { id: 'rjob_sum', workflow: 'summarize', status: 'processing', created_at: 1 },
      ]),
      resync,
    });

    await waitFor(() => expect(screen.getByTestId('robots_job_table')).toBeInTheDocument());
    expect(resync).not.toHaveBeenCalled();
  });
});

describe('RobotsPanel unconfirmed creates', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('keeps Run blocked after a create Mux never confirmed, and offers an informed way out', async () => {
    // The cold-start case: the app action lost its caller, so we do not know whether the job
    // started. It may be running and billing.
    const muxApi = {
      ...apiThatReturns([]),
      createRobotsJob: vi.fn(async () => {
        throw new Error('The app action response is taking longer than expected to process.');
      }),
    };

    renderPanel({ muxApi });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize' }));

    await waitFor(
      () => expect(screen.getByText(/Mux never confirmed it/)).toBeInTheDocument(),
      // Reconciliation retries the job list a few times before giving up, which is real time.
      { timeout: 15000 }
    );
    expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeDisabled();

    // Nothing re-enables Run on its own — not a timer, not a refresh that fails to find the job.
    // Only the editor saying so.
    fireEvent.click(screen.getByRole('button', { name: 'Nothing is running — let me try again' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled()
    );
  }, 20000);

  it('clears the guard by finding the job, not only by the button that duplicates it', async () => {
    // ADR-0003 always said the passthrough would be "re-checked on every subsequent refresh". It
    // never was: the refresh path tested `fetched.some((job) => job.passthrough === pending)`
    // against a list that carries no passthrough, so the predicate could not be true. Run stayed
    // disabled for the whole session even after the job was listed and completed, and the only
    // way out was "Nothing is running — let me try again" — the one button that creates a
    // duplicate. The guard against double-billing could only be dismissed by double-billing.
    const nowSeconds = Math.floor(Date.now() / 1000);
    let stamped = '';
    let listed: unknown[] = [];

    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: listed.map((row) => ({ ...(row as object) })) })),
      getRobotsJob: vi.fn(async (_workflow: string, id: string) => ({
        data: {
          id,
          workflow: 'summarize',
          status: 'completed',
          created_at: nowSeconds,
          // The single-job GET is the only place a passthrough exists, which is why resolving
          // this costs more than reading the list.
          passthrough: stamped,
        },
      })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
      createRobotsJob: vi.fn(async (_workflow: string, _params: unknown, passthrough: string) => {
        stamped = passthrough;
        throw new Error('The app action response is taking longer than expected to process.');
      }),
    };

    let stored: any = value();
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      stored = mutate(stored);
    });

    renderPanel({ muxApi, updateField });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize' }));

    await waitFor(() => expect(screen.getByText(/Mux never confirmed it/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeDisabled();

    // It was running the whole time, and now it is in the list.
    listed = [
      { id: 'rjob_found', workflow: 'summarize', status: 'completed', created_at: nowSeconds },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled(),
      { timeout: 10000 }
    );
    // Adopted, not merely forgotten: the job it found is on the entry.
    expect(stored?.robotsJobs?.map((record: any) => record.id)).toEqual(['rjob_found']);
  }, 30000);
});

describe('RobotsErrorBoundary', () => {
  it('keeps a fault in the Robots tab from unmounting the field editor', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error('boom');
    };

    render(
      <div>
        <span>The rest of the editor</span>
        <RobotsErrorBoundary>
          <Boom />
        </RobotsErrorBoundary>
      </div>
    );

    expect(screen.getByTestId('robots-crashed')).toBeInTheDocument();
    expect(screen.getByText('The rest of the editor')).toBeInTheDocument();
    error.mockRestore();
  });
});

describe('RobotsPanel persistence', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  /**
   * A harness that actually applies the mutators, instead of swallowing them.
   *
   * The original panel tests mocked `updateField` as a no-op and asserted only that it was
   * called — which is why "nothing is ever stored" passed every test it had.
   */
  const withStoredValue = (initial: MuxContentfulObject | undefined) => {
    let stored = initial;
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      stored = mutate(stored);
    });
    return { updateField, read: () => stored };
  };

  /** What the API really returns from `GET /robots/v0/jobs`: no passthrough, no outputs. */
  const summaryRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'rjob_1',
    workflow: 'ask-questions',
    status: 'completed',
    created_at: 1_700_000_000,
    ...overrides,
  });

  it('records a job the editor starts here, immediately', async () => {
    const { updateField, read } = withStoredValue(value());
    const created = { ...summaryRow({ status: 'pending' }), passthrough: 'contentful@x|req-1' };

    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        createRobotsJob: vi.fn(async () => ({ data: created })),
      },
      updateField,
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize' }));

    await waitFor(() => expect(read()?.robotsJobs).toHaveLength(1));
    expect(read()?.robotsJobs?.[0]).toMatchObject({ id: 'rjob_1', status: 'pending' });
    // v4 is asserted only because the value now genuinely holds v4 data.
    expect(read()?.version).toBe(4);
  });

  it('updates a recorded job from a later summary that omits the passthrough', async () => {
    const { updateField, read } = withStoredValue(
      value({
        robotsJobs: [{ id: 'rjob_1', workflow: 'ask-questions', status: 'processing' }],
      })
    );

    renderPanel({ muxApi: apiThatReturns([summaryRow()]), updateField });

    await waitFor(() => expect(read()?.robotsJobs?.[0].status).toBe('completed'));
  });

  it('does not record a job someone ran in the Mux dashboard', async () => {
    const { updateField, read } = withStoredValue(value());

    renderPanel({ muxApi: apiThatReturns([summaryRow({ id: 'rjob_theirs' })]), updateField });

    await waitFor(() => expect(screen.getByTestId('robots_job_table')).toBeInTheDocument());
    // Shown in the table, absent from the entry.
    expect(read()?.robotsJobs).toBeUndefined();
  });

  it('claims a directive-dispatched job once its run is known, whatever the order', async () => {
    const { updateField, read } = withStoredValue(value());

    renderPanel({
      muxApi: {
        listRobotsJobs: vi.fn(async () => ({ data: [summaryRow({ id: 'rjob_auto' })] })),
        listRobotsDirectives: vi.fn(async () => ({ data: [{ id: 'drv_1', name: 'Ingest' }] })),
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [
            {
              run_id: 'drvrun_1',
              subject_id: 'asset-1',
              status: 'completed',
              node_states: [{ job_id: 'rjob_auto', workflow_name: 'ask-questions' }],
            },
          ],
        })),
      },
      defaultDirectiveIds: ['drv_1'],
      updateField,
    });

    // Persistence is its own effect keyed on both lists, so it re-runs when the runs arrive —
    // whichever of the two fetches lands first.
    await waitFor(() => expect(read()?.robotsJobs).toHaveLength(1));
    expect(read()?.robotsJobs?.[0].id).toBe('rjob_auto');
  });

  it('leaves an entry with no Robots activity byte-identical', async () => {
    const original = value();
    const { updateField, read } = withStoredValue(original);

    renderPanel({ muxApi: apiThatReturns([summaryRow({ id: 'rjob_theirs' })]), updateField });

    await waitFor(() => expect(screen.getByTestId('robots_job_table')).toBeInTheDocument());
    expect(read()).toBe(original);
  });
});

describe('RobotsPanel — a started job is never reported as failed', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('reports success even if recording the job on the entry fails', async () => {
    // The job is running and billing. A failed write is our problem, not something to tell the
    // editor a run failed over — they would pay for it twice.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const created = {
      id: 'rjob_1',
      workflow: 'summarize',
      status: 'pending',
      passthrough: 'contentful@x|req-1',
    };

    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        createRobotsJob: vi.fn(async () => ({ data: created })),
      },
      updateField: vi.fn(async () => {
        throw new Error('version conflict');
      }),
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize' }));

    await waitFor(() => expect(sdk.notifier.success).toHaveBeenCalled());
    expect(sdk.notifier.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled();
    consoleError.mockRestore();
  });
});

describe('RobotsPanel — the fields the list leaves out', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  const withStored = (initial: MuxContentfulObject | undefined) => {
    let stored = initial;
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      stored = mutate(stored);
    });
    // `value` is also the prop the panel reads ownership from, so it has to be handed over too.
    return { updateField, value: initial, read: () => stored };
  };

  const summary = (overrides: Record<string, unknown> = {}) => ({
    id: 'rjob_sum',
    workflow: 'summarize',
    status: 'completed',
    created_at: 1_700_000_000,
    ...overrides,
  });

  it('populates robotsOutputs, which is only possible from the single-job GET', async () => {
    const stored = withStored(
      value({ robotsJobs: [{ id: 'rjob_sum', workflow: 'summarize', status: 'processing' }] })
    );
    const { updateField, read } = stored;

    renderPanel({
      muxApi: apiThatReturns([summary()], {
        rjob_sum: {
          ...summary(),
          units_consumed: 4,
          passthrough: 'contentful@x|req-1',
          outputs: { title: 'A generated title', tags: ['alpha'] },
        },
      }),
      value: stored.value,
      updateField,
    });

    await waitFor(() => expect(read()?.robotsOutputs?.summarize?.title).toBe('A generated title'));
    expect(read()?.robotsOutputs?.summarize?.tags).toEqual(['alpha']);
    // And the value carries the Robots version, because it now holds Robots data.
    expect(read()?.version).toBe(4);
  });

  it('records units consumed and the failure reason, neither of which the list carries', async () => {
    const stored = withStored(
      value({ robotsJobs: [{ id: 'rjob_sum', workflow: 'summarize', status: 'processing' }] })
    );
    const { updateField, read } = stored;

    renderPanel({
      muxApi: apiThatReturns([summary({ status: 'errored' })], {
        rjob_sum: {
          ...summary({ status: 'errored' }),
          units_consumed: 2,
          errors: [{ message: 'The audio track was too quiet' }],
        },
      }),
      value: stored.value,
      updateField,
    });

    await waitFor(() => expect(read()?.robotsJobs?.[0].error).toBe('The audio track was too quiet'));
    expect(read()?.robotsJobs?.[0].units_consumed).toBe(2);
  });

  it('marks the rows the entry does not hold, and only those', async () => {
    // After the units fix an external row looks identical to one of ours, so nothing on screen
    // explained why it was missing from the entry's data. This is that explanation.
    const stored = withStored(
      value({ robotsJobs: [{ id: 'rjob_sum', workflow: 'summarize', status: 'completed' }] })
    );

    renderPanel({
      muxApi: apiThatReturns([summary(), summary({ id: 'rjob_theirs' })]),
      value: stored.value,
      updateField: stored.updateField,
    });

    await waitFor(() => expect(screen.getByTestId('robots_job_table')).toBeInTheDocument());
    expect(screen.getAllByText('Not saved to this entry')).toHaveLength(1);
  });

  it('opens a job that is not ours, so its units and output are not left blank', async () => {
    // Ownership is a persistence rule, not a read gate. A dashboard job is shown in the table,
    // and a row whose Units column can never be filled in looks like a bug. Reading a job costs
    // nothing and charges nobody.
    const muxApi = apiThatReturns([summary({ id: 'rjob_theirs' })], {
      rjob_theirs: { ...summary({ id: 'rjob_theirs' }), units_consumed: 7 },
    });
    const { updateField, read } = withStored(value());
    renderPanel({ muxApi, updateField });

    await waitFor(() => expect(muxApi.getRobotsJob).toHaveBeenCalledWith('summarize', 'rjob_theirs'));
    expect(await screen.findByText('7')).toBeInTheDocument();

    // But it still never reaches the entry.
    expect(read()?.robotsJobs).toBeUndefined();
  });

  it('does not adopt another install\'s job just because it fetched its passthrough', async () => {
    // `contentful@` identifies the app, not the install. Now that detail is fetched for jobs we
    // do not own, a second Contentful install pointed at the same Mux account would otherwise
    // have its jobs copied onto this entry. Both shapes are refused: the pre-scope format, which
    // names nothing, and a scoped one naming a different space.
    const foreign = summary({ id: 'rjob_other_space' });
    const legacy = summary({ id: 'rjob_legacy' });
    const muxApi = apiThatReturns([foreign, legacy], {
      rjob_other_space: {
        ...foreign,
        passthrough: 'contentful@9.9.9|other-space:master:other-entry|0123456789abcdef',
        units_consumed: 11,
      },
      rjob_legacy: {
        ...legacy,
        passthrough: 'contentful@9.9.9|req-from-before-the-scope',
        units_consumed: 3,
      },
    });
    const { updateField, read } = withStored(value());
    renderPanel({ muxApi, updateField });

    await waitFor(() =>
      expect(muxApi.getRobotsJob).toHaveBeenCalledWith('summarize', 'rjob_other_space')
    );
    expect(await screen.findByText('11')).toBeInTheDocument();
    expect(read()?.robotsJobs).toBeUndefined();
  });

  it('adopts a job of ours that was never recorded, which nothing else could claim', async () => {
    // The orphan case, and the reason the scope segment exists at all. The page was closed
    // during the cold-start window, so the create was never written to the entry. Under
    // `trustPassthrough: false` this job ran, it billed, and it belonged to nobody for good.
    const orphan = summary({ id: 'rjob_orphan' });
    const muxApi = apiThatReturns([orphan], {
      rjob_orphan: { ...orphan, passthrough: ourPassthrough(), units_consumed: 5 },
    });
    const { updateField, read } = withStored(value());
    renderPanel({ muxApi, updateField });

    await waitFor(() => expect(read()?.robotsJobs).toHaveLength(1));
    expect(read()?.robotsJobs?.[0].id).toBe('rjob_orphan');
  });

  it('stamps the space, environment and entry onto the jobs it creates', async () => {
    const createRobotsJob = vi.fn(async () => ({
      data: { id: 'rjob_new', workflow: 'summarize', status: 'pending' },
    }));
    renderPanel({ muxApi: { ...apiThatReturns([]), createRobotsJob } });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run a workflow' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Run Summarize' }));

    await waitFor(() => expect(createRobotsJob).toHaveBeenCalled());
    const [, , stamped] = createRobotsJob.mock.calls[0] as unknown[];
    const passthrough = String(stamped);
    expect(passthrough).toContain(`${ids.space}:${ids.environment}:${ids.entry}`);
    expect(passthrough.length).toBeLessThanOrEqual(255);
  });

  it('stops re-reading a job whose detail fetch failed', async () => {
    // Without a tombstone the failed id never lands in the detail cache, so every poll tick
    // re-requests it: a job Robots has purged would 404 in a loop for as long as the entry
    // stays open. Reproducing that needs the two things the real world supplies and a
    // one-shot mock does not — a live poll (something still processing) and a *fresh* array
    // from each list call, which is what actually re-triggers the effect.
    // Recent timestamps matter: `activeJobs` drops anything older than `ROBOTS_STALE_JOB_MS`, so
    // a job dated 1970 is never "in flight" and the poll that reproduces the loop never arms.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const gone = {
      id: 'rjob_gone',
      workflow: 'summarize',
      status: 'errored',
      created_at: nowSeconds,
    };
    const running = {
      id: 'rjob_live',
      workflow: 'summarize',
      status: 'processing',
      created_at: nowSeconds,
    };

    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [{ ...gone }, { ...running }] })),
      getRobotsJob: vi.fn(async () => {
        throw new Error('404 — job purged');
      }),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, updateField: withStored(value()).updateField });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(1);

      // Drive several poll cycles. The list keeps handing back new arrays, so the detail effect
      // re-evaluates every time; only the tombstone stops it asking again.
      for (let tick = 0; tick < 3; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
        });
      }

      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens each job at most once', async () => {
    const muxApi = apiThatReturns([summary()]);
    const stored = withStored(
      value({ robotsJobs: [{ id: 'rjob_sum', workflow: 'summarize', status: 'processing' }] })
    );

    renderPanel({ muxApi, value: stored.value, updateField: stored.updateField });

    await waitFor(() => expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(1));
    // Give the effects a few more cycles to prove it does not loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(1);
  });
});

/**
 * What happens past the detail window.
 *
 * The background read is capped at the newest 20 terminal jobs, and that cap is the whole reason
 * an asset with a long dashboard history is cheap to open. What it must not do is quietly lie:
 * a row past it had `units_consumed` rendered as an em dash, which reads as "this job consumed
 * nothing" when it means "nobody ever asked". These tests hold both halves at once — the ceiling
 * still holds, *and* every row says which kind of blank it is.
 */
describe('RobotsPanel — Units past the detail window', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  /**
   * More history than the window covers: 24 cancelled jobs, and one completed job older than all
   * of them. The completed one is therefore the row the background pass can never reach — and,
   * because a cancelled row no longer offers an output modal, the only "View output" on screen.
   */
  const OLD_JOB = {
    id: 'rjob_old',
    workflow: 'summarize',
    status: 'completed',
    created_at: 1_700_000_000,
  };

  const longHistory = () => [
    ...Array.from({ length: 24 }, (_, index) => ({
      id: `rjob_c${index}`,
      workflow: 'summarize',
      status: 'cancelled',
      created_at: 1_700_000_001 + index,
    })),
    OLD_JOB,
  ];

  const apiWithLongHistory = () =>
    apiThatReturns(longHistory(), {
      rjob_old: { ...OLD_JOB, units_consumed: 9, outputs: { title: 'A generated title' } },
    });

  /** The background pass has drained as far as the window lets it. */
  const settled = async (muxApi: ReturnType<typeof apiWithLongHistory>) => {
    await waitFor(() => expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(20));
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  it('stops at the window, and says so rather than showing an em dash', async () => {
    const muxApi = apiWithLongHistory();
    renderPanel({ muxApi });

    await settled(muxApi);
    // The ceiling held: 25 terminal jobs on the asset, 20 detail reads, never the oldest.
    expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(20);
    expect(muxApi.getRobotsJob).not.toHaveBeenCalledWith('summarize', 'rjob_old');

    // And the row it never reached says which kind of blank it is.
    expect(screen.getByTestId('robots-load-units-rjob_old')).toHaveTextContent('Not loaded');
  });

  it('answers a cancelled row without spending a read on it', async () => {
    const muxApi = apiWithLongHistory();
    renderPanel({ muxApi });

    await settled(muxApi);
    // Known from the status alone, so it reads the same inside the window or outside it.
    expect(screen.getByTestId('robots-units-rjob_c0')).toHaveTextContent('Not charged');
    expect(screen.getByTestId('robots-units-rjob_c23')).toHaveTextContent('Not charged');
    // And there is nothing to open on it — the one modal on screen belongs to the completed job.
    expect(screen.getAllByRole('button', { name: 'View output' })).toHaveLength(1);
  });

  it('fills one row on demand, and only that row', async () => {
    const muxApi = apiWithLongHistory();
    renderPanel({ muxApi });

    await settled(muxApi);
    fireEvent.click(screen.getByTestId('robots-load-units-rjob_old'));

    await waitFor(() =>
      expect(screen.getByTestId('robots-units-rjob_old')).toHaveTextContent('9')
    );
    // Exactly one more request than the bounded pass made: volume tracks interest, not history.
    expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(21);
    expect(muxApi.getRobotsJob).toHaveBeenCalledWith('summarize', 'rjob_old');
  });

  it('keeps what the output modal already paid for', async () => {
    // The modal reads the whole job to show the result. Until this, that record died with the
    // modal and the row behind it went straight back to saying it knew nothing about its units.
    const muxApi = apiWithLongHistory();
    renderPanel({ muxApi });

    await settled(muxApi);
    fireEvent.click(screen.getByRole('button', { name: 'View output' }));

    await waitFor(() =>
      expect(screen.getByTestId('robots-units-rjob_old')).toHaveTextContent('9')
    );
    expect(screen.queryByTestId('robots-load-units-rjob_old')).not.toBeInTheDocument();
    // One read, not one per open: the row is filled by the fetch the modal was making anyway.
    expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(21);
  });
});

describe('RobotsPanel — directive runs', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('opens a run whose listing omits node_states, so automated jobs are still claimed', async () => {
    // A safety net rather than a normal path: the list does carry node_states. But it is the
    // ownership signal — without it a directive's jobs look like a stranger's and never reach the
    // entry — so a run that arrives without one is opened rather than guessed at.
    const getRobotsDirectiveRun = vi.fn(async () => ({
      data: {
        run_id: 'drvrun_1',
        subject_id: 'asset-1',
        status: 'completed',
        node_states: [{ job_id: 'rjob_auto', workflow_name: 'summarize' }],
      },
    }));

    let stored: any = value();
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      stored = mutate(stored);
    });

    renderPanel({
      muxApi: {
        listRobotsJobs: vi.fn(async () => ({
          data: [
            { id: 'rjob_auto', workflow: 'summarize', status: 'completed', created_at: 1 },
          ],
        })),
        getRobotsJob: vi.fn(async () => ({
          data: { id: 'rjob_auto', workflow: 'summarize', status: 'completed' },
        })),
        listRobotsDirectives: vi.fn(async () => ({ data: [] })),
        // Summary only — no node_states.
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [{ run_id: 'drvrun_1', subject_id: 'asset-1' }],
        })),
        getRobotsDirectiveRun,
      },
      defaultDirectiveIds: ['drv_1'],
      value: stored,
      updateField,
    });

    await waitFor(() => expect(getRobotsDirectiveRun).toHaveBeenCalledWith('drv_1', 'drvrun_1'));
    await waitFor(() => expect(stored?.robotsJobs).toHaveLength(1));
    expect(stored?.robotsJobs?.[0].id).toBe('rjob_auto');
  });

  it('does not open a run that already carries its node_states', async () => {
    const getRobotsDirectiveRun = vi.fn();

    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [
            {
              run_id: 'drvrun_1',
              subject_id: 'asset-1',
              node_states: [{ job_id: 'rjob_auto' }],
            },
          ],
        })),
        getRobotsDirectiveRun,
      },
      defaultDirectiveIds: ['drv_1'],
    });

    await waitFor(() => expect(screen.getByTestId('robots_directive_run_table')).toBeInTheDocument());
    expect(getRobotsDirectiveRun).not.toHaveBeenCalled();
  });
});

/**
 * The shape `GET /robots/v0/directives/{id}/runs` really returns.
 *
 * Mux serialises a run two ways and the difference is load-bearing: the *webhook* payload nests
 * `{ id, directive_id, asset_id, … }`, the *REST* response uses `run_id` and `subject_id` and
 * names no directive at all. The tab was written against the webhook shape, so its
 * `run.asset_id === assetId` filter matched nothing and the runs table was empty forever — and
 * every fixture in this file hand-supplied `asset_id`, which is exactly why it passed.
 *
 * Confirmed against `@mux/mux-node`'s generated `DirectiveRunDetail`; the API reference documents
 * these endpoints with no response schema.
 */
describe('RobotsPanel — the shape the runs endpoint actually returns', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  const wireRun = (overrides: Record<string, unknown> = {}) => ({
    run_id: 'drvrun_1',
    subject_id: 'asset-1',
    status: 'completed',
    started_at: 1_700_000_000,
    completed_at: 1_700_000_100,
    node_states: [
      { reference_id: 'sum', status: 'dispatched', workflow_name: 'summarize', job_id: 'rjob_a' },
    ],
    ...overrides,
  });

  it('lists a run the API returns, which names the asset in subject_id', async () => {
    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        listRobotsDirectives: vi.fn(async () => ({ data: [{ id: 'drv_1', name: 'Ingest' }] })),
        listRobotsDirectiveRuns: vi.fn(async () => ({ data: [wireRun()] })),
      },
      defaultDirectiveIds: ['drv_1'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('robots_directive_run_table')).toBeInTheDocument()
    );
    expect(screen.queryByText('No directive runs for this video yet.')).not.toBeInTheDocument();
  });

  it('names the directive from the request, because the run never names its own', async () => {
    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        listRobotsDirectives: vi.fn(async () => ({ data: [{ id: 'drv_1', name: 'Ingest' }] })),
        listRobotsDirectiveRuns: vi.fn(async () => ({ data: [wireRun()] })),
      },
      defaultDirectiveIds: ['drv_1'],
    });

    // Two "Ingest" on screen would be the picker plus the row; the row is the one under test, so
    // assert on the table specifically.
    const table = await screen.findByTestId('robots_directive_run_table');
    await waitFor(() => expect(within(table).getByText('Ingest')).toBeInTheDocument());
  });

  it('drops runs for another asset, which is the only filtering there is', async () => {
    // The API cannot filter runs by asset, so every run of the directive comes back and the
    // narrowing happens here.
    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [
            wireRun(),
            wireRun({ run_id: 'drvrun_2', subject_id: 'asset-2', status: 'errored' }),
          ],
        })),
      },
      defaultDirectiveIds: ['drv_1'],
    });

    const table = await screen.findByTestId('robots_directive_run_table');
    expect(within(table).getByText('completed')).toBeInTheDocument();
    expect(within(table).queryByText('errored')).not.toBeInTheDocument();
  });

  it('renders rows collapsed, which needs a run id that exists', async () => {
    // `expandedId === run.id` on a run that has no `id` is `undefined === undefined` — every row
    // would come up pre-expanded, and clicking one would collapse all of them.
    renderPanel({
      muxApi: {
        ...apiThatReturns([]),
        listRobotsDirectiveRuns: vi.fn(async () => ({ data: [wireRun()] })),
      },
      defaultDirectiveIds: ['drv_1'],
    });

    const table = await screen.findByTestId('robots_directive_run_table');
    expect(within(table).queryByText('Summarize')).not.toBeInTheDocument();

    fireEvent.click(within(table).getByRole('button', { name: 'Show steps' }));
    expect(within(table).getByText('Summarize')).toBeInTheDocument();
  });

  it('claims a directive-dispatched job from a run in the real wire shape', async () => {
    let stored: any = value();
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      stored = mutate(stored);
    });

    renderPanel({
      muxApi: {
        ...apiThatReturns([
          { id: 'rjob_a', workflow: 'summarize', status: 'completed', created_at: 1_700_000_000 },
        ]),
        listRobotsDirectiveRuns: vi.fn(async () => ({ data: [wireRun()] })),
      },
      defaultDirectiveIds: ['drv_1'],
      value: stored,
      updateField,
    });

    await waitFor(() => expect(stored?.robotsJobs).toHaveLength(1));
    expect(stored?.robotsJobs?.[0].id).toBe('rjob_a');
  });
});

/**
 * Polling across the gap a directive leaves between its workflows.
 *
 * A directive dispatches in sequence, so between job N finishing and job N+1 starting there are
 * zero non-terminal jobs on the asset. Gating the loop on in-flight jobs alone stops it dead in
 * that window, and the rest of the sequence then only appears on a page reload — which is exactly
 * the workaround this was reported with.
 */
describe('RobotsPanel — polling between a directive\'s workflows', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  const nowSeconds = Math.floor(Date.now() / 1000);

  /** Recent, because `activeJobs` and `activeDirectiveRuns` both drop anything stale. */
  const liveRun = (overrides: Record<string, unknown> = {}) => ({
    run_id: 'drvrun_1',
    subject_id: 'asset-1',
    status: 'running',
    started_at: nowSeconds,
    node_states: [
      { reference_id: 'one', status: 'dispatched', workflow_name: 'summarize', job_id: 'rjob_a' },
    ],
    ...overrides,
  });

  const finishedJob = {
    id: 'rjob_a',
    workflow: 'summarize',
    status: 'completed',
    created_at: nowSeconds,
  };
  const nextJob = {
    id: 'rjob_b',
    workflow: 'ask-questions',
    status: 'processing',
    created_at: nowSeconds,
  };

  const tick = async (times = 1) => {
    for (let n = 0; n < times; n += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });
    }
  };

  it('keeps re-reading the job list while a run is live but no job is in flight', async () => {
    // The whole window: job one is terminal, job two has not been dispatched yet. Nothing is in
    // flight, and only the run knows more work is coming.
    let jobs: unknown[] = [finishedJob];
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: jobs.map((job) => ({ ...(job as object) })) })),
      getRobotsJob: vi.fn(async (_workflow: string, id: string) => ({
        data: jobs.find((job: any) => job.id === id),
      })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [liveRun()] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, defaultDirectiveIds: ['drv_1'] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      const afterFirstLoad = muxApi.listRobotsJobs.mock.calls.length;
      await tick(2);
      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(afterFirstLoad);

      // And the job the directive dispatches next shows up without a page reload.
      jobs = [finishedJob, nextJob];
      await tick(2);
      expect(screen.getByText('Ask questions')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on a run that is stuck, rather than polling an open tab forever', async () => {
    // The terminal condition that keeps the fix above from becoming an unbounded spend: a run
    // still claiming to be `running` six hours on has silently died, and every tick costs an
    // app-action round trip per directive.
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [{ ...finishedJob }] })),
      getRobotsJob: vi.fn(async () => ({ data: finishedJob })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({
        data: [liveRun({ started_at: nowSeconds - 24 * 3600 })],
      })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, defaultDirectiveIds: ['drv_1'] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      const settled = muxApi.listRobotsJobs.mock.calls.length;
      await tick(3);
      expect(muxApi.listRobotsJobs.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read a transient failure of the runs list as "the run finished"', async () => {
    // The loop is gated on this list, so dropping a live run because one call threw ends the poll
    // exactly the way an always-empty list did.
    let failNext = false;
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [{ ...finishedJob }] })),
      getRobotsJob: vi.fn(async () => ({ data: finishedJob })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => {
        if (failNext) throw new Error('502 from the app-action bridge');
        return { data: [liveRun()] };
      }),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, defaultDirectiveIds: ['drv_1'] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      failNext = true;
      await tick(1);
      const afterFailure = muxApi.listRobotsJobs.mock.calls.length;
      await tick(2);
      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(afterFailure);
      // The run is still on screen, too — a failed read is not news about the run.
      expect(screen.getByTestId('robots_directive_run_table')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it('arms the poll from the create response, before the run is listable', async () => {
    // `POST .../runs` answers 202 with the run's id and `pending` before the run is necessarily
    // visible to `GET .../runs`. Without an optimistic row there is nothing non-terminal anywhere
    // and the loop never starts.
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [] })),
      listRobotsDirectives: vi.fn(async () => ({ data: [{ id: 'drv_1', name: 'Ingest' }] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
      createRobotsDirectiveRun: vi.fn(async () => ({
        data: { run_id: 'drvrun_new', subject_id: 'asset-1', status: 'pending' },
      })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, defaultDirectiveIds: ['drv_1'] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drv_1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Run directive' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(muxApi.createRobotsDirectiveRun).toHaveBeenCalledWith('drv_1', 'asset-1');
      // The optimistic row is what the poll gate reads, so it has to be there immediately.
      expect(screen.getByTestId('robots_directive_run_table')).toBeInTheDocument();

      const afterClick = muxApi.listRobotsJobs.mock.calls.length;
      await tick(1);
      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(afterClick);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The directive path: reconciliation, an in-flight guard, and a record on the entry.
 *
 * It is the more expensive of the two Run buttons — a directive dispatches several billable
 * workflows in sequence — and until now it was the less protected one. A failed create showed a
 * plain error toast, so a cold-start timeout invited the editor to pay for the whole directive
 * twice; and there was no in-flight disable at all, so a double click did it without any help.
 */
describe('RobotsPanel — starting a directive run', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  const nowSeconds = Math.floor(Date.now() / 1000);

  const withStoredValue = (initial: MuxContentfulObject | undefined) => {
    let stored = initial;
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      stored = mutate(stored);
    });
    return { updateField, value: initial, read: () => stored };
  };

  const directiveApi = (overrides: Record<string, any> = {}) => ({
    ...apiThatReturns([]),
    listRobotsDirectives: vi.fn(async () => ({ data: [{ id: 'drv_1', name: 'Ingest' }] })),
    listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    createRobotsDirectiveRun: vi.fn(async () => ({
      data: { run_id: 'drvrun_1', subject_id: 'asset-1', status: 'pending', started_at: nowSeconds },
    })),
    ...overrides,
  });

  const start = async (muxApi: Record<string, any>, extra: Record<string, any> = {}) => {
    renderPanel({ muxApi, defaultDirectiveIds: ['drv_1'], ...extra });
    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drv_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run directive' }));
  };

  it('records the run on the entry at creation', async () => {
    // Without this, ownership of everything the run dispatches depends on the run still being
    // among the newest 25 the API returns for that directive. A busy directive pushes it out
    // within hours; a deleted directive does it at once.
    const stored = withStoredValue(value());
    await start(directiveApi(), { updateField: stored.updateField, value: stored.value });

    await waitFor(() => expect(stored.read()?.robotsDirectiveRuns).toHaveLength(1));
    expect(stored.read()?.robotsDirectiveRuns?.[0]).toMatchObject({
      runId: 'drvrun_1',
      directiveId: 'drv_1',
      startedAt: nowSeconds,
    });
    // The value holds Robots data now, so the version says so — the same v4 every other Robots
    // key raises to, since they all ship together.
    expect(stored.read()?.version).toBe(4);
  });

  it('fills in the dispatched job ids as the run reports them', async () => {
    const stored = withStoredValue(value());
    let runs: unknown[] = [];
    const muxApi = directiveApi({
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: runs })),
    });

    await start(muxApi, { updateField: stored.updateField, value: stored.value });
    await waitFor(() => expect(stored.read()?.robotsDirectiveRuns).toHaveLength(1));

    // The create response is a run id and `pending`; the jobs arrive over the next few minutes.
    runs = [
      {
        run_id: 'drvrun_1',
        subject_id: 'asset-1',
        status: 'running',
        started_at: nowSeconds,
        node_states: [{ job_id: 'rjob_a', workflow_name: 'summarize' }],
      },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() =>
      expect(stored.read()?.robotsDirectiveRuns?.[0].jobIds).toEqual(['rjob_a'])
    );
  });

  it('claims a job after its run has fallen out of the API\'s list window', async () => {
    // The structural point. `GET .../runs` is capped at 25 and cannot filter by asset, so a busy
    // or deleted directive makes this run invisible — and before the run was recorded, its jobs
    // then became permanently unclaimable.
    const stored = withStoredValue(
      value({
        robotsDirectiveRuns: [
          { runId: 'drvrun_gone', directiveId: 'drv_1', jobIds: ['rjob_auto'] },
        ],
      })
    );

    renderPanel({
      muxApi: {
        ...apiThatReturns([
          { id: 'rjob_auto', workflow: 'summarize', status: 'completed', created_at: nowSeconds },
        ]),
        // The directive is gone: nothing to list.
        listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
      },
      defaultDirectiveIds: ['drv_1'],
      updateField: stored.updateField,
      value: stored.value,
    });

    await waitFor(() => expect(stored.read()?.robotsJobs).toHaveLength(1));
    expect(stored.read()?.robotsJobs?.[0].id).toBe('rjob_auto');
  });

  it('holds a guard instead of an error when Mux never confirms the run', async () => {
    vi.useFakeTimers();
    try {
      const muxApi = directiveApi({
        createRobotsDirectiveRun: vi.fn(async () => {
          throw new Error('The app action response is taking longer than expected to process.');
        }),
      });

      renderPanel({ muxApi, defaultDirectiveIds: ['drv_1'] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drv_1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Run directive' }));
      // Reconciliation retries the run list three times on a short backoff before giving up.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByTestId('robots-directive-run-unconfirmed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run directive' })).toBeDisabled();
      expect(sdk.notifier.error).not.toHaveBeenCalled();
      // The create is never retried on the app's own initiative.
      expect(muxApi.createRobotsDirectiveRun).toHaveBeenCalledTimes(1);

      // And the way out is the editor's decision, with the situation explained.
      fireEvent.click(
        screen.getByRole('button', { name: 'Nothing is running — let me try again' })
      );
      expect(screen.getByRole('button', { name: 'Run directive' })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts a run that did start, rather than guarding on it', async () => {
    vi.useFakeTimers();
    try {
      const stored = withStoredValue(value());
      const muxApi = directiveApi({
        createRobotsDirectiveRun: vi.fn(async () => {
          throw new Error('taking longer than expected');
        }),
        listRobotsDirectiveRuns: vi.fn(async () => ({
          data: [
            { run_id: 'drvrun_started', subject_id: 'asset-1', status: 'pending', started_at: nowSeconds },
          ],
        })),
      });

      renderPanel({
        muxApi,
        defaultDirectiveIds: ['drv_1'],
        updateField: stored.updateField,
        value: stored.value,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'drv_1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Run directive' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.queryByTestId('robots-directive-run-unconfirmed')).not.toBeInTheDocument();
      expect(stored.read()?.robotsDirectiveRuns?.[0].runId).toBe('drvrun_started');
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables the button while a run is starting, so a double click cannot pay twice', async () => {
    let release: (value: unknown) => void = () => undefined;
    const createRobotsDirectiveRun = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const muxApi = directiveApi({ createRobotsDirectiveRun });

    await start(muxApi);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run directive' })).toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run directive' }));
    expect(createRobotsDirectiveRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        data: { run_id: 'drvrun_1', subject_id: 'asset-1', status: 'pending', started_at: nowSeconds },
      });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run directive' })).toBeEnabled()
    );
  });

  it('reports success even if recording the run on the entry fails', async () => {
    // Same rule as the job path: the run has started and is billing, so a failed *write* must
    // never be reported as a failed *run*.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await start(directiveApi(), {
      updateField: vi.fn(async () => {
        throw new Error('version conflict');
      }),
    });

    await waitFor(() => expect(sdk.notifier.success).toHaveBeenCalledWith('Directive run started.'));
    expect(sdk.notifier.error).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('still reports a 409 as "already running" rather than reconciling it', async () => {
    const muxApi = directiveApi({
      createRobotsDirectiveRun: vi.fn(async () => {
        throw new MuxApiError('Already running', 409);
      }),
    });

    await start(muxApi);

    await waitFor(() =>
      expect(sdk.notifier.warning).toHaveBeenCalledWith(
        'That directive is already running on this video.'
      )
    );
    expect(screen.queryByTestId('robots-directive-run-unconfirmed')).not.toBeInTheDocument();
  });
});

/**
 * The reported bug: an `edit-captions` job finishes and its new track only shows up after an F5
 * or a manual Resync. Two causes, both here.
 */
describe('RobotsPanel — a finished job reaching the rest of the editor', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('keeps polling a live job after the editor leaves the Robots tab', async () => {
    // The natural thing to do after starting a caption edit is to go and watch the Captions tab
    // for the new track. The poll loop was gated on `isActive`, so that was exactly where nothing
    // was ever polled, nothing was ever seen to finish, and no resync ever fired.
    const running = {
      id: 'rjob_edit',
      workflow: 'edit-captions',
      status: 'processing',
      created_at: Math.floor(Date.now() / 1000),
    };
    const muxApi = apiThatReturns([running]);

    vi.useFakeTimers();
    try {
      const { rerender } = renderPanel({ muxApi });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const afterFirstLoad = muxApi.listRobotsJobs.mock.calls.length;

      // Switch away to the Captions tab.
      rerender(
        <RobotsPanel
          sdk={sdk}
          muxApi={muxApi as any}
          value={value()}
          isActive={false}
          updateField={vi.fn(async () => undefined)}
          resync={vi.fn(async () => undefined)}
          defaultDirectiveIds={[]}
        />
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS * 2 + 200);
      });

      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(afterFirstLoad);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never starts polling for a tab nobody has opened', async () => {
    // The other half of the same rule: `isActive` still gates the *first* load, so Robots stays
    // free for editors who never touch it.
    const muxApi = apiThatReturns([]);
    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, isActive: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS * 3);
      });
      expect(muxApi.listRobotsJobs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads the player for a job that finished while the editor was here', async () => {
    // `skipPlayerResync: true` was unconditional, so the player kept its old text tracks and the
    // edited caption only appeared after an F5.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const resync = vi.fn(async () => undefined);
    let status = 'processing';
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({
        data: [{ id: 'rjob_edit', workflow: 'edit-captions', status, created_at: nowSeconds }],
      })),
      getRobotsJob: vi.fn(async (_workflow: string, id: string) => ({
        data: { id, workflow: 'edit-captions', status },
      })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, resync });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(resync).not.toHaveBeenCalled();

      status = 'completed';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 200);
      });

      expect(resync).toHaveBeenCalledWith({ silent: true, skipPlayerResync: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the player alone for jobs that were already finished before this session', async () => {
    // Otherwise every visit to the Robots tab on an entry with job history restarts whatever the
    // editor was watching.
    const resync = vi.fn(async () => undefined);
    renderPanel({
      muxApi: apiThatReturns([
        { id: 'rjob_old', workflow: 'edit-captions', status: 'completed', created_at: 1 },
      ]),
      resync,
    });

    await waitFor(() => expect(resync).toHaveBeenCalledTimes(1));
    expect(resync).toHaveBeenCalledWith({ silent: true, skipPlayerResync: true });
  });
});

describe('RobotsPanel — what the run form knows about the asset', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  it('tells the run form the video is audio-only, so the docs restrictions can apply', async () => {
    // The gate lives in `validateParams`, but it is inert unless the panel passes what it knows.
    renderPanel({
      muxApi: apiThatReturns([]),
      value: value({ audioOnly: true } as Partial<MuxContentfulObject>),
    });

    await waitFor(() => expect(screen.getByText('Run a workflow')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    await userEvent.selectOptions(await screen.findByLabelText('Workflow'), 'find-scenes');

    expect(
      await screen.findByText('Find scenes does not support audio-only videos.')
    ).toBeInTheDocument();
  });

  it('does not invent a restriction for a video whose kind is not recorded', async () => {
    renderPanel({ muxApi: apiThatReturns([]), value: value() });

    await waitFor(() => expect(screen.getByText('Run a workflow')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Run a workflow' }));
    await userEvent.selectOptions(await screen.findByLabelText('Workflow'), 'find-scenes');

    expect(screen.queryByText(/does not support audio-only videos/)).not.toBeInTheDocument();
  });
});

/**
 * Opening a job's output the instant it completes.
 *
 * The reported bug: create an `ask-questions` job, wait for it to show as completed, click View
 * output straight away, and the modal reads "Loading the result from Mux…" forever. Refresh does
 * not clear it; only an F5 does. Wait a while before opening it and it works.
 *
 * What made it timing-dependent is the panel's own bounded detail read. The moment a job turns
 * terminal the panel fetches its full record in the background, and the viewer is handed
 * `jobDetails[id] ?? viewedJob`. Open the modal inside that window and the viewer starts its own
 * fetch against the summary row; when the panel's detail lands the `job` prop changes identity,
 * the viewer's effect re-runs and its cleanup cancels the request that was going to clear the
 * spinner. Nothing ever re-ran the effect after that, which is why only a reload helped.
 *
 * Nothing about this is specific to `ask-questions` — every workflow goes through the same two
 * fetches — so it is driven here over all twelve.
 */
describe('RobotsPanel — opening a job the moment it finishes', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  /** `activeJobs` drops anything older than `ROBOTS_STALE_JOB_MS`, so the poll only arms on a recent job. */
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  const raceApi = (workflow: string, outputs: Record<string, unknown>) => {
    const created = nowSeconds();
    // Flipped by the test, not counted off the call log: `resolveRobotsCapability` lists once
    // before the panel's own first read, so counting calls finishes the job a tick too early.
    let watchedStatus = 'processing';
    /** Resolvers for each `getRobotsJob`, so the panel's read and the viewer's can be ordered by hand. */
    const detailReads: Array<(value: unknown) => void> = [];

    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({
        data: [
          { id: 'rjob_watched', workflow, status: watchedStatus, created_at: created },
          // Something still in flight, so the poll loop stays armed exactly as it does in the
          // report — this bug only shows up while the panel is still polling.
          { id: 'rjob_other', workflow: 'summarize', status: 'processing', created_at: created },
        ],
      })),
      getRobotsJob: vi.fn(
        () => new Promise((resolve) => detailReads.push(resolve as (value: unknown) => void))
      ),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    const full = { id: 'rjob_watched', workflow, status: 'completed', created_at: created, outputs };
    return { muxApi, detailReads, full, finish: () => (watchedStatus = 'completed') };
  };

  it.each([
    ['ask-questions', { answers: [{ question: 'Who?', answer: 'The narrator' }] }, 'The narrator'],
    ['summarize', { title: 'A title Mux wrote' }, 'A title Mux wrote'],
    ['find-scenes', { scenes: [{ start_ms: 0, end_ms: 1000, title: 'Opening scene' }] }, 'Opening scene'],
    ['generate-chapters', { chapters: [{ start_time: 0, title: 'Chapter one' }] }, 'Chapter one'],
    ['find-key-moments', { moments: [{ start_ms: 0, end_ms: 1, title: 'A moment' }] }, 'A moment'],
    ['find-best-thumbnails', { best_thumbnails: [{ timestamp_ms: 0, description: 'A frame' }] }, 'A frame'],
    ['moderate', { max_scores: { nudity: 0.1 } }, 'nudity'],
    ['generate-engagement-insights', { overall_insight: { summary: 'Viewers dropped off' } }, 'Viewers dropped off'],
    ['generate-premium-captions', { track_id: 'trk_1' }, 'trk_1'],
    ['edit-captions', { track_id: 'trk_2' }, 'trk_2'],
    ['translate-captions', { track_id: 'trk_3' }, 'trk_3'],
    ['translate-audio', { track_id: 'trk_4' }, 'trk_4'],
  ])('%s: the result is on screen, not a spinner', async (workflow, outputs, expected) => {
    const { muxApi, detailReads, full, finish } = raceApi(workflow, outputs);

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi });

      // First list: nothing terminal yet, so no detail is read and the poll arms.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(muxApi.getRobotsJob).not.toHaveBeenCalled();

      // The poll tick that flips the job to completed. The panel starts reading its detail in the
      // background on this same tick — that read is deliberately left in flight.
      finish();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });
      expect(muxApi.getRobotsJob).toHaveBeenCalledTimes(1);

      // The editor clicks View output straight away, inside that window.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'View output' }));
      });
      expect(screen.getByText(/Loading the result from Mux/)).toBeInTheDocument();

      // The panel's background read lands, replacing the summary the viewer was fetching against.
      await act(async () => {
        detailReads[0]({ data: full });
        await vi.advanceTimersByTimeAsync(10);
      });

      // Let the loop go round again: a spinner that survives the poll is the reported bug.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });

      expect(screen.queryByText(/Loading the result from Mux/)).toBeNull();
      expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Concurrency between the two poll loops, the create path and the publish gate.
 *
 * Each of these fails if its fix is reverted; none of them asserts anything about how the fix is
 * implemented, only that the loop keeps running and no read is dropped or applied out of order.
 */
describe('RobotsPanel concurrency', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  const runningJob = (id = 'rjob_live') => ({
    id,
    workflow: 'summarize',
    status: 'processing',
    created_at: Math.floor(Date.now() / 1000),
  });

  it('keeps polling while the parent re-renders', async () => {
    const muxApi = apiThatReturns([runningJob()]);
    vi.useFakeTimers();
    try {
      const props: any = {
        sdk,
        muxApi,
        value: value(),
        isActive: true,
        updateField: vi.fn(async () => undefined),
        resync: vi.fn(async () => undefined),
      };
      // A fresh array each time, exactly as `installation.muxDefaultDirectiveIds ?? []` yields on
      // an install with no directives configured.
      const { rerender } = render(<RobotsPanel {...props} defaultDirectiveIds={[]} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      const afterFirstLoad = muxApi.listRobotsJobs.mock.calls.length;

      // The asset poll re-renders the field editor every 500 ms while an asset prepares. If that
      // re-arms this timer, it never fires.
      for (let tick = 0; tick < 24; tick += 1) {
        rerender(<RobotsPanel {...props} defaultDirectiveIds={[]} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
      }

      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(afterFirstLoad);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a just-created job on screen when the list has not caught up', async () => {
    const created = runningJob('rjob_new');
    const muxApi = {
      // The list genuinely does not have it yet — `POST` answers before `GET` lists it.
      listRobotsJobs: vi.fn(async () => ({ data: [] })),
      getRobotsJob: vi.fn(async () => ({ data: created })),
      createRobotsJob: vi.fn(async () => ({ data: created })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      fireEvent.click(screen.getByText('Run a workflow'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      fireEvent.click(screen.getByText('Continue'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      fireEvent.click(screen.getByText('Run Summarize'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      const callsAfterCreate = muxApi.listRobotsJobs.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });

      // The row is what the poll loop arms on. Losing it to the refresh that runs right after the
      // create leaves a billable job running with nothing watching it.
      expect(screen.getByTestId('robots_job_table').textContent).toContain('Summarize');
      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(callsAfterCreate);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a Refresh asked for while a poll tick was already running', async () => {
    let releaseList: (value: unknown) => void = () => undefined;
    const listCalls: number[] = [];
    const muxApi = {
      listRobotsJobs: vi.fn(() => {
        listCalls.push(Date.now());
        // `resolveRobotsCapability` probes with this same call, so the first two have to settle
        // before the tab renders at all; only a later poll tick blocks.
        if (listCalls.length <= 2) return Promise.resolve({ data: [runningJob()] });
        return new Promise((resolve) => {
          releaseList = resolve;
        });
      }),
      getRobotsJob: vi.fn(async () => ({ data: runningJob() })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // A poll tick starts and hangs.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });
      expect(muxApi.listRobotsJobs).toHaveBeenCalledTimes(3);

      // The editor presses Refresh while that tick is still in flight. Dropping it silently is
      // the bug: no spinner, no data, nothing.
      fireEvent.click(screen.getByText('Refresh'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      await act(async () => {
        releaseList({ data: [runningJob()] });
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the runs for one directive one pass at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [runningJob()] })),
      getRobotsJob: vi.fn(async () => ({ data: runningJob() })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 200));
        inFlight -= 1;
        return { data: [] };
      }),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, defaultDirectiveIds: ['dir_1'] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Refresh reads both lists, and so does the poll tick. Overlapping run reads resolve out of
      // order, and the loser puts back runs the newer pass had moved on from.
      fireEvent.click(screen.getByText('Refresh'));
      fireEvent.click(screen.getByText('Refresh'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 400);
      });

      expect(maxInFlight).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the newest read when a parked write is released later', async () => {
    const mutators: Array<(current: any) => any> = [];
    // Stands in for the publish gate: the mutator is held, not applied.
    const updateField = vi.fn(async (mutate: (current: any) => any) => {
      mutators.push(mutate);
    });

    const job = { id: 'rjob_p', workflow: 'summarize', created_at: Math.floor(Date.now() / 1000) };
    let status = 'processing';
    const muxApi = {
      listRobotsJobs: vi.fn(async () => ({ data: [{ ...job, status }] })),
      getRobotsJob: vi.fn(async () => ({ data: { ...job, status, passthrough: ourPassthrough() } })),
      listRobotsDirectives: vi.fn(async () => ({ data: [] })),
      listRobotsDirectiveRuns: vi.fn(async () => ({ data: [] })),
    };

    vi.useFakeTimers();
    try {
      renderPanel({ muxApi, updateField });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(mutators.length).toBeGreaterThan(0);

      // The job finishes while the gate is shut.
      status = 'completed';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });

      // The gate opens and the *oldest* parked mutator is re-applied first. It must not write the
      // `processing` it was queued with over the `completed` that has since been read.
      const applied = mutators[0](value({ robotsJobs: [{ ...job, status: 'completed' }] } as any));
      expect(applied.robotsJobs.find((record: any) => record.id === 'rjob_p').status).toBe(
        'completed'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Picking a running job back up on an entry that is merely opened.
 *
 * `isActive` keeps Robots free for editors who never open the tab, but an entry reopened while a
 * job it started is still running has to resume on its own — otherwise a publish re-publishes the
 * stale `processing` record. See ADR-0013.
 */
describe('RobotsPanel — resuming a job without opening the tab', () => {
  beforeEach(() => {
    resetRobotsCapabilityCache();
    vi.clearAllMocks();
  });

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  const recordedJob = (status: string, createdAt = nowSeconds()) => ({
    id: 'rjob_recorded',
    workflow: 'summarize',
    status,
    created_at: createdAt,
  });

  it('loads and polls for an entry whose record says a job is still running', async () => {
    const muxApi = apiThatReturns([recordedJob('processing')]);

    vi.useFakeTimers();
    try {
      renderPanel({
        muxApi,
        isActive: false,
        value: value({ robotsJobs: [recordedJob('processing')] } as any),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(muxApi.listRobotsJobs).toHaveBeenCalled();

      const afterFirstLoad = muxApi.listRobotsJobs.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ROBOTS_POLL_INTERVAL_MS + 100);
      });
      expect(muxApi.listRobotsJobs.mock.calls.length).toBeGreaterThan(afterFirstLoad);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays silent for an entry whose recorded jobs have all finished', async () => {
    const muxApi = apiThatReturns([recordedJob('completed')]);

    renderPanel({
      muxApi,
      isActive: false,
      value: value({ robotsJobs: [recordedJob('completed')] } as any),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The whole point of the `isActive` gate: an editor who never opens this tab pays nothing.
    expect(muxApi.listRobotsJobs).not.toHaveBeenCalled();
  });

  it('gives up on a record that has been stuck for longer than the staleness window', async () => {
    const stale = recordedJob('processing', nowSeconds() - 7 * 60 * 60);
    const muxApi = apiThatReturns([stale]);

    renderPanel({ muxApi, isActive: false, value: value({ robotsJobs: [stale] } as any) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A job Mux purged, or a session that died mid-run, must not make every open of this entry
    // fetch forever.
    expect(muxApi.listRobotsJobs).not.toHaveBeenCalled();
  });
});
