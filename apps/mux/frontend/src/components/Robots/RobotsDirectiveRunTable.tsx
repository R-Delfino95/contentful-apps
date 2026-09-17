import { FC, Fragment, useState } from 'react';
import { Badge, Box, IconButton, Note, Table, Text } from '@contentful/f36-components';
import { ChevronDownIcon, ChevronUpIcon } from '@contentful/f36-icons';
import {
  RobotsDirectiveRun,
  RobotsDirectiveRunStatus,
  RobotsNodeStatus,
} from '../../util/robotsTypes';
import { workflowLabel } from '../../util/robotsCatalog';

/**
 * Directive runs, one row each, expanding to the per-workflow `node_states`.
 *
 * `node_states` come back "in the order the bindings appear in the Directive's workflows", so the
 * row maps state to workflow by position and does not need a lookup against the directive.
 */

interface RobotsDirectiveRunTableProps {
  runs: RobotsDirectiveRun[];
  directiveNames: Record<string, string>;
}

const RUN_VARIANT: Record<
  RobotsDirectiveRunStatus,
  'primary' | 'positive' | 'negative' | 'warning' | 'secondary'
> = {
  pending: 'secondary',
  dispatching: 'primary',
  running: 'primary',
  waiting: 'secondary',
  completed: 'positive',
  partial: 'warning',
  errored: 'negative',
};

const NODE_VARIANT: Record<RobotsNodeStatus, 'primary' | 'negative' | 'secondary'> = {
  dispatched: 'primary',
  failed: 'negative',
  waiting_for_resources: 'secondary',
  waiting_for_source_workflow: 'secondary',
};

const formatTimestamp = (seconds?: number): string =>
  seconds ? new Date(seconds * 1000).toLocaleString() : '—';

const RobotsDirectiveRunTable: FC<RobotsDirectiveRunTableProps> = ({ runs, directiveNames }) => {
  const [expandedId, setExpandedId] = useState<string | undefined>();

  if (runs.length === 0) {
    return (
      <Box marginTop="spacingM" marginBottom="spacingM">
        <Note variant="neutral">No directive runs for this video yet.</Note>
      </Box>
    );
  }

  return (
    <Box marginBottom="spacingM">
      <Table data-testid="robots_directive_run_table">
        <Table.Head>
          <Table.Row>
            <Table.Cell>Directive</Table.Cell>
            <Table.Cell>Status</Table.Cell>
            <Table.Cell>Started</Table.Cell>
            <Table.Cell>Steps</Table.Cell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {runs.map((run) => {
            const isExpanded = expandedId === run.run_id;
            const nodeStates = run.node_states ?? [];
            return (
              <Fragment key={run.run_id}>
                <Table.Row>
                  <Table.Cell>
                    <Text>{directiveNames[run.directive_id ?? ''] ?? run.directive_id ?? '—'}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={RUN_VARIANT[run.status ?? 'pending'] ?? 'secondary'}>
                      {run.status ?? 'pending'}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>{formatTimestamp(run.started_at)}</Table.Cell>
                  <Table.Cell>
                    <IconButton
                      variant="transparent"
                      aria-label={isExpanded ? 'Hide steps' : 'Show steps'}
                      isDisabled={nodeStates.length === 0}
                      icon={isExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
                      onClick={() => setExpandedId(isExpanded ? undefined : run.run_id)}
                    />
                    <Text marginLeft="spacingXs">{nodeStates.length}</Text>
                  </Table.Cell>
                </Table.Row>
                {isExpanded && (
                  <Table.Row>
                    <Table.Cell colSpan={4}>
                      <Table>
                        <Table.Head>
                          <Table.Row>
                            <Table.Cell>Workflow</Table.Cell>
                            <Table.Cell>Status</Table.Cell>
                            <Table.Cell>Detail</Table.Cell>
                          </Table.Row>
                        </Table.Head>
                        <Table.Body>
                          {nodeStates.map((node, index) => (
                            <Table.Row key={node.job_id ?? node.reference_id ?? index}>
                              <Table.Cell>
                                {node.workflow_name
                                  ? workflowLabel(node.workflow_name)
                                  : node.reference_id ?? `Step ${index + 1}`}
                              </Table.Cell>
                              <Table.Cell>
                                <Badge
                                  variant={
                                    NODE_VARIANT[node.status as RobotsNodeStatus] ?? 'secondary'
                                  }>
                                  {(node.status ?? 'unknown').replace(/_/g, ' ')}
                                </Badge>
                              </Table.Cell>
                              <Table.Cell>
                                {node.reason ??
                                  (node.source_workflows?.length
                                    ? `Waiting on ${node.source_workflows.join(', ')}`
                                    : '—')}
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table>
                    </Table.Cell>
                  </Table.Row>
                )}
              </Fragment>
            );
          })}
        </Table.Body>
      </Table>
    </Box>
  );
};

export default RobotsDirectiveRunTable;
