import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import RobotsDirectiveRunTable from './RobotsDirectiveRunTable';
import { RobotsDirectiveRun } from '../../util/robotsTypes';

const run = (overrides: Partial<RobotsDirectiveRun> = {}): RobotsDirectiveRun => ({
  run_id: 'drvrun_1',
  directive_id: 'drv_1',
  subject_id: 'asset-1',
  status: 'completed',
  started_at: 1_700_000_000,
  node_states: [
    { reference_id: 'captions', workflow_name: 'generate-premium-captions', status: 'dispatched' },
    { reference_id: 'summary', workflow_name: 'summarize', status: 'failed', reason: 'Nope' },
  ],
  ...overrides,
});

describe('RobotsDirectiveRunTable', () => {
  it('centres a run row’s cells, the steps count with its arrow included', () => {
    render(<RobotsDirectiveRunTable runs={[run()]} directiveNames={{ drv_1: 'Ingest' }} />);

    const cells = screen.getByTestId('robots_directive_run_table').querySelectorAll('tbody td');
    for (const cell of Array.from(cells)) expect(cell).toHaveStyle({ verticalAlign: 'middle' });
    // The count and its expand button sit on one centred line rather than on a shared baseline.
    const arrow = screen.getByRole('button', { name: 'Show steps' });
    expect(arrow.parentElement).toHaveStyle({ display: 'flex', alignItems: 'center' });
    expect(arrow.parentElement).toHaveTextContent('2');
  });

  it('centres the expanded steps too', () => {
    render(<RobotsDirectiveRunTable runs={[run()]} directiveNames={{ drv_1: 'Ingest' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));

    const stepCell = screen.getByText('Nope').closest('td') as HTMLElement;
    expect(stepCell).toHaveStyle({ verticalAlign: 'middle' });
  });

  it('wraps a directive shown by its id, which has no spaces to break at', () => {
    const id = `drv_${'x'.repeat(80)}`;
    render(<RobotsDirectiveRunTable runs={[run({ directive_id: id })]} directiveNames={{}} />);
    expect(screen.getByText(id).closest('td')).toHaveStyle({ wordBreak: 'break-word' });
  });

  it('says it is still reading rather than that there are no runs', () => {
    render(<RobotsDirectiveRunTable runs={[]} directiveNames={{}} isLoading />);
    expect(screen.getByTestId('robots_directive_run_table_loading')).toBeInTheDocument();
    expect(screen.queryByText(/No directive runs for this video yet/)).not.toBeInTheDocument();
  });

  it('shows the runs it has, even while it is still reading', () => {
    render(<RobotsDirectiveRunTable runs={[run()]} directiveNames={{}} isLoading />);
    expect(screen.getByTestId('robots_directive_run_table')).toBeInTheDocument();
  });
});
