import { FC, Fragment, useState } from 'react';
import { Box, IconButton, Table, Text } from '@contentful/f36-components';
import { ChevronDownIcon, ChevronUpIcon } from '@contentful/f36-icons';
import { RobotsDirectiveRun, RobotsNodeState } from '../../util/robotsTypes';
import { workflowLabel } from '../../util/robotsCatalog';
import { EM_DASH, formatTimestamp } from '../../util/robotsFormat';
import EmptyTableNote from './EmptyTableNote';
import RobotsStatusBadge from './RobotsStatusBadge';

/**
 * Directive runs, one row each, expanding to the per-workflow `node_states`.
 *
 * `node_states` come back "in the order the bindings appear in the Directive's workflows", so a
 * step maps to its workflow by position and needs no lookup against the directive.
 */

interface RobotsDirectiveRunTableProps {
  runs: RobotsDirectiveRun[];
  directiveNames: Record<string, string>;
}

const nodeDetail = (node: RobotsNodeState): string => {
  if (node.reason) return node.reason;
  if (node.source_workflows?.length) return `Waiting on ${node.source_workflows.join(', ')}`;
  return EM_DASH;
};

const NodeStateRows: FC<{ nodeStates: RobotsNodeState[] }> = ({ nodeStates }) => (
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
            <RobotsStatusBadge kind="node" status={node.status} />
          </Table.Cell>
          <Table.Cell>{nodeDetail(node)}</Table.Cell>
        </Table.Row>
      ))}
    </Table.Body>
  </Table>
);

const RobotsDirectiveRunTable: FC<RobotsDirectiveRunTableProps> = ({ runs, directiveNames }) => {
  const [expandedId, setExpandedId] = useState<string | undefined>();

  if (runs.length === 0) {
    return <EmptyTableNote>No directive runs for this video yet.</EmptyTableNote>;
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
                    <Text>
                      {directiveNames[run.directive_id ?? ''] ?? run.directive_id ?? EM_DASH}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <RobotsStatusBadge kind="run" status={run.status} />
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
                      <NodeStateRows nodeStates={nodeStates} />
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
