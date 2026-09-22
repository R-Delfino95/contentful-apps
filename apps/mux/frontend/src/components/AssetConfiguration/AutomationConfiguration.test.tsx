import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AutomationConfiguration from './AutomationConfiguration';
import {
  directiveNamesById,
  useRobotsDirectiveNames,
} from '../Robots/useRobotsDirectiveNames';
import { MuxApiService } from '../../util/muxApi';

/**
 * The Automation section of the upload modal.
 *
 * It listed raw directive ids — `drv_01H8X...` — as the whole label, next to a checkbox asking
 * the editor whether to spend Mux AI units on this upload. An id is not a question anyone can
 * answer.
 */
describe('AutomationConfiguration', () => {
  it('labels a directive with its name, and keeps the id underneath', () => {
    render(
      <AutomationConfiguration
        availableDirectiveIds={['drv_1']}
        selectedDirectiveIds={['drv_1']}
        directiveNames={{ drv_1: 'Publish pipeline' }}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('Publish pipeline')).toBeInTheDocument();
    // The id is what the configuration screen and the Mux dashboard identify it by, so it stays.
    expect(screen.getByText('drv_1')).toBeInTheDocument();
  });

  it('falls back to the id when the name cannot be resolved', () => {
    render(
      <AutomationConfiguration
        availableDirectiveIds={['drv_deleted']}
        selectedDirectiveIds={[]}
        directiveNames={{}}
        onChange={vi.fn()}
      />
    );

    // Exactly once: an unresolved directive must not render the id as both label and help text.
    expect(screen.getAllByText('drv_deleted')).toHaveLength(1);
  });

  it('renders with no names at all, because the listing is never waited on', () => {
    render(
      <AutomationConfiguration
        availableDirectiveIds={['drv_1']}
        selectedDirectiveIds={[]}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('drv_1')).toBeInTheDocument();
  });
});

describe('directiveNamesById', () => {
  it('prefers the listed name and keeps every id answerable', () => {
    expect(
      directiveNamesById([{ id: 'drv_1', name: 'Publish pipeline' }], ['drv_1', 'drv_2'])
    ).toEqual({ drv_1: 'Publish pipeline', drv_2: 'drv_2' });
  });

  it('answers an id for a directive whose name Mux left empty', () => {
    expect(directiveNamesById([{ id: 'drv_1', name: '' }], [])).toEqual({ drv_1: 'drv_1' });
  });
});

describe('useRobotsDirectiveNames', () => {
  const Probe = ({
    muxApi,
    ids,
    isEnabled = true,
  }: {
    muxApi?: MuxApiService;
    ids: string[];
    isEnabled?: boolean;
  }) => {
    const names = useRobotsDirectiveNames(muxApi, ids, isEnabled);
    return <span data-testid="names">{JSON.stringify(names)}</span>;
  };

  it('resolves names once and hands back the ids until they arrive', async () => {
    const listRobotsDirectives = vi.fn(async () => ({
      data: [{ id: 'drv_1', name: 'Publish pipeline' }],
    }));
    render(<Probe muxApi={{ listRobotsDirectives } as never} ids={['drv_1']} />);

    // Before the listing resolves, the id is the answer — which is what stops this ever holding
    // an upload up.
    expect(screen.getByTestId('names')).toHaveTextContent('{"drv_1":"drv_1"}');
    await waitFor(() =>
      expect(screen.getByTestId('names')).toHaveTextContent('{"drv_1":"Publish pipeline"}')
    );
    expect(listRobotsDirectives).toHaveBeenCalledTimes(1);
  });

  it('degrades to the id when the listing fails', async () => {
    const listRobotsDirectives = vi.fn(async () => {
      throw new Error('403');
    });
    render(<Probe muxApi={{ listRobotsDirectives } as never} ids={['drv_1']} />);

    await waitFor(() => expect(listRobotsDirectives).toHaveBeenCalled());
    expect(screen.getByTestId('names')).toHaveTextContent('{"drv_1":"drv_1"}');
  });

  it('calls nothing when there is nothing to resolve', () => {
    const listRobotsDirectives = vi.fn(async () => ({ data: [] }));
    render(<Probe muxApi={{ listRobotsDirectives } as never} ids={[]} />);

    expect(listRobotsDirectives).not.toHaveBeenCalled();
  });

  it('calls nothing while disabled, so editing an asset costs no round trip', () => {
    const listRobotsDirectives = vi.fn(async () => ({ data: [] }));
    render(<Probe muxApi={{ listRobotsDirectives } as never} ids={['drv_1']} isEnabled={false} />);

    expect(listRobotsDirectives).not.toHaveBeenCalled();
  });
});
